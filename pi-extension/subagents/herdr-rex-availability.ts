/**
 * Mux availability checks, shared by herdr.ts, rex.ts and mux.ts.
 *
 * Pulled out of herdr.ts so rex.ts and mux.ts can both read "is herdr
 * available" without rex.ts importing herdr.ts for anything beyond the
 * pure helpers it already reuses (chooseSplit, canonicalSubagentName,
 * shellEscape), and without mux.ts creating a herdr.ts <-> rex.ts cycle.
 */
import { execFileSync } from "node:child_process";

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

export function herdrSetupHint(): string {
  return "Start pi inside herdr (`herdr`, then run `pi` in a pane).";
}

/**
 * The selector the Rex CLI's `-s` flag takes for this process's session.
 *
 * `REX_SESSION` when Rex set it (0.1.0-preview.21 and earlier). Otherwise
 * `REX_BLOCK`: Rex 0.1.0-preview.23 stopped exporting `REX_SESSION`, and its
 * own guide says "a pane's full ID also names the session that holds it", so
 * `rex -s "$REX_BLOCK" ...` scopes to the same session (verified live against
 * preview.23, 2026-11-24). Undefined when neither is set.
 */
export function rexSessionSelector(): string | undefined {
  const session = process.env.REX_SESSION;
  if (typeof session === "string" && session !== "") return session;
  const block = process.env.REX_BLOCK;
  if (typeof block === "string" && block !== "") return block;
  return undefined;
}

/**
 * True when running inside a Rex block with a session selector and the `rex`
 * binary available. `TERM_PROGRAM=rex` plus `REX_SESSION` or `REX_BLOCK` are
 * what Rex sets in every block it creates (see rexSessionSelector for which
 * release sets which); neither marker alone is enough — a nested shell could
 * export a stale id from a parent that has since exited, so the CLI's own
 * presence is checked too.
 */
export function isRexAvailable(): boolean {
  return process.env.TERM_PROGRAM === "rex" && rexSessionSelector() !== undefined && hasCommand("rex");
}

export function rexSetupHint(): string {
  return "Run pi in a Rex block (`rex window new -- pi`), with REX_SESSION or REX_BLOCK set.";
}
