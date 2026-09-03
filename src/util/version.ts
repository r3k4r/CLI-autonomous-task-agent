import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * NOTE: read package.json at runtime rather than importing it, so the bundled
 * CLI does not inline a version that goes stale relative to the published package.
 */
export function readVersion(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const candidate of [
    join(here, '..', '..', 'package.json'),
    join(here, '..', 'package.json'),
  ]) {
    try {
      const raw = readFileSync(candidate, 'utf8');
      const parsed: unknown = JSON.parse(raw);
      if (
        typeof parsed === 'object' &&
        parsed !== null &&
        'version' in parsed &&
        typeof (parsed as { version: unknown }).version === 'string'
      ) {
        return (parsed as { version: string }).version;
      }
    } catch {
      // try the next candidate
    }
  }
  return '0.0.0';
}
