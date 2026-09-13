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
import { unlinkSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import * as subagentsModule from "../../pi-extension/subagents/index.ts";
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
  sentinelEcho,
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

      const id = "aa11bb22";
      sendLongCommand(surface, `(exit 7)\n${sentinelEcho(id)}`);
      const result = await pollForExit(surface, new AbortController().signal, {
        interval: 500,
        doneId: id,
      });

      assert.equal(result.reason, "sentinel");
      assert.equal(result.exitCode, 7);
    });

    it("ignores another run's sentinel", async () => {
      // The literal on screen belongs to a different subagent id, so this
      // watcher must stay deaf to it — an agent that prints, greps or echoes
      // some other run's marker cannot terminate this one.
      const surface = createTrackedSurface(env, "foreign-sentinel-probe");
      await sleep(1200);

      sendLongCommand(surface, `(exit 3)\n${sentinelEcho("ffffffff")}`);
      const ctrl = new AbortController();
      setTimeout(() => ctrl.abort(), 2500);
      await assert.rejects(() =>
        pollForExit(surface, ctrl.signal, { interval: 300, doneId: "aa11bb22" }),
      );
    });

    it("aborting a wait rejects and stops watching", async () => {
      const surface = createTrackedSurface(env, "abort-probe");
      await sleep(1000);
      const ctrl = new AbortController();
      setTimeout(() => ctrl.abort(), 800);
      await assert.rejects(() =>
        pollForExit(surface, ctrl.signal, { interval: 300, doneId: "abort01" }),
      );
    });

    /** A minimal ExtensionAPI host, enough to register and drive a tool. */
    function makeToolHost() {
      const registeredTools: any[] = [];
      return {
        registeredTools,
        api: {
          on() {},
          registerTool(t: any) {
            registeredTools.push(t);
          },
          registerCommand() {},
          registerMessageRenderer() {},
          registerShortcut() {},
          sendUserMessage() {},
          sendMessage() {},
          getAllTools() {
            return [];
          },
        } as any,
      };
    }

    /** Every pane id herdr currently has, across tabs. */
    function paneIds(): string[] {
      const out = execFileSync("herdr", ["pane", "list"], { encoding: "utf8" });
      return (JSON.parse(out)?.result?.panes ?? []).map((p: any) => p.pane_id);
    }

    it("closes the pane it opened when the spawn fails", async () => {
      // The `Unknown CLI runner` throw fires ~60 lines after createSurface, so
      // a bad `cli:` value used to leave an orphan pane with no owner —
      // nothing tracks it until the subagent reaches runningSubagents.
      const dir = mkdtempSync(join(tmpdir(), "pi-leak-"));
      const agentsDir = join(dir, ".pi", "agents");
      mkdirSync(agentsDir, { recursive: true });
      writeFileSync(
        join(agentsDir, "bad-cli-agent.md"),
        ["---", "name: bad-cli-agent", "cli: nope", "---", "", "body", ""].join("\n"),
      );

      const before = paneIds();
      const prevAgentDir = process.env.PI_CODING_AGENT_DIR;
      process.env.PI_CODING_AGENT_DIR = join(dir, ".pi");
      try {
        await assert.rejects(
          () =>
            (subagentsModule as any).__test__.launchSubagent(
              { agent: "bad-cli-agent", task: "irrelevant", name: "leakprobe" },
              {
                cwd: dir,
                sessionManager: {
                  getSessionFile: () => join(dir, "parent.jsonl"),
                  getSessionId: () => "leakprobe-session",
                  getSessionDir: () => dir,
                },
              },
            ),
          /Unknown CLI runner/,
        );
      } finally {
        if (prevAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
        else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
      }

      // Give herdr a moment to reap the closed pane.
      await sleep(800);
      const leaked = paneIds().filter((id) => !before.includes(id));
      // Close anything we leaked before asserting, so a failure doesn't
      // poison the rest of the run.
      for (const id of leaked) {
        try {
          closeSurface(id);
        } catch {}
      }
      rmSync(dir, { recursive: true, force: true });
      assert.deepEqual(leaked, [], "a failed spawn must not leave its pane behind");
    });

    /** Drive a real launchSubagent against a throwaway project dir. */
    async function launchWith(frontmatter: string[], name: string) {
      const dir = mkdtempSync(join(tmpdir(), "pi-guard-"));
      const agentsDir = join(dir, ".pi", "agents");
      mkdirSync(agentsDir, { recursive: true });
      writeFileSync(
        join(agentsDir, `${name}.md`),
        ["---", `name: ${name}`, ...frontmatter, "---", "", "body", ""].join("\n"),
      );
      const prev = process.env.PI_CODING_AGENT_DIR;
      process.env.PI_CODING_AGENT_DIR = join(dir, ".pi");
      try {
        return await (subagentsModule as any).__test__.launchSubagent(
          { agent: name, task: "irrelevant", name: `${name}-probe` },
          {
            cwd: dir,
            sessionManager: {
              getSessionFile: () => join(dir, "parent.jsonl"),
              getSessionId: () => "guard-session",
              getSessionDir: () => dir,
            },
          },
        );
      } finally {
        if (prev === undefined) delete process.env.PI_CODING_AGENT_DIR;
        else process.env.PI_CODING_AGENT_DIR = prev;
        rmSync(dir, { recursive: true, force: true });
      }
    }

    it("refuses cli: + tools: at the real spawn, before opening anything", async () => {
      // The guard is only useful if launchSubagent actually calls it.
      const before = paneIds();
      await assert.rejects(
        () => launchWith(["cli: claude", "tools: read, bash"], "cli-tools-agent"),
        /Refusing the spawn/,
      );
      await sleep(600);
      assert.deepEqual(
        paneIds().filter((id) => !before.includes(id)),
        [],
        "a refusal must happen before any pane exists",
      );
    });

    it("refuses a YAML block-list tools: at the real spawn", async () => {
      const before = paneIds();
      await assert.rejects(
        () => launchWith(["tools:", "  - read", "  - bash"], "block-tools-agent"),
        /YAML block list/,
      );
      await sleep(600);
      assert.deepEqual(paneIds().filter((id) => !before.includes(id)), []);
    });

    it("cleans up the worktree too when a spawn fails after creating one", async () => {
      // The pane and the worktree are both unowned until the subagent is
      // registered; a failure between must not strand either.
      const repo = mkdtempSync(join(tmpdir(), "pi-wt-leak-"));
      execFileSync("git", ["init", "-q"], { cwd: repo });
      execFileSync("git", ["config", "user.email", "t@t.com"], { cwd: repo });
      execFileSync("git", ["config", "user.name", "T"], { cwd: repo });
      execFileSync("git", ["config", "commit.gpgsign", "false"], { cwd: repo });
      writeFileSync(join(repo, "README.md"), "# t\n");
      execFileSync("git", ["add", "."], { cwd: repo });
      execFileSync("git", ["commit", "-qm", "init"], { cwd: repo });

      const agentsDir = join(repo, ".pi", "agents");
      mkdirSync(agentsDir, { recursive: true });
      writeFileSync(
        join(agentsDir, "wt-bad-cli.md"),
        ["---", "name: wt-bad-cli", "worktree: true", "cli: nope", "---", "", "body", ""].join("\n"),
      );

      const prev = process.env.PI_CODING_AGENT_DIR;
      process.env.PI_CODING_AGENT_DIR = join(repo, ".pi");
      try {
        await assert.rejects(
          () =>
            (subagentsModule as any).__test__.launchSubagent(
              { agent: "wt-bad-cli", task: "irrelevant", name: "wtleak" },
              {
                cwd: repo,
                sessionManager: {
                  getSessionFile: () => join(repo, "parent.jsonl"),
                  getSessionId: () => "wtleak-session",
                  getSessionDir: () => repo,
                },
              },
            ),
          /Unknown CLI runner/,
        );

        // The worktree directory must be gone, and its work preserved on a branch.
        const listed = execFileSync("git", ["worktree", "list", "--porcelain"], {
          cwd: repo,
          encoding: "utf8",
        });
        assert.equal(
          listed.includes("/.pi/worktrees/"),
          false,
          `a failed spawn must not strand its worktree: ${listed}`,
        );
        const branches = execFileSync("git", ["branch", "--list", "pi-subagent/*"], {
          cwd: repo,
          encoding: "utf8",
        }).trim();
        assert.notEqual(branches, "", "the branch must survive so nothing is lost");
      } finally {
        if (prev === undefined) delete process.env.PI_CODING_AGENT_DIR;
        else process.env.PI_CODING_AGENT_DIR = prev;
        rmSync(repo, { recursive: true, force: true });
      }
    });

    it("refuses to resume a sub-agent whose pane is still working", async () => {
      // The in-memory guard only sees children THIS process launched, so a
      // child that outlived its parent was invisible and resuming it started a
      // SECOND pi on the same session file. This drives the real tool handler
      // against a real busy pane.
      const dir = mkdtempSync(join(tmpdir(), "pi-resume-"));
      const busy = createTrackedSurface(env, "busy-probe");
      await sleep(1000);
      sendCommand(busy, "sleep 45");
      await sleep(1200);

      try {
        const sessionPath = join(dir, "orphan.jsonl");
        writeFileSync(sessionPath, JSON.stringify({ type: "session", id: "orphan-1" }) + "\n");
        writeFileSync(
          `${sessionPath}.loadout.json`,
          JSON.stringify({ agent: "scout", tools: "read", cwd: dir, model: null }),
        );

        // The registry the resume path reads, with the pane recorded.
        const artifactDir = join(dir, "artifacts", "resume-session");
        mkdirSync(artifactDir, { recursive: true });
        writeFileSync(
          join(artifactDir, "subagent-registry.json"),
          JSON.stringify({
            orphan: {
              sessionFile: sessionPath,
              sessionId: "orphan-1",
              surface: busy,
              herdrSession: process.env.HERDR_SESSION,
            },
          }),
        );

        const { api, registeredTools } = makeToolHost();
        (subagentsModule as any).default(api);
        const tool = registeredTools.find((t: any) => t.name === "subagent_message");
        assert.ok(tool, "subagent_message must be registered");

        const out = await tool.execute(
          "call-1",
          { name: "orphan", message: "status?" },
          undefined,
          undefined,
          {
            cwd: dir,
            sessionManager: {
              getSessionFile: () => join(dir, "parent.jsonl"),
              getSessionId: () => "resume-session",
              getSessionDir: () => dir,
            },
          },
        );

        const text = out?.content?.[0]?.text ?? "";
        assert.match(
          text,
          /still running in pane/i,
          `a busy pane must block the resume, got: ${text}`,
        );
      } finally {
        // Close it here rather than at suite teardown: a pane running `sleep`
        // shrinks every other pane in the session and makes the screen-read
        // tests flaky.
        closeSurface(busy);
        untrackSurface(env, busy);
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("honours a batch-level worktree override on an agent that never asked for one", async () => {
      // subagents_parallel({ worktree: true }) must isolate every task, even
      // agents whose own frontmatter says nothing about worktrees. The
      // override used to be computed and then dropped on the floor.
      const repo = mkdtempSync(join(tmpdir(), "pi-wt-override-"));
      execFileSync("git", ["init", "-q"], { cwd: repo });
      execFileSync("git", ["config", "user.email", "t@t.com"], { cwd: repo });
      execFileSync("git", ["config", "user.name", "T"], { cwd: repo });
      execFileSync("git", ["config", "commit.gpgsign", "false"], { cwd: repo });
      writeFileSync(join(repo, "README.md"), "# t\n");
      execFileSync("git", ["add", "."], { cwd: repo });
      execFileSync("git", ["commit", "-qm", "init"], { cwd: repo });

      const agentsDir = join(repo, ".pi", "agents");
      mkdirSync(agentsDir, { recursive: true });
      // No `worktree:` key at all — the override is the only thing that can
      // cause isolation here. `cli: nope` makes the spawn fail fast.
      writeFileSync(
        join(agentsDir, "plain-agent.md"),
        ["---", "name: plain-agent", "cli: nope", "---", "", "body", ""].join("\n"),
      );

      const prev = process.env.PI_CODING_AGENT_DIR;
      process.env.PI_CODING_AGENT_DIR = join(repo, ".pi");
      try {
        await assert.rejects(
          () =>
            (subagentsModule as any).__test__.launchSubagent(
              { agent: "plain-agent", task: "irrelevant", name: "override-probe" },
              {
                cwd: repo,
                sessionManager: {
                  getSessionFile: () => join(repo, "parent.jsonl"),
                  getSessionId: () => "override-session",
                  getSessionDir: () => repo,
                },
              },
              { worktree: true },
            ),
          /Unknown CLI runner/,
        );

        // The override really created (and then cleaned up) a worktree: the
        // branch is the evidence that survives.
        const branches = execFileSync("git", ["branch", "--list", "pi-subagent/*"], {
          cwd: repo,
          encoding: "utf8",
        }).trim();
        assert.notEqual(
          branches,
          "",
          "worktree: true on the batch must isolate an agent that never declared it",
        );
      } finally {
        if (prev === undefined) delete process.env.PI_CODING_AGENT_DIR;
        else process.env.PI_CODING_AGENT_DIR = prev;
        rmSync(repo, { recursive: true, force: true });
      }
    });

    it("reports a cli: claude child's own final message, not its screen", async () => {
      // The Stop hook's sentinel file is the only place the agent's real final
      // message lives. Falling back to the 200-line pane scrape hands the
      // orchestrator terminal noise and defeats output-schema validation.
      const dir = mkdtempSync(join(tmpdir(), "pi-claude-final-"));
      const surface = createTrackedSurface(env, "claude-final-probe");
      await sleep(900);

      try {
        const sentinelFile = join(dir, "sentinel");
        writeFileSync(sentinelFile, "  CLAUDE FINAL ANSWER\n");

        const running = {
          id: "claudefinal",
          name: "claude-final-probe",
          task: "whatever",
          surface,
          startTime: Date.now(),
          sessionFile: join(dir, "never.jsonl"),
          cli: "claude",
          sentinelFile,
          interactive: false,
          statusState: null as any,
        };

        const result = await (subagentsModule as any).__test__.watchSubagent(
          running,
          new AbortController().signal,
        );

        assert.equal(
          result.summary,
          "CLAUDE FINAL ANSWER",
          `the sentinel's contents are the result, got: ${JSON.stringify(result.summary)}`,
        );
      } finally {
        untrackSurface(env, surface);
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("leaves a timed-out sub-agent's pane open and its worktree alone", async () => {
      // A timeout means we stopped WATCHING, not that the agent stopped. If it
      // fell through to the completion path it would close the pane of an
      // agent that is still working and commit its half-done worktree.
      const dir = mkdtempSync(join(tmpdir(), "pi-timeout-"));
      const surface = createTrackedSurface(env, "timeout-probe");
      await sleep(1000);
      sendCommand(surface, "sleep 60");
      await sleep(800);

      const savedMax = process.env.PI_SUBAGENT_MAX_MS;
      process.env.PI_SUBAGENT_MAX_MS = "600";
      try {
        const running = {
          id: "timeoutprobe",
          name: "timeout-probe",
          task: "sleep",
          surface,
          startTime: Date.now(),
          sessionFile: join(dir, "never.jsonl"),
          interactive: false,
          statusState: null as any,
        };

        const result = await (subagentsModule as any).__test__.watchSubagent(
          running,
          new AbortController().signal,
        );

        assert.match(
          result.summary ?? "",
          /still running in its pane/i,
          `a timeout must say the agent is still alive, got: ${result.summary}`,
        );
        // The decisive part: the pane it was watching is untouched.
        assert.notEqual(
          tabOf(surface),
          null,
          "a timeout must NOT close the pane of an agent that is still working",
        );
      } finally {
        if (savedMax === undefined) delete process.env.PI_SUBAGENT_MAX_MS;
        else process.env.PI_SUBAGENT_MAX_MS = savedMax;
        // Same reason: do not leave a `sleep` pane squeezing the layout.
        closeSurface(surface);
        untrackSurface(env, surface);
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("stops watching a pane that has gone away, instead of re-arming forever", async () => {
      // `wait-output` on a vanished pane errors immediately; re-arming with no
      // liveness check forked one `herdr` process per second for the rest of
      // the session, and the subagent was never reported at all.
      const dir = mkdtempSync(join(tmpdir(), "pi-gone-"));
      try {
        const result = await pollForExit("w9:p99", new AbortController().signal, {
          interval: 300,
          doneId: "goneprobe",
          sessionFile: join(dir, "never.jsonl"),
          maxMs: 30_000,
        });
        assert.equal(result.reason, "error");
        assert.match(result.errorMessage ?? "", /pane disappeared/i);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
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
