import { execa } from 'execa';
import type { RunConfig, Task } from '../core/types.js';
import { logger } from '../util/logger.js';

/**
 * Verification: the thing that decides whether a task is actually done.
 *
 * An agent claiming success proves nothing. The build and verify commands run
 * in the agent's own worktree, and a non-zero exit means failed whatever the
 * agent said about its work.
 */

export interface VerifyOutcome {
  passed: boolean;
  output: string;
  /** True when nothing was actually checked because no command is configured. */
  unverified?: boolean;
}

/** Run one shell command in a worktree, capturing combined output. */
async function runCommand(
  command: string,
  cwd: string,
): Promise<{ ok: boolean; output: string }> {
  logger.debug({ command, cwd }, 'verify command');

  try {
    // shell: true so a configured command reads naturally ('bun run test').
    const result = await execa(command, {
      cwd,
      shell: true,
      reject: false,
      all: true,
      timeout: 10 * 60 * 1000,
    });

    const output = result.all ?? `${result.stdout ?? ''}${result.stderr ?? ''}`;
    if (result.timedOut) {
      return { ok: false, output: `${output}\n[agentrun] '${command}' timed out` };
    }
    return { ok: result.exitCode === 0, output };
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    return { ok: false, output: `[agentrun] could not run '${command}': ${message}` };
  }
}

/**
 * Run `buildCommand` then `verifyCommand` in the worktree.
 *
 * With neither configured, nothing has been checked: the task passes, but is
 * flagged `unverified` so `status` can say so rather than implying a guarantee
 * nobody made.
 */
export async function verifyTask(
  config: Pick<RunConfig, 'buildCommand' | 'verifyCommand'>,
  worktreePath: string,
): Promise<VerifyOutcome> {
  const sections: string[] = [];

  if (config.buildCommand) {
    const build = await runCommand(config.buildCommand, worktreePath);
    sections.push(`[agentrun] build: ${config.buildCommand}\n${build.output}`);
    if (!build.ok) {
      return { passed: false, output: sections.join('\n') };
    }
  }

  if (config.verifyCommand) {
    const verify = await runCommand(config.verifyCommand, worktreePath);
    sections.push(`[agentrun] verify: ${config.verifyCommand}\n${verify.output}`);
    return { passed: verify.ok, output: sections.join('\n') };
  }

  if (sections.length === 0) {
    return {
      passed: true,
      output: '[agentrun] no verifyCommand configured — nothing was checked\n',
      unverified: true,
    };
  }

  // A build succeeded but there is nothing that actually tests the change.
  return { passed: true, output: sections.join('\n'), unverified: true };
}

/** Bind a config into the Verifier shape the orchestrator expects. */
export function makeVerifier(
  config: Pick<RunConfig, 'buildCommand' | 'verifyCommand'>,
): (task: Task, worktreePath: string) => Promise<VerifyOutcome> {
  return (_task, worktreePath) => verifyTask(config, worktreePath);
}
