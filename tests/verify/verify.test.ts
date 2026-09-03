import { afterEach, describe, expect, it } from 'vitest';
import { makeVerifier, verifyTask } from '../../src/verify/verify.js';
import { makeTask } from '../helpers/fixtures.js';
import { makeTempDir, removeTempDir } from '../helpers/temp.js';

const dirs: string[] = [];

function tempDir(): string {
  const dir = makeTempDir();
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  while (dirs.length > 0) removeTempDir(dirs.pop()!);
});

describe('verifyTask', () => {
  it('passes when the verify command exits zero', async () => {
    const result = await verifyTask({ verifyCommand: 'exit 0' }, tempDir());

    expect(result.passed).toBe(true);
    expect(result.unverified).toBeUndefined();
  });

  it('fails when the verify command exits non-zero, whatever the agent said', async () => {
    const result = await verifyTask({ verifyCommand: 'exit 1' }, tempDir());
    expect(result.passed).toBe(false);
  });

  it('captures command output for the task log', async () => {
    const result = await verifyTask({ verifyCommand: 'echo checking-things' }, tempDir());

    expect(result.passed).toBe(true);
    expect(result.output).toContain('checking-things');
    // The command itself is recorded so a log reader knows what ran.
    expect(result.output).toContain('verify: echo checking-things');
  });

  it('captures output from a failing command', async () => {
    const result = await verifyTask({ verifyCommand: 'echo boom && exit 3' }, tempDir());

    expect(result.passed).toBe(false);
    expect(result.output).toContain('boom');
  });

  it('runs the build command before the verify command', async () => {
    const dir = tempDir();
    const result = await verifyTask(
      { buildCommand: 'echo building', verifyCommand: 'echo verifying' },
      dir,
    );

    expect(result.passed).toBe(true);
    expect(result.output.indexOf('building')).toBeLessThan(result.output.indexOf('verifying'));
  });

  it('does not run the verify command when the build fails', async () => {
    const result = await verifyTask(
      { buildCommand: 'exit 1', verifyCommand: 'echo should-not-appear' },
      tempDir(),
    );

    expect(result.passed).toBe(false);
    expect(result.output).not.toContain('should-not-appear');
  });

  it('marks the task unverified when no command is configured', async () => {
    const result = await verifyTask({}, tempDir());

    expect(result.passed).toBe(true);
    expect(result.unverified).toBe(true);
    expect(result.output).toContain('nothing was checked');
  });

  it('marks it unverified when only a build command is set', async () => {
    // A build proves it compiles, not that it works.
    const result = await verifyTask({ buildCommand: 'exit 0' }, tempDir());

    expect(result.passed).toBe(true);
    expect(result.unverified).toBe(true);
  });

  it('runs the command in the given worktree', async () => {
    const dir = tempDir();
    // `pwd` is not portable to Windows shells; check via node instead.
    const result = await verifyTask(
      { verifyCommand: 'node -e "process.stdout.write(process.cwd())"' },
      dir,
    );

    expect(result.passed).toBe(true);
    expect(result.output.toLowerCase()).toContain(dir.toLowerCase().slice(-12));
  });

  it('turns an unrunnable command into a failure, not a crash', async () => {
    const result = await verifyTask(
      { verifyCommand: 'this-command-definitely-does-not-exist-xyz' },
      tempDir(),
    );

    expect(result.passed).toBe(false);
  });
});

describe('makeVerifier', () => {
  it('binds a config into the shape the orchestrator expects', async () => {
    const verifier = makeVerifier({ verifyCommand: 'exit 0' });
    const result = await verifier(makeTask('a'), tempDir());
    expect(result.passed).toBe(true);
  });

  it('propagates failure', async () => {
    const verifier = makeVerifier({ verifyCommand: 'exit 1' });
    expect((await verifier(makeTask('a'), tempDir())).passed).toBe(false);
  });
});
