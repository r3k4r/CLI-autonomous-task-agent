import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Orchestrator, type Verifier } from '../../src/core/orchestrator.js';
import { Store } from '../../src/core/store.js';
import { MockProvider } from '../../src/providers/mock.js';
import { listWorktrees } from '../../src/git/worktree.js';
import { CyclicDependencyError } from '../../src/util/errors.js';
import { makeConfig } from '../helpers/fixtures.js';
import { gitOutput, makeTempRepo } from '../helpers/repo.js';
import { removeTempDir } from '../helpers/temp.js';

const dirs: string[] = [];
const stores: Store[] = [];

afterEach(() => {
  while (stores.length > 0) stores.pop()!.close();
  while (dirs.length > 0) removeTempDir(dirs.pop()!);
});

interface SetupOptions {
  notes: string;
  parallel?: number;
  maxAttempts?: number;
  failTasks?: string[];
  delayMs?: number;
  writeBack?: 'auto' | 'none';
  verify?: Verifier;
}

async function setup(options: SetupOptions): Promise<{
  repo: string;
  store: Store;
  orchestrator: Orchestrator;
  notePath: string;
}> {
  const repo = await makeTempRepo();
  dirs.push(repo);

  const notePath = join(repo, 'tasks.md');
  await writeFile(notePath, options.notes, 'utf8');

  const store = Store.open(repo);
  stores.push(store);

  const config = makeConfig({
    projectPath: repo,
    parallel: options.parallel ?? 1,
    maxAttempts: options.maxAttempts ?? 2,
    writeBack: options.writeBack ?? 'auto',
  });

  const provider = new MockProvider({
    delayMs: options.delayMs ?? 5,
    ...(options.failTasks ? { failTasks: options.failTasks } : {}),
  });

  const orchestrator = new Orchestrator(config, store, provider, {
    runId: 'test-run',
    ...(options.verify ? { verify: options.verify } : {}),
  });

  return { repo, store, orchestrator, notePath };
}

describe('parallelism', () => {
  it('runs five independent tasks and never exceeds the parallel limit', async () => {
    const { orchestrator } = await setup({
      notes: ['Task one', 'Task two', 'Task three', 'Task four', 'Task five'].join('\n'),
      parallel: 3,
      delayMs: 30,
    });

    let running = 0;
    let peak = 0;
    orchestrator.on('taskStart', () => {
      running += 1;
      peak = Math.max(peak, running);
    });
    orchestrator.on('taskEnd', () => {
      running -= 1;
    });

    const summary = await orchestrator.start();

    expect(summary.done).toHaveLength(5);
    expect(summary.ok).toBe(true);
    expect(peak).toBeLessThanOrEqual(3);
    expect(peak).toBeGreaterThan(1);
  });

  it('runs strictly in order when tasks form a chain', async () => {
    const { orchestrator } = await setup({
      notes: [
        'Build the thing #id:a',
        'Test the thing #id:b #needs:a',
        'Ship the thing #id:c #needs:b',
      ].join('\n'),
      parallel: 3,
    });

    const order: string[] = [];
    orchestrator.on('taskStart', (e) => order.push(e.task.id));

    const summary = await orchestrator.start();

    expect(order).toEqual(['a', 'b', 'c']);
    expect(summary.done).toEqual(['a', 'b', 'c']);
  });
});

describe('failure handling', () => {
  it('blocks a task whose dependency failed permanently', async () => {
    const { orchestrator, store } = await setup({
      notes: ['Build the thing #id:a', 'Test the thing #id:b #needs:a'].join('\n'),
      failTasks: ['a'],
      maxAttempts: 1,
    });

    const summary = await orchestrator.start();

    expect(summary.failed).toEqual(['a']);
    expect(summary.blocked).toEqual(['b']);
    expect(summary.ok).toBe(false);

    // b must never have started.
    expect(store.getTask('test-run', 'b')?.status).toBe('blocked');
    expect(store.getTask('test-run', 'b')?.attempts).toBe(0);
  });

  it('blocks the whole transitive chain behind a failure', async () => {
    const { orchestrator } = await setup({
      notes: [
        'Build the thing #id:a',
        'Test the thing #id:b #needs:a',
        'Ship the thing #id:c #needs:b',
      ].join('\n'),
      failTasks: ['a'],
      maxAttempts: 1,
    });

    const summary = await orchestrator.start();
    expect(summary.failed).toEqual(['a']);
    expect(summary.blocked.sort()).toEqual(['b', 'c']);
  });

  it('retries a failing task exactly maxAttempts times, then stops', async () => {
    const { orchestrator, store } = await setup({
      notes: 'Do the thing #id:a',
      failTasks: ['a'],
      maxAttempts: 3,
    });

    let starts = 0;
    orchestrator.on('taskStart', () => {
      starts += 1;
    });

    const summary = await orchestrator.start();

    expect(starts).toBe(3);
    expect(summary.failed).toEqual(['a']);
    expect(store.getTask('test-run', 'a')?.attempts).toBe(3);
  });

  it('passes the previous error into the retry', async () => {
    const { orchestrator, repo } = await setup({
      notes: 'Do the thing #id:a',
      failTasks: ['a'],
      maxAttempts: 2,
    });

    await orchestrator.start();

    const log = await readFile(join(repo, '.agentrun', 'logs', 'test-run', 'a.log'), 'utf8');
    expect(log).toContain('retrying after:');
  });

  it('does not block an unrelated task when another fails', async () => {
    const { orchestrator } = await setup({
      notes: [
        'Build the thing #id:a',
        'Test the thing #id:b #needs:a',
        'Something unrelated #id:c',
      ].join('\n'),
      failTasks: ['a'],
      maxAttempts: 1,
      parallel: 2,
    });

    const summary = await orchestrator.start();

    expect(summary.failed).toEqual(['a']);
    expect(summary.blocked).toEqual(['b']);
    expect(summary.done).toEqual(['c']);
  });

  it('fails a task whose agent succeeded but whose verification failed', async () => {
    const failingVerify: Verifier = async () => ({
      passed: false,
      output: 'tests failed: 3 assertions',
    });

    const { orchestrator, store } = await setup({
      notes: 'Do the thing #id:a',
      maxAttempts: 1,
      verify: failingVerify,
    });

    const summary = await orchestrator.start();

    expect(summary.done).toEqual([]);
    expect(summary.failed).toEqual(['a']);
    expect(store.getTask('test-run', 'a')?.error).toContain('verification failed');
  });
});

describe('cycles', () => {
  it('errors before any agent starts', async () => {
    const { orchestrator, repo } = await setup({
      notes: ['Build the thing #id:a #needs:b', 'Test the thing #id:b #needs:a'].join('\n'),
    });

    let started = false;
    orchestrator.on('taskStart', () => {
      started = true;
    });

    await expect(orchestrator.start()).rejects.toThrow(CyclicDependencyError);
    expect(started).toBe(false);
    // No worktree was created.
    expect(existsSync(join(repo, '.agentrun', 'worktrees'))).toBe(false);
  });
});

describe('skipped tasks', () => {
  it('never runs a #skip task and does not treat it as done', async () => {
    const { orchestrator } = await setup({
      notes: ['Do this one #id:a', 'Never do this #id:b #skip'].join('\n'),
    });

    const order: string[] = [];
    orchestrator.on('taskStart', (e) => order.push(e.task.id));

    const summary = await orchestrator.start();

    expect(order).toEqual(['a']);
    expect(summary.skipped).toEqual(['b']);
    expect(summary.done).toEqual(['a']);
  });
});

describe('stop', () => {
  it('cancels running agents and leaves no worktrees behind', async () => {
    const { orchestrator, repo, store } = await setup({
      notes: ['Build the thing #id:a', 'Test the thing #id:b'].join('\n'),
      parallel: 2,
      delayMs: 5000,
    });

    const runPromise = orchestrator.start();
    await new Promise((resolve) => setTimeout(resolve, 150));
    await orchestrator.stop();

    const summary = await runPromise;

    expect(summary.cancelled.length).toBeGreaterThan(0);
    expect(summary.done).toEqual([]);
    expect(store.getRun('test-run')?.status).toBe('stopped');

    // No leftover agent worktrees.
    const worktrees = await listWorktrees(repo);
    expect(worktrees.filter((w) => w.branch.startsWith('agent/'))).toEqual([]);
  });

  it('stops quickly rather than waiting out the agent delay', async () => {
    const { orchestrator } = await setup({
      notes: 'Slow task #id:a',
      delayMs: 10_000,
    });

    const started = Date.now();
    const runPromise = orchestrator.start();
    await new Promise((resolve) => setTimeout(resolve, 100));
    await orchestrator.stop();
    await runPromise;

    expect(Date.now() - started).toBeLessThan(5000);
  });
});

describe('note file write-back', () => {
  it('marks a completed checkbox and leaves every other line untouched', async () => {
    const notes = [
      '# My tasks',
      '',
      '- [ ] First task',
      '- [ ] Second task',
      '',
      '// a comment',
      '',
    ].join('\n');
    const { orchestrator, notePath } = await setup({ notes, parallel: 2 });

    await orchestrator.start();

    const after = await readFile(notePath, 'utf8');
    const beforeLines = notes.split('\n');
    const afterLines = after.split('\n');

    expect(afterLines[2]).toBe('- [x] First task');
    expect(afterLines[3]).toBe('- [x] Second task');
    for (const i of [0, 1, 4, 5, 6]) {
      expect(afterLines[i], `line ${i}`).toBe(beforeLines[i]);
    }
  });

  it('appends #done to plain lines', async () => {
    const { orchestrator, notePath } = await setup({ notes: 'Create a login page\n' });

    await orchestrator.start();

    expect(await readFile(notePath, 'utf8')).toBe('Create a login page #done\n');
  });

  it('leaves the file untouched when writeBack is none', async () => {
    const notes = '- [ ] First task\n';
    const { orchestrator, notePath } = await setup({ notes, writeBack: 'none' });

    const summary = await orchestrator.start();

    expect(summary.done).toHaveLength(1);
    expect(await readFile(notePath, 'utf8')).toBe(notes);
  });

  it('does not mark a failed task complete in the file', async () => {
    const notes = '- [ ] Will fail #id:a\n';
    const { orchestrator, notePath } = await setup({
      notes,
      failTasks: ['a'],
      maxAttempts: 1,
    });

    await orchestrator.start();

    expect(await readFile(notePath, 'utf8')).toBe(notes);
  });
});

describe('git integration', () => {
  it('commits the agent work onto the agent branch, not the base branch', async () => {
    const { orchestrator, repo } = await setup({ notes: 'Do the thing #id:a' });
    const baseBefore = await gitOutput(repo, ['rev-parse', 'main']);

    await orchestrator.start();

    expect(await gitOutput(repo, ['rev-parse', 'main'])).toBe(baseBefore);
    const branchLog = await gitOutput(repo, ['log', 'agent/a', '--pretty=%s', '-1']);
    expect(branchLog).toContain('agentrun');
  });

  it('removes the worktree but keeps the branch after a successful run', async () => {
    const { orchestrator, repo } = await setup({ notes: 'Do the thing #id:a' });

    await orchestrator.start();

    const worktrees = await listWorktrees(repo);
    expect(worktrees.filter((w) => w.branch === 'agent/a')).toEqual([]);
    expect(await gitOutput(repo, ['branch', '--list', 'agent/a'])).toContain('agent/a');
  });
});

describe('state and logs', () => {
  it('persists task state so another process can read it', async () => {
    const { orchestrator, repo } = await setup({ notes: 'Do the thing #id:a' });

    await orchestrator.start();

    // A separate handle, as `agentrun status` would use.
    const reader = Store.open(repo);
    stores.push(reader);
    expect(reader.getTask('test-run', 'a')?.status).toBe('done');
    expect(reader.getRun('test-run')?.status).toBe('finished');
  });

  it('writes a per-task log file under .agentrun/logs/<runId>/', async () => {
    const { orchestrator, repo } = await setup({ notes: 'Do the thing #id:a' });

    await orchestrator.start();

    const log = await readFile(join(repo, '.agentrun', 'logs', 'test-run', 'a.log'), 'utf8');
    expect(log).toContain('starting task a');
  });

  it('emits taskLog events as the agent produces output', async () => {
    const { orchestrator } = await setup({ notes: 'Do the thing #id:a' });

    const chunks: string[] = [];
    orchestrator.on('taskLog', (e) => chunks.push(e.chunk));

    await orchestrator.start();

    expect(chunks.join('')).toContain('starting task a');
  });

  it('emits runEnd with the final summary', async () => {
    const { orchestrator } = await setup({ notes: 'Do the thing #id:a' });

    let summary: { done: string[] } | undefined;
    orchestrator.on('runEnd', (e) => {
      summary = e;
    });

    await orchestrator.start();
    expect(summary?.done).toEqual(['a']);
  });

  it('passes task details through to the agent', async () => {
    const { orchestrator, repo } = await setup({
      notes: [
        'Create a login page #id:a',
        '  use the Button component',
        '  redirect to /dashboard',
      ].join('\n'),
    });

    await orchestrator.start();

    const log = await readFile(join(repo, '.agentrun', 'logs', 'test-run', 'a.log'), 'utf8');
    expect(log).toContain('use the Button component');
    expect(log).toContain('redirect to /dashboard');
  });
});
