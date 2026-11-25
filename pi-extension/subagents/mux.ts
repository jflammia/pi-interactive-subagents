/**
 * Mux dispatcher — picks herdr.ts or rex.ts and re-exports the one function
 * surface index.ts (and the test suite) calls.
 *
 * index.ts never imports herdr.ts or rex.ts directly; it imports from here,
 * so adding a third backend later means adding one more module with the same
 * shape and one more branch below — no caller changes.
 *
 * Selection: real Rex, not herdr, wins when both would otherwise look
 * available (a Rex block that happens to inherit stale `HERDR_ENV`/pane env
 * vars from an ancestor shell, say) — see `pickBackend()`. Pi runs in
 * exactly one terminal at a time, so there is one right answer per process,
 * decided once at module load and cached: a subagent's whole lifecycle (spawn,
 * poll, resume) must use the same backend that created its pane, and
 * `process.env` does not change mid-process in a way that should flip it.
 */
import * as herdrBackend from "./herdr.ts";
import * as rexBackend from "./rex.ts";
import { isHerdrAvailable, isRexAvailable, herdrSetupHint, rexSetupHint } from "./herdr-rex-availability.ts";

export type { SurfacePlacement, AgentReportState, LayoutNode, PaneRect, PollResult } from "./herdr.ts";
export { evenSplitRatios, chooseSplit, pruneOwned, canonicalSubagentName, shellEscape, socketEndpoint, sentinelEcho, sentinelPattern, exitTrailer } from "./herdr.ts";

export type MuxBackendName = "herdr" | "rex" | "none";

/**
 * Decide once which backend this process uses. Rex is preferred when both
 * report available, because `REX_SESSION` or `REX_BLOCK` with `TERM_PROGRAM=rex` are Rex's own
 * unambiguous markers (set only by Rex itself on every block it creates),
 * while `HERDR_ENV=1` could in principle survive into a Rex block spawned
 * from a nested shell that still carries it. Memoized: see the module
 * comment above for why this must not be re-evaluated mid-process.
 */
function pickBackend(): MuxBackendName {
  if (isRexAvailable()) return "rex";
  if (isHerdrAvailable()) return "herdr";
  return "none";
}

let cachedBackend: MuxBackendName | undefined;

/** The backend this process will use. Resolved once; see pickBackend(). */
export function currentBackend(): MuxBackendName {
  if (cachedBackend === undefined) cachedBackend = pickBackend();
  return cachedBackend;
}

/** Tests only: force re-selection on the next currentBackend() call. */
export function __resetBackendCache__(): void {
  cachedBackend = undefined;
}

function backendModule() {
  const name = currentBackend();
  if (name === "rex") return rexBackend;
  if (name === "herdr") return herdrBackend;
  return undefined;
}

export function isMuxAvailable(): boolean {
  return currentBackend() !== "none";
}

export function muxSetupHint(): string {
  // Name both, so a user running neither sees both ways in, not just
  // whichever this file happened to check first.
  return `${herdrSetupHint()} Or: ${rexSetupHint()}`;
}

export function createSurface(name: string, placement?: import("./herdr.ts").SurfacePlacement, cwd?: string): string {
  const mod = backendModule();
  if (!mod) throw new Error(`Subagents require herdr or Rex. ${muxSetupHint()}`);
  return mod.createSurface(name, placement, cwd);
}

export function createSurfaceSplit(
  name: string,
  direction: "left" | "right" | "up" | "down",
  fromSurface?: string,
  cwd?: string,
): string {
  const mod = backendModule();
  if (!mod) throw new Error(`Subagents require herdr or Rex. ${muxSetupHint()}`);
  return mod.createSurfaceSplit(name, direction, fromSurface, cwd);
}

export function sendCommand(surface: string, command: string): void {
  const mod = backendModule();
  if (!mod) throw new Error(`Subagents require herdr or Rex. ${muxSetupHint()}`);
  mod.sendCommand(surface, command);
}

export function sendLongCommand(
  surface: string,
  command: string,
  options?: { scriptPath?: string; scriptPreamble?: string; exec?: boolean; trailer?: string },
): string {
  const mod = backendModule();
  if (!mod) throw new Error(`Subagents require herdr or Rex. ${muxSetupHint()}`);
  return mod.sendLongCommand(surface, command, options);
}

export function readScreen(surface: string, lines?: number): string {
  const mod = backendModule();
  if (!mod) throw new Error(`Subagents require herdr or Rex. ${muxSetupHint()}`);
  return mod.readScreen(surface, lines);
}

export async function readScreenAsync(surface: string, lines?: number): Promise<string> {
  const mod = backendModule();
  if (!mod) throw new Error(`Subagents require herdr or Rex. ${muxSetupHint()}`);
  return mod.readScreenAsync(surface, lines);
}

export function paneBusy(surface: string): boolean {
  const mod = backendModule();
  if (!mod) return false; // fails open, same as both backends' own paneBusy.
  return mod.paneBusy(surface);
}

export function closeSurface(surface: string): void {
  const mod = backendModule();
  if (!mod) throw new Error(`Subagents require herdr or Rex. ${muxSetupHint()}`);
  mod.closeSurface(surface);
}

export function reportAgentState(
  surface: string,
  name: string,
  state: import("./herdr.ts").AgentReportState,
  message?: string,
): void {
  const mod = backendModule();
  mod?.reportAgentState(surface, name, state, message); // best-effort in both backends; no mod is a silent no-op.
}

export function releaseAgentState(surface: string, name: string): void {
  const mod = backendModule();
  mod?.releaseAgentState(surface, name);
}

export function __forgetSubagentTab__(): void {
  herdrBackend.__forgetSubagentTab__();
  rexBackend.__forgetSubagentTab__();
}

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
  const mod = backendModule();
  if (!mod) throw new Error(`Subagents require herdr or Rex. ${muxSetupHint()}`);
  return mod.pollForExit(surface, signal, options);
}
