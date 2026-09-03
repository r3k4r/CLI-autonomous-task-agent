import { describe, expect, it } from 'vitest';
import { buildProgram } from '../../src/cli/index.js';

describe('program wiring', () => {
  const commandNames = (): string[] => buildProgram().commands.map((c) => c.name());

  it('registers every documented command', () => {
    expect(commandNames().sort()).toEqual([
      'add',
      'clean',
      'init',
      'list',
      'logs',
      'merge',
      'retry',
      'run',
      'status',
      'stop',
    ]);
  });

  it('exposes the run flags from the plan', () => {
    const run = buildProgram().commands.find((c) => c.name() === 'run')!;
    const flags = run.options.map((o) => o.long);
    expect(flags).toContain('--parallel');
    expect(flags).toContain('--provider');
    expect(flags).toContain('--dry-run');
    expect(flags).toContain('--no-tui');
  });

  it('requires an argument for the commands that take one', () => {
    const program = buildProgram();
    for (const name of ['add', 'logs', 'retry']) {
      const command = program.commands.find((c) => c.name() === name)!;
      expect(command.registeredArguments, name).toHaveLength(1);
      expect(command.registeredArguments[0]?.required, name).toBe(true);
    }
  });
});
