/**
 * Import this FIRST in any unit test file that loads the extension.
 *
 * The extension resolves agents, settings and tool extensions from
 * PI_CODING_AGENT_DIR (default ~/.pi/agent). Left alone, tests read whatever
 * the developer has installed there - a customised worker.md made the bundled
 * defaults assertions fail - and can create session dirs in it. Point the whole
 * test process at an empty throwaway dir instead. An inherited value is
 * deliberately overridden: the suite must behave the same on every machine.
 *
 * Tests that exercise user-level overrides build their own fixture dir
 * (withIsolatedAgentEnv in test.ts) and restore this one afterwards.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const agentDir = mkdtempSync(join(tmpdir(), "pi-subagents-agent-dir-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
// The extension reads the subagent identity at import time (resolveSubagentAllowlist). A suite run
// from inside a subagent pane inherits it and would see an empty allowlist: clear it so the suite
// behaves as a top-level session on every machine (adversary 2026-11-12).
for (const k of ["PI_SUBAGENT_ID", "PI_SUBAGENT_ALLOWED", "PI_SUBAGENT_AGENT", "PI_SUBAGENT_NAME"]) delete process.env[k];
process.on("exit", () => rmSync(agentDir, { recursive: true, force: true }));
