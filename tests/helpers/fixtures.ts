import type { RunConfig, Task } from '../../src/core/types.js';

export function makeConfig(overrides: Partial<RunConfig> = {}): RunConfig {
  return {
    projectPath: '/tmp/project',
    noteFile: 'tasks.md',
    provider: 'mock',
    parallel: 1,
    maxAttempts: 2,
    writeBack: 'auto',
    baseBranch: 'main',
    ...overrides,
  };
}

export function makeTask(id: string, overrides: Partial<Task> = {}): Task {
  return {
    id,
    title: `Task ${id}`,
    details: [],
    status: 'pending',
    dependsOn: [],
    attempts: 0,
    maxAttempts: 2,
    lineNumber: 0,
    lineStyle: 'plain',
    ...overrides,
  };
}
