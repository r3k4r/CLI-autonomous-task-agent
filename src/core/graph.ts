import { CyclicDependencyError, UnknownDependencyError } from '../util/errors.js';
import type { Task } from './types.js';

/**
 * Dependency graph helpers. Pure functions — no I/O, no side effects.
 */

/** Throw if any `#needs:` names a task that is not in the file. */
export function assertKnownDependencies(tasks: readonly Task[]): void {
  const ids = new Set(tasks.map((t) => t.id));
  for (const task of tasks) {
    for (const dep of task.dependsOn) {
      if (!ids.has(dep)) throw new UnknownDependencyError(task.id, dep);
    }
  }
}

/**
 * Throw if the graph contains a cycle, naming the tasks involved.
 *
 * Depth-first search over the graph, tracking the current path so the error can
 * report the actual cycle rather than just "a cycle exists".
 */
export function assertNoCycles(tasks: readonly Task[]): void {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const visited = new Set<string>();
  const onPath = new Set<string>();
  const path: string[] = [];

  const visit = (id: string): void => {
    if (visited.has(id)) return;

    if (onPath.has(id)) {
      const start = path.indexOf(id);
      throw new CyclicDependencyError([...path.slice(start), id]);
    }

    onPath.add(id);
    path.push(id);

    for (const dep of byId.get(id)?.dependsOn ?? []) {
      if (byId.has(dep)) visit(dep);
    }

    path.pop();
    onPath.delete(id);
    visited.add(id);
  };

  for (const task of tasks) visit(task.id);
}

/** Validate a task list before a run starts. */
export function validateGraph(tasks: readonly Task[]): void {
  assertKnownDependencies(tasks);
  assertNoCycles(tasks);
}

/**
 * Group tasks into waves: everything in wave N can run in parallel once every
 * earlier wave is done. Used by `--dry-run` to show the execution plan.
 *
 * Tasks that will never run (skipped, already done) are not included.
 */
export function executionWaves(tasks: readonly Task[]): Task[][] {
  validateGraph(tasks);

  const runnable = tasks.filter((t) => t.status !== 'skipped' && t.status !== 'done');
  const satisfied = new Set(tasks.filter((t) => t.status === 'done').map((t) => t.id));
  const remaining = new Map(runnable.map((t) => [t.id, t]));
  const waves: Task[][] = [];

  while (remaining.size > 0) {
    const wave = [...remaining.values()].filter((task) =>
      task.dependsOn.every((dep) => satisfied.has(dep) || !remaining.has(dep)),
    );

    // validateGraph rules out cycles, so a wave can only be empty if a
    // dependency is unsatisfiable — treat the rest as one final wave.
    if (wave.length === 0) {
      waves.push([...remaining.values()]);
      break;
    }

    for (const task of wave) {
      remaining.delete(task.id);
      satisfied.add(task.id);
    }
    waves.push(wave);
  }

  return waves;
}

/**
 * Every task that transitively depends on `taskId`. Used to mark the fallout of
 * a permanent failure as blocked.
 */
export function dependents(tasks: readonly Task[], taskId: string): string[] {
  const found = new Set<string>();
  let changed = true;

  while (changed) {
    changed = false;
    for (const task of tasks) {
      if (found.has(task.id)) continue;
      if (task.dependsOn.some((dep) => dep === taskId || found.has(dep))) {
        found.add(task.id);
        changed = true;
      }
    }
  }

  return [...found];
}
