import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AgentContext, AgentResult, Provider } from './types.js';

/**
 * A free fake agent. It sleeps, writes one file into the worktree, and reports
 * success — enough to exercise the whole orchestration loop without spending a
 * token. This is the default provider everywhere, including tests.
 *
 * `MOCK_FAIL_TASKS` (comma-separated task ids) makes those tasks fail, so retry
 * and blocking logic is testable.
 */

const DEFAULT_DELAY_MS = 1500;

export interface MockProviderOptions {
  /** How long the fake agent pretends to work. */
  delayMs?: number;
  /** Task ids that should fail. Defaults to reading MOCK_FAIL_TASKS. */
  failTasks?: readonly string[];
}

/** Sleep that settles early — and rejects — when the run is aborted. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error('aborted'));
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    function onAbort(): void {
      clearTimeout(timer);
      reject(new Error('aborted'));
    }
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function failTasksFromEnv(): string[] {
  return (process.env.MOCK_FAIL_TASKS ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter((id) => id !== '');
}

export class MockProvider implements Provider {
  readonly name = 'mock';
  readonly #delayMs: number;
  readonly #failTasks: readonly string[] | undefined;

  constructor(options: MockProviderOptions = {}) {
    this.#delayMs = options.delayMs ?? DEFAULT_DELAY_MS;
    this.#failTasks = options.failTasks;
  }

  async run(ctx: AgentContext): Promise<AgentResult> {
    const { task, worktreePath, onOutput, signal } = ctx;

    onOutput(`[mock] starting task ${task.id}: ${task.title}\n`);
    for (const detail of task.details) {
      onOutput(`[mock] detail: ${detail}\n`);
    }
    if (ctx.previousError) {
      onOutput(`[mock] retrying after: ${ctx.previousError}\n`);
    }

    try {
      await sleep(this.#delayMs, signal);
    } catch {
      onOutput(`[mock] aborted\n`);
      return { success: false, summary: `Task ${task.id} was aborted`, error: 'aborted' };
    }

    const failing = this.#failTasks ?? failTasksFromEnv();
    if (failing.includes(task.id)) {
      onOutput(`[mock] failing task ${task.id} on purpose\n`);
      return {
        success: false,
        summary: `Mock agent failed task ${task.id}`,
        error: `MOCK_FAIL_TASKS includes ${task.id}`,
      };
    }

    // Write something so the orchestrator has a real change to commit.
    await writeFile(
      join(worktreePath, `${task.id}.txt`),
      `${task.title}\n${task.details.join('\n')}\n`,
      'utf8',
    );
    onOutput(`[mock] wrote ${task.id}.txt\n`);

    return {
      success: true,
      summary: `Mock agent completed ${task.id}`,
      tokensUsed: { input: 0, output: 0 },
      costUsd: 0,
    };
  }
}
