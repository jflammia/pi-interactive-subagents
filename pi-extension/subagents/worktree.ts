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
 *   3. `finishWorktree(path)` — commits whatever the subagent left behind,
 *      then removes the worktree directory but KEEPS the branch, so the work
 *      is recoverable. Called on subagent completion (or failure).
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
 * Finish a worktree: commit whatever the subagent left behind, drop the
 * worktree directory, and KEEP the branch.
 *
 * This used to `git worktree remove --force` + `git branch -D`, which deleted
 * every uncommitted edit the subagent had just made — worktree isolation
 * advertised "edit-safe" and then threw the edits away. Committing first means
 * the work survives on `pi-subagent/<name>-<id>`, which the parent can diff,
 * cherry-pick or merge.
 *
 * Safe to call on an already-removed or stale path (returns null).
 *
 * ponytail: keeps every subagent branch, including ones with no commits
 * (a branch ref is ~41 bytes). Add base-comparison work detection if
 * `git branch --list 'pi-subagent/*'` ever gets noisy.
 */
export function finishWorktree(worktreePath: string): { branch: string; commit?: string } | null {
  try {
    const branch = git(["rev-parse", "--abbrev-ref", "HEAD"], { cwd: worktreePath });

    // `git worktree remove` must run from the main repo, not from inside the
    // worktree being removed. `--git-common-dir` always points at the original
    // repo regardless of which worktree you ask from.
    const commonDir = git(["rev-parse", "--git-common-dir"], { cwd: worktreePath });
    const repoRoot = commonDir.replace(/\/\.git$/, "");

    let commit: string | undefined;
    if (git(["status", "--porcelain"], { cwd: worktreePath }) !== "") {
      git(["add", "-A"], { cwd: worktreePath });
      // No hooks, no signing: this is a machine-local save point in a cleanup
      // path with no TTY. A signing agent that wants a touch confirmation
      // would hang here and the work would be lost to `worktree remove`.
      // Whoever merges or cherry-picks the branch signs their own commit.
      git(
        [
          "-c", "commit.gpgsign=false",
          "commit", "--no-verify",
          "-m", `subagent work (${basename(worktreePath)})`,
        ],
        { cwd: worktreePath },
      );
      commit = git(["rev-parse", "HEAD"], { cwd: worktreePath });
    }

    git(["worktree", "remove", "--force", worktreePath], { cwd: repoRoot });
    return { branch, ...(commit ? { commit } : {}) };
  } catch {
    // Already removed, or path is stale. Cleanup is best-effort; a stale entry
    // can be cleared later with `git worktree prune`.
    return null;
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
