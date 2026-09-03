import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * A temp directory that cleans itself up. Tests must never touch the
 * developer's real `.agentrun/`, so everything stateful goes through here.
 */
export function makeTempDir(prefix = 'agentrun-test-'): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function removeTempDir(path: string): void {
  rmSync(path, { recursive: true, force: true, maxRetries: 3 });
}
