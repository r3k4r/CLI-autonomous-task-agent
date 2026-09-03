import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { mergeAll, mergeBranch } from '../../src/git/merge.js';
import { commitAll, createWorktree, removeWorktree } from '../../src/git/worktree.js';
import { DirtyWorkingTreeError, MergeConflictError } from '../../src/util/errors.js';
import { gitOutput, makeTempRepo } from '../helpers/repo.js';
import { removeTempDir } from '../helpers/temp.js';

const dirs: string[] = [];

async function newRepo(): Promise<string> {
  const repo = await makeTempRepo();
  dirs.push(repo);
  return repo;
}

afterEach(() => {
  while (dirs.length > 0) removeTempDir(dirs.pop()!);
});

/**
 * Read a file, normalising line endings.
 *
 * NOTE: git checks files out with native endings on Windows, so asserting on
 * raw bytes here would test the platform rather than the merge.
 */
async function readText(path: string): Promise<string> {
  return (await readFile(path, 'utf8')).replace(/\r\n/g, '\n');
}

/** Do a task's worth of work on its own agent branch. */
async function agentWork(
  repo: string,
  taskId: string,
  file: string,
  contents: string,
): Promise<void> {
  const { path } = await createWorktree(repo, taskId, 'main');
  await writeFile(join(path, file), contents, 'utf8');
  await commitAll(path, `agentrun: ${taskId}`);
  await removeWorktree(repo, taskId, 'main');
}

describe('mergeBranch', () => {
  it('merges an agent branch into the base branch', async () => {
    const repo = await newRepo();
    await agentWork(repo, 'a', 'a.txt', 'from a\n');

    const outcome = await mergeBranch(repo, 'a', 'main');

    expect(outcome.merged).toBe(true);
    expect(await readText(join(repo, 'a.txt'))).toBe('from a\n');
    expect(await gitOutput(repo, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('main');
  });

  it('reports a branch that does not exist rather than throwing', async () => {
    const repo = await newRepo();
    const outcome = await mergeBranch(repo, 'never-ran', 'main');

    expect(outcome.merged).toBe(false);
    expect(outcome.reason).toContain('does not exist');
  });

  it('refuses to merge into a dirty working tree', async () => {
    const repo = await newRepo();
    await agentWork(repo, 'a', 'a.txt', 'from a\n');
    await writeFile(join(repo, 'README.md'), '# uncommitted edit\n', 'utf8');

    await expect(mergeBranch(repo, 'a', 'main')).rejects.toThrow(DirtyWorkingTreeError);
  });

  it('merges two branches that touch different files', async () => {
    const repo = await newRepo();
    await agentWork(repo, 'a', 'a.txt', 'from a\n');
    await agentWork(repo, 'b', 'b.txt', 'from b\n');

    expect((await mergeBranch(repo, 'a', 'main')).merged).toBe(true);
    expect((await mergeBranch(repo, 'b', 'main')).merged).toBe(true);

    expect(await readText(join(repo, 'a.txt'))).toBe('from a\n');
    expect(await readText(join(repo, 'b.txt'))).toBe('from b\n');
  });
});

describe('conflicts', () => {
  it('aborts cleanly when two branches touch the same line', async () => {
    const repo = await newRepo();
    await agentWork(repo, 'a', 'shared.txt', 'version from a\n');
    await agentWork(repo, 'b', 'shared.txt', 'version from b\n');

    expect((await mergeBranch(repo, 'a', 'main')).merged).toBe(true);

    await expect(mergeBranch(repo, 'b', 'main')).rejects.toThrow(MergeConflictError);
  });

  it('leaves the base branch unconflicted after an aborted merge', async () => {
    const repo = await newRepo();
    await agentWork(repo, 'a', 'shared.txt', 'version from a\n');
    await agentWork(repo, 'b', 'shared.txt', 'version from b\n');

    await mergeBranch(repo, 'a', 'main');
    await expect(mergeBranch(repo, 'b', 'main')).rejects.toThrow(MergeConflictError);

    // No merge left in progress, no conflict markers, tree clean.
    const status = await gitOutput(repo, ['status', '--porcelain']);
    expect(status).toBe('');
    expect(await readText(join(repo, 'shared.txt'))).toBe('version from a\n');

    const mergeHead = await gitOutput(repo, [
      'rev-parse',
      '--verify',
      '--quiet',
      'MERGE_HEAD',
    ]).catch(() => '');
    expect(mergeHead).toBe('');
  });

  it('keeps the conflicting branch so the work is not lost', async () => {
    const repo = await newRepo();
    await agentWork(repo, 'a', 'shared.txt', 'version from a\n');
    await agentWork(repo, 'b', 'shared.txt', 'version from b\n');

    await mergeBranch(repo, 'a', 'main');
    await expect(mergeBranch(repo, 'b', 'main')).rejects.toThrow(MergeConflictError);

    expect(await gitOutput(repo, ['branch', '--list', 'agent/b'])).toContain('agent/b');
    expect(await gitOutput(repo, ['log', 'agent/b', '--pretty=%s', '-1'])).toContain('b');
  });
});

describe('mergeAll', () => {
  it('merges every branch in order', async () => {
    const repo = await newRepo();
    await agentWork(repo, 'a', 'a.txt', 'from a\n');
    await agentWork(repo, 'b', 'b.txt', 'from b\n');

    const report = await mergeAll(repo, ['a', 'b'], 'main');

    expect(report.merged.map((m) => m.taskId)).toEqual(['a', 'b']);
    expect(report.failed).toEqual([]);
    expect(report.unmerged).toEqual([]);
  });

  it('stops at the first conflict and reports what was not attempted', async () => {
    const repo = await newRepo();
    await agentWork(repo, 'a', 'shared.txt', 'from a\n');
    await agentWork(repo, 'b', 'shared.txt', 'from b\n');
    await agentWork(repo, 'c', 'c.txt', 'from c\n');

    const report = await mergeAll(repo, ['a', 'b', 'c'], 'main');

    expect(report.merged.map((m) => m.taskId)).toEqual(['a']);
    expect(report.failed.map((f) => f.taskId)).toEqual(['b']);
    expect(report.unmerged).toEqual(['agent/c']);
    // c was never touched, so its branch is intact.
    expect(await gitOutput(repo, ['branch', '--list', 'agent/c'])).toContain('agent/c');
  });

  it('rolls back a merge whose verification fails', async () => {
    const repo = await newRepo();
    await agentWork(repo, 'a', 'a.txt', 'from a\n');
    const before = await gitOutput(repo, ['rev-parse', 'main']);

    const report = await mergeAll(repo, ['a'], 'main', {
      verify: async () => ({ passed: false, output: 'tests failed after merge' }),
    });

    expect(report.merged).toEqual([]);
    expect(report.failed[0]?.reason).toContain('tests failed after merge');
    // The base branch is exactly where it started.
    expect(await gitOutput(repo, ['rev-parse', 'main'])).toBe(before);
  });

  it('keeps a merge whose verification passes', async () => {
    const repo = await newRepo();
    await agentWork(repo, 'a', 'a.txt', 'from a\n');

    const report = await mergeAll(repo, ['a'], 'main', {
      verify: async () => ({ passed: true, output: 'all good' }),
    });

    expect(report.merged.map((m) => m.taskId)).toEqual(['a']);
    expect(await readText(join(repo, 'a.txt'))).toBe('from a\n');
  });

  it('verifies after each merge, not just at the end', async () => {
    const repo = await newRepo();
    await agentWork(repo, 'a', 'a.txt', 'from a\n');
    await agentWork(repo, 'b', 'b.txt', 'from b\n');

    let calls = 0;
    await mergeAll(repo, ['a', 'b'], 'main', {
      verify: async () => {
        calls += 1;
        return { passed: true, output: '' };
      },
    });

    expect(calls).toBe(2);
  });

  it('handles an empty task list', async () => {
    const repo = await newRepo();
    const report = await mergeAll(repo, [], 'main');
    expect(report).toEqual({ merged: [], failed: [], unmerged: [] });
  });
});
