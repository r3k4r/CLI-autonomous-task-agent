import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Store, agentrunDir, logFilePath } from '../../src/core/store.js';
import { makeConfig, makeTask } from '../helpers/fixtures.js';
import { makeTempDir, removeTempDir } from '../helpers/temp.js';

describe('Store', () => {
  let dir: string;
  let store: Store;

  beforeEach(() => {
    dir = makeTempDir();
    store = Store.open(dir);
  });

  afterEach(() => {
    store.close();
    removeTempDir(dir);
  });

  it('creates the database under .agentrun in the project directory', () => {
    expect(existsSync(join(agentrunDir(dir), 'state.db'))).toBe(true);
  });

  it('round trips a run and its tasks', () => {
    const config = makeConfig({ projectPath: dir, parallel: 3 });
    const tasks = [
      makeTask('a', { title: 'First', details: ['detail one', 'detail two'], lineNumber: 0 }),
      makeTask('b', { dependsOn: ['a'], model: 'opus', lineNumber: 1, lineStyle: 'checkbox' }),
    ];

    const run = store.createRun('run-1', config, tasks);
    expect(run.status).toBe('running');

    const loaded = store.getRun('run-1');
    expect(loaded?.config.parallel).toBe(3);
    expect(loaded?.config.projectPath).toBe(dir);

    const loadedTasks = store.listTasks('run-1');
    expect(loadedTasks).toHaveLength(2);
    expect(loadedTasks[0]?.title).toBe('First');
    expect(loadedTasks[0]?.details).toEqual(['detail one', 'detail two']);
    expect(loadedTasks[1]?.dependsOn).toEqual(['a']);
    expect(loadedTasks[1]?.model).toBe('opus');
    expect(loadedTasks[1]?.lineStyle).toBe('checkbox');
  });

  it('omits absent optional fields rather than storing undefined', () => {
    store.createRun('run-1', makeConfig(), [makeTask('a')]);
    const task = store.getTask('run-1', 'a');
    expect(task).toBeDefined();
    expect('model' in task!).toBe(false);
    expect('branch' in task!).toBe(false);
    expect('error' in task!).toBe(false);
  });

  it('returns undefined for a run or task that does not exist', () => {
    expect(store.getRun('nope')).toBeUndefined();
    expect(store.getTask('nope', 'a')).toBeUndefined();
    expect(store.listTasks('nope')).toEqual([]);
  });

  it('patches only the fields given', () => {
    store.createRun('run-1', makeConfig(), [makeTask('a', { title: 'Original' })]);

    store.updateTask('run-1', 'a', { status: 'running', startedAt: 1234 });
    let task = store.getTask('run-1', 'a');
    expect(task?.status).toBe('running');
    expect(task?.startedAt).toBe(1234);
    expect(task?.title).toBe('Original');
    expect(task?.attempts).toBe(0);

    store.updateTask('run-1', 'a', { status: 'done', attempts: 1, branch: 'agent/a' });
    task = store.getTask('run-1', 'a');
    expect(task?.status).toBe('done');
    expect(task?.attempts).toBe(1);
    expect(task?.branch).toBe('agent/a');
    // Untouched by the second patch.
    expect(task?.startedAt).toBe(1234);
  });

  it('ignores an empty patch', () => {
    store.createRun('run-1', makeConfig(), [makeTask('a')]);
    expect(() => store.updateTask('run-1', 'a', {})).not.toThrow();
    expect(store.getTask('run-1', 'a')?.status).toBe('pending');
  });

  it('appends and reads back events per task', () => {
    store.createRun('run-1', makeConfig(), [makeTask('a'), makeTask('b')]);

    store.appendEvent('run-1', 'a', 'start', 'agent started');
    store.appendEvent('run-1', 'b', 'start', 'agent started');
    store.appendEvent('run-1', 'a', 'end', 'agent finished');

    const forA = store.listEvents('run-1', 'a');
    expect(forA.map((e) => e.type)).toEqual(['start', 'end']);
    expect(forA[0]?.message).toBe('agent started');

    expect(store.listEvents('run-1')).toHaveLength(3);
  });

  it('tracks the active run and closes it out', () => {
    expect(store.getActiveRun()).toBeUndefined();

    store.createRun('run-1', makeConfig(), [makeTask('a')]);
    expect(store.getActiveRun()?.id).toBe('run-1');

    store.finishRun('run-1', 'finished');
    expect(store.getActiveRun()).toBeUndefined();

    const finished = store.getRun('run-1');
    expect(finished?.status).toBe('finished');
    expect(finished?.finishedAt).toBeTypeOf('number');
    // The finished run is still the latest one.
    expect(store.getLatestRun()?.id).toBe('run-1');
  });

  it('returns the most recent active run when several exist', () => {
    store.createRun('old', makeConfig(), [makeTask('a')]);
    store.finishRun('old', 'finished');
    store.createRun('new', makeConfig(), [makeTask('a')]);

    expect(store.getActiveRun()?.id).toBe('new');
    expect(store.listRuns().map((r) => r.id)).toContain('old');
  });

  it('survives closing and reopening the database', () => {
    store.createRun('run-1', makeConfig({ projectPath: dir }), [makeTask('a')]);
    store.updateTask('run-1', 'a', { status: 'done', branch: 'agent/a' });
    store.appendEvent('run-1', 'a', 'end', 'all good');
    store.close();

    const reopened = Store.open(dir);
    try {
      expect(reopened.getRun('run-1')?.status).toBe('running');
      expect(reopened.getTask('run-1', 'a')?.status).toBe('done');
      expect(reopened.getTask('run-1', 'a')?.branch).toBe('agent/a');
      expect(reopened.listEvents('run-1', 'a')).toHaveLength(1);
    } finally {
      reopened.close();
      // The afterEach hook closes `store`; closing twice is an error.
      store = Store.open(dir);
    }
  });

  it('does not corrupt state when several handles hammer updateTask', () => {
    store.createRun('run-1', makeConfig(), [makeTask('a'), makeTask('b'), makeTask('c')]);

    const handles = [Store.open(dir), Store.open(dir), Store.open(dir)];
    try {
      for (let i = 0; i < 100; i++) {
        for (const [index, handle] of handles.entries()) {
          const taskId = ['a', 'b', 'c'][index]!;
          handle.updateTask('run-1', taskId, { attempts: i, status: 'running' });
          handle.appendEvent('run-1', taskId, 'tick', `iteration ${i}`);
        }
      }
    } finally {
      for (const handle of handles) handle.close();
    }

    for (const taskId of ['a', 'b', 'c']) {
      const task = store.getTask('run-1', taskId);
      expect(task?.attempts, taskId).toBe(99);
      expect(task?.status, taskId).toBe('running');
      expect(store.listEvents('run-1', taskId), taskId).toHaveLength(100);
    }
  });

  it('sees writes made by another handle to the same database', () => {
    store.createRun('run-1', makeConfig(), [makeTask('a')]);

    // This is what `agentrun status` does from a second terminal.
    const reader = Store.open(dir);
    try {
      store.updateTask('run-1', 'a', { status: 'verifying' });
      expect(reader.getTask('run-1', 'a')?.status).toBe('verifying');
    } finally {
      reader.close();
    }
  });

  it('builds per-task log paths under .agentrun/logs/<runId>/', () => {
    expect(logFilePath(dir, 'run-1', 'my-task')).toBe(
      join(dir, '.agentrun', 'logs', 'run-1', 'my-task.log'),
    );
  });
});
