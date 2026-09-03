import { execa } from 'execa';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { makeTempDir } from './temp.js';

/**
 * A real git repository in os.tmpdir(). Git tests use the real thing — no
 * mocking — so worktree isolation is actually proven.
 */
export async function makeTempRepo(baseBranch = 'main'): Promise<string> {
  const dir = makeTempDir('agentrun-repo-');

  await execa('git', ['init', '--initial-branch', baseBranch], { cwd: dir });
  await execa('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  await execa('git', ['config', 'user.name', 'Test'], { cwd: dir });
  // Keep the test repo independent of the developer's global git settings.
  await execa('git', ['config', 'commit.gpgsign', 'false'], { cwd: dir });

  await writeFile(join(dir, 'README.md'), '# test repo\n', 'utf8');
  await execa('git', ['add', '-A'], { cwd: dir });
  await execa('git', ['commit', '-m', 'initial'], { cwd: dir });

  return dir;
}

export async function gitOutput(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execa('git', args, { cwd });
  return stdout.trim();
}
