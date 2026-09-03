import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MockProvider } from '../../src/providers/mock.js';
import { getProvider, providerNames, registerProvider } from '../../src/providers/registry.js';
import type { AgentContext, Provider } from '../../src/providers/types.js';
import { UnknownProviderError } from '../../src/util/errors.js';
import { makeTask } from '../helpers/fixtures.js';
import { makeTempDir, removeTempDir } from '../helpers/temp.js';

const dirs: string[] = [];

function tempDir(): string {
  const dir = makeTempDir();
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  while (dirs.length > 0) removeTempDir(dirs.pop()!);
  delete process.env.MOCK_FAIL_TASKS;
});

interface ContextOptions {
  taskId?: string;
  details?: string[];
  worktreePath: string;
  signal?: AbortSignal;
  previousError?: string;
}

function makeContext(options: ContextOptions): { ctx: AgentContext; output: string[] } {
  const output: string[] = [];
  const task = makeTask(options.taskId ?? 'a', {
    title: 'Do the thing',
    details: options.details ?? [],
  });
  const ctx: AgentContext = {
    task,
    worktreePath: options.worktreePath,
    signal: options.signal ?? new AbortController().signal,
    onOutput: (chunk) => output.push(chunk),
  };
  if (options.previousError !== undefined) ctx.previousError = options.previousError;
  return { ctx, output };
}

describe('MockProvider', () => {
  it('succeeds and writes <taskId>.txt into the worktree', async () => {
    const dir = tempDir();
    const provider = new MockProvider({ delayMs: 0 });
    const { ctx } = makeContext({ worktreePath: dir, taskId: 'login' });

    const result = await provider.run(ctx);

    expect(result.success).toBe(true);
    expect(result.summary).toContain('login');
    expect(existsSync(join(dir, 'login.txt'))).toBe(true);
  });

  it('writes the task title and details into the file', async () => {
    const dir = tempDir();
    const provider = new MockProvider({ delayMs: 0 });
    const { ctx } = makeContext({
      worktreePath: dir,
      taskId: 'a',
      details: ['use the Button component', 'redirect to /dashboard'],
    });

    await provider.run(ctx);

    const contents = await readFile(join(dir, 'a.txt'), 'utf8');
    expect(contents).toContain('Do the thing');
    expect(contents).toContain('use the Button component');
  });

  it('streams output through onOutput, including details', async () => {
    const dir = tempDir();
    const provider = new MockProvider({ delayMs: 0 });
    const { ctx, output } = makeContext({
      worktreePath: dir,
      details: ['a detail line'],
    });

    await provider.run(ctx);

    const joined = output.join('');
    expect(joined).toContain('starting task a');
    expect(joined).toContain('a detail line');
    expect(joined).toContain('wrote a.txt');
  });

  it('reports the previous error when retrying', async () => {
    const dir = tempDir();
    const provider = new MockProvider({ delayMs: 0 });
    const { ctx, output } = makeContext({
      worktreePath: dir,
      previousError: 'tests failed last time',
    });

    await provider.run(ctx);

    expect(output.join('')).toContain('tests failed last time');
  });

  it('fails the tasks named in the failTasks option', async () => {
    const dir = tempDir();
    const provider = new MockProvider({ delayMs: 0, failTasks: ['a'] });
    const { ctx } = makeContext({ worktreePath: dir, taskId: 'a' });

    const result = await provider.run(ctx);

    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
    // A failed agent leaves no file behind.
    expect(existsSync(join(dir, 'a.txt'))).toBe(false);
  });

  it('fails the tasks named in MOCK_FAIL_TASKS', async () => {
    const dir = tempDir();
    process.env.MOCK_FAIL_TASKS = 'b, a';
    const provider = new MockProvider({ delayMs: 0 });

    const failed = await provider.run(makeContext({ worktreePath: dir, taskId: 'a' }).ctx);
    const passed = await provider.run(makeContext({ worktreePath: dir, taskId: 'c' }).ctx);

    expect(failed.success).toBe(false);
    expect(passed.success).toBe(true);
  });

  it('aborts promptly when the signal fires mid-run', async () => {
    const dir = tempDir();
    const controller = new AbortController();
    const provider = new MockProvider({ delayMs: 10_000 });
    const { ctx } = makeContext({ worktreePath: dir, signal: controller.signal });

    const started = Date.now();
    const promise = provider.run(ctx);
    controller.abort();
    const result = await promise;

    expect(result.success).toBe(false);
    expect(result.error).toBe('aborted');
    // Nowhere near the 10s delay.
    expect(Date.now() - started).toBeLessThan(2000);
    expect(existsSync(join(dir, 'a.txt'))).toBe(false);
  });

  it('returns immediately when the signal is already aborted', async () => {
    const dir = tempDir();
    const provider = new MockProvider({ delayMs: 10_000 });
    const { ctx } = makeContext({ worktreePath: dir, signal: AbortSignal.abort() });

    const result = await provider.run(ctx);
    expect(result.success).toBe(false);
    expect(result.error).toBe('aborted');
  });

  it('never makes a network call — it only touches the worktree', async () => {
    const dir = tempDir();
    const provider = new MockProvider({ delayMs: 0 });
    const result = await provider.run(makeContext({ worktreePath: dir }).ctx);
    expect(result.costUsd).toBe(0);
    expect(result.tokensUsed).toEqual({ input: 0, output: 0 });
  });
});

describe('provider registry', () => {
  it('resolves mock by name', async () => {
    const provider = await getProvider('mock');
    expect(provider.name).toBe('mock');
  });

  it('lists the registered provider names', () => {
    expect(providerNames()).toContain('mock');
  });

  it('throws a typed error naming the known providers', async () => {
    await expect(getProvider('gpt-9')).rejects.toThrow(UnknownProviderError);
    await expect(getProvider('gpt-9')).rejects.toThrow(/mock/);
  });

  it('accepts a newly registered provider', async () => {
    const fake: Provider = {
      name: 'fake',
      run: async () => ({ success: true, summary: 'ok' }),
    };
    registerProvider('fake', () => fake);

    expect(await getProvider('fake')).toBe(fake);
    expect(providerNames()).toContain('fake');
  });
});
