import { execa } from 'execa';
import { logger } from '../util/logger.js';
import type { AgentContext, AgentResult, Provider } from './types.js';
import type { ProviderOptions } from './registry.js';

/**
 * Runs the real `claude` CLI in headless mode, one process per task, with cwd
 * set to that task's worktree.
 */

/** Fifteen minutes. A stuck agent is aborted rather than hanging the run. */
const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;

/**
 * Build the environment for the spawned agent.
 *
 * SAFETY: ANTHROPIC_API_KEY is stripped unless billing is explicitly 'api'.
 * Child processes inherit the parent environment, and a leaked key silently
 * converts free Pro/Max subscription runs into per-token billing. Opting into
 * API billing has to be a deliberate choice in agentrun.config.json.
 */
export function buildEnv(
  parent: NodeJS.ProcessEnv,
  billing: 'subscription' | 'api',
): NodeJS.ProcessEnv {
  const env = { ...parent };
  if (billing !== 'api') {
    delete env.ANTHROPIC_API_KEY;
  }
  return env;
}

/** Compose the prompt from the task, its details, and any previous failure. */
export function buildPrompt(ctx: AgentContext): string {
  const parts = [`Task: ${ctx.task.title}`];

  if (ctx.task.details.length > 0) {
    parts.push('', 'Context and constraints:', ...ctx.task.details.map((d) => `- ${d}`));
  }

  if (ctx.previousError) {
    parts.push(
      '',
      'A previous attempt at this task failed with:',
      ctx.previousError,
      'Fix the underlying problem rather than working around it.',
    );
  }

  parts.push(
    '',
    'Work only inside this repository checkout. Do not commit — the changes are',
    'committed for you once they have been verified.',
  );

  return parts.join('\n');
}

/** The arguments passed to `claude`. Exported so tests can assert them. */
export function buildArgs(model: string | undefined): string[] {
  const args = ['--print', '--permission-mode', 'acceptEdits'];
  if (model !== undefined) args.push('--model', model);
  return args;
}

export class ClaudeCodeProvider implements Provider {
  readonly name = 'claude-code';
  readonly #timeoutMs: number;
  readonly #billing: 'subscription' | 'api';

  constructor(options: ProviderOptions = {}) {
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#billing = options.billing ?? 'subscription';
  }

  async run(ctx: AgentContext): Promise<AgentResult> {
    const args = buildArgs(ctx.model ?? ctx.task.model);
    const prompt = buildPrompt(ctx);
    const env = buildEnv(process.env, this.#billing);

    // Log the exact command so a failed run can be reproduced by hand.
    logger.info({ taskId: ctx.task.id, args, cwd: ctx.worktreePath }, 'spawning claude');
    ctx.onOutput(`[agentrun] claude ${args.join(' ')}\n`);

    try {
      const child = execa('claude', args, {
        cwd: ctx.worktreePath,
        env,
        // Not `extendEnv: false` — the agent needs PATH and friends; only the
        // API key is removed, by buildEnv above.
        input: prompt,
        signal: ctx.signal,
        timeout: this.#timeoutMs,
        reject: false,
        all: true,
      });

      child.stdout?.on('data', (chunk: Buffer) => ctx.onOutput(chunk.toString()));
      child.stderr?.on('data', (chunk: Buffer) => ctx.onOutput(chunk.toString()));

      const result = await child;

      if (ctx.signal.aborted) {
        return { success: false, summary: `Task ${ctx.task.id} was aborted`, error: 'aborted' };
      }

      if (result.timedOut) {
        const error = `claude timed out after ${this.#timeoutMs}ms`;
        ctx.onOutput(`[agentrun] ${error}\n`);
        return { success: false, summary: `Task ${ctx.task.id} timed out`, error };
      }

      if (result.exitCode !== 0) {
        const error = `claude exited with code ${result.exitCode}`;
        return {
          success: false,
          summary: `Task ${ctx.task.id} failed`,
          error: `${error}: ${(result.stderr || result.stdout || '').slice(-500)}`,
        };
      }

      // NOTE: the agent's own claim of success is only a claim — the verify
      // command decides whether the task is actually done.
      return {
        success: true,
        summary: summarise(result.stdout ?? '', ctx.task.id),
      };
    } catch (cause) {
      if (ctx.signal.aborted) {
        return { success: false, summary: `Task ${ctx.task.id} was aborted`, error: 'aborted' };
      }
      const message = cause instanceof Error ? cause.message : String(cause);
      return { success: false, summary: `Task ${ctx.task.id} failed to run`, error: message };
    }
  }
}

/** The agent's closing lines make a reasonable one-line summary. */
function summarise(stdout: string, taskId: string): string {
  const lastLine = stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .pop();
  return lastLine ? lastLine.slice(0, 200) : `claude completed ${taskId}`;
}
