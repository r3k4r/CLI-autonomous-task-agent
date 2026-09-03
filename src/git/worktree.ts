import { execa } from 'execa';
import { rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  BranchExistsError,
  DirtyWorkingTreeError,
  GitError,
  NotARepositoryError,
} from '../util/errors.js';
import { logger } from '../util/logger.js';

/**
 * Git worktree management. Calls `git` directly through execa — no wrapper
 * library, by design.
 *
 * Every agent gets its own checkout so two agents can never overwrite each
 * other, and so an agent never runs in the base branch's working tree.
 */

export interface WorktreeInfo {
  path: string;
  branch: string;
}

/** Agent branches are namespaced so `clean` can find them unambiguously. */
export const BRANCH_PREFIX = 'agent/';

export function branchNameFor(taskId: string): string {
  return `${BRANCH_PREFIX}${taskId}`;
}

export function worktreePathFor(repo: string, taskId: string): string {
  return join(repo, '.agentrun', 'worktrees', taskId);
}

interface GitRunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** Run a git command, returning the result rather than throwing on failure. */
async function tryGit(cwd: string, args: readonly string[]): Promise<GitRunResult> {
  logger.debug({ cwd, args }, 'git');
  const result = await execa('git', [...args], { cwd, reject: false, all: false });
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    exitCode: result.exitCode ?? 1,
  };
}

/** Run a git command, throwing a typed error if it fails. */
async function git(cwd: string, args: readonly string[]): Promise<string> {
  const result = await tryGit(cwd, args);
  if (result.exitCode !== 0) {
    throw new GitError(`git ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout;
}

/** Throw unless `repo` is the root of a git repository. */
export async function assertRepo(repo: string): Promise<void> {
  const result = await tryGit(repo, ['rev-parse', '--is-inside-work-tree']);
  if (result.exitCode !== 0 || result.stdout.trim() !== 'true') {
    throw new NotARepositoryError(repo);
  }
}

/**
 * True when the working tree has uncommitted changes to *tracked* files, other
 * than files agentrun owns.
 *
 * Two exclusions, both learned from running the tool for real:
 *
 * - Untracked files do not count. The guard exists to stop an agent branching
 *   from work that is not committed anywhere; an untracked file has no
 *   committed state to lose and `git worktree add` does not touch it. On a
 *   fresh `agentrun init` the note file, config and `.gitignore` are all
 *   untracked, and counting them made the documented first run impossible.
 *
 * - `ignore` names files agentrun writes itself. Once the note file is
 *   committed — which is the normal thing to do — agentrun's own write-back
 *   would otherwise block every subsequent run.
 */
/**
 * The paths agentrun writes itself, which must never count as the user's
 * uncommitted work. Pass the configured note file name, which is not fixed.
 */
export function agentrunOwnedPaths(noteFile: string): string[] {
  return [noteFile, 'agentrun.config.json', '.agentrun'];
}

export async function hasChanges(
  worktreePath: string,
  ignore: readonly string[] = [],
): Promise<boolean> {
  // -uno: modifications to tracked files only.
  const pathspecs = ['.', ...ignore.map((path) => `:(exclude)${path}`)];
  const stdout = await git(worktreePath, ['status', '--porcelain', '-uno', '--', ...pathspecs]);
  return stdout.trim() !== '';
}

export async function branchExists(repo: string, branch: string): Promise<boolean> {
  const result = await tryGit(repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]);
  return result.exitCode === 0;
}

/** Parse `git worktree list --porcelain` into paths and branches. */
export async function listWorktrees(repo: string): Promise<WorktreeInfo[]> {
  await assertRepo(repo);
  const stdout = await git(repo, ['worktree', 'list', '--porcelain']);

  const worktrees: WorktreeInfo[] = [];
  let path: string | undefined;

  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('worktree ')) {
      path = trimmed.slice('worktree '.length);
    } else if (trimmed.startsWith('branch ') && path !== undefined) {
      worktrees.push({ path, branch: trimmed.slice('branch refs/heads/'.length) });
      path = undefined;
    } else if (trimmed === '' && path !== undefined) {
      // A detached worktree has no branch line.
      worktrees.push({ path, branch: '' });
      path = undefined;
    }
  }
  if (path !== undefined) worktrees.push({ path, branch: '' });

  return worktrees;
}

/**
 * Create an isolated worktree for a task on a fresh `agent/<taskId>` branch.
 *
 * Guards, all of which throw typed errors:
 * - the path must be a git repository
 * - the base branch's working tree must be clean
 * - `agent/<taskId>` must not already exist
 */
export async function createWorktree(
  repo: string,
  taskId: string,
  baseBranch: string,
  ignore: readonly string[] = [],
): Promise<WorktreeInfo> {
  await assertRepo(repo);

  // A dirty base checkout means the agent would branch from a state that is
  // not committed anywhere — refuse rather than silently losing the work.
  if (await hasChanges(repo, ignore)) {
    throw new DirtyWorkingTreeError(repo);
  }

  const branch = branchNameFor(taskId);
  if (await branchExists(repo, branch)) {
    throw new BranchExistsError(branch);
  }

  const path = worktreePathFor(repo, taskId);
  await git(repo, ['worktree', 'add', path, '-b', branch, baseBranch]);

  return { path, branch };
}

/** True if the branch has commits the base branch does not. */
export async function hasCommits(
  repo: string,
  branch: string,
  baseBranch: string,
): Promise<boolean> {
  const result = await tryGit(repo, ['rev-list', '--count', `${baseBranch}..${branch}`]);
  if (result.exitCode !== 0) return false;
  return Number(result.stdout.trim()) > 0;
}

/**
 * Remove a task's worktree, and delete its branch when it holds no commits.
 * A branch with commits is kept — that is the agent's work.
 */
export async function removeWorktree(
  repo: string,
  taskId: string,
  baseBranch = 'main',
): Promise<void> {
  await assertRepo(repo);

  const path = worktreePathFor(repo, taskId);
  const branch = branchNameFor(taskId);

  const removal = await tryGit(repo, ['worktree', 'remove', '--force', path]);
  if (removal.exitCode !== 0) {
    // The directory may already be gone; drop the stale administrative entry
    // and clear the leftover directory ourselves.
    await tryGit(repo, ['worktree', 'prune']);
    await rm(path, { recursive: true, force: true });
  }

  if ((await branchExists(repo, branch)) && !(await hasCommits(repo, branch, baseBranch))) {
    await tryGit(repo, ['branch', '-D', branch]);
  }
}

/**
 * Stage everything in a worktree and commit. Returns false if nothing changed.
 *
 * NOTE: this checks the raw status rather than hasChanges — inside an agent's
 * worktree every change is the agent's work, and `add -A` would stage it
 * regardless, so an exclusion here would only make the "nothing changed" answer
 * disagree with what actually gets committed.
 */
export async function commitAll(worktreePath: string, message: string): Promise<boolean> {
  const status = await git(worktreePath, ['status', '--porcelain']);
  if (status.trim() === '') return false;

  await git(worktreePath, ['add', '-A']);
  // NOTE: -c overrides identity for this commit only, so agentrun works in a
  // repo where the agent has no configured git user.
  await git(worktreePath, [
    '-c',
    'user.name=agentrun',
    '-c',
    'user.email=agentrun@localhost',
    'commit',
    '-m',
    message,
  ]);
  return true;
}

/**
 * Prune stale worktree entries, then remove any `agent/*` worktree whose task
 * is not part of the current run.
 */
export async function pruneStale(
  repo: string,
  activeTaskIds: readonly string[] = [],
): Promise<string[]> {
  await assertRepo(repo);
  await git(repo, ['worktree', 'prune']);

  const keep = new Set(activeTaskIds.map((id) => resolve(worktreePathFor(repo, id))));
  const removed: string[] = [];

  for (const worktree of await listWorktrees(repo)) {
    if (!worktree.branch.startsWith(BRANCH_PREFIX)) continue;
    if (keep.has(resolve(worktree.path))) continue;

    const taskId = worktree.branch.slice(BRANCH_PREFIX.length);
    await removeWorktree(repo, taskId);
    removed.push(taskId);
  }

  return removed;
}

/** The branch currently checked out in the repo's own working tree. */
export async function currentBranch(repo: string): Promise<string> {
  await assertRepo(repo);
  return (await git(repo, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
}
