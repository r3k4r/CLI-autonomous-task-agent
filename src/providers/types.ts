import type { Task } from '../core/types.js';

/**
 * The boundary between the orchestrator and any AI agent. Everything an agent
 * needs comes in through AgentContext; everything it reports goes out through
 * AgentResult. Nothing else in the codebase knows what a model is.
 */

export interface AgentContext {
  task: Task; // includes details[]
  worktreePath: string;
  model?: string;
  previousError?: string; // set on retries
  signal: AbortSignal; // for `agentrun stop`
  onOutput: (chunk: string) => void; // streamed to the log file
}

export interface AgentResult {
  success: boolean;
  summary: string;
  error?: string;
  tokensUsed?: { input: number; output: number };
  costUsd?: number;
}

export interface Provider {
  readonly name: string;
  run(ctx: AgentContext): Promise<AgentResult>;
}
