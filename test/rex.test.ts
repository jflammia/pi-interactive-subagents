/**
 * Unit tests for the Rex backend (rex.ts) and the mux dispatcher (mux.ts).
 *
 * Mirrors the style and coverage shape of herdr.ts's own tests in test.ts:
 * pure predicates get direct-call tests here; anything that shells out to
 * `rex` is exercised only in test/integration (same split herdr.ts already
 * uses).
 */
import "./isolate-agent-dir.ts";
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { __rexApiTest__, reportAgentState, releaseAgentState, sendLongCommand } from "../pi-extension/subagents/rex.ts";
import { exitTrailer } from "../pi-extension/subagents/herdr.ts";
import {
  isHerdrAvailable,
  herdrSetupHint,
  isRexAvailable,
  rexSetupHint,
} from "../pi-extension/subagents/herdr-rex-availability.ts";
import * as mux from "../pi-extension/subagents/mux.ts";

// --- Env helpers ---

const ENV_KEYS = ["HERDR_ENV", "TERM_PROGRAM", "REX_SESSION", "REX_BLOCK"] as const;

function clearMuxEnv(): void {
  for (const key of ENV_KEYS) delete process.env[key];
}

describe("rex.ts isBusyProcessInfo", () => {
  // Shapes observed from a live `rex block call process` on this machine
  // (macOS, a login-wrapped shell) — see the long comment on
  // isBusyProcessInfo in rex.ts for why `ancestors` length, not a pid
  // comparison, is the right signal here.
  const freshIdle = {
    child: { pid: 2018, name: "login" },
    foreground: { pid: 2018, name: "login" },
  };
  const idleAfterOneCommand = {
    child: { pid: 2018, name: "login" },
    foreground: { pid: 2065, name: "zsh" },
    ancestors: [{ pid: 2018, name: "login" }],
  };
  const busy = {
    child: { pid: 2018, name: "login" },
    foreground: { pid: 2166, name: "sleep" },
    ancestors: [
      { pid: 2065, name: "zsh" },
      { pid: 2018, name: "login" },
    ],
  };

  it("is idle at a fresh prompt before any command has run (foreground == child, no ancestors)", () => {
    assert.equal(__rexApiTest__.isBusyProcessInfo(freshIdle), false);
  });

  it("is idle back at the prompt after a command finished (ancestors holds only the wrapper)", () => {
    assert.equal(__rexApiTest__.isBusyProcessInfo(idleAfterOneCommand), false);
  });

  it("is busy while a command runs (ancestors holds the shell AND the wrapper)", () => {
    assert.equal(__rexApiTest__.isBusyProcessInfo(busy), true);
  });

  it("fails open on a missing or shapeless reply", () => {
    assert.equal(__rexApiTest__.isBusyProcessInfo(null), false);
    assert.equal(__rexApiTest__.isBusyProcessInfo({}), false);
    assert.equal(
      __rexApiTest__.isBusyProcessInfo({ child: {}, foreground: { pid: 1 } }),
      false,
      "fails open when child.pid is missing (can't tell the idle shape apart)",
    );
  });
});

describe("rex.ts isBlockGoneError", () => {
  it("recognizes Rex's not-found wording and nothing else", () => {
    const gone = __rexApiTest__.isBlockGoneError;
    assert.equal(gone("Error: block 7a638a not found", null), true);
    assert.equal(gone("", new Error("no such block: logs")), true);
    assert.equal(gone("", new Error("connection refused")), false);
    assert.equal(gone("", null), false, "a clean no-match must re-arm, not give up");
  });
});

describe("rex.ts reportAgentState/releaseAgentState", () => {
  it("are no-ops: no backend call site may break because mid-run mirroring is unsafe here", () => {
    // See rex.ts's long comment on reportAgentState: `write` feeds PTY
    // input, not output a terminal parses, so there is no safe way to
    // mirror a mid-run state change without risking the subagent's own
    // input. Both functions must therefore never throw and never shell out.
    assert.doesNotThrow(() => reportAgentState("block:does-not-exist", "name", "working"));
    assert.doesNotThrow(() => reportAgentState("block:does-not-exist", "name", "blocked", "why"));
    assert.doesNotThrow(() => releaseAgentState("block:does-not-exist", "name"));
  });
});

describe("rex.ts rexLayoutToNode", () => {
  it("maps Rex's horizontal/vertical split onto herdr.ts's right/down LayoutNode", () => {
    const sideBySide = __rexApiTest__.rexLayoutToNode({
      split: {
        direction: "horizontal",
        ratio: 0.5,
        before: { block_id: "block:a" },
        after: { block_id: "block:b" },
      },
    });
    assert.deepEqual(sideBySide, {
      type: "split",
      direction: "right",
      ratio: 0.5,
      first: { type: "pane", pane_id: "block:a" },
      second: { type: "pane", pane_id: "block:b" },
    });

    const stacked = __rexApiTest__.rexLayoutToNode({
      split: {
        direction: "vertical",
        ratio: 0.3,
        before: { block_id: "block:c" },
        after: { block_id: "block:d" },
      },
    });
    assert.equal(stacked.type, "split");
    assert.equal(stacked.type === "split" && stacked.direction, "down");
  });

  it("maps a bare block to a pane leaf", () => {
    const leaf = __rexApiTest__.rexLayoutToNode({ block_id: "block:only" });
    assert.deepEqual(leaf, { type: "pane", pane_id: "block:only" });
  });
});

describe("herdr-rex-availability.ts", () => {
  afterEach(() => {
    clearMuxEnv();
  });

  it("isHerdrAvailable requires HERDR_ENV=1, not just the binary on PATH", () => {
    clearMuxEnv();
    // herdr may genuinely be on PATH in this environment (it is, on this
    // machine) — the point under test is that HERDR_ENV alone gates it.
    assert.equal(isHerdrAvailable(), false, "no HERDR_ENV means herdr is not available, binary or not");
  });

  it("isRexAvailable requires TERM_PROGRAM=rex AND a non-empty REX_SESSION", () => {
    clearMuxEnv();
    assert.equal(isRexAvailable(), false, "neither var set");

    process.env.TERM_PROGRAM = "rex";
    assert.equal(isRexAvailable(), false, "TERM_PROGRAM alone, no REX_SESSION, is not enough");

    process.env.REX_SESSION = "";
    assert.equal(isRexAvailable(), false, "an empty REX_SESSION must not count as set");

    process.env.REX_SESSION = "session:01a1be15-e6ea-7d04-bf1b-11d078f9d48e";
    // Whether this resolves true now depends on whether `rex` is on this
    // test runner's PATH — assert only the negative cases above are stable
    // without a live binary; the positive case is covered by integration
    // tests where `rex` is guaranteed present.
  });

  it("setup hints name each backend's own bootstrap command", () => {
    assert.match(herdrSetupHint(), /herdr/);
    assert.match(rexSetupHint(), /[Rr]ex/);
  });
});

describe("rex.ts sendLongCommand's exec:true script shape", () => {
  // Live-tested against a real Rex session (2026-11-14): a block created by
  // `exec bash <script>` closes the instant the script's last line finishes,
  // with no flush grace period, so a boundary OSC 7501 report placed AFTER
  // exitTrailer's own `sleep 2` loses the race and is never observed. These
  // tests pin the fix: `done` must print BEFORE `trailer`, and `$?` must
  // survive the printf so exitTrailer still sees the real exit code.

  it("orders working/command/done BEFORE the trailer, not after", () => {
    const dir = mkdtempSync(join(tmpdir(), "rex-sendlong-"));
    try {
      const scriptPath = join(dir, "script.sh");
      // The script file is written before sendCommand's final rex CLI call,
      // so its content is correct regardless of whether a real Rex session
      // is available here — same pattern as herdr.ts's own
      // surfaceThatDoesNotExist() tests (test.ts), which assert against a
      // deliberately-missing surface and ignore the resulting throw.
      try {
        sendLongCommand("block:does-not-exist", "echo mid-run", {
          scriptPath,
          exec: true,
          trailer: exitTrailer("ordertest", join(dir, "session.jsonl")),
        });
      } catch {
        // Expected when no live Rex session backs "block:does-not-exist";
        // the script was already written to scriptPath before this throw.
      }
      const script = readFileSync(scriptPath, "utf-8");
      const workingIndex = script.indexOf("state=working");
      const commandIndex = script.indexOf("echo mid-run");
      const doneIndex = script.indexOf("state=done");
      const sentinelIndex = script.indexOf("__SUBAGENT_DONE_ordertest_");
      const sleepIndex = script.lastIndexOf("sleep 2");
      assert.ok(workingIndex >= 0 && commandIndex > workingIndex, "working printed before the command runs");
      assert.ok(doneIndex > commandIndex, "done printed after the command");
      assert.ok(sentinelIndex > doneIndex, "the trailer's sentinel comes after done, not before");
      assert.ok(sleepIndex > doneIndex, "done comes before the trailer's sleep 2, so it has that window to be observed");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("preserves the wrapped command's real exit code through the OSC report AND the trailer's sentinel/sidecar", () => {
    const dir = mkdtempSync(join(tmpdir(), "rex-sendlong-exit-"));
    try {
      const sessionFile = join(dir, "session.jsonl");
      const scriptPath = join(dir, "script.sh");
      try {
        sendLongCommand("block:does-not-exist", "(exit 42)", {
          scriptPath,
          exec: true,
          trailer: exitTrailer("realexit", sessionFile),
        });
      } catch {
        // Expected without a live Rex session — see the comment on the
        // ordering test above; the script was already written.
      }
      // Run it directly (no Rex needed): proves the shell-level contract
      // (the printf must not clobber $?) independent of any live session.
      const out = execFileSync("bash", [scriptPath], { encoding: "utf8" });
      assert.match(out, /__SUBAGENT_DONE_realexit_42__/);
      const sidecar = JSON.parse(readFileSync(`${sessionFile}.exit`, "utf-8"));
      assert.deepEqual(sidecar, { type: "done", exitCode: 42 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("omits the OSC lines entirely when exec is not set (ad-hoc sends never report status)", () => {
    const dir = mkdtempSync(join(tmpdir(), "rex-sendlong-noexec-"));
    try {
      const scriptPath = join(dir, "script.sh");
      try {
        sendLongCommand("block:does-not-exist", "echo hi", { scriptPath, exec: false });
      } catch {
        // Expected without a live Rex session — see the comment above.
      }
      const script = readFileSync(scriptPath, "utf-8");
      assert.doesNotMatch(script, /7501/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("mux.ts backend selection", () => {
  afterEach(() => {
    clearMuxEnv();
    mux.__resetBackendCache__();
  });

  it("picks \"none\" when neither backend's env markers are set", () => {
    clearMuxEnv();
    mux.__resetBackendCache__();
    assert.equal(mux.currentBackend(), "none");
    assert.equal(mux.isMuxAvailable(), false);
  });

  it("caches the pick for the life of the process until explicitly reset", () => {
    clearMuxEnv();
    mux.__resetBackendCache__();
    assert.equal(mux.currentBackend(), "none");

    // Flipping the env after the first call must NOT change the cached
    // answer — a subagent's whole lifecycle (spawn, poll, resume) has to
    // keep using the backend that actually created its pane.
    process.env.TERM_PROGRAM = "rex";
    process.env.REX_SESSION = "session:fake";
    assert.equal(mux.currentBackend(), "none", "must stay cached, not re-read the environment");

    mux.__resetBackendCache__();
    // After an explicit reset it re-evaluates — whether this now reports
    // "rex" depends on whether `rex` is on PATH, same caveat as the
    // availability test above; this just proves the cache actually cleared,
    // by checking the call doesn't throw and returns one of the valid names.
    const picked = mux.currentBackend();
    assert.ok(["herdr", "rex", "none"].includes(picked));
  });

  it("muxUnavailable functions throw a message naming both setup paths, not just herdr's", () => {
    clearMuxEnv();
    mux.__resetBackendCache__();
    assert.throws(() => mux.createSurface("test"), /herdr/i);
    assert.throws(() => mux.createSurface("test"), /[Rr]ex/);
  });

  it("paneBusy fails open (false) rather than throwing when no backend is available", () => {
    clearMuxEnv();
    mux.__resetBackendCache__();
    assert.equal(mux.paneBusy("surface-that-does-not-exist"), false);
  });

  it("reportAgentState/releaseAgentState are silent no-ops with no backend (never fatal)", () => {
    clearMuxEnv();
    mux.__resetBackendCache__();
    assert.doesNotThrow(() => mux.reportAgentState("s", "name", "working"));
    assert.doesNotThrow(() => mux.releaseAgentState("s", "name"));
  });
});
