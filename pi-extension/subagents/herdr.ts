/**
 * herdr surface layer — the only terminal multiplexer this extension supports.
 *
 * Everything the extension does to a pane goes through the small API in this
 * file: create/split a pane, type a command into it, read its screen, close
 * it, and poll for exit. Keeping the herdr calls isolated here means index.ts
 * stays testable without a multiplexer running.
 *
 * Panes are identified by workspace-qualified herdr pane ids (e.g. `w3:p2`).
 * Splits always target the parent pi's pane (`$HERDR_PANE_ID`) so they follow
 * the agent rather than the user's focus.
 */
import { execFile, execFileSync } from "node:child_process";
import { connect } from "node:net";
import { promisify } from "node:util";
import { existsSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const execFileAsync = promisify(execFile);

// ── Availability ──

const commandAvailability = new Map<string, boolean>();

function hasCommand(command: string): boolean {
  if (commandAvailability.has(command)) {
    return commandAvailability.get(command)!;
  }

  let available = false;
  try {
    execFileSync("sh", ["-c", `command -v ${command}`], { stdio: "ignore" });
    available = true;
  } catch {
    available = false;
  }

  commandAvailability.set(command, available);
  return available;
}

/**
 * True when running inside herdr with the herdr binary on PATH.
 * `HERDR_ENV=1` is set by herdr in every process it spawns.
 */
export function isHerdrAvailable(): boolean {
  return process.env.HERDR_ENV === "1" && hasCommand("herdr");
}

export function isMuxAvailable(): boolean {
  return isHerdrAvailable();
}

export function muxSetupHint(): string {
  return "Start pi inside herdr (`herdr`, then run `pi` in a pane).";
}

function requireHerdr(): void {
  if (!isHerdrAvailable()) {
    throw new Error(`herdr is required for subagents. ${muxSetupHint()}`);
  }
}

/**
 * Run a herdr CLI command and return its stdout.
 *
 * stderr is captured rather than inherited: herdr prints a JSON error blob
 * there on any failure, and letting that reach the terminal corrupts pi's TUI.
 */
function herdrCli(args: string[]): string {
  return execFileSync("herdr", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

// ── Shell helpers ──

export function shellEscape(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

// ── Socket API ──

/**
 * One request over herdr's socket API, for the few methods the CLI does not
 * wrap. Everything else should use the CLI: herdr's server reads a request one
 * byte at a time and sleeps CONNECTION_POLL_INTERVAL (100ms) whenever that read
 * comes back pending (`src/api/server.rs`), so a client that cannot deliver its
 * request in the same instant it connects pays ~160ms. Node's event loop always
 * needs a turn, so it always loses that race, while the Rust CLI wins it and
 * costs ~4ms including the process spawn. Fine here: this is only ever called
 * from the debounced background rebalance.
 *
 * The server handles exactly one request per connection and then closes.
 */
function herdrApi(method: string, params: unknown): Promise<any> {
  return new Promise((resolve, reject) => {
    const socketPath = process.env.HERDR_SOCKET_PATH;
    if (!socketPath) return reject(new Error("HERDR_SOCKET_PATH is not set"));
    // On Windows the local socket is a named pipe, as herdr's own integration
    // does it. Untested here (macOS), but a plain path cannot work there.
    const endpoint =
      process.platform === "win32" ? `\\\\.\\pipe\\${socketPath}` : socketPath;

    const sock = connect(endpoint);
    let buf = "";
    sock.setTimeout(5000, () => sock.destroy(new Error("herdr socket timed out")));
    sock.on("error", reject);
    sock.on("connect", () => sock.write(JSON.stringify({ id: "pi", method, params }) + "\n"));
    sock.on("data", (chunk) => {
      buf += chunk;
      const end = buf.indexOf("\n");
      if (end < 0) return;
      sock.destroy();
      try {
        const message = JSON.parse(buf.slice(0, end));
        message.error ? reject(new Error(message.error.message)) : resolve(message.result);
      } catch (err) {
        reject(err as Error);
      }
    });
  });
}

/** A node of the BSP tree returned by `layout.export`. */
export type LayoutNode =
  | { type: "pane"; pane_id?: string }
  | { type: "split"; direction: "right" | "down"; ratio: number; first: LayoutNode; second: LayoutNode };

/**
 * Ratios that make every pane we own the same size.
 *
 * A split's share must weigh each side by how many panes it stacks *along that
 * split's own axis*, not by how many panes it holds: a subtree split the other
 * way spans the axis with a single band, however many panes are in it. Counting
 * panes instead equalizes area, which lets cells drift to the same area in
 * wildly different shapes (101x14 beside 34x42). Counting extent keeps a
 * grid-shaped tree's cells uniform, and collapses to 0.5 everywhere once the
 * grid is balanced.
 *
 * Splits with a pane we do not own anywhere beneath them are left alone — the
 * user's own panes keep the size they chose — but our subtrees underneath such
 * a split are still evened out.
 *
 * `path` addresses a split for `layout.set_split_ratio`: false descends into
 * `first`, true into `second` (`set_ratio_at` in `src/layout.rs`).
 */
export function evenSplitRatios(
  root: LayoutNode,
  isOwned: (paneId: string) => boolean,
): { path: boolean[]; ratio: number }[] {
  const out: { path: boolean[]; ratio: number }[] = [];

  /** Panes stacked along `axis`, or null if any pane below is not ours. */
  function extent(node: LayoutNode, axis: "right" | "down"): number | null {
    if (node.type === "pane") return node.pane_id && isOwned(node.pane_id) ? 1 : null;
    const first = extent(node.first, axis);
    const second = extent(node.second, axis);
    if (first === null || second === null) return null;
    // Along this split's axis the two sides sit end to end; across it they
    // overlap, so the wider of the two sets the extent.
    return node.direction === axis ? first + second : Math.max(first, second);
  }

  function walk(node: LayoutNode, path: boolean[]): void {
    if (node.type !== "split") return;
    const first = extent(node.first, node.direction);
    const second = extent(node.second, node.direction);
    if (first !== null && second !== null) {
      out.push({ path, ratio: first / (first + second) });
    }
    walk(node.first, [...path, false]);
    walk(node.second, [...path, true]);
  }

  walk(root, []);
  return out;
}

/** One debounce per placement: the two tabs balance independently. */
const rebalanceTimers = new Map<SurfacePlacement, ReturnType<typeof setTimeout>>();

/**
 * Re-balance the tab so every pane we own is exactly the same size.
 *
 * Splitting the largest pane keeps panes within 2x of each other; this makes
 * them exactly even at any count (3, 5, 6, 7 — not just powers of two), and it
 * is the only way to tidy up after a subagent exits, since herdr hands a closed
 * pane's space to its sibling alone. There is no CLI verb for it —
 * `layout.set_split_ratio` is socket-only.
 *
 * Debounced so a burst of parallel spawns or staggered exits collapses into one
 * pass, and non-fatal throughout: a cosmetic resize must never break spawning
 * or watching.
 */
function rebalanceSurfaces(placement: SurfacePlacement): void {
  const pending = rebalanceTimers.get(placement);
  if (pending) clearTimeout(pending);
  rebalanceTimers.set(
    placement,
    setTimeout(() => {
      rebalanceTimers.delete(placement);
      void (async () => {
        try {
          // Any live pane of the target tab anchors the pass: `layout.export`
          // resolves a pane id to the tab that holds it.
          const anchor = placement === "tab" ? tabAnchor() : process.env.HERDR_PANE_ID;
          if (!anchor) return;
          const result = await herdrApi("layout.export", { pane_id: anchor });
          const root: LayoutNode | undefined = result?.layout?.root;
          if (!root) return;
          for (const { path, ratio } of evenSplitRatios(root, (id) => isOwned(id, placement))) {
            await herdrApi("layout.set_split_ratio", { pane_id: anchor, path, ratio });
          }
        } catch {
          // Panes may have closed mid-pass; balancing is best-effort.
        }
      })();
    }, 120),
  );
}

// ── Agent lifecycle reporting ──

/**
 * How we identify ourselves to herdr when reporting a subagent's state.
 * Stable and unique to this extension, per herdr's custom-integration contract.
 */
const AGENT_SOURCE = "custom:pi-subagents";

export type AgentReportState = "working" | "idle" | "blocked" | "unknown";

/** herdr ignores stale reports from the same source by sequence number. */
let reportSeq = 0;

/**
 * The one name shape a subagent uses everywhere: herdr's agent-label pattern,
 * `[a-z][a-z0-9_-]{0,31}`.
 *
 * Subagent names are canonicalized to this at spawn, so the same string serves
 * as the widget row, the pane label, the herdr agent label, and the launch
 * script / task artifact filenames — instead of each consumer sanitizing the
 * raw name its own slightly different way.
 */
export function canonicalSubagentName(name: string): string {
  const cleaned = name
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[^a-z]+/, "")
    .replace(/-+$/, "");
  return (cleaned || "subagent").slice(0, 32).replace(/-+$/, "");
}

/**
 * Tell herdr what a subagent pane is doing, so its sidebar, notifications,
 * `agent list` and `agent wait` see the same state the status widget does.
 *
 * The parent reports on the subagent's behalf rather than the child loading
 * herdr's own pi integration: subagents launch `--no-extensions` by design, and
 * that integration also reports a *session reference*, which herdr uses to
 * relaunch a pane as plain `pi --session <path>` after a server restart
 * (`src/agent_resume.rs`) — unsandboxed, with every global extension and the
 * full toolset. That is exactly the escalation `subagent_message` refuses. We
 * report state and nothing else, so there is nothing for herdr to resume.
 *
 * Best-effort: a failed report must never disturb a running subagent.
 */
export function reportAgentState(
  surface: string,
  name: string,
  state: AgentReportState,
  message?: string,
): void {
  try {
    herdrCli([
      "pane", "report-agent", surface,
      "--source", AGENT_SOURCE,
      "--agent", canonicalSubagentName(name),
      "--state", state,
      "--seq", String(++reportSeq),
      ...(message ? ["--message", message.slice(0, 120)] : []),
    ]);
  } catch {}
}

/** Hand lifecycle authority for this pane back to herdr. */
export function releaseAgentState(surface: string, name: string): void {
  try {
    herdrCli([
      "pane", "release-agent", surface,
      "--source", AGENT_SOURCE,
      "--agent", canonicalSubagentName(name),
    ]);
  } catch {}
}

/**
 * Drop the cached subagent-tab id, so the next `tab` placement rediscovers it
 * the way a freshly started pi process would. Tests only.
 */
export function __forgetSubagentTab__(): void {
  subagentTabId = null;
}

// ── Surface primitives ──

/**
 * Smallest pane we are willing to create, in terminal cells. An agent TUI
 * below this is unreadable. herdr itself enforces no minimum — `src/layout.rs`
 * splits a rect by ratio and will happily render a 1-column pane — so the
 * floor has to live here.
 */
const MIN_COLS = 40;
const MIN_ROWS = 12;

/**
 * Where a subagent's pane goes: `split` carves up the tab pi is running in,
 * `tab` puts it in a dedicated subagent tab so pi keeps its whole window.
 * Set per agent via `pane-placement:` in the agent definition.
 */
export type SurfacePlacement = "split" | "tab";

/**
 * Panes this extension created and where each one lives, so tiling only ever
 * re-splits our own real estate — never a pane the user opened alongside us —
 * and each tab is balanced against its own panes.
 */
const ownedSurfaces = new Map<string, SurfacePlacement>();

/** Label herdr shows on the dedicated subagent tab, and how we recognize it. */
const SUBAGENT_TAB_LABEL = "subagents";

/**
 * The dedicated subagent tab, once created. herdr closes a tab as soon as its
 * last pane closes, so this goes stale on its own; `tabAnchor()` notices and
 * the next `tab` spawn makes a fresh one.
 */
let subagentTabId: string | null = null;

/**
 * A subagents tab from an earlier run of this extension in pi's workspace.
 *
 * Quitting pi leaves its subagent panes and their tab standing (they are
 * separate panes), and a herdr server restart restores them. Adopting that tab
 * keeps restarts from stacking up duplicate "subagents" tabs. Its leftover
 * panes are not ours, so tiling treats them as the user's and works around
 * them.
 */
function findExistingSubagentTab(): string | null {
  try {
    const tabs = JSON.parse(herdrCli(["tab", "list"]))?.result?.tabs ?? [];
    const workspace = process.env.HERDR_WORKSPACE_ID;
    const match = tabs.find(
      (t: any) =>
        t.label === SUBAGENT_TAB_LABEL && (!workspace || t.workspace_id === workspace),
    );
    return match?.tab_id ?? null;
  } catch {
    return null;
  }
}

/**
 * Forget panes that are no longer live. Closing a subagent pane by hand (or
 * herdr reaping it with its tab) never routes through closeSurface, so without
 * this the map only ever grows.
 */
export function pruneOwned<T>(owned: Map<string, T>, live: Set<string>): void {
  for (const paneId of owned.keys()) {
    if (!live.has(paneId)) owned.delete(paneId);
  }
}

/** A live pane in the subagent tab, or null when that tab is gone. */
function tabAnchor(): string | null {
  if (!subagentTabId) subagentTabId = findExistingSubagentTab();
  if (!subagentTabId) return null;
  const panes = livePanes();
  return panes.find((p: any) => p.tab_id === subagentTabId)?.pane_id ?? null;
}

/** Every pane herdr currently has open, and a chance to forget dead ones. */
function livePanes(): any[] {
  try {
    const panes = JSON.parse(herdrCli(["pane", "list"]))?.result?.panes ?? [];
    pruneOwned(ownedSurfaces, new Set(panes.map((p: any) => p.pane_id)));
    return panes;
  } catch {
    return [];
  }
}

/** Create the dedicated subagent tab. Returns its ready-to-use root pane. */
function createSubagentTab(cwd?: string): string {
  // Pin the workspace to pi's own. Without `--workspace`, `tab.create` falls
  // back to the *focused* workspace (`src/app/api/tabs.rs`), so a subagent
  // spawned while the user is looking elsewhere would open its tab over there.
  const workspace = process.env.HERDR_WORKSPACE_ID;
  const out = herdrCli([
    "tab",
    "create",
    "--label",
    SUBAGENT_TAB_LABEL,
    "--no-focus",
    ...(workspace ? ["--workspace", workspace] : []),
    ...(cwd ? ["--cwd", cwd] : []),
  ]);
  const created = JSON.parse(out)?.result;
  const paneId = created?.root_pane?.pane_id;
  if (typeof paneId !== "string" || paneId === "") {
    throw new Error(`Unexpected herdr tab create output: ${out}`);
  }
  // A new tab arrives with a live shell in its root pane, so the first subagent
  // uses that pane instead of splitting it and stranding an idle shell.
  subagentTabId = created.tab.tab_id;
  return paneId;
}

export interface PaneRect {
  pane_id: string;
  width: number;
  height: number;
}

/** Pane rects for the tab containing `anchor`. */
function paneRects(anchor: string): PaneRect[] {
  const out = herdrCli(["pane", "layout", "--pane", anchor]);
  const panes = JSON.parse(out)?.result?.layout?.panes ?? [];
  return panes.map((p: any) => ({
    pane_id: p.pane_id,
    width: p.rect?.width ?? 0,
    height: p.rect?.height ?? 0,
  }));
}

/**
 * Pick the pane to split and the axis to split it on.
 *
 * herdr splits the *target* pane's real estate rather than the window's, so
 * repeatedly splitting the parent pi pane halves it every spawn until it is
 * unusable. Instead: always split the largest pane we own, and split it across
 * its long axis. Splitting the largest keeps every pane within 2x of every
 * other (exactly even at 2, 4, 8 subagents), which is what tmux's
 * `select-layout even-horizontal` bought us — and alternating the axis grows
 * the layout into a grid, adding rows once columns would go below MIN_COLS,
 * rather than into ever-thinner columns.
 *
 * A terminal cell is roughly twice as tall as it is wide, so a pane looks
 * square at width ~= 2 * height; that is the threshold for preferring a
 * vertical cut over a horizontal one.
 */
export function chooseSplit(candidates: PaneRect[]): {
  pane: string;
  direction: "right" | "down";
} | null {
  const target = [...candidates].sort((a, b) => b.width * b.height - a.width * a.height)[0];
  if (!target) return null;

  const wideEnough = target.width / 2 >= MIN_COLS;
  const tallEnough = target.height / 2 >= MIN_ROWS;
  const looksWide = target.width >= target.height * 2;

  let direction: "right" | "down";
  if (wideEnough && tallEnough) direction = looksWide ? "right" : "down";
  else if (wideEnough) direction = "right";
  else if (tallEnough) direction = "down";
  // Out of room on both axes: cut the long way and accept a cramped pane —
  // a spawn must never fail over cosmetics.
  else direction = looksWide ? "right" : "down";

  return { pane: target.pane_id, direction };
}

function pickSplitTarget(
  anchor: string,
  placement: SurfacePlacement,
): { pane: string; direction: "right" | "down" } {
  const candidates = paneRects(anchor).filter((p) => isOwned(p.pane_id, placement));
  return chooseSplit(candidates) ?? { pane: anchor, direction: "right" };
}

/**
 * Panes we may resize for `placement`. In `split` mode the parent pi pane is
 * one of the tiles; in `tab` mode it lives in another tab entirely.
 */
function isOwned(paneId: string, placement: SurfacePlacement): boolean {
  if (placement === "split" && paneId === process.env.HERDR_PANE_ID) return true;
  return ownedSurfaces.get(paneId) === placement;
}

/**
 * Create a new pane for a subagent. Never steals focus, so panes follow the
 * agent rather than the user.
 * See https://github.com/HazAT/pi-interactive-subagents/issues/12
 *
 * `split` (the default) carves up the tab pi is running in, splitting the
 * largest pane we own there so the parent pi pane keeps its share. `tab` puts
 * the pane in a dedicated subagent tab instead, leaving pi's window untouched;
 * the first such subagent takes the new tab's root pane and the rest tile
 * inside it. Both are balanced against their own tab, so the two can be mixed.
 *
 * Returns the new pane id (e.g. `w3:p2`).
 */
export function createSurface(
  name: string,
  placement: SurfacePlacement = "split",
  cwd?: string,
): string {
  requireHerdr();

  let anchor: string | undefined;
  if (placement === "tab") {
    const existing = tabAnchor();
    if (!existing) {
      const root = createSubagentTab(cwd);
      ownedSurfaces.set(root, placement);
      renameSurface(root, name);
      return root;
    }
    anchor = existing;
  } else {
    anchor = process.env.HERDR_PANE_ID;
  }

  let target: { pane: string; direction: "right" | "down" };
  try {
    target = pickSplitTarget(anchor ?? "", placement);
  } catch {
    // Layout unavailable — split the anchor rather than fail the spawn.
    target = { pane: anchor ?? "", direction: "right" };
  }

  const surface = createSurfaceSplit(name, target.direction, target.pane || anchor, cwd);
  ownedSurfaces.set(surface, placement);
  renameSurface(surface, name);
  rebalanceSurfaces(placement);
  return surface;
}

/** Label the pane with the subagent's name. Cosmetic; never fatal. */
function renameSurface(surface: string, name: string): void {
  try {
    herdrCli(["pane", "rename", surface, name]);
  } catch {}
}

/**
 * Create a new split in the given direction from an optional source pane.
 * Returns the new pane id (e.g. `w3:p2`).
 *
 * herdr only splits `right` and `down` (no "before" splits), so `left`/`up`
 * collapse onto their axis counterparts.
 */
export function createSurfaceSplit(
  name: string,
  direction: "left" | "right" | "up" | "down",
  fromSurface?: string,
  cwd?: string,
): string {
  void name; // named after the split, via `pane rename`.
  requireHerdr();

  const args = ["pane", "split", "--no-focus", "--direction"];
  args.push(direction === "up" || direction === "down" ? "down" : "right");
  if (fromSurface) {
    args.push("--pane", fromSurface);
  } else {
    args.push("--current");
  }
  // Start the shell where the sub-agent will work, so the pane is usable as-is
  // and the launch command needs no `cd` prefix.
  if (cwd) args.push("--cwd", cwd);

  const out = herdrCli(args);
  const paneId = JSON.parse(out)?.result?.pane?.pane_id;
  if (typeof paneId !== "string" || paneId === "") {
    throw new Error(`Unexpected herdr pane split output: ${out}`);
  }
  return paneId;
}

/**
 * Send a command string to a pane and execute it.
 * `pane run` types the command literally and submits it in one call.
 */
export function sendCommand(surface: string, command: string): void {
  requireHerdr();
  herdrCli(["pane", "run", surface, command]);
}

/**
 * Send a long command to a pane by writing it to a script file first.
 * This avoids terminal line-wrapping issues that break commands exceeding the
 * pane's column width when sent character-by-character via sendCommand.
 *
 * By default the script is written to a temp directory, but callers can pass a
 * stable path (for example under session artifacts) so the exact invocation is
 * preserved for debugging.
 *
 * Returns the script path.
 */
export function sendLongCommand(
  surface: string,
  command: string,
  options?: { scriptPath?: string; scriptPreamble?: string },
): string {
  const scriptPath =
    options?.scriptPath ??
    join(
      tmpdir(),
      "pi-subagent-scripts",
      `cmd-${Date.now()}-${Math.random().toString(16).slice(2, 8)}.sh`,
    );
  mkdirSync(dirname(scriptPath), { recursive: true });

  const scriptParts = ["#!/bin/bash"];
  if (options?.scriptPreamble) {
    scriptParts.push(options.scriptPreamble.trimEnd());
  }
  scriptParts.push(command);

  writeFileSync(scriptPath, scriptParts.join("\n") + "\n", {
    mode: 0o755,
  });
  sendCommand(surface, `bash ${shellEscape(scriptPath)}`);
  return scriptPath;
}


/**
 * Read the screen contents of a pane (sync).
 *
 * `recent-unwrapped` joins rows the terminal soft-wrapped, so a narrow pane
 * can't split `__SUBAGENT_DONE_0__` (or a summary line) across rows and defeat
 * the callers' regexes. It only covers output produced since the pane's last
 * command started, so a pane that has printed nothing yet reads empty —
 * fall back to the raw visible screen there.
 */
export function readScreen(surface: string, lines = 50): string {
  requireHerdr();
  try {
    const out = herdrCli(readArgs(surface, lines, "recent-unwrapped"));
    if (out.trim() !== "") return out;
  } catch {
    // A recent read of more rows than fit on screen drives a recognized
    // agent's own scrollback, and errors with agent_not_idle while it works.
  }
  return herdrCli(readArgs(surface, lines, "visible"));
}

/**
 * Read the screen contents of a pane (async).
 */
export async function readScreenAsync(surface: string, lines = 50): Promise<string> {
  requireHerdr();
  try {
    const { stdout } = await execFileAsync("herdr", readArgs(surface, lines, "recent-unwrapped"), {
      encoding: "utf8",
    });
    if (stdout.trim() !== "") return stdout;
  } catch {}
  const fallback = await execFileAsync("herdr", readArgs(surface, lines, "visible"), {
    encoding: "utf8",
  });
  return fallback.stdout;
}

function readArgs(surface: string, lines: number, source: string): string[] {
  return ["pane", "read", surface, "--source", source, "--lines", String(Math.max(1, lines))];
}

/**
 * Close a pane. Idempotent: closing a pane that is already gone succeeds.
 */
export function closeSurface(surface: string): void {
  requireHerdr();
  const placement = ownedSurfaces.get(surface) ?? "split";
  ownedSurfaces.delete(surface);
  try {
    herdrCli(["pane", "close", surface]);
  } catch {
    // Already gone — the user closed it, or herdr reaped it along with its
    // tab. The pane is closed either way, which is all the caller asked for.
    // Throwing here used to drop a finished subagent into watchSubagent's
    // error path and lose its result.
  }
  rebalanceSurfaces(placement);
}

// ── Exit polling ──

/** The terminal sentinel the launch command prints when the sub-agent exits. */
const SENTINEL_PATTERN = "__SUBAGENT_DONE_(\\d+)__";

/**
 * Watch a pane for the exit sentinel using herdr's own `pane wait-output`,
 * which matches server-side and returns as soon as the line appears.
 *
 * This replaces reading the screen on every poll tick: one long-lived process
 * per sub-agent instead of a `herdr pane read` spawn per second each (measured
 * at ~6ms per read, so ~31ms/s of CPU with five sub-agents running).
 *
 * Calls `onExit` with the shell's exit code. Re-arms if the wait ends without a
 * match — a pane that has gone away errors immediately, and re-arming lets the
 * watch recover instead of going deaf, while the caller's file checks continue
 * either way.
 */
function watchForSentinel(
  surface: string,
  signal: AbortSignal,
  onExit: (exitCode: number) => void,
): void {
  if (signal.aborted) return;

  const child = execFile(
    "herdr",
    [
      "pane", "wait-output", surface,
      "--regex", SENTINEL_PATTERN,
      "--source", "recent-unwrapped",
      "--lines", "20",
    ],
    { encoding: "utf8" },
    (error, stdout) => {
      signal.removeEventListener("abort", kill);
      if (signal.aborted) return;
      const match = !error && stdout.match(/__SUBAGENT_DONE_(\d+)__/);
      if (match) {
        onExit(parseInt(match[1], 10));
        return;
      }
      // No match: the pane may be gone or herdr may have restarted. Wait a beat
      // so a permanently dead pane cannot spin, then look again.
      const retry = setTimeout(() => watchForSentinel(surface, signal, onExit), 1000);
      signal.addEventListener("abort", () => clearTimeout(retry), { once: true });
    },
  );

  function kill() {
    child.kill();
  }
  signal.addEventListener("abort", kill, { once: true });
}

export interface PollResult {
  /** How the subagent exited */
  reason: "done" | "sentinel" | "error";
  /** Shell exit code (from sentinel). 0 for file-based exits. */
  exitCode: number;
  /** Error message if reason is "error" (auto-retry exhausted, provider overload, etc.) */
  errorMessage?: string;
}

/**
 * Interpret an `.exit` sidecar payload (written by the error path in
 * subagent-done.ts). Centralized so both the fast and slow paths in
 * pollForExit decode the payload the same way. Clean completions write no
 * sidecar and are detected via the terminal sentinel instead.
 *
 * Note: ask_question does NOT write a `.exit` sidecar — it keeps the session
 * open and signals the parent via a separate `.ask` file (see deliverPendingQuestion).
 */
function interpretExitSidecar(data: any): PollResult {
  if (data?.type === "error") {
    const errorMessage =
      typeof data.errorMessage === "string" && data.errorMessage.trim() !== ""
        ? data.errorMessage
        : "Subagent exited with stopReason=error (no errorMessage in sidecar).";
    return { reason: "error", exitCode: 1, errorMessage };
  }
  return { reason: "done", exitCode: 0 };
}

export const __pollForExitTest__ = { interpretExitSidecar };

/**
 * Poll until the subagent exits. Checks for a `.exit` sidecar file first
 * (written by the error path), falling back to the terminal sentinel for
 * clean-completion and crash detection.
 */
export async function pollForExit(
  surface: string,
  signal: AbortSignal,
  options: {
    interval: number;
    sessionFile?: string;
    sentinelFile?: string;
    onTick?: (elapsed: number) => void;
  },
): Promise<PollResult> {
  const start = Date.now();

  // herdr watches the pane for the sentinel; we only poll the sidecar files.
  const watch = new AbortController();
  const stopWatch = AbortSignal.any([signal, watch.signal]);
  let sentinelExitCode: number | null = null;
  watchForSentinel(surface, stopWatch, (code) => {
    sentinelExitCode = code;
  });

  try {
  for (;;) {
    if (signal.aborted) {
      throw new Error("Aborted while waiting for subagent to finish");
    }

    // Fast path: check for .exit sidecar file (written by the error path)
    if (options.sessionFile) {
      try {
        const exitFile = `${options.sessionFile}.exit`;
        if (existsSync(exitFile)) {
          const data = JSON.parse(readFileSync(exitFile, "utf-8"));
          rmSync(exitFile, { force: true });
          return interpretExitSidecar(data);
        }
      } catch {}
    }

    // Check Claude sentinel file (written by plugin Stop hook)
    if (options.sentinelFile) {
      try {
        if (existsSync(options.sentinelFile)) {
          return { reason: "sentinel", exitCode: 0 };
        }
      } catch {}
    }

    // Terminal sentinel, seen by the herdr watch above (crash detection).
    if (sentinelExitCode !== null) {
      return { reason: "sentinel", exitCode: sentinelExitCode };
    }

    const elapsed = Math.floor((Date.now() - start) / 1000);
    options.onTick?.(elapsed);

    await new Promise<void>((resolve, reject) => {
      if (signal.aborted) return reject(new Error("Aborted"));
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, options.interval);
      function onAbort() {
        clearTimeout(timer);
        reject(new Error("Aborted"));
      }
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }
  } finally {
    watch.abort();
  }
}
