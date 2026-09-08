import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createWorktree, removeWorktree, listSubagentWorktrees } from "../pi-extension/subagents/worktree.ts";

function hasGit(): boolean {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

// Helper: create a temp git repo for testing.
function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-worktree-test-"));
  execFileSync("git", ["init"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir, stdio: "ignore" });
  writeFileSync(join(dir, "README.md"), "# test\n");
  execFileSync("git", ["add", "."], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "init"], { cwd: dir, stdio: "ignore" });
  return dir;
}

test("createWorktree creates a working tree on a new branch", { skip: !hasGit() }, () => {
  const repo = makeRepo();
  try {
    const wt = createWorktree(repo, "worker-1");
    assert.ok(existsSync(wt), "worktree path should exist");
    assert.ok(existsSync(join(wt, "README.md")), "worktree should have repo files");

    // The worktree should be on its own branch.
    const branch = execFileSync("git", ["branch", "--show-current"], { cwd: wt, encoding: "utf8" }).trim();
    assert.ok(branch.startsWith("pi-subagent/"), `branch should be pi-subagent/*, got: ${branch}`);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("removeWorktree deletes the worktree and branch", { skip: !hasGit() }, () => {
  const repo = makeRepo();
  try {
    const wt = createWorktree(repo, "worker-2");
    assert.ok(existsSync(wt));

    removeWorktree(wt);
    assert.ok(!existsSync(wt), "worktree path should be gone after removal");

    // The branch should be deleted too.
    const branches = execFileSync("git", ["branch", "--list", "pi-subagent/*"], {
      cwd: repo,
      encoding: "utf8",
    }).trim();
    assert.equal(branches, "", "no pi-subagent branches should remain");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("removeWorktree is safe on already-removed paths", { skip: !hasGit() }, () => {
  const repo = makeRepo();
  try {
    const wt = createWorktree(repo, "worker-3");
    removeWorktree(wt);
    // Calling again should not throw.
    removeWorktree(wt);
    removeWorktree("/nonexistent/path");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("createWorktree isolates file changes", { skip: !hasGit() }, () => {
  const repo = makeRepo();
  try {
    const wt = createWorktree(repo, "worker-4");

    // Edit a file in the worktree.
    writeFileSync(join(wt, "README.md"), "# changed in worktree\n");
    execFileSync("git", ["add", "."], { cwd: wt, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "edit"], { cwd: wt, stdio: "ignore" });

    // The original repo should still have the original content.
    const original = execFileSync("git", ["show", "HEAD:README.md"], { cwd: repo, encoding: "utf8" }).trim();
    assert.equal(original, "# test", "original repo should be unchanged");

    // The worktree's branch should have the edit.
    const changed = execFileSync("git", ["show", "HEAD:README.md"], { cwd: wt, encoding: "utf8" }).trim();
    assert.equal(changed, "# changed in worktree", "worktree should have the edit");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("listSubagentWorktrees returns pi-subagent worktrees", { skip: !hasGit() }, () => {
  const repo = makeRepo();
  try {
    const wt1 = createWorktree(repo, "worker-5");
    const wt2 = createWorktree(repo, "worker-6");

    const listed = listSubagentWorktrees(repo);
    assert.ok(listed.includes(wt1), "should list first worktree");
    assert.ok(listed.includes(wt2), "should list second worktree");
    assert.equal(listed.length, 2);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("listSubagentWorktrees returns empty array outside a git repo", () => {
  const tmp = mkdtempSync(join(tmpdir(), "pi-not-git-"));
  try {
    const listed = listSubagentWorktrees(tmp);
    assert.deepEqual(listed, []);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
