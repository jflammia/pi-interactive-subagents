/**
 * Git worktree isolation for parallel subagents.
 *
 * When an agent definition declares `worktree: true`, the subagent is launched
 * in a freshly-created git worktree on a dedicated branch. This lets parallel
 * `worker` agents edit files without colliding on the same working tree.
 *
 * Lifecycle:
 *   1. `createWorktree(cwd, name)` — runs `git worktree add` on a new branch
 *      derived from the current HEAD, returns the worktree path.
 *   2. The subagent is launched with `--cwd <worktree-path>`.
 *   3. `removeWorktree(path)` — runs `git worktree remove --force` + deletes
 *      the branch. Called on subagent completion (or failure).
 *
 * All git operations are synchronous (execFileSync) because they happen in the
 * spawn/cleanup paths, which are already synchronous-friendly. Failures are
 * thrown to the caller — a worktree failure should abort the spawn, not silently
 * fall back to a shared cwd (that would defeat the isolation guarantee).
 */
import { execFileSync } from "node:child_process";
import { basename } from "node:path";

function git(args: string[], opts: { cwd: string }): string {
  return execFileSync("git", args, {
    cwd: opts.cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

/**
 * Create a worktree at `<repo>/.pi/worktrees/<name>-<short-id>` on a new branch
 * `pi-subagent/<name>-<short-id>` off the current HEAD.
 *
 * The worktree path is inside `.pi/` so it is gitignored by convention and
 * doesn't clutter the repo root. The branch name is prefixed with `pi-subagent/`
 * so it's easy to identify and clean up later.
 *
 * Returns the absolute path to the new worktree.
 */
export function createWorktree(repoCwd: string, name: string): string {
  // Resolve the repo root so worktrees always land relative to the true root,
  // not a subdirectory the parent happened to be in.
  const repoRoot = git(["rev-parse", "--show-toplevel"], { cwd: repoCwd });

  const safeName = name
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[^a-z]+/, "")
    .replace(/-+$/, "")
    .slice(0, 40) || "subagent";

  const shortId = Math.random().toString(16).slice(2, 8);
  const branchName = `pi-subagent/${safeName}-${shortId}`;
  const worktreePath = `${repoRoot}/.pi/worktrees/${safeName}-${shortId}`;

  git(["worktree", "add", "-b", branchName, worktreePath, "HEAD"], { cwd: repoRoot });

  return worktreePath;
}

/**
 * Remove a worktree and its branch. Safe to call on an already-removed path
 * (returns silently). Uses `--force` because the subagent may have left
 * untracked files (build artifacts, node_modules, etc.).
 *
 * The branch is deleted with `-D` (force) because the work has already been
 * merged or handed off by the time cleanup runs — keeping the branch would
 * just accumulate.
 */
export function removeWorktree(worktreePath: string): void {
  try {
    // `git worktree remove` and `git branch -D` must run from the main repo
    // or another live worktree — not from inside the worktree being removed.
    // `git rev-parse --show-toplevel` from inside a worktree returns that
    // worktree's own path, which is gone after `worktree remove`. So we
    // resolve the main repo via `git common-dir` first, which always points
    // to the original repo regardless of which worktree you're in.
    const commonDir = git(["rev-parse", "--git-common-dir"], { cwd: worktreePath });
    const repoRoot = commonDir.replace(/\/\.git$/, "");

    git(["worktree", "remove", "--force", worktreePath], { cwd: repoRoot });

    // Best-effort branch cleanup. The branch name is derived from the
    // worktree directory name, so we can reconstruct it.
    const dirName = basename(worktreePath);
    const branchName = `pi-subagent/${dirName}`;
    try {
      git(["branch", "-D", branchName], { cwd: repoRoot });
    } catch {
      // Branch may already be gone or have a different name — not fatal.
    }
  } catch {
    // Worktree already removed, or path is stale. Not fatal — cleanup is
    // best-effort. A stale worktree entry can be cleaned later with
    // `git worktree prune`.
  }
}

/**
 * List all pi-subagent worktrees under a repo. Returns their paths.
 * Useful for a future `/subagents cleanup` command.
 */
export function listSubagentWorktrees(repoCwd: string): string[] {
  try {
    const repoRoot = git(["rev-parse", "--show-toplevel"], { cwd: repoCwd });
    const output = git(["worktree", "list", "--porcelain"], { cwd: repoRoot });
    const paths: string[] = [];
    for (const line of output.split("\n")) {
      if (line.startsWith("worktree ")) {
        const path = line.slice("worktree ".length);
        if (path.includes("/.pi/worktrees/")) paths.push(path);
      }
    }
    return paths;
  } catch {
    return [];
  }
}
