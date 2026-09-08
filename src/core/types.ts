export type TaskStatus =
  | 'pending' // not started
  | 'blocked' // a dependency failed, will never run
  | 'running' // an agent is working on it
  | 'verifying' // agent finished, running checks
  | 'done' // verified successfully
  | 'failed' // agent or verification failed
  | 'skipped' // #skip tag
  | 'cancelled';

export type LineStyle = 'checkbox' | 'bullet' | 'numbered' | 'todo' | 'plain';

export interface Task {
  id: string;
  title: string; // markers and tags stripped
  details: string[]; // indented continuation lines
  status: TaskStatus;
  dependsOn: string[];
  model?: string;
  attempts: number;
  maxAttempts: number; // default 2
  branch?: string; // agent/<id>
  worktreePath?: string;
  files?: string[]; // workspace mode: paths this task changed
  startedAt?: number;
  finishedAt?: number;
  error?: string;
  lineNumber: number; // 0-indexed line in the note file
  lineStyle: LineStyle; // how to write completion back
}

/**
 * Where agents do their work.
 *
 * - 'worktree': each task gets an isolated checkout on its own `agent/<id>`
 *   branch. Safe and parallelisable; the work has to be merged afterwards.
 * - 'workspace': tasks edit the project's own working tree, one after another,
 *   leaving the changes uncommitted for review. Each task therefore sees what
 *   the previous one did, which is the point — but it forces `parallel: 1` and
 *   the changes are not isolated by git.
 */
export type WorkMode = 'worktree' | 'workspace';

export interface RunConfig {
  projectPath: string;
  noteFile: string; // default 'tasks.md'
  provider: string; // 'mock' | 'claude-code'
  parallel: number; // default 1
  maxAttempts: number; // default 2
  writeBack: 'auto' | 'none';
  verifyCommand?: string; // e.g. 'bun run test'
  buildCommand?: string;
  baseBranch: string; // default 'main'
  mode: WorkMode; // default 'worktree'
}
