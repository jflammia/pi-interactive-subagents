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
 * True when running inside a Rex block with both the session id and the
 * `rex` binary available. `TERM_PROGRAM=rex` plus `REX_SESSION` are what Rex
 * sets in every block it creates (observed on the installed Rex
 * 0.1.0-preview CLI); neither alone is enough — a nested shell could export
 * a stale `REX_SESSION` from a parent that has since exited, so the CLI's
 * own presence is checked too.
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
