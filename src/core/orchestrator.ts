import { EventEmitter } from 'node:events';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createWriteStream, type WriteStream } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  agentrunOwnedPaths,
  commitAll,
  createWorktree,
  removeWorktree,
} from '../git/worktree.js';
import type { Provider } from '../providers/types.js';
import { logger } from '../util/logger.js';
import { validateGraph } from './graph.js';
import { markComplete, parseNotes } from './parser.js';
import { logFilePath, type Store } from './store.js';
import type { RunConfig, Task, TaskStatus } from './types.js';

/**
 * The scheduling loop.
 *
 * Runs at most `config.parallel` agents at once, each in its own worktree, and
 * decides what happens to a task afterwards. An agent claiming success does not
 * make a task done — verification decides that.
 */

export interface RunSummary {
  runId: string;
  done: string[];
  failed: string[];
  blocked: string[];
  skipped: string[];
  cancelled: string[];
  /** True when every task that could run ended `done`. */
  ok: boolean;
}

export interface VerifyResult {
  passed: boolean;
  output: string;
  /** True when no verify command was configured, so nothing actually checked. */
  unverified?: boolean;
}

/** Runs build and verify commands inside a worktree. Stubbed until phase 8. */
export type Verifier = (task: Task, worktreePath: string) => Promise<VerifyResult>;

export interface OrchestratorOptions {
  /** Injected so phase 8 can supply real verification without touching this file. */
  verify?: Verifier;
  /** Overrides the generated run id, for deterministic tests. */
  runId?: string;
}

export interface TaskStartEvent {
  task: Task;
  attempt: number;
}
export interface TaskEndEvent {
  task: Task;
  status: TaskStatus;
  error?: string;
}
export interface TaskLogEvent {
  taskId: string;
  chunk: string;
}

/** NOTE: always-pass stub. Phase 8 replaces this with real verification. */
const alwaysPasses: Verifier = async () => ({ passed: true, output: '', unverified: true });

function makeRunId(): string {
  const stamp = new Date()
    .toISOString()
    .replace(/[-:.TZ]/g, '')
    .slice(0, 14);
  const suffix = Math.random().toString(36).slice(2, 8);
  return `${stamp}-${suffix}`;
}

export class Orchestrator {
  readonly #config: RunConfig;
  readonly #store: Store;
  readonly #provider: Provider;
  readonly #verify: Verifier;
  readonly #emitter = new EventEmitter();
  readonly #controllers = new Map<string, AbortController>();
  readonly #runId: string;

  #tasks: Task[] = [];
  #stopping = false;

  constructor(
    config: RunConfig,
    store: Store,
    provider: Provider,
    options: OrchestratorOptions = {},
  ) {
    this.#config = config;
    this.#store = store;
    this.#provider = provider;
    this.#verify = options.verify ?? alwaysPasses;
    this.#runId = options.runId ?? makeRunId();
  }

  get runId(): string {
    return this.#runId;
  }

  on(event: 'taskStart', handler: (e: TaskStartEvent) => void): void;
  on(event: 'taskEnd', handler: (e: TaskEndEvent) => void): void;
  on(event: 'taskLog', handler: (e: TaskLogEvent) => void): void;
  on(event: 'runEnd', handler: (e: RunSummary) => void): void;
  on(event: string, handler: (payload: never) => void): void {
    this.#emitter.on(event, handler as (payload: unknown) => void);
  }

  /**
   * Run every runnable task, respecting dependencies and the parallel limit.
   * Cycles are detected before any agent starts.
   */
  async start(): Promise<RunSummary> {
    const notePath = join(this.#config.projectPath, this.#config.noteFile);
    const content = await readFile(notePath, 'utf8');
    this.#tasks = parseNotes(content);

    // Fail fast, before a single worktree exists.
    validateGraph(this.#tasks);

    for (const task of this.#tasks) {
      task.maxAttempts = this.#config.maxAttempts;
    }

    this.#store.createRun(this.#runId, this.#config, this.#tasks);

    await this.#loop();

    const summary = this.#summarise();
    this.#store.finishRun(this.#runId, this.#stopping ? 'stopped' : 'finished');
    this.#emitter.emit('runEnd', summary);
    return summary;
  }

  /** Abort running agents, mark them cancelled, and clean up their worktrees. */
  async stop(): Promise<void> {
    this.#stopping = true;
    for (const controller of this.#controllers.values()) {
      controller.abort();
    }
  }

  /** The scheduling loop proper. */
  async #loop(): Promise<void> {
    const inFlight = new Map<string, Promise<void>>();

    for (;;) {
      // Anything whose dependencies can never be satisfied is blocked now.
      this.#markBlocked();

      if (this.#stopping) {
        // Let the aborted agents settle, then stop scheduling.
        await Promise.all(inFlight.values());
        break;
      }

      const ready = this.#readyTasks().filter((task) => !inFlight.has(task.id));
      const slots = this.#config.parallel - inFlight.size;

      for (const task of ready.slice(0, Math.max(0, slots))) {
        const promise = this.#runTask(task).finally(() => inFlight.delete(task.id));
        inFlight.set(task.id, promise);
      }

      if (inFlight.size === 0) {
        // Nothing running and nothing ready — either everything finished or
        // what remains is blocked.
        if (this.#readyTasks().length === 0) break;
        continue;
      }

      // Wake as soon as any agent finishes so a freed slot is refilled at once.
      await Promise.race(inFlight.values());
    }
  }

  /** Tasks whose dependencies are all done and which still need to run. */
  #readyTasks(): Task[] {
    const statusById = new Map(this.#tasks.map((t) => [t.id, t.status]));
    return this.#tasks.filter(
      (task) =>
        task.status === 'pending' && task.dependsOn.every((dep) => statusById.get(dep) === 'done'),
    );
  }

  /**
   * Mark as blocked every pending task with a dependency that failed, was
   * blocked, cancelled or skipped — it will never become runnable.
   */
  #markBlocked(): void {
    const dead: TaskStatus[] = ['failed', 'blocked', 'cancelled', 'skipped'];
    let changed = true;

    while (changed) {
      changed = false;
      const statusById = new Map(this.#tasks.map((t) => [t.id, t.status]));

      for (const task of this.#tasks) {
        if (task.status !== 'pending') continue;
        const blocker = task.dependsOn.find((dep) => {
          const status = statusById.get(dep);
          return status !== undefined && dead.includes(status);
        });
        if (blocker === undefined) continue;

        this.#setStatus(task, 'blocked', `dependency '${blocker}' did not complete`);
        this.#emitter.emit('taskEnd', {
          task,
          status: 'blocked',
          error: task.error,
        } satisfies TaskEndEvent);
        changed = true;
      }
    }
  }

  /** Run one task to a terminal state, retrying within maxAttempts. */
  async #runTask(task: Task): Promise<void> {
    const controller = new AbortController();
    this.#controllers.set(task.id, controller);

    try {
      for (;;) {
        task.attempts += 1;
        const attempt = task.attempts;

        this.#setStatus(task, 'running');
        task.startedAt = Date.now();
        this.#store.updateTask(this.#runId, task.id, {
          status: 'running',
          attempts: attempt,
          startedAt: task.startedAt,
        });
        this.#emitter.emit('taskStart', { task, attempt } satisfies TaskStartEvent);

        const outcome = await this.#attempt(task, controller, attempt);

        if (outcome.status === 'done') {
          await this.#finish(task, 'done');
          return;
        }

        if (outcome.status === 'cancelled') {
          await this.#finish(task, 'cancelled', outcome.error);
          return;
        }

        const canRetry = attempt < task.maxAttempts && !this.#stopping;
        if (!canRetry) {
          await this.#finish(task, 'failed', outcome.error);
          return;
        }

        this.#store.appendEvent(
          this.#runId,
          task.id,
          'retry',
          `attempt ${attempt} failed: ${outcome.error ?? 'unknown error'}`,
        );
        task.error = outcome.error ?? 'unknown error';
      }
    } finally {
      this.#controllers.delete(task.id);
    }
  }

  /** One attempt: worktree, agent, verify, commit. */
  async #attempt(
    task: Task,
    controller: AbortController,
    attempt: number,
  ): Promise<{ status: 'done' | 'failed' | 'cancelled'; error?: string }> {
    let worktreePath: string | undefined;
    let log: WriteStream | undefined;

    try {
      const worktree = await createWorktree(
        this.#config.projectPath,
        task.id,
        this.#config.baseBranch,
        agentrunOwnedPaths(this.#config.noteFile),
      );
      worktreePath = worktree.path;
      task.worktreePath = worktree.path;
      task.branch = worktree.branch;
      this.#store.updateTask(this.#runId, task.id, {
        worktreePath: worktree.path,
        branch: worktree.branch,
      });

      log = await this.#openLog(task.id);
      const writeLog = (chunk: string): void => {
        log?.write(chunk);
        this.#emitter.emit('taskLog', { taskId: task.id, chunk } satisfies TaskLogEvent);
      };

      const result = await this.#provider.run({
        task,
        worktreePath: worktree.path,
        signal: controller.signal,
        onOutput: writeLog,
        ...(task.model !== undefined ? { model: task.model } : {}),
        ...(attempt > 1 && task.error !== undefined ? { previousError: task.error } : {}),
      });

      if (controller.signal.aborted) {
        return { status: 'cancelled', error: 'run stopped' };
      }

      // An agent claiming success does not mean success — verify decides.
      if (!result.success) {
        writeLog(`[agentrun] agent reported failure: ${result.error ?? 'no reason given'}\n`);
        return { status: 'failed', error: result.error ?? result.summary };
      }

      this.#setStatus(task, 'verifying');
      const verification = await this.#verify(task, worktree.path);
      if (verification.output) writeLog(verification.output);

      if (!verification.passed) {
        return {
          status: 'failed',
          error: `verification failed: ${verification.output.slice(-500)}`,
        };
      }

      await commitAll(worktree.path, `agentrun: ${task.title}`);
      return { status: 'done' };
    } catch (cause) {
      if (controller.signal.aborted) return { status: 'cancelled', error: 'run stopped' };
      const message = cause instanceof Error ? cause.message : String(cause);
      logger.error({ taskId: task.id, err: message }, 'task attempt threw');
      return { status: 'failed', error: message };
    } finally {
      log?.end();
      if (worktreePath !== undefined) {
        // The branch survives if the agent committed; only the checkout goes.
        await removeWorktree(this.#config.projectPath, task.id, this.#config.baseBranch).catch(
          (err: unknown) => {
            logger.warn({ taskId: task.id, err }, 'could not remove worktree');
          },
        );
      }
    }
  }

  /** Settle a task into a terminal status and write the note file back. */
  async #finish(task: Task, status: TaskStatus, error?: string): Promise<void> {
    this.#setStatus(task, status, error);
    task.finishedAt = Date.now();
    this.#store.updateTask(this.#runId, task.id, {
      status,
      finishedAt: task.finishedAt,
      attempts: task.attempts,
      ...(error !== undefined ? { error } : {}),
    });

    if (status === 'done' && this.#config.writeBack === 'auto') {
      await this.#writeBack(task);
    }

    this.#emitter.emit('taskEnd', {
      task,
      status,
      ...(error !== undefined ? { error } : {}),
    } satisfies TaskEndEvent);
  }

  /** Tick the task's line in the note file, leaving every other byte alone. */
  async #writeBack(task: Task): Promise<void> {
    const notePath = join(this.#config.projectPath, this.#config.noteFile);
    try {
      const content = await readFile(notePath, 'utf8');
      const updated = markComplete(content, task.lineNumber, task.lineStyle);
      if (updated !== content) await writeFile(notePath, updated, 'utf8');
    } catch (err) {
      logger.warn({ taskId: task.id, err }, 'could not write completion back to the note file');
    }
  }

  async #openLog(taskId: string): Promise<WriteStream> {
    const path = logFilePath(this.#config.projectPath, this.#runId, taskId);
    await mkdir(dirname(path), { recursive: true });
    return createWriteStream(path, { flags: 'a' });
  }

  #setStatus(task: Task, status: TaskStatus, error?: string): void {
    task.status = status;
    if (error !== undefined) task.error = error;
    this.#store.updateTask(this.#runId, task.id, {
      status,
      ...(error !== undefined ? { error } : {}),
    });
    this.#store.appendEvent(this.#runId, task.id, status, error ?? '');
  }

  #summarise(): RunSummary {
    const collect = (status: TaskStatus): string[] =>
      this.#tasks.filter((t) => t.status === status).map((t) => t.id);

    const summary: RunSummary = {
      runId: this.#runId,
      done: collect('done'),
      failed: collect('failed'),
      blocked: collect('blocked'),
      skipped: collect('skipped'),
      cancelled: collect('cancelled'),
      ok: false,
    };
    summary.ok =
      summary.failed.length === 0 && summary.blocked.length === 0 && summary.cancelled.length === 0;
    return summary;
  }
}
