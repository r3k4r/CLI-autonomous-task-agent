import { describe, expect, it } from 'vitest';
import { buildProgram } from '../../src/cli/index.js';
import { readVersion } from '../../src/util/version.js';

describe('cli scaffold', () => {
  it('reads a semver-shaped version from package.json', () => {
    expect(readVersion()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('registers the program name and version', () => {
    const program = buildProgram();
    expect(program.name()).toBe('agentrun');
    expect(program.version()).toBe(readVersion());
  });
});
