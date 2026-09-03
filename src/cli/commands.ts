import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CONFIG_FILENAME, loadConfig } from '../core/config.js';
import { executionWaves } from '../core/graph.js';
import { Orchestrator, type RunSummary } from '../core/orchestrator.js';
import { addTask, parseNotes } from '../core/parser.js';
import { Store, logFilePath } from '../core/store.js';
import type { RunConfig, Task } from '../core/types.js';
import { pruneStale } from '../git/worktree.js';
import { getProvider } from '../providers/registry.js';
import { NoActiveRunError, TaskNotFoundError } from '../util/errors.js';
import { formatTaskLine, type OutputOptions } from './output.js';

/**
 * Command implementations, kept free of commander so each one is directly
 * testable. Everything here returns the lines it would print rather than
 * printing, except where a command genuinely streams.
 */

export interface CommandContext extends OutputOptions {
  projectPath: string;
}

const DEFAULT_NOTES = `# Tasks

Write what you want done, one thing per line. Any style works:

Create a login page
  use the existing Button component
  redirect to /dashboard on success

- [ ] Fix the failing auth test
`;

const DEFAULT_CONFIG = {
  provider: 'mock',
  parallel: 1,
  maxAttempts: 2,
  writeBack: 'auto',
  baseBranch: 'main',
};

async function fileExists(path: string): Promise<boolean> {
  try {
    await readFile(path);
    return true;
  } catch {
    return false;
  }
}

/** Read the note file, or return '' when it does not exist yet. */
async function readNotes(projectPath: string, noteFile: string): Promise<string> {
  try {
    return await readFile(join(projectPath, noteFile), 'utf8');
  } catch {
    return '';
  }
}

/**
 * `agentrun init` — create the note file and config, and gitignore `.agentrun/`.
 */
export async function initCommand(ctx: CommandContext): Promise<string[]> {
  const config = await loadConfig(ctx.projectPath);
  const lines: string[] = [];

  const notePath = join(ctx.projectPath, config.noteFile);
  if (await fileExists(notePath)) {
    lines.push(`${config.noteFile} already exists, leaving it alone`);
  } else {
    await writeFile(notePath, DEFAULT_NOTES, 'utf8');
    lines.push(`created ${config.noteFile}`);
  }

  const configPath = join(ctx.projectPath, CONFIG_FILENAME);
  if (await fileExists(configPath)) {
    lines.push(`${CONFIG_FILENAME} already exists, leaving it alone`);
  } else {
    await writeFile(configPath, `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`, 'utf8');
    lines.push(`created ${CONFIG_FILENAME}`);
  }

  lines.push(await ensureGitignored(ctx.projectPath));
  return lines;
}

/** Add `.agentrun/` to .gitignore, creating the file if needed. */
async function ensureGitignored(projectPath: string): Promise<string> {
  const path = join(projectPath, '.gitignore');
  const entry = '.agentrun/';

  let content = '';
  try {
    content = await readFile(path, 'utf8');
  } catch {
    // No .gitignore yet; one will be created below.
  }

  const alreadyListed = content
    .split(/\r?\n/)
    .some((line) => line.trim() === entry || line.trim() === '.agentrun');
  if (alreadyListed) return '.gitignore already ignores .agentrun/';

  const needsNewline = content !== '' && !content.endsWith('\n');
  await writeFile(path, `${content}${needsNewline ? '\n' : ''}${entry}\n`, 'utf8');
  return 'added .agentrun/ to .gitignore';
}

/** `agentrun add "<title>"` — append a task in the file's dominant style. */
export async function addCommand(ctx: CommandContext, title: string): Promise<string[]> {
  const config = await loadConfig(ctx.projectPath);
  const notePath = join(ctx.projectPath, config.noteFile);

  const content = await readNotes(ctx.projectPath, config.noteFile);
  const updated = addTask(content, title);
  await writeFile(notePath, updated, 'utf8');

  return [`added to ${config.noteFile}: ${title}`];
}

/** `agentrun list` — print parsed tasks, statuses and dependencies. */
export async function listCommand(ctx: CommandContext): Promise<string[]> {
  const config = await loadConfig(ctx.projectPath);
  const tasks = parseNotes(await readNotes(ctx.projectPath, config.noteFile));

  if (tasks.length === 0) {
    return [`no tasks found in ${config.noteFile}`];
  }

  // Statuses from the latest run beat the ones parsed out of the file.
  const merged = withStoredStatus(ctx.projectPath, tasks);
  return merged.map((task) => formatTaskLine(task, ctx));
}

/** Overlay the newest run's statuses onto tasks parsed from the note file. */
function withStoredStatus(projectPath: string, tasks: Task[]): Task[] {
  const store = Store.open(projectPath);
  try {
    const run = store.getLatestRun();
    if (!run) return tasks;

    const stored = new Map(store.listTasks(run.id).map((t) => [t.id, t]));
    return tasks.map((task) => {
      const found = stored.get(task.id);
      // A file edited since the run may have tasks the run never saw.
      return found ? { ...task, status: found.status, error: found.error } : task;
    });
  } finally {
    store.close();
  }
}

export interface RunOptions {
  parallel?: number;
  provider?: string;
  dryRun?: boolean;
  /** Plain line output instead of the live ink table. */
  noTui?: boolean;
  onSummary?: (summary: RunSummary) => void;
}

/**
 * `agentrun run` — start a run, or with `--dry-run` print the execution plan
 * and exit without spawning anything or creating a worktree.
 */
export async function runCommand(ctx: CommandContext, options: RunOptions = {}): Promise<string[]> {
  const overrides: Partial<RunConfig> = {};
  if (options.parallel !== undefined) overrides.parallel = options.parallel;
  if (options.provider !== undefined) overrides.provider = options.provider;

  const config = await loadConfig(ctx.projectPath, overrides);
  const tasks = parseNotes(await readNotes(ctx.projectPath, config.noteFile));

  if (tasks.length === 0) {
    return [`no tasks found in ${config.noteFile}`];
  }

  if (options.dryRun) return dryRunPlan(tasks, config);

  const store = Store.open(ctx.projectPath);
  try {
    const provider = await getProvider(config.provider, {
      timeoutMs: config.timeoutMs,
      billing: config.billing,
    });
    const orchestrator = new Orchestrator(config, store, provider);

    // The live table only makes sense on a TTY; everywhere else (pipes, CI,
    // tests) the run prints plain lines and no escape codes.
    const { shouldUseTui, renderRun } = await import('./tui.js');
    if (shouldUseTui(options.noTui)) {
      // Subscribe before starting, or a fast run emits runEnd before the table
      // is listening and the render never resolves.
      const drawn = renderRun(orchestrator, tasks);
      const summary = await orchestrator.start();
      await drawn;
      options.onSummary?.(summary);
      return summarise(summary);
    }

    const summary = await orchestrator.start();
    options.onSummary?.(summary);
    return summarise(summary);
  } finally {
    store.close();
  }
}

/** The execution plan: waves, order and dependencies. Spawns nothing. */
function dryRunPlan(tasks: Task[], config: RunConfig): string[] {
  const waves = executionWaves(tasks);
  const lines = [
    `plan for ${config.noteFile} (provider: ${config.provider}, parallel: ${config.parallel})`,
    '',
  ];

  if (waves.length === 0) {
    lines.push('nothing to run');
    return lines;
  }

  for (const [index, wave] of waves.entries()) {
    // Tasks in a wave can run together, but only `parallel` at a time.
    lines.push(`wave ${index + 1} (${wave.length} task${wave.length === 1 ? '' : 's'}):`);
    for (const task of wave) {
      const needs = task.dependsOn.length > 0 ? `  needs: ${task.dependsOn.join(', ')}` : '';
      lines.push(`  ${task.id}  ${task.title}${needs}`);
    }
    lines.push('');
  }

  const skipped = tasks.filter((t) => t.status === 'skipped');
  if (skipped.length > 0) {
    lines.push(`skipped: ${skipped.map((t) => t.id).join(', ')}`);
  }
  return lines;
}

function summarise(summary: RunSummary): string[] {
  const lines = [
    `run ${summary.runId} ${summary.ok ? 'completed' : 'finished with problems'}`,
    `  done:      ${summary.done.length}`,
  ];
  if (summary.failed.length > 0) lines.push(`  failed:    ${summary.failed.join(', ')}`);
  if (summary.blocked.length > 0) lines.push(`  blocked:   ${summary.blocked.join(', ')}`);
  if (summary.cancelled.length > 0) lines.push(`  cancelled: ${summary.cancelled.join(', ')}`);
  if (summary.skipped.length > 0) lines.push(`  skipped:   ${summary.skipped.join(', ')}`);
  return lines;
}

/** `agentrun status` — the current run's state, read straight from SQLite. */
export async function statusCommand(ctx: CommandContext): Promise<string[]> {
  const store = Store.open(ctx.projectPath);
  try {
    const run = store.getActiveRun() ?? store.getLatestRun();
    if (!run) return ['no runs yet'];

    const tasks = store.listTasks(run.id);
    const lines = [
      `run ${run.id} — ${run.status}`,
      `started ${new Date(run.startedAt).toISOString()}`,
      '',
      ...tasks.map((task) => formatTaskLine(task, ctx)),
    ];

    const unverified = run.config.verifyCommand === undefined;
    if (unverified && tasks.some((t) => t.status === 'done')) {
      lines.push('', 'note: no verifyCommand configured — completed tasks are unverified');
    }
    return lines;
  } finally {
    store.close();
  }
}

/** `agentrun logs <taskId>` — print a task's log. */
export async function logsCommand(ctx: CommandContext, taskId: string): Promise<string[]> {
  const store = Store.open(ctx.projectPath);
  let runId: string;
  try {
    const run = store.getActiveRun() ?? store.getLatestRun();
    if (!run) throw new NoActiveRunError();
    if (!store.getTask(run.id, taskId)) throw new TaskNotFoundError(taskId);
    runId = run.id;
  } finally {
    store.close();
  }

  try {
    const contents = await readFile(logFilePath(ctx.projectPath, runId, taskId), 'utf8');
    return contents.split('\n');
  } catch {
    return [`no log yet for ${taskId}`];
  }
}

/** `agentrun retry <taskId>` — reset a failed task and run it again. */
export async function retryCommand(ctx: CommandContext, taskId: string): Promise<string[]> {
  const config = await loadConfig(ctx.projectPath);
  const store = Store.open(ctx.projectPath);

  try {
    const run = store.getLatestRun();
    if (!run) throw new NoActiveRunError();

    const task = store.getTask(run.id, taskId);
    if (!task) throw new TaskNotFoundError(taskId);

    // Clear the failure so the orchestrator sees it as runnable again.
    store.updateTask(run.id, taskId, { status: 'pending', attempts: 0, error: undefined });
    store.appendEvent(run.id, taskId, 'retry', 'reset by `agentrun retry`');
  } finally {
    store.close();
  }

  // Clean up the old worktree and branch before running again.
  await pruneStale(ctx.projectPath, []).catch(() => []);

  return runCommand({ ...ctx, projectPath: ctx.projectPath }, { provider: config.provider });
}

/** `agentrun stop` — stop the active run. */
export async function stopCommand(ctx: CommandContext): Promise<string[]> {
  const store = Store.open(ctx.projectPath);
  try {
    const run = store.getActiveRun();
    if (!run) return ['no active run'];

    // NOTE: with no daemon, a run lives inside one CLI process. Marking the run
    // stopped is what a second terminal can do; the running process cleans up
    // its own worktrees when it notices. Phase 9 would make this immediate.
    store.finishRun(run.id, 'stopped');
    for (const task of store.listTasks(run.id)) {
      if (task.status === 'running' || task.status === 'verifying' || task.status === 'pending') {
        store.updateTask(run.id, task.id, { status: 'cancelled' });
      }
    }
    return [`stopped run ${run.id}`];
  } finally {
    store.close();
  }
}

/** `agentrun clean` — prune worktrees and branches from finished runs. */
export async function cleanCommand(ctx: CommandContext): Promise<string[]> {
  const store = Store.open(ctx.projectPath);
  let activeTaskIds: string[] = [];
  try {
    const active = store.getActiveRun();
    // Never remove a worktree belonging to a run that is still going.
    if (active) {
      activeTaskIds = store
        .listTasks(active.id)
        .filter((t) => t.status === 'running' || t.status === 'verifying')
        .map((t) => t.id);
    }
  } finally {
    store.close();
  }

  const removed = await pruneStale(ctx.projectPath, activeTaskIds);
  return removed.length === 0
    ? ['nothing to clean']
    : [`removed ${removed.length} worktree(s): ${removed.join(', ')}`];
}
