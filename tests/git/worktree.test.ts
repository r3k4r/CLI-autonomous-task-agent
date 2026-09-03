import { execa } from 'execa';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  agentrunOwnedPaths,
  branchExists,
  commitAll,
  createWorktree,
  currentBranch,
  hasChanges,
  listWorktrees,
  pruneStale,
  removeWorktree,
  worktreePathFor,
} from '../../src/git/worktree.js';
import {
  BranchExistsError,
  DirtyWorkingTreeError,
  NotARepositoryError,
} from '../../src/util/errors.js';
import { gitOutput, makeTempRepo } from '../helpers/repo.js';
import { makeTempDir, removeTempDir } from '../helpers/temp.js';

const dirs: string[] = [];

async function newRepo(baseBranch = 'main'): Promise<string> {
  const repo = await makeTempRepo(baseBranch);
  dirs.push(repo);
  return repo;
}

afterEach(() => {
  while (dirs.length > 0) removeTempDir(dirs.pop()!);
});

describe('guards', () => {
  it('refuses a directory that is not a git repository', async () => {
    const dir = makeTempDir();
    dirs.push(dir);
    await expect(createWorktree(dir, 'a', 'main')).rejects.toThrow(NotARepositoryError);
    await expect(listWorktrees(dir)).rejects.toThrow(NotARepositoryError);
  });

  it('refuses when a tracked file has uncommitted changes', async () => {
    const repo = await newRepo();
    // README.md is committed by the fixture, so editing it is real work at risk.
    await writeFile(join(repo, 'README.md'), '# edited but not committed\n', 'utf8');

    await expect(createWorktree(repo, 'a', 'main')).rejects.toThrow(DirtyWorkingTreeError);
    // No worktree should have been created.
    expect(existsSync(worktreePathFor(repo, 'a'))).toBe(false);
  });

  it('allows a modified note file, which agentrun writes itself', async () => {
    const repo = await newRepo();
    // Committing the note file is the normal thing to do.
    await writeFile(join(repo, 'tasks.md'), 'Do the thing\n', 'utf8');
    await execa('git', ['add', 'tasks.md'], { cwd: repo });
    await execa('git', ['commit', '-m', 'add tasks'], { cwd: repo });

    // Now edit it, as a user adding a task or as write-back does.
    await writeFile(join(repo, 'tasks.md'), 'Do the thing #done\nAnd another\n', 'utf8');

    await expect(createWorktree(repo, 'a', 'main', ['tasks.md'])).resolves.toMatchObject({
      branch: 'agent/a',
    });
  });

  it('still refuses when a tracked file other than the note file is dirty', async () => {
    const repo = await newRepo();
    await writeFile(join(repo, 'README.md'), '# real uncommitted work\n', 'utf8');

    await expect(createWorktree(repo, 'a', 'main', ['tasks.md'])).rejects.toThrow(
      DirtyWorkingTreeError,
    );
  });

  it('allows a modified, committed agentrun.config.json', async () => {
    const repo = await newRepo();
    await writeFile(join(repo, 'agentrun.config.json'), '{"parallel":1}', 'utf8');
    await execa('git', ['add', 'agentrun.config.json'], { cwd: repo });
    await execa('git', ['commit', '-m', 'add config'], { cwd: repo });

    await writeFile(join(repo, 'agentrun.config.json'), '{"parallel":4}', 'utf8');

    await expect(
      createWorktree(repo, 'a', 'main', agentrunOwnedPaths('tasks.md')),
    ).resolves.toMatchObject({ branch: 'agent/a' });
  });

  it('allows untracked files — they have no committed state to lose', async () => {
    const repo = await newRepo();
    // This is the state a fresh `agentrun init` leaves behind.
    await writeFile(join(repo, 'tasks.md'), 'Do the thing\n', 'utf8');
    await writeFile(join(repo, 'agentrun.config.json'), '{}', 'utf8');
    await writeFile(join(repo, '.gitignore'), '.agentrun/\n', 'utf8');

    await expect(createWorktree(repo, 'a', 'main')).resolves.toMatchObject({
      branch: 'agent/a',
    });
  });

  it('refuses when the agent branch already exists', async () => {
    const repo = await newRepo();
    await createWorktree(repo, 'a', 'main');

    await expect(createWorktree(repo, 'a', 'main')).rejects.toThrow(BranchExistsError);
  });

  it('never checks the agent branch out in the base working tree', async () => {
    const repo = await newRepo();
    await createWorktree(repo, 'a', 'main');

    expect(await currentBranch(repo)).toBe('main');
  });
});

describe('createWorktree', () => {
  it('creates a worktree on a new agent/<taskId> branch', async () => {
    const repo = await newRepo();
    const { path, branch } = await createWorktree(repo, 'login-page', 'main');

    expect(branch).toBe('agent/login-page');
    expect(path).toBe(worktreePathFor(repo, 'login-page'));
    expect(existsSync(path)).toBe(true);
    // The base commit came along.
    expect(existsSync(join(path, 'README.md'))).toBe(true);
    expect(await branchExists(repo, 'agent/login-page')).toBe(true);
  });

  it('puts worktrees under .agentrun/worktrees/<taskId>', async () => {
    const repo = await newRepo();
    const { path } = await createWorktree(repo, 'a', 'main');
    expect(path).toBe(join(repo, '.agentrun', 'worktrees', 'a'));
  });

  it('works with a base branch other than main', async () => {
    const repo = await newRepo('develop');
    const { path } = await createWorktree(repo, 'a', 'develop');
    expect(existsSync(path)).toBe(true);
  });
});

describe('isolation', () => {
  it('a file written in worktree A is invisible in worktree B and the base checkout', async () => {
    const repo = await newRepo();
    const a = await createWorktree(repo, 'a', 'main');
    const b = await createWorktree(repo, 'b', 'main');

    await writeFile(join(a.path, 'only-in-a.txt'), 'hello from a\n', 'utf8');

    expect(existsSync(join(a.path, 'only-in-a.txt'))).toBe(true);
    expect(existsSync(join(b.path, 'only-in-a.txt'))).toBe(false);
    expect(existsSync(join(repo, 'only-in-a.txt'))).toBe(false);
  });

  it('a commit in worktree A does not move the base branch', async () => {
    const repo = await newRepo();
    const a = await createWorktree(repo, 'a', 'main');
    const baseBefore = await gitOutput(repo, ['rev-parse', 'main']);

    await writeFile(join(a.path, 'file.txt'), 'work\n', 'utf8');
    await commitAll(a.path, 'agent commit');

    expect(await gitOutput(repo, ['rev-parse', 'main'])).toBe(baseBefore);
    expect(await gitOutput(repo, ['rev-parse', 'agent/a'])).not.toBe(baseBefore);
  });

  it('two agents editing the same filename do not collide', async () => {
    const repo = await newRepo();
    const a = await createWorktree(repo, 'a', 'main');
    const b = await createWorktree(repo, 'b', 'main');

    await writeFile(join(a.path, 'shared.txt'), 'from a\n', 'utf8');
    await writeFile(join(b.path, 'shared.txt'), 'from b\n', 'utf8');

    expect(await readFile(join(a.path, 'shared.txt'), 'utf8')).toBe('from a\n');
    expect(await readFile(join(b.path, 'shared.txt'), 'utf8')).toBe('from b\n');
  });
});

describe('hasChanges', () => {
  it('is false for a clean worktree and true once a tracked file changes', async () => {
    const repo = await newRepo();
    const { path } = await createWorktree(repo, 'a', 'main');

    expect(await hasChanges(path)).toBe(false);
    await writeFile(join(path, 'README.md'), '# changed\n', 'utf8');
    expect(await hasChanges(path)).toBe(true);
  });

  it('ignores untracked files', async () => {
    const repo = await newRepo();
    const { path } = await createWorktree(repo, 'a', 'main');

    await writeFile(join(path, 'brand-new.txt'), 'x\n', 'utf8');
    expect(await hasChanges(path)).toBe(false);
  });
});

describe('commitAll', () => {
  it('commits everything and reports that it did', async () => {
    const repo = await newRepo();
    const { path } = await createWorktree(repo, 'a', 'main');
    await writeFile(join(path, 'new.txt'), 'x\n', 'utf8');

    expect(await commitAll(path, 'agent: done')).toBe(true);
    expect(await hasChanges(path)).toBe(false);
    expect(await gitOutput(path, ['log', '-1', '--pretty=%s'])).toBe('agent: done');
  });

  it('returns false and makes no commit when nothing changed', async () => {
    const repo = await newRepo();
    const { path } = await createWorktree(repo, 'a', 'main');
    const before = await gitOutput(path, ['rev-parse', 'HEAD']);

    expect(await commitAll(path, 'nothing to do')).toBe(false);
    expect(await gitOutput(path, ['rev-parse', 'HEAD'])).toBe(before);
  });

  it('commits without relying on the developer git identity', async () => {
    const repo = await newRepo();
    const { path } = await createWorktree(repo, 'a', 'main');
    await writeFile(join(path, 'new.txt'), 'x\n', 'utf8');
    await commitAll(path, 'agent: done');

    expect(await gitOutput(path, ['log', '-1', '--pretty=%an'])).toBe('agentrun');
  });
});

describe('listWorktrees', () => {
  it('lists the base checkout plus each agent worktree', async () => {
    const repo = await newRepo();
    await createWorktree(repo, 'a', 'main');
    await createWorktree(repo, 'b', 'main');

    const branches = (await listWorktrees(repo)).map((w) => w.branch);
    expect(branches).toContain('main');
    expect(branches).toContain('agent/a');
    expect(branches).toContain('agent/b');
  });
});

describe('removeWorktree', () => {
  it('removes the worktree and deletes a branch with no commits', async () => {
    const repo = await newRepo();
    const { path } = await createWorktree(repo, 'a', 'main');

    await removeWorktree(repo, 'a', 'main');

    expect(existsSync(path)).toBe(false);
    expect(await branchExists(repo, 'agent/a')).toBe(false);
    expect((await listWorktrees(repo)).map((w) => w.branch)).not.toContain('agent/a');
  });

  it('keeps a branch that has commits — that is the agent work', async () => {
    const repo = await newRepo();
    const { path } = await createWorktree(repo, 'a', 'main');
    await writeFile(join(path, 'work.txt'), 'x\n', 'utf8');
    await commitAll(path, 'agent: real work');

    await removeWorktree(repo, 'a', 'main');

    expect(existsSync(path)).toBe(false);
    expect(await branchExists(repo, 'agent/a')).toBe(true);
  });

  it('is safe to call for a task that has no worktree', async () => {
    const repo = await newRepo();
    await expect(removeWorktree(repo, 'never-existed', 'main')).resolves.toBeUndefined();
  });

  it('leaves no stray worktrees or branches after a full cycle', async () => {
    const repo = await newRepo();
    for (const id of ['a', 'b', 'c']) await createWorktree(repo, id, 'main');
    for (const id of ['a', 'b', 'c']) await removeWorktree(repo, id, 'main');

    const worktrees = await listWorktrees(repo);
    expect(worktrees.filter((w) => w.branch.startsWith('agent/'))).toEqual([]);

    const branches = await gitOutput(repo, ['branch', '--list', 'agent/*']);
    expect(branches).toBe('');
  });
});

describe('pruneStale', () => {
  it('removes agent worktrees that are not part of the current run', async () => {
    const repo = await newRepo();
    await createWorktree(repo, 'keep-me', 'main');
    await createWorktree(repo, 'stale-one', 'main');

    const removed = await pruneStale(repo, ['keep-me']);

    expect(removed).toEqual(['stale-one']);
    expect(existsSync(worktreePathFor(repo, 'keep-me'))).toBe(true);
    expect(existsSync(worktreePathFor(repo, 'stale-one'))).toBe(false);
  });

  it('never touches the base checkout', async () => {
    const repo = await newRepo();
    await createWorktree(repo, 'a', 'main');

    await pruneStale(repo, []);

    expect(existsSync(join(repo, 'README.md'))).toBe(true);
    expect(await currentBranch(repo)).toBe('main');
  });

  it('removes everything when no task ids are active', async () => {
    const repo = await newRepo();
    await createWorktree(repo, 'a', 'main');
    await createWorktree(repo, 'b', 'main');

    const removed = await pruneStale(repo);
    expect(removed.sort()).toEqual(['a', 'b']);
  });
});
