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
  startedAt?: number;
  finishedAt?: number;
  error?: string;
  lineNumber: number; // 0-indexed line in the note file
  lineStyle: LineStyle; // how to write completion back
}

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
}
