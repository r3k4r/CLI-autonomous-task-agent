/**
 * Typed error classes. Never `throw new Error('string')` for anything a user might see.
 */

export class AgentrunError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = new.target.name;
    this.code = code;
  }
}

export class ConfigError extends AgentrunError {
  constructor(message: string) {
    super('CONFIG', message);
  }
}

export class ParseError extends AgentrunError {
  constructor(message: string) {
    super('PARSE', message);
  }
}

export class StoreError extends AgentrunError {
  constructor(message: string) {
    super('STORE', message);
  }
}

export class GitError extends AgentrunError {
  constructor(message: string) {
    super('GIT', message);
  }
}

export class NotARepositoryError extends AgentrunError {
  constructor(path: string) {
    super('GIT_NOT_A_REPO', `Not a git repository: ${path}`);
  }
}

export class DirtyWorkingTreeError extends AgentrunError {
  constructor(path: string) {
    super(
      'GIT_DIRTY',
      `The working tree at ${path} has uncommitted changes. Commit or stash them before running agents.`,
    );
  }
}

export class BranchExistsError extends AgentrunError {
  constructor(branch: string) {
    super(
      'GIT_BRANCH_EXISTS',
      `Branch ${branch} already exists. Run \`agentrun clean\` or delete it manually.`,
    );
  }
}

export class MergeConflictError extends AgentrunError {
  constructor(branch: string, details: string) {
    super(
      'GIT_MERGE_CONFLICT',
      `Merging ${branch} produced a conflict. The merge was aborted and the branch was kept.\n${details}`,
    );
  }
}

export class ProviderError extends AgentrunError {
  constructor(message: string) {
    super('PROVIDER', message);
  }
}

export class UnknownProviderError extends AgentrunError {
  constructor(name: string, known: readonly string[]) {
    super('PROVIDER_UNKNOWN', `Unknown provider '${name}'. Known providers: ${known.join(', ')}.`);
  }
}

export class CyclicDependencyError extends AgentrunError {
  constructor(cycle: readonly string[]) {
    super('GRAPH_CYCLE', `Cyclic task dependency: ${cycle.join(' -> ')}.`);
  }
}

export class UnknownDependencyError extends AgentrunError {
  constructor(taskId: string, missing: string) {
    super(
      'GRAPH_UNKNOWN_DEP',
      `Task '${taskId}' depends on '${missing}', which is not a task in the note file.`,
    );
  }
}

export class TaskNotFoundError extends AgentrunError {
  constructor(taskId: string) {
    super('TASK_NOT_FOUND', `No task with id '${taskId}'.`);
  }
}

export class NoActiveRunError extends AgentrunError {
  constructor() {
    super('NO_ACTIVE_RUN', 'There is no active run.');
  }
}

export class VerificationError extends AgentrunError {
  constructor(message: string) {
    super('VERIFY', message);
  }
}
