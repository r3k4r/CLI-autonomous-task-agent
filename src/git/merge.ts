import { execa } from 'execa';
import { MergeConflictError } from '../util/errors.js';
import { logger } from '../util/logger.js';
import { assertRepo, branchNameFor, hasChanges } from './worktree.js';
import { DirtyWorkingTreeError } from '../util/errors.js';

/**
 * Merging agent branches back into the base branch.
 *
 * One at a time, verifying after each. On conflict the merge is aborted, the
 * branch is kept and the task is reported failed — conflicts are never
 * auto-resolved, and the base branch is never left in a conflicted state.
 */

export interface MergeOutcome {
  taskId: string;
  branch: string;
  merged: boolean;
  reason?: string;
}

export interface MergeReport {
  merged: MergeOutcome[];
  failed: MergeOutcome[];
  /** Branches not attempted because an earlier merge failed. */
  unmerged: string[];
}

interface GitResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

async function git(cwd: string, args: readonly string[]): Promise<GitResult> {
  logger.debug({ cwd, args }, 'git merge');
  const result = await execa('git', [...args], { cwd, reject: false });
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    exitCode: result.exitCode ?? 1,
  };
}

/** True when a merge is currently in progress in this working tree. */
async function mergeInProgress(repo: string): Promise<boolean> {
  const result = await git(repo, ['rev-parse', '--verify', '--quiet', 'MERGE_HEAD']);
  return result.exitCode === 0;
}

/**
 * Merge one agent branch into the base branch.
 *
 * Aborts and throws on conflict, leaving the base branch exactly as it was.
 */
export async function mergeBranch(
  repo: string,
  taskId: string,
  baseBranch: string,
  ignore: readonly string[] = [],
): Promise<MergeOutcome> {
  await assertRepo(repo);

  const branch = branchNameFor(taskId);

  // Merging into a dirty tree risks the user's uncommitted work. The note file
  // is excluded — agentrun writes it itself as tasks complete.
  if (await hasChanges(repo, ignore)) {
    throw new DirtyWorkingTreeError(repo);
  }

  const exists = await git(repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]);
  if (exists.exitCode !== 0) {
    return { taskId, branch, merged: false, reason: `branch ${branch} does not exist` };
  }

  const checkout = await git(repo, ['checkout', baseBranch]);
  if (checkout.exitCode !== 0) {
    return {
      taskId,
      branch,
      merged: false,
      reason: `could not check out ${baseBranch}: ${checkout.stderr}`,
    };
  }

  // --no-ff keeps each agent's work identifiable in the history.
  const merge = await git(repo, ['merge', '--no-ff', '--no-edit', branch]);
  if (merge.exitCode === 0) {
    return { taskId, branch, merged: true };
  }

  // NEVER auto-resolve. Abort, keep the branch, and report.
  if (await mergeInProgress(repo)) {
    await git(repo, ['merge', '--abort']);
  }

  throw new MergeConflictError(branch, merge.stdout || merge.stderr);
}

export interface MergeOptions {
  /** Runs after each successful merge; returning false rolls that merge back. */
  verify?: () => Promise<{ passed: boolean; output: string }>;
  /** Paths agentrun owns, which never count as a dirty tree — the note file. */
  ignore?: readonly string[];
}

/**
 * Merge several agent branches, one at a time, verifying after each.
 *
 * Stops at the first failure and reports which branches remain unmerged, so a
 * broken merge never cascades into the rest.
 */
export async function mergeAll(
  repo: string,
  taskIds: readonly string[],
  baseBranch: string,
  options: MergeOptions = {},
): Promise<MergeReport> {
  const report: MergeReport = { merged: [], failed: [], unmerged: [] };

  for (const [index, taskId] of taskIds.entries()) {
    let outcome: MergeOutcome;

    try {
      outcome = await mergeBranch(repo, taskId, baseBranch, options.ignore ?? []);
    } catch (cause) {
      const reason = cause instanceof Error ? cause.message : String(cause);
      report.failed.push({ taskId, branch: branchNameFor(taskId), merged: false, reason });
      report.unmerged = taskIds.slice(index + 1).map(branchNameFor);
      return report;
    }

    if (!outcome.merged) {
      report.failed.push(outcome);
      report.unmerged = taskIds.slice(index + 1).map(branchNameFor);
      return report;
    }

    if (options.verify) {
      const verification = await options.verify();
      if (!verification.passed) {
        // The merge itself was clean, but the result does not work. Undo just
        // this merge so the base branch stays green.
        await git(repo, ['reset', '--hard', 'HEAD~1']);
        report.failed.push({
          taskId,
          branch: outcome.branch,
          merged: false,
          reason: `verification failed after merging: ${verification.output.slice(-500)}`,
        });
        report.unmerged = taskIds.slice(index + 1).map(branchNameFor);
        return report;
      }
    }

    report.merged.push(outcome);
  }

  return report;
}
