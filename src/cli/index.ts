import { realpathSync } from 'node:fs';
import { argv, cwd, exit } from 'node:process';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';
import { AgentrunError } from '../util/errors.js';
import {
  addCommand,
  cleanCommand,
  initCommand,
  listCommand,
  logsCommand,
  retryCommand,
  runCommand,
  statusCommand,
  stopCommand,
  type CommandContext,
} from './commands.js';
import { print, printError } from './output.js';
import { readVersion } from '../util/version.js';

function context(options: { noColor?: boolean } = {}): CommandContext {
  const ctx: CommandContext = { projectPath: cwd() };
  if (options.noColor) ctx.color = false;
  return ctx;
}

function emit(lines: readonly string[]): void {
  for (const line of lines) print(line);
}

export function buildProgram(): Command {
  const program = new Command();
  program
    .name('agentrun')
    .description('Run AI coding agents from a plain note file, one per task, in git worktrees.')
    .version(readVersion(), '-v, --version', 'print the version');

  program
    .command('init')
    .description('create the note file and config, and gitignore .agentrun/')
    .action(async () => {
      emit(await initCommand(context()));
    });

  program
    .command('add')
    .argument('<title>', 'what you want done')
    .description("append a task in the note file's dominant style")
    .action(async (title: string) => {
      emit(await addCommand(context(), title));
    });

  program
    .command('list')
    .description('print parsed tasks, statuses and dependencies')
    .option('--no-color', 'disable colour output')
    .action(async (options: { color?: boolean }) => {
      emit(await listCommand(context({ noColor: options.color === false })));
    });

  program
    .command('run')
    .description('run the tasks in the note file')
    .option('-p, --parallel <n>', 'how many agents to run at once', (value) => Number(value))
    .option('--provider <name>', "which agent to use ('mock' or 'claude-code')")
    .option('--dry-run', 'print the execution plan and exit without spawning anything')
    .option('--no-tui', 'plain line output instead of the live table')
    .option('--no-color', 'disable colour output')
    .action(
      async (options: {
        parallel?: number;
        provider?: string;
        dryRun?: boolean;
        tui?: boolean;
        color?: boolean;
      }) => {
        const runOptions: Parameters<typeof runCommand>[1] = {};
        if (options.parallel !== undefined) runOptions.parallel = options.parallel;
        if (options.provider !== undefined) runOptions.provider = options.provider;
        if (options.dryRun) runOptions.dryRun = true;
        if (options.tui === false) runOptions.noTui = true;

        emit(await runCommand(context({ noColor: options.color === false }), runOptions));
      },
    );

  program
    .command('status')
    .description('the current run state, readable from any terminal')
    .option('--no-color', 'disable colour output')
    .action(async (options: { color?: boolean }) => {
      emit(await statusCommand(context({ noColor: options.color === false })));
    });

  program
    .command('logs')
    .argument('<taskId>')
    .description("print a task's log")
    .action(async (taskId: string) => {
      emit(await logsCommand(context(), taskId));
    });

  program
    .command('retry')
    .argument('<taskId>')
    .description('reset a failed task and run it again')
    .action(async (taskId: string) => {
      emit(await retryCommand(context(), taskId));
    });

  program
    .command('stop')
    .description('stop the active run')
    .action(async () => {
      emit(await stopCommand(context()));
    });

  program
    .command('clean')
    .description('prune worktrees and branches from finished runs')
    .action(async () => {
      emit(await cleanCommand(context()));
    });

  return program;
}

export async function main(args: readonly string[]): Promise<void> {
  try {
    await buildProgram().parseAsync([...args]);
  } catch (cause) {
    // Typed errors carry a message written for the user; anything else is a bug
    // and deserves its stack.
    if (cause instanceof AgentrunError) {
      printError(`agentrun: ${cause.message}`);
      exit(1);
    }
    throw cause;
  }
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
