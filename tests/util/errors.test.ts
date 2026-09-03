import { describe, expect, it } from 'vitest';
import {
  AgentrunError,
  BranchExistsError,
  CyclicDependencyError,
  DirtyWorkingTreeError,
  NotARepositoryError,
  UnknownProviderError,
} from '../../src/util/errors.js';

describe('errors', () => {
  it('every typed error is an AgentrunError and an Error', () => {
    const err = new NotARepositoryError('/tmp/x');
    expect(err).toBeInstanceOf(AgentrunError);
    expect(err).toBeInstanceOf(Error);
  });

  it('carries a stable machine-readable code', () => {
    expect(new NotARepositoryError('/tmp/x').code).toBe('GIT_NOT_A_REPO');
    expect(new DirtyWorkingTreeError('/tmp/x').code).toBe('GIT_DIRTY');
    expect(new BranchExistsError('agent/a').code).toBe('GIT_BRANCH_EXISTS');
    expect(new CyclicDependencyError(['a', 'b', 'a']).code).toBe('GRAPH_CYCLE');
  });

  it('sets name to the concrete subclass', () => {
    expect(new BranchExistsError('agent/a').name).toBe('BranchExistsError');
  });

  it('builds messages that name the offending value', () => {
    expect(new NotARepositoryError('/tmp/x').message).toContain('/tmp/x');
    expect(new CyclicDependencyError(['a', 'b', 'a']).message).toContain('a -> b -> a');
    expect(new UnknownProviderError('gpt', ['mock', 'claude-code']).message).toContain(
      'mock, claude-code',
    );
  });
});
