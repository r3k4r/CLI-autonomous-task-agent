import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentContext } from '../../src/providers/types.js';
import { makeTask } from '../helpers/fixtures.js';

/**
 * These tests never spawn a real agent — execa is mocked. That is the point:
 * the suite must cost nothing and make no network call.
 */

const execaMock = vi.hoisted(() => vi.fn());
vi.mock('execa', () => ({ execa: execaMock }));

const { ClaudeCodeProvider, buildArgs, buildEnv, buildPrompt } =
  await import('../../src/providers/claudeCode.js');

interface FakeResult {
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  timedOut?: boolean;
}

/** A stand-in for execa's child process promise. */
function fakeChild(result: FakeResult = {}): Promise<FakeResult> & {
  stdout: EventEmitter;
  stderr: EventEmitter;
} {
  const promise = Promise.resolve({
    exitCode: 0,
    stdout: 'done',
    stderr: '',
    timedOut: false,
    ...result,
  });
  return Object.assign(promise, { stdout: new EventEmitter(), stderr: new EventEmitter() });
}

function makeContext(overrides: Partial<AgentContext> = {}): AgentContext {
  return {
    task: makeTask('a', { title: 'Create a login page' }),
    worktreePath: '/tmp/worktree',
    signal: new AbortController().signal,
    onOutput: () => {},
    ...overrides,
  };
}

/** The env passed to the most recent execa call. */
function lastEnv(): NodeJS.ProcessEnv {
  const call = execaMock.mock.calls.at(-1);
  return (call?.[2] as { env: NodeJS.ProcessEnv }).env;
}

beforeEach(() => {
  execaMock.mockReset();
  execaMock.mockReturnValue(fakeChild());
});

afterEach(() => {
  delete process.env.ANTHROPIC_API_KEY;
});

describe('billing safety', () => {
  it('strips ANTHROPIC_API_KEY from the child env by default', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-secret';

    await new ClaudeCodeProvider().run(makeContext());

    expect(lastEnv().ANTHROPIC_API_KEY).toBeUndefined();
  });

  it('strips it when billing is explicitly subscription', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-secret';

    await new ClaudeCodeProvider({ billing: 'subscription' }).run(makeContext());

    expect(lastEnv().ANTHROPIC_API_KEY).toBeUndefined();
  });

  it("keeps it only when billing is explicitly 'api'", async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-secret';

    await new ClaudeCodeProvider({ billing: 'api' }).run(makeContext());

    expect(lastEnv().ANTHROPIC_API_KEY).toBe('sk-ant-secret');
  });

  it('leaves the rest of the environment intact', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-secret';

    await new ClaudeCodeProvider().run(makeContext());

    // The agent still needs PATH and the like.
    expect(lastEnv().PATH ?? lastEnv().Path).toBeDefined();
  });

  it('does not mutate the parent process environment', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-secret';

    await new ClaudeCodeProvider().run(makeContext());

    expect(process.env.ANTHROPIC_API_KEY).toBe('sk-ant-secret');
  });
});

describe('buildEnv', () => {
  it('removes the key for subscription billing', () => {
    expect(buildEnv({ ANTHROPIC_API_KEY: 'k', OTHER: 'v' }, 'subscription')).toEqual({
      OTHER: 'v',
    });
  });

  it('keeps the key for api billing', () => {
    expect(buildEnv({ ANTHROPIC_API_KEY: 'k' }, 'api')).toEqual({ ANTHROPIC_API_KEY: 'k' });
  });

  it('is harmless when no key is set', () => {
    expect(buildEnv({ OTHER: 'v' }, 'subscription')).toEqual({ OTHER: 'v' });
  });
});

describe('buildPrompt', () => {
  it('includes the task title', () => {
    expect(buildPrompt(makeContext())).toContain('Create a login page');
  });

  it('includes every detail line', () => {
    const ctx = makeContext({
      task: makeTask('a', {
        title: 'Create a login page',
        details: ['use the existing Button component', 'redirect to /dashboard on success'],
      }),
    });

    const prompt = buildPrompt(ctx);

    expect(prompt).toContain('use the existing Button component');
    expect(prompt).toContain('redirect to /dashboard on success');
  });

  it('includes the previous error when retrying', () => {
    const prompt = buildPrompt(makeContext({ previousError: 'the auth test still fails' }));
    expect(prompt).toContain('the auth test still fails');
  });

  it('omits the retry section on a first attempt', () => {
    expect(buildPrompt(makeContext())).not.toContain('previous attempt');
  });

  it('reaches the agent as the process input', async () => {
    const ctx = makeContext({
      task: makeTask('a', { title: 'Do the thing', details: ['a specific constraint'] }),
    });

    await new ClaudeCodeProvider().run(ctx);

    const options = execaMock.mock.calls.at(-1)?.[2] as { input: string };
    expect(options.input).toContain('Do the thing');
    expect(options.input).toContain('a specific constraint');
  });
});

describe('buildArgs', () => {
  it('runs headless', () => {
    expect(buildArgs(undefined)).toContain('--print');
  });

  it('passes a model when one is given', () => {
    expect(buildArgs('opus').join(' ')).toContain('--model opus');
  });

  it('omits --model when none is given', () => {
    expect(buildArgs(undefined)).not.toContain('--model');
  });
});

describe('spawning', () => {
  it('runs claude in the task worktree', async () => {
    await new ClaudeCodeProvider().run(makeContext({ worktreePath: '/tmp/wt-a' }));

    const [command, , options] = execaMock.mock.calls.at(-1)!;
    expect(command).toBe('claude');
    expect((options as { cwd: string }).cwd).toBe('/tmp/wt-a');
  });

  it('uses the model from the task when the context has none', async () => {
    await new ClaudeCodeProvider().run(makeContext({ task: makeTask('a', { model: 'opus' }) }));

    const args = execaMock.mock.calls.at(-1)?.[1] as string[];
    expect(args.join(' ')).toContain('--model opus');
  });

  it('applies a per-task timeout', async () => {
    await new ClaudeCodeProvider({ timeoutMs: 1234 }).run(makeContext());

    const options = execaMock.mock.calls.at(-1)?.[2] as { timeout: number };
    expect(options.timeout).toBe(1234);
  });

  it('defaults the timeout to fifteen minutes', async () => {
    await new ClaudeCodeProvider().run(makeContext());

    const options = execaMock.mock.calls.at(-1)?.[2] as { timeout: number };
    expect(options.timeout).toBe(15 * 60 * 1000);
  });

  it('logs the exact spawned command for debuggability', async () => {
    const output: string[] = [];
    await new ClaudeCodeProvider().run(makeContext({ onOutput: (c) => output.push(c) }));

    expect(output.join('')).toContain('claude --print');
  });

  it('passes the abort signal through', async () => {
    const controller = new AbortController();
    await new ClaudeCodeProvider().run(makeContext({ signal: controller.signal }));

    const options = execaMock.mock.calls.at(-1)?.[2] as { signal: AbortSignal };
    expect(options.signal).toBe(controller.signal);
  });
});

describe('results', () => {
  it('reports success on exit code 0', async () => {
    execaMock.mockReturnValue(fakeChild({ exitCode: 0, stdout: 'all done here' }));

    const result = await new ClaudeCodeProvider().run(makeContext());

    expect(result.success).toBe(true);
    expect(result.summary).toContain('all done here');
  });

  it('reports failure on a non-zero exit code', async () => {
    execaMock.mockReturnValue(fakeChild({ exitCode: 2, stderr: 'something broke' }));

    const result = await new ClaudeCodeProvider().run(makeContext());

    expect(result.success).toBe(false);
    expect(result.error).toContain('2');
    expect(result.error).toContain('something broke');
  });

  it('reports a timeout distinctly', async () => {
    execaMock.mockReturnValue(fakeChild({ exitCode: 1, timedOut: true }));

    const result = await new ClaudeCodeProvider({ timeoutMs: 500 }).run(makeContext());

    expect(result.success).toBe(false);
    expect(result.error).toContain('timed out');
  });

  it('reports an abort as aborted, not as a crash', async () => {
    execaMock.mockReturnValue(fakeChild({ exitCode: 1 }));

    const result = await new ClaudeCodeProvider().run(makeContext({ signal: AbortSignal.abort() }));

    expect(result.success).toBe(false);
    expect(result.error).toBe('aborted');
  });

  it('turns a thrown spawn error into a failed result', async () => {
    execaMock.mockImplementation(() => {
      throw new Error('claude: command not found');
    });

    const result = await new ClaudeCodeProvider().run(makeContext());

    expect(result.success).toBe(false);
    expect(result.error).toContain('command not found');
  });

  it('streams stdout into onOutput', async () => {
    const child = fakeChild();
    execaMock.mockReturnValue(child);

    const output: string[] = [];
    const promise = new ClaudeCodeProvider().run(makeContext({ onOutput: (c) => output.push(c) }));
    child.stdout.emit('data', Buffer.from('agent thinking...\n'));
    await promise;

    expect(output.join('')).toContain('agent thinking...');
  });
});

describe('registry', () => {
  it('resolves claude-code without spawning anything', async () => {
    const { getProvider } = await import('../../src/providers/registry.js');
    const provider = await getProvider('claude-code');

    expect(provider.name).toBe('claude-code');
    expect(execaMock).not.toHaveBeenCalled();
  });

  it('still defaults to mock', async () => {
    const { getProvider } = await import('../../src/providers/registry.js');
    expect((await getProvider('mock')).name).toBe('mock');
  });
});
