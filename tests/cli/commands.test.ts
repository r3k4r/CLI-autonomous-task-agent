import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  addCommand,
  cleanCommand,
  initCommand,
  listCommand,
  logsCommand,
  retryCommand,
  runCommand,
  statusCommand,
  stopCommand,
  type CommandContext,
} from '../../src/cli/commands.js';
import { CONFIG_FILENAME } from '../../src/core/config.js';
import { Store } from '../../src/core/store.js';
import { listWorktrees } from '../../src/git/worktree.js';
import { TaskNotFoundError } from '../../src/util/errors.js';
import { makeTempRepo } from '../helpers/repo.js';
import { removeTempDir } from '../helpers/temp.js';

const dirs: string[] = [];

/** A repo plus a context with colour off, as a non-TTY run would have. */
async function setup(notes?: string): Promise<{ repo: string; ctx: CommandContext }> {
  const repo = await makeTempRepo();
  dirs.push(repo);
  if (notes !== undefined) await writeFile(join(repo, 'tasks.md'), notes, 'utf8');
  return { repo, ctx: { projectPath: repo, color: false } };
}

/** Writes a config so runs use the mock provider with no delay. */
async function writeConfig(repo: string, extra: Record<string, unknown> = {}): Promise<void> {
  await writeFile(
    join(repo, CONFIG_FILENAME),
    JSON.stringify({ provider: 'mock', parallel: 2, ...extra }),
    'utf8',
  );
}

afterEach(() => {
  while (dirs.length > 0) removeTempDir(dirs.pop()!);
});

// Detecting an escape code is the point of these assertions, so the control
// character is deliberate.
// eslint-disable-next-line no-control-regex
const ANSI = /\[[0-9;]*m/;

describe('init', () => {
  it('creates the note file, the config and the gitignore entry', async () => {
    const { repo, ctx } = await setup();

    const lines = await initCommand(ctx);

    expect(existsSync(join(repo, 'tasks.md'))).toBe(true);
    expect(existsSync(join(repo, CONFIG_FILENAME))).toBe(true);
    expect(await readFile(join(repo, '.gitignore'), 'utf8')).toContain('.agentrun/');
    expect(lines.join('\n')).toContain('created tasks.md');
  });

  it('does not overwrite an existing note file', async () => {
    const { repo, ctx } = await setup('My own notes\n');

    const lines = await initCommand(ctx);

    expect(await readFile(join(repo, 'tasks.md'), 'utf8')).toBe('My own notes\n');
    expect(lines.join('\n')).toContain('already exists');
  });

  it('appends to an existing .gitignore without clobbering it', async () => {
    const { repo, ctx } = await setup();
    await writeFile(join(repo, '.gitignore'), 'node_modules/\n', 'utf8');

    await initCommand(ctx);

    const gitignore = await readFile(join(repo, '.gitignore'), 'utf8');
    expect(gitignore).toContain('node_modules/');
    expect(gitignore).toContain('.agentrun/');
  });

  it('does not add .agentrun/ twice', async () => {
    const { repo, ctx } = await setup();
    await initCommand(ctx);
    await initCommand(ctx);

    const gitignore = await readFile(join(repo, '.gitignore'), 'utf8');
    expect(gitignore.match(/\.agentrun\//g)).toHaveLength(1);
  });

  it('creates a note file that parses as real tasks', async () => {
    const { repo, ctx } = await setup();
    await initCommand(ctx);

    const lines = await listCommand({ projectPath: repo, color: false });
    expect(lines.join('\n')).toContain('Create a login page');
  });
});

describe('add', () => {
  it('appends a task in the file dominant style', async () => {
    const { repo, ctx } = await setup('- First task\n');

    await addCommand(ctx, 'Second task');

    expect(await readFile(join(repo, 'tasks.md'), 'utf8')).toBe('- First task\n- Second task\n');
  });

  it('creates the note file when there is none', async () => {
    const { repo, ctx } = await setup();

    await addCommand(ctx, 'A brand new task');

    expect(await readFile(join(repo, 'tasks.md'), 'utf8')).toBe('A brand new task\n');
  });
});

describe('list', () => {
  it('prints one line per task with dependencies', async () => {
    const { ctx } = await setup(
      ['Build the thing #id:a', 'Test the thing #id:b #needs:a'].join('\n'),
    );

    const lines = await listCommand(ctx);

    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('Build the thing');
    expect(lines[1]).toContain('needs: a');
  });

  it('says so when there are no tasks', async () => {
    const { ctx } = await setup('# just a heading\n');
    expect((await listCommand(ctx)).join('')).toContain('no tasks');
  });

  it('emits no ANSI escapes when colour is off', async () => {
    const { ctx } = await setup('Build the thing\n');
    const lines = await listCommand(ctx);
    expect(lines.join('\n')).not.toMatch(ANSI);
  });

  it('reflects statuses from the latest run', async () => {
    const { repo, ctx } = await setup('Build the thing #id:a\n');
    await writeConfig(repo);
    await runCommand(ctx);

    const lines = await listCommand(ctx);
    expect(lines[0]).toContain('[+]');
  });
});

describe('run --dry-run', () => {
  it('prints waves in dependency order', async () => {
    const { ctx } = await setup(
      ['Build the thing #id:a', 'Test the thing #id:b #needs:a', 'Something separate #id:c'].join(
        '\n',
      ),
    );

    const output = (await runCommand(ctx, { dryRun: true })).join('\n');

    expect(output).toContain('wave 1');
    expect(output).toContain('wave 2');
    // a and c are independent, so they share the first wave.
    const wave1 = output.slice(output.indexOf('wave 1'), output.indexOf('wave 2'));
    expect(wave1).toContain('a ');
    expect(wave1).toContain('c ');
    expect(output.slice(output.indexOf('wave 2'))).toContain('b ');
  });

  it('creates no worktree and starts no agent', async () => {
    const { repo, ctx } = await setup('Build the thing #id:a\n');

    await runCommand(ctx, { dryRun: true });

    expect(existsSync(join(repo, '.agentrun', 'worktrees'))).toBe(false);
    const worktrees = await listWorktrees(repo);
    expect(worktrees.filter((w) => w.branch.startsWith('agent/'))).toEqual([]);
  });

  it('shows the dependency change when #needs is added', async () => {
    const { repo, ctx } = await setup(['Build the thing #id:a', 'Ship the thing #id:b'].join('\n'));

    const before = (await runCommand(ctx, { dryRun: true })).join('\n');
    expect(before).toContain('wave 1');
    expect(before).not.toContain('wave 2');

    await writeFile(
      join(repo, 'tasks.md'),
      ['Build the thing #id:a', 'Ship the thing #id:b #needs:a'].join('\n'),
      'utf8',
    );

    const after = (await runCommand(ctx, { dryRun: true })).join('\n');
    expect(after).toContain('wave 2');
  });

  it('lists skipped tasks separately', async () => {
    const { ctx } = await setup(['Build the thing #id:a', 'Never do this #id:b #skip'].join('\n'));
    const output = (await runCommand(ctx, { dryRun: true })).join('\n');
    expect(output).toContain('skipped: b');
  });
});

describe('run', () => {
  it('runs every task with the mock provider and marks the file', async () => {
    const { repo, ctx } = await setup(['- [ ] First task', '- [ ] Second task'].join('\n'));
    await writeConfig(repo);

    const output = (await runCommand(ctx)).join('\n');

    expect(output).toContain('completed');
    const notes = await readFile(join(repo, 'tasks.md'), 'utf8');
    expect(notes).toBe(['- [x] First task', '- [x] Second task'].join('\n'));
  });

  it('honours --parallel from the command line', async () => {
    const { repo, ctx } = await setup(['Task one', 'Task two', 'Task three'].join('\n'));
    await writeConfig(repo, { parallel: 1 });

    const summaries: Array<{ done: string[] }> = [];
    await runCommand(ctx, { parallel: 3, onSummary: (s) => summaries.push(s) });

    expect(summaries[0]?.done).toHaveLength(3);
  });

  it('says so when the note file has no tasks', async () => {
    const { ctx } = await setup('# nothing here\n');
    expect((await runCommand(ctx)).join('')).toContain('no tasks');
  });

  it('emits no ANSI escapes when colour is off', async () => {
    const { repo, ctx } = await setup('Build the thing\n');
    await writeConfig(repo);
    expect((await runCommand(ctx)).join('\n')).not.toMatch(ANSI);
  });
});

describe('status', () => {
  it('reports that there are no runs yet', async () => {
    const { ctx } = await setup('Build the thing\n');
    expect((await statusCommand(ctx)).join('')).toContain('no runs yet');
  });

  it('reads run state written by another process', async () => {
    const { repo, ctx } = await setup('Build the thing #id:a\n');
    await writeConfig(repo);
    await runCommand(ctx);

    // A fresh context, as a second terminal would have.
    const lines = await statusCommand({ projectPath: repo, color: false });

    expect(lines.join('\n')).toContain('finished');
    expect(lines.join('\n')).toContain('a');
  });

  it('warns that completed tasks are unverified with no verifyCommand', async () => {
    const { repo, ctx } = await setup('Build the thing #id:a\n');
    await writeConfig(repo);
    await runCommand(ctx);

    expect((await statusCommand(ctx)).join('\n')).toContain('unverified');
  });

  it('does not warn about verification when a verifyCommand is set', async () => {
    const { repo, ctx } = await setup('Build the thing #id:a\n');
    await writeConfig(repo, { verifyCommand: 'echo ok' });
    await runCommand(ctx);

    expect((await statusCommand(ctx)).join('\n')).not.toContain('unverified');
  });
});

describe('logs', () => {
  it('prints a task log after a run', async () => {
    const { repo, ctx } = await setup('Build the thing #id:a\n');
    await writeConfig(repo);
    await runCommand(ctx);

    const lines = await logsCommand(ctx, 'a');
    expect(lines.join('\n')).toContain('starting task a');
  });

  it('rejects an unknown task id', async () => {
    const { repo, ctx } = await setup('Build the thing #id:a\n');
    await writeConfig(repo);
    await runCommand(ctx);

    await expect(logsCommand(ctx, 'nope')).rejects.toThrow(TaskNotFoundError);
  });
});

describe('retry', () => {
  it('resets a failed task and runs it again to success', async () => {
    const { repo, ctx } = await setup('Build the thing #id:a\n');
    await writeConfig(repo, { maxAttempts: 1 });

    process.env.MOCK_FAIL_TASKS = 'a';
    try {
      await runCommand(ctx);
    } finally {
      delete process.env.MOCK_FAIL_TASKS;
    }

    const store = Store.open(repo);
    const failedRun = store.getLatestRun()!;
    expect(store.getTask(failedRun.id, 'a')?.status).toBe('failed');
    store.close();

    // The second run succeeds because MOCK_FAIL_TASKS is no longer set.
    const output = (await retryCommand(ctx, 'a')).join('\n');
    expect(output).toContain('completed');
  });

  it('rejects an unknown task id', async () => {
    const { repo, ctx } = await setup('Build the thing #id:a\n');
    await writeConfig(repo);
    await runCommand(ctx);

    await expect(retryCommand(ctx, 'ghost')).rejects.toThrow(TaskNotFoundError);
  });
});

describe('stop', () => {
  it('reports when there is no active run', async () => {
    const { ctx } = await setup('Build the thing\n');
    expect((await stopCommand(ctx)).join('')).toContain('no active run');
  });

  it('marks an active run stopped', async () => {
    const { repo, ctx } = await setup('Build the thing #id:a\n');
    const store = Store.open(repo);
    store.createRun('manual-run', { ...(await import('../helpers/fixtures.js')).makeConfig() }, []);
    store.close();

    const output = (await stopCommand(ctx)).join('');
    expect(output).toContain('stopped');

    const reader = Store.open(repo);
    expect(reader.getRun('manual-run')?.status).toBe('stopped');
    reader.close();
  });
});

describe('clean', () => {
  it('reports when there is nothing to clean', async () => {
    const { ctx } = await setup('Build the thing\n');
    expect((await cleanCommand(ctx)).join('')).toContain('nothing to clean');
  });

  it('removes leftover agent worktrees', async () => {
    const { repo, ctx } = await setup('Build the thing #id:a\n');
    const { createWorktree } = await import('../../src/git/worktree.js');
    await createWorktree(repo, 'leftover', 'main');

    const output = (await cleanCommand(ctx)).join('');

    expect(output).toContain('leftover');
    const worktrees = await listWorktrees(repo);
    expect(worktrees.filter((w) => w.branch.startsWith('agent/'))).toEqual([]);
  });
});
