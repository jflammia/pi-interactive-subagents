/**
 * Rex surface layer — the second terminal multiplexer this extension
 * supports, beside herdr.ts.
 *
 * Mirrors herdr.ts's public shape exactly (same function names, same
 * signatures, same semantics for "surface", "busy", "exit sentinel") so
 * mux.ts can dispatch between the two without either index.ts or the test
 * suite caring which one is live. Everything Rex-specific — the CLI verbs,
 * the block/window/session vocabulary, the `rex api call` fallback for
 * rebalancing — stays isolated here.
 *
 * Panes are identified by Rex block ids (e.g. `block:01a1d94c-c363-...`).
 * Splits always target the parent pi's own block ($REX_BLOCK) so they follow
 * the agent rather than the user's focus, same rule as herdr.ts.
 */
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { chooseSplit, shellEscape, type AgentReportState, type SurfacePlacement } from "./herdr.ts";

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
 * True when running inside a Rex block with both the session id and the
 * `rex` binary available. `TERM_PROGRAM=rex` plus `REX_SESSION` are what Rex
 * sets in every block it creates (observed on the installed Rex 0.1.0-preview
 * CLI); neither alone is enough — a nested shell could export a stale
 * `REX_SESSION` from a parent that has since exited, so the CLI's own
 * presence is checked too.
 */
export function isRexAvailable(): boolean {
  return (
    process.env.TERM_PROGRAM === "rex" &&
    typeof process.env.REX_SESSION === "string" &&
    process.env.REX_SESSION !== "" &&
    hasCommand("rex")
  );
}

export function rexSetupHint(): string {
  return "Run pi in a Rex block (`rex window new -- pi`), with REX_SESSION set.";
}

function requireRex(): void {
  if (!isRexAvailable()) {
    throw new Error(`Rex is required for subagents. ${rexSetupHint()}`);
  }
}

/** The session this process runs in. Only called after requireRex(). */
function sessionId(): string {
  const id = process.env.REX_SESSION;
  if (!id) throw new Error("REX_SESSION is not set");
  return id;
}

/**
 * Run a Rex CLI command scoped to our session and return its stdout.
 *
 * stderr is captured rather than inherited: a CLI error prints human text
 * there, and letting that reach the terminal corrupts pi's TUI (same
 * reasoning as herdr.ts's herdrCli).
 */
function rexCli(args: string[]): string {
  return execFileSync("rex", ["-s", sessionId(), ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function rexCliAsync(args: string[]): Promise<string> {
  return execFileAsync("rex", ["-s", sessionId(), ...args], { encoding: "utf8" }).then((r) => r.stdout);
}

// ── Layout model (mirrors herdr.ts's LayoutNode / evenSplitRatios) ──

/**
 * One node of the layout tree `rex window ls --json` / `rex session inspect
 * --json` returns under `windows[].layers[].layout`. Rex's `rect` is
 * normalized `[x, y, w, h]` fractions of the window, not herdr's terminal
 * cells, but the extent math in evenSplitRatios (herdr.ts) only needs
 * relative width/height, so the same function works unchanged on either
 * shape — see rexLayoutToNode below, which adapts this into herdr.ts's
 * LayoutNode so evenSplitRatios can be reused as-is.
 */
interface RexLayoutNode {
  rect?: [number, number, number, number];
  block_id?: string;
  split?: {
    direction: "horizontal" | "vertical";
    ratio: number;
    before: RexLayoutNode;
    after: RexLayoutNode;
  };
}

/**
 * Convert Rex's `session.view`/`window ls` layout shape into herdr.ts's
 * `LayoutNode`, so the one evenSplitRatios implementation in herdr.ts is the
 * only place that balancing math lives. Rex has no bare "split" node distinct
 * from a block node; a node is either `{block_id}` (a leaf) or `{split}` (two
 * children). `horizontal` in Rex means side-by-side (our "right"); `vertical`
 * means stacked (our "down").
 */
function rexLayoutToNode(node: RexLayoutNode): import("./herdr.ts").LayoutNode {
  if (node.split) {
    return {
      type: "split",
      direction: node.split.direction === "horizontal" ? "right" : "down",
      ratio: node.split.ratio,
      first: rexLayoutToNode(node.split.before),
      second: rexLayoutToNode(node.split.after),
    };
  }
  return { type: "pane", pane_id: node.block_id };
}

/** One window's root layout node, read from `rex window ls --json`. */
interface RexWindow {
  window_id: string;
  focused_block_id?: string;
  layers: Array<{ kind: string; layout: RexLayoutNode }>;
}

function listWindows(): RexWindow[] {
  const out = JSON.parse(rexCli(["window", "ls", "--json"]));
  return out?.windows ?? [];
}

/** The window containing `blockId`, by walking every window's layout tree. */
function windowContaining(blockId: string): RexWindow | undefined {
  function contains(node: RexLayoutNode): boolean {
    if (node.block_id === blockId) return true;
    if (node.split) return contains(node.split.before) || contains(node.split.after);
    return false;
  }
  return listWindows().find((w) => w.layers.some((l) => contains(l.layout)));
}

// ── Agent lifecycle reporting (OSC 7501 via com.superlogical.terminal.write) ──

/**
 * Report a subagent's state to Rex the same way Pi's own interactive mode
 * does (ProgramStatusReporter, `dist/modes/interactive/interactive-mode.js`):
 * an OSC 7501 escape sequence written to the block. Rex's own
 * `com.superlogical.terminal.program_status` block method then surfaces it to
 * `rex block call <block> program_status`, the sidebar, and Moshi.
 *
 * Unlike herdr.ts's reportAgentState, this cannot report arbitrary mid-run
 * state changes — see reportAgentState's own doc comment below for why, and
 * sendLongCommand's oscReportLine for where start/finish ARE reported.
 */
const REX_PROGRAM_STATUS_APP = "pi-subagents";

/**
 * Known limitation, logged once per process rather than per call: live
 * `com.superlogical.terminal.write` testing against a real Rex session
 * (2026-11-14) showed it feeds the PTY's INPUT side ("as if typed" — the
 * Lua API docs' own words), which zsh's line editor then cooks as a
 * meta-key escape rather than passing through to the terminal's OSC
 * parser (confirmed: a raw OSC byte sequence sent this way showed up
 * mangled in a screen capture, and `program_status` stayed empty).
 * Rex has no out-of-band status-setting API (checked `rex api list`
 * and the Lua reference): OSC 7501 is strictly a read-only reflection of
 * real program *output*. The only safe emitter is therefore the launch
 * script itself, at the two boundaries nothing else can be mid-command in
 * the pane — see sendLongCommand's oscReportLine calls. Mid-run
 * working/blocked/idle transitions (status.ts's classifyStatus in
 * index.ts, which calls reportAgentState on every tick change) are not
 * mirrored on this backend: typing a `printf` into a pane that may be
 * mid-command would risk corrupting the subagent's own input, which is a
 * correctness hazard, not a cosmetic one, so this is a no-op rather than
 * a workaround.
 */
let loggedStatusLimitation = false;
function logStatusLimitationOnce(): void {
  if (loggedStatusLimitation) return;
  loggedStatusLimitation = true;
  if (process.env.PI_SUBAGENT_DEBUG) {
    // eslint-disable-next-line no-console
    console.error(
      "[pi-subagents/rex] mid-run agent-state mirroring is a no-op on the Rex backend " +
        "(no safe out-of-band status API); start/finish states are still reported by the " +
        "launch script itself. Set PI_SUBAGENT_DEBUG=0 to silence this.",
    );
  }
}

/**
 * No-op on this backend beyond the one-time debug note above — see the
 * limitation comment. herdr.ts's reportAgentState mirrors every tick change;
 * this cannot, safely, mid-run.
 */
export function reportAgentState(
  _surface: string,
  _name: string,
  _state: AgentReportState,
  _message?: string,
): void {
  logStatusLimitationOnce();
}

/** No-op on this backend — see reportAgentState's limitation comment. */
export function releaseAgentState(_surface: string, _name: string): void {
  logStatusLimitationOnce();
}

/** Tests only — matches herdr.ts's exported testing hook for symmetry. */
export function __forgetSubagentTab__(): void {
  subagentWindowId = null;
}

// ── Surface primitives ──
//
// MIN_COLS/MIN_ROWS live in herdr.ts's chooseSplit, which this module calls
// (via pickSplitTarget) instead of redefining them: one tiling-heuristic
// floor for both backends.

/** Blocks this extension created and where each one lives (mirrors herdr.ts's ownedSurfaces). */
const ownedSurfaces = new Map<string, SurfacePlacement>();

/** Label Rex shows on the dedicated subagent window, and how we recognize it. */
const SUBAGENT_WINDOW_LABEL = "subagents";

/**
 * The dedicated subagent window, once created. A window with no live blocks
 * is not auto-closed by Rex the way herdr auto-closes an empty tab, so
 * `windowAnchor()` below also checks the window still has at least one block
 * before reusing it.
 */
let subagentWindowId: string | null = null;

function findExistingSubagentWindow(): string | null {
  try {
    // SAFETY: `rex window ls --json` includes a `label` string per window
    // (observed on the installed Rex 0.1.0-preview CLI; confirmed again via
    // `rex api describe session.new_window`'s `window_label` field), but the
    // shared RexWindow type above only declares the fields this module reads
    // elsewhere (window_id, focused_block_id, layers) — label is read only
    // here, so it is cast in locally rather than widening the shared type.
    const windows = listWindows() as unknown as Array<RexWindow & { label?: string }>;
    const match = windows.find((w) => w.label === SUBAGENT_WINDOW_LABEL);
    return match?.window_id ?? null;
  } catch {
    return null;
  }
}

export function pruneOwned<T>(owned: Map<string, T>, live: Set<string>): void {
  for (const blockId of owned.keys()) {
    if (!live.has(blockId)) owned.delete(blockId);
  }
}

/** Every block id Rex currently has open, across every window in our session. */
function liveBlockIds(): Set<string> {
  const ids = new Set<string>();
  function walk(node: RexLayoutNode): void {
    if (node.block_id) ids.add(node.block_id);
    if (node.split) {
      walk(node.split.before);
      walk(node.split.after);
    }
  }
  try {
    for (const w of listWindows()) for (const l of w.layers) walk(l.layout);
  } catch {
    // fall through with whatever was collected
  }
  return ids;
}

/** A live block in the subagent window, or null when that window is gone or empty. */
function windowAnchor(): string | null {
  if (!subagentWindowId) subagentWindowId = findExistingSubagentWindow();
  if (!subagentWindowId) return null;
  const windows = listWindows();
  const window = windows.find((w) => w.window_id === subagentWindowId);
  if (!window) {
    subagentWindowId = null;
    return null;
  }
  return window.focused_block_id ?? null;
}

/** Create the dedicated subagent window. Returns its ready-to-use root block. */
function createSubagentWindow(cwd?: string): string {
  const args = ["window", "new", SUBAGENT_WINDOW_LABEL, "--focus=false", "--json"];
  if (cwd) args.push("-c", cwd);
  const out = rexCli(args);
  const created = JSON.parse(out);
  const blockId = created?.block_ids?.[0];
  if (typeof blockId !== "string" || blockId === "") {
    throw new Error(`Unexpected rex window new output: ${out}`);
  }
  subagentWindowId = created.window_id ?? null;
  // Prune ownedSurfaces so a reused window's leftover block from a prior run
  // (one this extension already closed, but Rex kept alive with no last
  // owner) is never mistaken for live inventory.
  pruneOwned(ownedSurfaces, liveBlockIds());
  return blockId;
}

export interface PaneRect {
  pane_id: string;
  width: number;
  height: number;
}

/** Block rects (normalized to a 1000x1000 grid so herdr.ts's chooseSplit, which compares pixel-shaped extents, keeps its "looks wide" heuristic meaningful) for the window containing `anchor`. */
function paneRects(anchor: string): PaneRect[] {
  const window = windowContaining(anchor);
  if (!window) return [];
  const rects: PaneRect[] = [];
  function walk(node: RexLayoutNode): void {
    if (node.block_id && node.rect) {
      const [, , w, h] = node.rect;
      rects.push({ pane_id: node.block_id, width: Math.round(w * 1000), height: Math.round(h * 1000) });
    }
    if (node.split) {
      walk(node.split.before);
      walk(node.split.after);
    }
  }
  for (const l of window.layers) walk(l.layout);
  return rects;
}

/**
 * Pick the block to split and the axis to split it on. Delegates to
 * herdr.ts's chooseSplit (pure, mux-agnostic) — the same "split the largest,
 * alternate axis, prefer a square-ish result" policy applies here unchanged.
 * Importing it keeps the tiling heuristic defined in exactly one place.
 *
 * Synchronous, matching herdr.ts's createSurface contract exactly: index.ts
 * calls createSurface() as a plain synchronous function (it predates any
 * async mux backend), so this module must not introduce a Promise into that
 * call chain. chooseSplit itself is pure/sync in herdr.ts; only the module
 * import is awaited elsewhere at load time, not per call — see the top of
 * this file.
 */
function pickSplitTarget(
  anchor: string,
  placement: SurfacePlacement,
): { pane: string; direction: "right" | "down" } {
  const candidates = paneRects(anchor).filter((p) => isOwned(p.pane_id, placement));
  return chooseSplit(candidates) ?? { pane: anchor, direction: "right" };
}

function isOwned(blockId: string, placement: SurfacePlacement): boolean {
  if (placement === "split" && blockId === process.env.REX_BLOCK) return true;
  return ownedSurfaces.get(blockId) === placement;
}

/**
 * Create a new block for a subagent. Never steals focus (`--focus=false`),
 * so blocks follow the agent rather than the user — same contract as
 * herdr.ts's createSurface, including the `split`/`tab` placement choice
 * (Rex calls its "tab" a "window"; the public SurfacePlacement type from
 * herdr.ts is reused unchanged so callers never see the difference).
 *
 * Returns the new block id (e.g. `block:01a1d94c-...`).
 */
export function createSurface(
  name: string,
  placement: SurfacePlacement = "split",
  cwd?: string,
): string {
  requireRex();

  let anchor: string | undefined;
  if (placement === "tab") {
    const existing = windowAnchor();
    if (!existing) {
      const root = createSubagentWindow(cwd);
      ownedSurfaces.set(root, placement);
      renameSurface(root, name);
      return root;
    }
    anchor = existing;
  } else {
    anchor = process.env.REX_BLOCK;
  }

  let target: { pane: string; direction: "right" | "down" };
  try {
    target = pickSplitTarget(anchor ?? "", placement);
  } catch {
    // Layout unavailable — split the anchor rather than fail the spawn, same
    // tolerance as herdr.ts's createSurface.
    target = { pane: anchor ?? "", direction: "right" };
  }

  const surface = createSurfaceSplit(name, target.direction, target.pane || anchor, cwd);
  ownedSurfaces.set(surface, placement);
  renameSurface(surface, name);
  return surface;
}

function renameSurface(surface: string, name: string): void {
  try {
    rexCli(["block", "rename", "-b", surface, name]);
  } catch {
    // Cosmetic; never fatal — same tolerance as herdr.ts's renameSurface.
  }
}

/**
 * Create a new split in the given direction from an optional source block.
 * Returns the new block id.
 *
 * Rex only splits `right`/`left`/`above`/`below` via `--split`, all four
 * directions are native (unlike herdr's right/down-only CLI), so no
 * collapsing is needed here.
 */
export function createSurfaceSplit(
  name: string,
  direction: "left" | "right" | "up" | "down",
  fromSurface?: string,
  cwd?: string,
): string {
  void name; // named after the split, via `block rename`.
  requireRex();

  const splitDirection = direction === "up" ? "above" : direction === "down" ? "below" : direction;
  const args = ["split", "--focus=false", "--split", splitDirection, "--json"];
  if (fromSurface) args.push("-b", fromSurface);
  if (cwd) args.push("-c", cwd);

  const out = rexCli(args);
  const parsed = JSON.parse(out);
  const blockId = parsed?.block_ids?.[0];
  if (typeof blockId !== "string" || blockId === "") {
    throw new Error(`Unexpected rex split output: ${out}`);
  }
  return blockId;
}

/** Send a command string to a block and execute it (text, then Enter). */
export function sendCommand(surface: string, command: string): void {
  requireRex();
  rexCli(["send", "-b", surface, command]);
  rexCli(["send-key", "-b", surface, "enter"]);
}

/**
 * Send a long command to a block by writing it to a script file first — same
 * rationale and same contract as herdr.ts's sendLongCommand (avoids
 * terminal line-wrapping issues at the pane's column width).
 */
export function sendLongCommand(
  surface: string,
  command: string,
  options?: { scriptPath?: string; scriptPreamble?: string; exec?: boolean; trailer?: string },
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
  // `exec: true` is the real subagent launch path (index.ts always sets it
  // for the actual pi command, never for ad-hoc one-off sends): the script
  // owns the pane for the subagent's whole run, so it is the one place this
  // backend can safely emit OSC 7501 itself, as its own real stdout, rather
  // than injecting bytes into a pane that may be mid-command (see
  // reportAgentState's doc comment for why that path was rejected).
  //
  // Placement matters: `done` must print BEFORE `options.trailer`
  // (exitTrailer's sentinel/sidecar/`sleep 2`), not after it — live-tested
  // against a real Rex session (2026-11-14): `exec bash <script>` closes the
  // block the instant the script's last line finishes, with no flush grace
  // period, so a report placed after the trailer's own `sleep 2` loses the
  // race to the pane closing and is never observed. Putting it right after
  // `command`, before the trailer, uses that same `sleep 2` as this report's
  // margin instead.
  //
  // `$?` must survive the printf: capture it immediately after `command`,
  // before the OSC line runs (which would otherwise clobber `$?` with
  // printf's own exit status), then restore it with `(exit "$RC")` so
  // `options.trailer` (which itself reads `$?` first, in exitTrailer) still
  // sees the subagent's real exit code, not 0 from this printf.
  if (options?.exec) {
    scriptParts.push(oscReportLine("working"));
    scriptParts.push(command);
    scriptParts.push(`__PI_REX_OSC_RC=$?`);
    scriptParts.push(oscReportLine("done"));
    scriptParts.push(`(exit "$__PI_REX_OSC_RC")`);
  } else {
    scriptParts.push(command);
  }
  if (options?.trailer) {
    scriptParts.push(options.trailer);
  }

  writeFileSync(scriptPath, scriptParts.join("\n") + "\n", { mode: 0o755 });
  const prefix = options?.exec ? "exec bash" : "bash";
  sendCommand(surface, `${prefix} ${shellEscape(scriptPath)}`);
  return scriptPath;
}

/** A shell `printf` line that emits one OSC 7501 report as the script's own stdout. */
function oscReportLine(state: "working" | "done"): string {
  return `printf '\\033]7501;state=${state}:app=${REX_PROGRAM_STATUS_APP}\\033\\\\'`;
}

/** Read the screen contents of a block (sync). `--unwrap` is Rex's `recent-unwrapped` equivalent. */
export function readScreen(surface: string, lines = 50): string {
  requireRex();
  const out = rexCli(["capture", "-b", surface, "--unwrap"]);
  const rows = out.split("\n");
  return rows.slice(Math.max(0, rows.length - lines)).join("\n");
}

/** Read the screen contents of a block (async). */
export async function readScreenAsync(surface: string, lines = 50): Promise<string> {
  requireRex();
  const out = await rexCliAsync(["capture", "-b", surface, "--unwrap"]);
  const rows = out.split("\n");
  return rows.slice(Math.max(0, rows.length - lines)).join("\n");
}

/**
 * True when something other than the bare shell is running in this block.
 * Mirrors herdr.ts's paneBusy exactly: compares the foreground process to the
 * block's own shell (its `child`), via `com.superlogical.terminal.process`.
 * Fails open on any error — same reasoning as herdr.ts.
 */
export function paneBusy(surface: string): boolean {
  try {
    const out = JSON.parse(rexCli(["block", "call", "-b", surface, "process"]));
    return isBusyProcessInfo(out);
  } catch {
    return false;
  }
}

/**
 * True when the foreground process is a direct child of `child` (the
 * terminal's own started process — `login` on macOS, the shell itself on
 * Linux), i.e. nothing is running "inside" that shell right now.
 *
 * `com.superlogical.terminal.process`'s own schema: "ancestors: the
 * processes between foreground and child... Left out when foreground is
 * child". So:
 *   - At a bare prompt before any command has ever run, `foreground` equals
 *     `child` outright (`ancestors` absent) — observed on a fresh Rex block:
 *     `child.pid === foreground.pid`, both the macOS `login` wrapper.
 *   - At a prompt after at least one command has run, the login wrapper has
 *     spawned the real shell, and `foreground` is that shell; `ancestors`
 *     holds exactly one entry, `child` itself (the wrapper) — observed:
 *     `ancestors: [{pid: child.pid, name: "login"}]`, `foreground.pid !==
 *     child.pid`.
 *   - While a command runs, `foreground` is that command, and `ancestors`
 *     holds the shell *and* the wrapper, nearest first — observed:
 *     `ancestors: [{name: "zsh"}, {name: "login"}]`.
 * The busy/idle line is therefore "is `ancestors` longer than the
 * (constant, one-entry-for-just-the-wrapper) idle shape": idle iff
 * `ancestors` is absent or has at most one entry. This avoids ever
 * comparing a pid against `child.pid` or a cached shell pid, because the
 * real shell's own pid is not stable across subagent runs in the same pane
 * on this backend (the plain-idle shape has no shell process at all yet).
 */
function isBusyProcessInfo(info: any): boolean {
  if (!info) return false;
  if (typeof info.foreground?.pid !== "number" || typeof info.child?.pid !== "number") return false;
  const ancestors = info.ancestors;
  if (!Array.isArray(ancestors)) return false; // absent => foreground is child => idle.
  return ancestors.length > 1;
}

/** Close a block. Idempotent: closing a block that is already gone succeeds. */
export function closeSurface(surface: string): void {
  requireRex();
  ownedSurfaces.delete(surface);
  try {
    rexCli(["block", "close", "-b", surface]);
  } catch {
    // Already gone — same tolerance as herdr.ts's closeSurface.
  }
}

// ── Exit polling (shares the sentinel/exit-sidecar contract with herdr.ts) ──

/**
 * Does `rex capture`/`rex send` failing on `surface` mean the block is gone?
 * Rex's CLI prints `Error: block <id> not found` (or similar) to stderr on a
 * missing target — verified against the installed CLI's own error text for
 * an unknown `-b` id.
 */
function isBlockGoneError(stderr: unknown, error: unknown): boolean {
  return /block.*not found|no such block/i.test(String(stderr ?? "") + String(error ?? ""));
}

/**
 * Watch a block for the exit sentinel. Rex has no server-side `wait-output`
 * matcher the way herdr does (`pane wait-output --regex`), so this polls
 * `rex capture` on an interval instead of blocking on one long-lived `rex`
 * process. Cost is bounded by the same `interval` pollForExit already uses
 * for its own loop, so no extra process-per-tick overhead beyond what
 * pollForExit already pays.
 */
function watchForSentinel(
  surface: string,
  id: string,
  intervalMs: number,
  signal: AbortSignal,
  onExit: (exitCode: number) => void,
  onGone: () => void,
): void {
  if (signal.aborted) return;

  const pattern = new RegExp(sentinelPatternSource(id), "g");
  const tick = async () => {
    if (signal.aborted) return;
    try {
      const out = await rexCliAsync(["capture", "-b", surface, "--unwrap", "--trim"]);
      const matches = [...out.matchAll(pattern)];
      const match = matches[matches.length - 1];
      if (match) {
        onExit(parseInt(match[1], 10));
        return;
      }
    } catch (error: any) {
      if (isBlockGoneError(error?.stderr, error?.message)) {
        onGone();
        return;
      }
      // Any other failure: Rex may have hiccuped. Keep polling.
    }
    const retry = setTimeout(tick, intervalMs);
    signal.addEventListener("abort", () => clearTimeout(retry), { once: true });
  };
  void tick();
}

function sentinelPatternSource(id: string): string {
  return `__SUBAGENT_DONE_${id}_(\\d+)__`;
}

export const __rexApiTest__ = { isBusyProcessInfo, isBlockGoneError, rexLayoutToNode };

/**
 * Poll until the subagent exits. Same contract and same `.exit` sidecar
 * protocol as herdr.ts's pollForExit (the launch script's exitTrailer is
 * mux-agnostic — see herdr.ts — so this reuses it verbatim); only the
 * sentinel-watch mechanism differs (polling vs. server-side `wait-output`).
 */
export async function pollForExit(
  surface: string,
  signal: AbortSignal,
  options: {
    interval: number;
    doneId: string;
    sessionFile?: string;
    childFinished?: () => boolean;
    maxMs?: number;
    onTick?: (elapsed: number) => void;
  },
): Promise<import("./herdr.ts").PollResult> {
  const start = Date.now();
  const maxMs = options.maxMs ?? 6 * 60 * 60 * 1000;

  const watch = new AbortController();
  const stopWatch = AbortSignal.any([signal, watch.signal]);
  let sentinelExitCode: number | null = null;
  let paneGoneAt: number | null = null;
  watchForSentinel(
    surface,
    options.doneId,
    options.interval,
    stopWatch,
    (code) => {
      sentinelExitCode = code;
    },
    () => {
      paneGoneAt = Date.now();
    },
  );

  try {
    for (;;) {
      if (signal.aborted) {
        throw new Error("Aborted while waiting for subagent to finish");
      }

      if (options.sessionFile) {
        try {
          const exitFile = `${options.sessionFile}.exit`;
                                        if (existsSync(exitFile)) {
                                                const data = JSON.parse(readFileSync(exitFile, "utf-8"));
                                                rmSync(exitFile, { force: true });
                                                return interpretExitSidecar(data);
                                        }
                                } catch {
                                        // Sidecar read/parse failed (missing, truncated mid-write, or not
                                        // valid JSON yet) — fall through to the sentinel watch below;
                                        // the next tick retries this fast path.
                                }
                        }

      if (sentinelExitCode !== null) {
        return { reason: "sentinel", exitCode: sentinelExitCode };
      }

      if (paneGoneAt !== null && Date.now() - paneGoneAt > 2 * options.interval) {
        let finished = false;
        try {
          finished = options.childFinished?.() === true;
        } catch {
          // A throwing childFinished() must not be mistaken for "not finished":
          // leave `finished` false and fall through to the error-path return
          // below, same as if the callback had answered false.
        }
        if (finished) return { reason: "done", exitCode: 0 };
        return {
          reason: "error",
          exitCode: 1,
          errorMessage: "Subagent block disappeared before it reported a result.",
        };
      }

      if (Date.now() - start > maxMs) {
        return {
          reason: "timeout",
          exitCode: 1,
          errorMessage: `Subagent still running after ${Math.round(maxMs / 60000)} minutes; giving up watching it.`,
        };
      }

      const elapsed = Math.floor((Date.now() - start) / 1000);
      try {
        options.onTick?.(elapsed);
      } catch {
        // Observation (status snapshot, pending-question check) must never be
        // able to terminate the poll loop it's observing — see herdr.ts's
        // pollForExit, which documents the same rule for its onTick.
      }

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

/** Same decoder contract as herdr.ts's interpretExitSidecar (duplicated, not imported, so each backend's test suite can exercise it against its own module boundary). */
function interpretExitSidecar(data: any): import("./herdr.ts").PollResult {
  if (data?.type === "error") {
    const errorMessage =
      typeof data.errorMessage === "string" && data.errorMessage.trim() !== ""
        ? data.errorMessage
        : "Subagent exited with stopReason=error (no errorMessage in sidecar).";
    return { reason: "error", exitCode: 1, errorMessage };
  }
  const exitCode = Number.isInteger(data?.exitCode) ? data.exitCode : 0;
  return { reason: "done", exitCode };
}
