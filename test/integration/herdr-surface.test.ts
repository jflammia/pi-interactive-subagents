/**
 * Integration tests for the herdr surface layer.
 *
 * These tests exercise real herdr operations: creating panes,
 * sending commands, reading screen output, and closing panes.
 * No LLM calls — fast and free.
 *
 * Run inside a herdr pane:
 *   npm run test:integration
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { unlinkSync } from "node:fs";
import { execFileSync } from "node:child_process";
import {
  getAvailableBackends,
  createTestEnv,
  cleanupTestEnv,
  createTrackedSurface,
  getFocusedSurface,
  reportAgentState,
  releaseAgentState,
  forgetSubagentTab,
  listTabs,
  tabOf,
  untrackSurface,
  sendCommand,
  sendLongCommand,
  readScreen,
  readScreenAsync,
  closeSurface,
  createSurface,
  pollForExit,
  sleep,
  uniqueId,
  trackTempFile,
  waitForFile,
  waitForScreen,
  type TestEnv,
} from "./harness.ts";

const backends = getAvailableBackends();
const FOCUS_TEST_SHELL_READY_DELAY_MS = Number(process.env.PI_SUBAGENT_SHELL_READY_DELAY_MS ?? "2500");

if (backends.length === 0) {
  console.log("⚠️  herdr is not available — skipping herdr-surface integration tests");
  console.log("   Run inside a herdr pane to enable these tests.");
}

for (const backend of backends) {
  describe(`herdr-surface [${backend}]`, { timeout: 60_000 }, () => {
    let env: TestEnv;

    before(() => {
      env = createTestEnv();
    });

    after(() => {
      cleanupTestEnv(env);
    });

    it("keeps focus on the active surface while creating and targeting subagent surfaces", async () => {
      const anchor = getFocusedSurface();
      assert.ok(anchor, "expected herdr to report a focused pane");

      const childA = createTrackedSurface(env, "focus-child-a");
      await sleep(FOCUS_TEST_SHELL_READY_DELAY_MS);
      assert.equal(getFocusedSurface(), anchor);

      const childB = createTrackedSurface(env, "focus-child-b");
      await sleep(FOCUS_TEST_SHELL_READY_DELAY_MS);
      assert.equal(getFocusedSurface(), anchor);

      const markerA = uniqueId();
      const markerB = uniqueId();
      sendCommand(childA, `echo "FOCUS_A_${markerA}"`);
      sendCommand(childB, `echo "FOCUS_B_${markerB}"`);

      await Promise.all([
        waitForScreen(childA, new RegExp(`FOCUS_A_${markerA}`), 20_000, 50),
        waitForScreen(childB, new RegExp(`FOCUS_B_${markerB}`), 20_000, 50),
      ]);
      assert.equal(getFocusedSurface(), anchor);
    });

    it("creates a surface, sends a command, reads output, and closes it", async () => {
      const surface = createTrackedSurface(env, "echo-test");
      await sleep(1000);

      const marker = uniqueId();
      sendCommand(surface, `echo "MARKER_${marker}"`);
      await sleep(1500);

      const screen = readScreen(surface, 50);
      assert.ok(
        screen.includes(`MARKER_${marker}`),
        `Expected screen to contain MARKER_${marker}. Got:\n${screen}`,
      );

      closeSurface(surface);
      untrackSurface(env, surface);
    });

    it("preserves shell special characters in echo output", async () => {
      const surface = createTrackedSurface(env, "escape-test");
      await sleep(1000);

      const marker = uniqueId();
      // Single-quoted string — $ and " are literal inside single quotes
      sendCommand(surface, `echo 'SPEC_${marker}_$HOME_"quotes"_done'`);
      await sleep(1500);

      const screen = readScreen(surface, 50);
      assert.ok(
        screen.includes(`SPEC_${marker}`),
        `Expected special-char output. Got:\n${screen}`,
      );
      // $ should be literal inside single quotes
      assert.ok(
        screen.includes("$HOME"),
        `Expected literal $HOME in output. Got:\n${screen}`,
      );
    });

    it("sends a long command via script file without truncation", async () => {
      const surface = createTrackedSurface(env, "long-cmd-test");
      await sleep(1000);

      const marker = uniqueId();
      const longValue = "X".repeat(500);
      const command = `echo "LONG_${marker}_${longValue}_END"`;

      sendLongCommand(surface, command);
      await sleep(2000);

      // 200 rows: unwrapping happens after the row limit, so a 500-char line
      // in a pane narrowed by the earlier tests needs plenty of rows to survive.
      const screen = readScreen(surface, 200);
      assert.ok(
        screen.includes(`LONG_${marker}`),
        `Expected long command output. Got:\n${screen.slice(0, 300)}...`,
      );
      assert.ok(
        screen.includes("_END"),
        `Expected full output (not truncated). Got:\n${screen.slice(-300)}`,
      );
    });

    it("reads screen asynchronously", async () => {
      const surface = createTrackedSurface(env, "async-read-test");
      await sleep(1000);

      const marker = uniqueId();
      sendCommand(surface, `echo "ASYNC_${marker}"`);
      await sleep(1500);

      const screen = await readScreenAsync(surface, 50);
      assert.ok(
        screen.includes(`ASYNC_${marker}`),
        `Async read should find marker. Got:\n${screen}`,
      );
    });

    it("manages multiple surfaces concurrently", async () => {
      const s1 = createTrackedSurface(env, "multi-1");
      const s2 = createTrackedSurface(env, "multi-2");
      await sleep(1500);

      const m1 = uniqueId();
      const m2 = uniqueId();
      sendCommand(s1, `echo "S1_${m1}"`);
      sendCommand(s2, `echo "S2_${m2}"`);
      await sleep(1500);

      const screen1 = readScreen(s1, 50);
      const screen2 = readScreen(s2, 50);

      assert.ok(screen1.includes(`S1_${m1}`), `Surface 1 missing marker. Got:\n${screen1}`);
      assert.ok(screen2.includes(`S2_${m2}`), `Surface 2 missing marker. Got:\n${screen2}`);
    });

    it("reports agent lifecycle state to herdr without a session reference", async () => {
      const surface = createTrackedSurface(env, "state-probe");
      await sleep(1000);
      const paneAgent = () =>
        JSON.parse(
          execFileSync("herdr", ["pane", "get", surface], {
            encoding: "utf8",
            stdio: ["ignore", "pipe", "pipe"],
          }),
        ).result.pane;

      reportAgentState(surface, "state-probe", "working", "scanning");
      await sleep(400);
      assert.equal(paneAgent().agent_status, "working");

      reportAgentState(surface, "state-probe", "idle");
      await sleep(400);
      assert.equal(paneAgent().agent_status, "idle");

      // The point of reporting from the parent: herdr never learns a session
      // it could relaunch unsandboxed after a restart.
      assert.equal(paneAgent().agent_session, undefined);

      releaseAgentState(surface, "state-probe");
    });

    it("adopts a leftover subagents tab instead of stacking duplicates", async () => {
      const subagentTabs = () =>
        JSON.parse(
          execFileSync("herdr", ["tab", "list"], {
            encoding: "utf8",
            stdio: ["ignore", "pipe", "pipe"],
          }),
        ).result.tabs.filter((t: any) => t.label === "subagents");

      const first = createTrackedSurface(env, "restart-1", "tab");
      await sleep(1200);
      assert.equal(subagentTabs().length, 1);

      // Quitting pi leaves the tab and its panes standing; a fresh run starts
      // with no module state and must find that tab rather than make another.
      forgetSubagentTab();
      const second = createTrackedSurface(env, "restart-2", "tab");
      await sleep(1200);
      const tabs = subagentTabs();
      assert.equal(tabs.length, 1, "still exactly one subagents tab");
      assert.equal(tabOf(second), tabOf(first), "the second run joined the first tab");

      // Leave no subagents tab behind: herdr drops it with its last pane, and
      // the next test asserts on how many tabs a spawn adds.
      closeSurface(first);
      untrackSurface(env, first);
      closeSurface(second);
      untrackSurface(env, second);
      await sleep(1000);
      assert.deepEqual(subagentTabs(), []);
    });

    it("detects the exit sentinel and its code", async () => {
      // pollForExit relies on herdr matching the sentinel server-side; nothing
      // reads the screen on a timer any more.
      const surface = createTrackedSurface(env, "exit-probe");
      await sleep(1200);

      sendLongCommand(surface, `(exit 7)\nprintf '__SUBAGENT_DONE_%s__\\n' "$?"`);
      const result = await pollForExit(surface, new AbortController().signal, { interval: 500 });

      assert.equal(result.reason, "sentinel");
      assert.equal(result.exitCode, 7);
    });

    it("aborting a wait rejects and stops watching", async () => {
      const surface = createTrackedSurface(env, "abort-probe");
      await sleep(1000);
      const ctrl = new AbortController();
      setTimeout(() => ctrl.abort(), 800);
      await assert.rejects(() => pollForExit(surface, ctrl.signal, { interval: 300 }));
    });

    it("opens the pane in the requested cwd", async () => {
      const surface = createSurface("cwd-probe", "split", "/usr/local");
      env.surfaces.push(surface);
      await sleep(1200);
      const pane = JSON.parse(
        execFileSync("herdr", ["pane", "get", surface], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        }),
      ).result.pane;
      assert.equal(pane.cwd, "/usr/local");
    });

    it("closing a surface that is already gone is not an error", async () => {
      // A user closing a subagent pane by hand used to throw out of the
      // completion path and lose the finished subagent's result.
      const surface = createTrackedSurface(env, "vanishing");
      await sleep(1000);
      execFileSync("herdr", ["pane", "close", surface], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      await sleep(500);

      assert.doesNotThrow(() => closeSurface(surface));
      untrackSurface(env, surface);
    });

    it("puts a tab-placed surface in its own tab and cleans the tab up", async () => {
      const before = listTabs();
      const first = createTrackedSurface(env, "tab-agent-1", "tab");
      const second = createTrackedSurface(env, "tab-agent-2", "tab");
      await sleep(1500);

      const subagentTab = tabOf(first);
      assert.ok(subagentTab, "expected the tab-placed surface to report a tab");
      assert.equal(tabOf(second), subagentTab, "both tab-placed surfaces share one tab");
      assert.notEqual(subagentTab, tabOf(process.env.HERDR_PANE_ID!), "and not pi's tab");
      assert.equal(listTabs().length, before.length + 1, "exactly one tab was added");

      // A real terminal, not just a rect.
      const marker = uniqueId();
      sendCommand(second, `echo "TAB_${marker}"`);
      await waitForScreen(second, new RegExp(`TAB_${marker}`), 20_000, 50);

      closeSurface(first);
      untrackSurface(env, first);
      closeSurface(second);
      untrackSurface(env, second);
      await sleep(1000);
      // herdr drops a tab as soon as its last pane closes.
      assert.deepEqual(listTabs(), before, "the subagent tab went away with its panes");
    });

    it("writes output to a file and verifies via surface", async () => {
      const surface = createTrackedSurface(env, "file-test");
      await sleep(1000);

      const marker = uniqueId();
      const filePath = `/tmp/pi-herdr-test-${marker}.txt`;

      sendCommand(surface, `echo "FILE_${marker}" > ${filePath} && echo "WRITTEN_${marker}"`);

      await waitForScreen(surface, new RegExp(`WRITTEN_${marker}`), 10_000, 50);
      const content = await waitForFile(filePath, 10_000, new RegExp(`FILE_${marker}`));
      assert.ok(content.includes(`FILE_${marker}`), `File content wrong. Got: ${content}`);

      // Clean up
      try {
        unlinkSync(filePath);
      } catch {}
    });
  });
}
