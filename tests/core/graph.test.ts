import { describe, expect, it } from 'vitest';
import {
  assertKnownDependencies,
  assertNoCycles,
  dependents,
  executionWaves,
  validateGraph,
} from '../../src/core/graph.js';
import { CyclicDependencyError, UnknownDependencyError } from '../../src/util/errors.js';
import { makeTask } from '../helpers/fixtures.js';

describe('assertKnownDependencies', () => {
  it('accepts a graph where every dependency exists', () => {
    const tasks = [makeTask('a'), makeTask('b', { dependsOn: ['a'] })];
    expect(() => assertKnownDependencies(tasks)).not.toThrow();
  });

  it('names the task and the missing dependency', () => {
    const tasks = [makeTask('b', { dependsOn: ['nope'] })];
    expect(() => assertKnownDependencies(tasks)).toThrow(UnknownDependencyError);
    expect(() => assertKnownDependencies(tasks)).toThrow(/'b'.*'nope'/);
  });
});

describe('assertNoCycles', () => {
  it('accepts a chain and a diamond', () => {
    expect(() =>
      assertNoCycles([
        makeTask('a'),
        makeTask('b', { dependsOn: ['a'] }),
        makeTask('c', { dependsOn: ['a'] }),
        makeTask('d', { dependsOn: ['b', 'c'] }),
      ]),
    ).not.toThrow();
  });

  it('detects a two-task cycle and names it', () => {
    const tasks = [makeTask('a', { dependsOn: ['b'] }), makeTask('b', { dependsOn: ['a'] })];
    expect(() => assertNoCycles(tasks)).toThrow(CyclicDependencyError);
    expect(() => assertNoCycles(tasks)).toThrow(/a|b/);
  });

  it('detects a longer cycle', () => {
    const tasks = [
      makeTask('a', { dependsOn: ['c'] }),
      makeTask('b', { dependsOn: ['a'] }),
      makeTask('c', { dependsOn: ['b'] }),
    ];
    expect(() => assertNoCycles(tasks)).toThrow(CyclicDependencyError);
  });

  it('detects a task depending on itself', () => {
    expect(() => assertNoCycles([makeTask('a', { dependsOn: ['a'] })])).toThrow(
      CyclicDependencyError,
    );
  });
});

describe('executionWaves', () => {
  it('puts independent tasks in a single wave', () => {
    const waves = executionWaves([makeTask('a'), makeTask('b'), makeTask('c')]);
    expect(waves).toHaveLength(1);
    expect(waves[0]?.map((t) => t.id).sort()).toEqual(['a', 'b', 'c']);
  });

  it('puts a chain in one wave per link', () => {
    const waves = executionWaves([
      makeTask('a'),
      makeTask('b', { dependsOn: ['a'] }),
      makeTask('c', { dependsOn: ['b'] }),
    ]);
    expect(waves.map((w) => w.map((t) => t.id))).toEqual([['a'], ['b'], ['c']]);
  });

  it('groups a diamond into three waves', () => {
    const waves = executionWaves([
      makeTask('a'),
      makeTask('b', { dependsOn: ['a'] }),
      makeTask('c', { dependsOn: ['a'] }),
      makeTask('d', { dependsOn: ['b', 'c'] }),
    ]);
    expect(waves.map((w) => w.map((t) => t.id).sort())).toEqual([['a'], ['b', 'c'], ['d']]);
  });

  it('excludes skipped and already-done tasks', () => {
    const waves = executionWaves([
      makeTask('a', { status: 'done' }),
      makeTask('b', { status: 'skipped' }),
      makeTask('c', { dependsOn: ['a'] }),
    ]);
    expect(waves.map((w) => w.map((t) => t.id))).toEqual([['c']]);
  });

  it('throws on a cycle rather than looping forever', () => {
    expect(() =>
      executionWaves([makeTask('a', { dependsOn: ['b'] }), makeTask('b', { dependsOn: ['a'] })]),
    ).toThrow(CyclicDependencyError);
  });
});

describe('dependents', () => {
  it('finds direct and transitive dependents', () => {
    const tasks = [
      makeTask('a'),
      makeTask('b', { dependsOn: ['a'] }),
      makeTask('c', { dependsOn: ['b'] }),
      makeTask('unrelated'),
    ];
    expect(dependents(tasks, 'a').sort()).toEqual(['b', 'c']);
  });

  it('returns nothing for a task nobody depends on', () => {
    expect(dependents([makeTask('a'), makeTask('b')], 'a')).toEqual([]);
  });
});

describe('validateGraph', () => {
  it('checks both unknown dependencies and cycles', () => {
    expect(() => validateGraph([makeTask('a', { dependsOn: ['ghost'] })])).toThrow(
      UnknownDependencyError,
    );
    expect(() =>
      validateGraph([makeTask('a', { dependsOn: ['b'] }), makeTask('b', { dependsOn: ['a'] })]),
    ).toThrow(CyclicDependencyError);
  });
});
