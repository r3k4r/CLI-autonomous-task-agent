import { realpathSync } from 'node:fs';
import { argv } from 'node:process';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';
import { readVersion } from '../util/version.js';

export function buildProgram(): Command {
  const program = new Command();
  program
    .name('agentrun')
    .description('Run AI coding agents from a plain note file, one per task, in git worktrees.')
    .version(readVersion(), '-v, --version', 'print the version');
  return program;
}

export async function main(args: readonly string[]): Promise<void> {
  await buildProgram().parseAsync([...args]);
}

/**
 * NOTE: the entry file is also imported by tests, so only parse argv when this
 * module is the process entry point.
 */
function isEntryPoint(): boolean {
  const entry = argv[1];
  if (entry === undefined) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  await main(argv);
}
