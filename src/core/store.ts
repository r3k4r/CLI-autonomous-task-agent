import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { StoreError } from '../util/errors.js';
import type { RunConfig, Task, TaskStatus } from './types.js';

/**
 * Run state, persisted so `agentrun status` works from another terminal and a
 * crash does not lose everything.
 *
 * NOTE: better-sqlite3 is synchronous by design — this is the one module where
 * sync I/O is intentional. Agent output goes to log files, never into the DB.
 */

export type RunStatus = 'running' | 'finished' | 'stopped';

export interface Run {
  id: string;
  config: RunConfig;
  status: RunStatus;
  startedAt: number;
  finishedAt?: number;
}

export interface TaskEvent {
  id: number;
  taskId: string;
  type: string;
  message: string;
  at: number;
}

/** The mutable slice of a task. Ids, line numbers and styles never change. */
export type TaskPatch = Partial<
  Pick<
    Task,
    | 'status'
    | 'attempts'
    | 'branch'
    | 'worktreePath'
    | 'startedAt'
    | 'finishedAt'
    | 'error'
    | 'model'
  >
>;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS runs (
  id          TEXT PRIMARY KEY,
  config      TEXT NOT NULL,
  status      TEXT NOT NULL,
  startedAt   INTEGER NOT NULL,
  finishedAt  INTEGER
);

CREATE TABLE IF NOT EXISTS tasks (
  runId        TEXT NOT NULL,
  id           TEXT NOT NULL,
  title        TEXT NOT NULL,
  details      TEXT NOT NULL,
  status       TEXT NOT NULL,
  dependsOn    TEXT NOT NULL,
  model        TEXT,
  attempts     INTEGER NOT NULL,
  maxAttempts  INTEGER NOT NULL,
  branch       TEXT,
  worktreePath TEXT,
  startedAt    INTEGER,
  finishedAt   INTEGER,
  error        TEXT,
  lineNumber   INTEGER NOT NULL,
  lineStyle    TEXT NOT NULL,
  PRIMARY KEY (runId, id)
);

CREATE TABLE IF NOT EXISTS events (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  runId   TEXT NOT NULL,
  taskId  TEXT NOT NULL,
  type    TEXT NOT NULL,
  message TEXT NOT NULL,
  at      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_events_task ON events (runId, taskId, id);
`;

interface RunRow {
  id: string;
  config: string;
  status: string;
  startedAt: number;
  finishedAt: number | null;
}

interface TaskRow {
  runId: string;
  id: string;
  title: string;
  details: string;
  status: string;
  dependsOn: string;
  model: string | null;
  attempts: number;
  maxAttempts: number;
  branch: string | null;
  worktreePath: string | null;
  startedAt: number | null;
  finishedAt: number | null;
  error: string | null;
  lineNumber: number;
  lineStyle: string;
}

interface EventRow {
  id: number;
  taskId: string;
  type: string;
  message: string;
  at: number;
}

function parseJsonArray(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

function rowToTask(row: TaskRow): Task {
  const task: Task = {
    id: row.id,
    title: row.title,
    details: parseJsonArray(row.details),
    status: row.status as TaskStatus,
    dependsOn: parseJsonArray(row.dependsOn),
    attempts: row.attempts,
    maxAttempts: row.maxAttempts,
    lineNumber: row.lineNumber,
    lineStyle: row.lineStyle as Task['lineStyle'],
  };
  if (row.model !== null) task.model = row.model;
  if (row.branch !== null) task.branch = row.branch;
  if (row.worktreePath !== null) task.worktreePath = row.worktreePath;
  if (row.startedAt !== null) task.startedAt = row.startedAt;
  if (row.finishedAt !== null) task.finishedAt = row.finishedAt;
  if (row.error !== null) task.error = row.error;
  return task;
}

/** Where agentrun keeps its state for a project. */
export function agentrunDir(projectPath: string): string {
  return join(projectPath, '.agentrun');
}

/** Per-task log file path: `.agentrun/logs/<runId>/<taskId>.log`. */
export function logFilePath(projectPath: string, runId: string, taskId: string): string {
  return join(agentrunDir(projectPath), 'logs', runId, `${taskId}.log`);
}

export class Store {
  readonly #db: Database.Database;

  private constructor(db: Database.Database) {
    this.#db = db;
  }

  /** Open (creating if needed) the state DB at `.agentrun/state.db`. */
  static open(projectPath: string): Store {
    const path = join(agentrunDir(projectPath), 'state.db');
    try {
      mkdirSync(dirname(path), { recursive: true });
      const db = new Database(path);
      // WAL lets `agentrun status` read while a run is writing.
      db.pragma('journal_mode = WAL');
      // Wait rather than throwing when another process holds the write lock.
      db.pragma('busy_timeout = 5000');
      db.pragma('foreign_keys = ON');
      db.exec(SCHEMA);
      return new Store(db);
    } catch (cause) {
      throw new StoreError(
        `Could not open the state database at ${path}: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }
  }

  close(): void {
    this.#db.close();
  }

  createRun(id: string, config: RunConfig, tasks: readonly Task[]): Run {
    const startedAt = Date.now();

    const insertRun = this.#db.prepare(
      `INSERT INTO runs (id, config, status, startedAt, finishedAt)
       VALUES (?, ?, 'running', ?, NULL)`,
    );
    const insertTask = this.#db.prepare(
      `INSERT INTO tasks (
         runId, id, title, details, status, dependsOn, model, attempts, maxAttempts,
         branch, worktreePath, startedAt, finishedAt, error, lineNumber, lineStyle
       ) VALUES (
         @runId, @id, @title, @details, @status, @dependsOn, @model, @attempts, @maxAttempts,
         @branch, @worktreePath, @startedAt, @finishedAt, @error, @lineNumber, @lineStyle
       )`,
    );

    const write = this.#db.transaction(() => {
      insertRun.run(id, JSON.stringify(config), startedAt);
      for (const task of tasks) {
        insertTask.run({
          runId: id,
          id: task.id,
          title: task.title,
          details: JSON.stringify(task.details),
          status: task.status,
          dependsOn: JSON.stringify(task.dependsOn),
          model: task.model ?? null,
          attempts: task.attempts,
          maxAttempts: task.maxAttempts,
          branch: task.branch ?? null,
          worktreePath: task.worktreePath ?? null,
          startedAt: task.startedAt ?? null,
          finishedAt: task.finishedAt ?? null,
          error: task.error ?? null,
          lineNumber: task.lineNumber,
          lineStyle: task.lineStyle,
        });
      }
    });
    write();

    return { id, config, status: 'running', startedAt };
  }

  getRun(id: string): Run | undefined {
    const row = this.#db.prepare('SELECT * FROM runs WHERE id = ?').get(id) as RunRow | undefined;
    return row ? this.#rowToRun(row) : undefined;
  }

  /** The most recently started run that is still running, if any. */
  getActiveRun(): Run | undefined {
    const row = this.#db
      .prepare(`SELECT * FROM runs WHERE status = 'running' ORDER BY startedAt DESC LIMIT 1`)
      .get() as RunRow | undefined;
    return row ? this.#rowToRun(row) : undefined;
  }

  /** The most recently started run whatever its status. */
  getLatestRun(): Run | undefined {
    const row = this.#db.prepare('SELECT * FROM runs ORDER BY startedAt DESC LIMIT 1').get() as
      RunRow | undefined;
    return row ? this.#rowToRun(row) : undefined;
  }

  listRuns(): Run[] {
    const rows = this.#db.prepare('SELECT * FROM runs ORDER BY startedAt DESC').all() as RunRow[];
    return rows.map((row) => this.#rowToRun(row));
  }

  finishRun(id: string, status: Exclude<RunStatus, 'running'>): void {
    this.#db
      .prepare('UPDATE runs SET status = ?, finishedAt = ? WHERE id = ?')
      .run(status, Date.now(), id);
  }

  listTasks(runId: string): Task[] {
    const rows = this.#db
      .prepare('SELECT * FROM tasks WHERE runId = ? ORDER BY lineNumber')
      .all(runId) as TaskRow[];
    return rows.map(rowToTask);
  }

  getTask(runId: string, taskId: string): Task | undefined {
    const row = this.#db
      .prepare('SELECT * FROM tasks WHERE runId = ? AND id = ?')
      .get(runId, taskId) as TaskRow | undefined;
    return row ? rowToTask(row) : undefined;
  }

  /**
   * Patch the mutable fields of a task. Unknown keys are ignored rather than
   * building SQL from caller-supplied names.
   */
  updateTask(runId: string, taskId: string, patch: TaskPatch): void {
    const columns: Array<keyof TaskPatch> = [
      'status',
      'attempts',
      'branch',
      'worktreePath',
      'startedAt',
      'finishedAt',
      'error',
      'model',
    ];

    const assignments: string[] = [];
    const values: Array<string | number | null> = [];
    for (const column of columns) {
      if (!(column in patch)) continue;
      const value = patch[column];
      assignments.push(`${column} = ?`);
      values.push(value === undefined ? null : value);
    }
    if (assignments.length === 0) return;

    values.push(runId, taskId);
    this.#db
      .prepare(`UPDATE tasks SET ${assignments.join(', ')} WHERE runId = ? AND id = ?`)
      .run(...values);
  }

  appendEvent(runId: string, taskId: string, type: string, message: string): void {
    this.#db
      .prepare('INSERT INTO events (runId, taskId, type, message, at) VALUES (?, ?, ?, ?, ?)')
      .run(runId, taskId, type, message, Date.now());
  }

  listEvents(runId: string, taskId?: string): TaskEvent[] {
    const rows = (
      taskId === undefined
        ? this.#db
            .prepare('SELECT id, taskId, type, message, at FROM events WHERE runId = ? ORDER BY id')
            .all(runId)
        : this.#db
            .prepare(
              'SELECT id, taskId, type, message, at FROM events WHERE runId = ? AND taskId = ? ORDER BY id',
            )
            .all(runId, taskId)
    ) as EventRow[];
    return rows.map((row) => ({
      id: row.id,
      taskId: row.taskId,
      type: row.type,
      message: row.message,
      at: row.at,
    }));
  }

  #rowToRun(row: RunRow): Run {
    let config: RunConfig;
    try {
      config = JSON.parse(row.config) as RunConfig;
    } catch (cause) {
      throw new StoreError(
        `Run ${row.id} has unreadable stored config: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }
    const run: Run = {
      id: row.id,
      config,
      status: row.status as RunStatus,
      startedAt: row.startedAt,
    };
    if (row.finishedAt !== null) run.finishedAt = row.finishedAt;
    return run;
  }
}
