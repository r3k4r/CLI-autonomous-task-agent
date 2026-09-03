import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CONFIG_FILENAME,
  DEFAULTS,
  loadConfig,
  loadConfigFile,
  parseConfig,
  resolveConfig,
} from '../../src/core/config.js';
import { ConfigError } from '../../src/util/errors.js';
import { makeTempDir, removeTempDir } from '../helpers/temp.js';

describe('parseConfig', () => {
  it('accepts an empty object', () => {
    expect(parseConfig('{}')).toEqual({});
  });

  it('accepts every known setting', () => {
    const parsed = parseConfig(
      JSON.stringify({
        noteFile: 'notes.txt',
        provider: 'claude-code',
        parallel: 4,
        maxAttempts: 3,
        writeBack: 'none',
        verifyCommand: 'bun run test',
        buildCommand: 'bun run build',
        baseBranch: 'develop',
        billing: 'api',
        timeoutMs: 1000,
      }),
    );
    expect(parsed.provider).toBe('claude-code');
    expect(parsed.billing).toBe('api');
  });

  it('throws a ConfigError on malformed JSON', () => {
    expect(() => parseConfig('{ not json')).toThrow(ConfigError);
  });

  it('rejects an unknown setting rather than silently ignoring it', () => {
    expect(() => parseConfig('{"parralel": 4}')).toThrow(ConfigError);
  });

  it('rejects a wrongly typed setting and names it', () => {
    expect(() => parseConfig('{"parallel": "lots"}')).toThrow(/parallel/);
    expect(() => parseConfig('{"parallel": 0}')).toThrow(ConfigError);
    expect(() => parseConfig('{"writeBack": "sometimes"}')).toThrow(ConfigError);
  });
});

describe('resolveConfig', () => {
  it('falls back to defaults when the file is empty', () => {
    const config = resolveConfig('/p', {});
    expect(config.noteFile).toBe(DEFAULTS.noteFile);
    expect(config.provider).toBe('mock');
    expect(config.parallel).toBe(1);
    expect(config.maxAttempts).toBe(2);
    expect(config.writeBack).toBe('auto');
    expect(config.baseBranch).toBe('main');
    expect(config.projectPath).toBe('/p');
  });

  it('defaults billing to subscription so the API key gets stripped', () => {
    expect(resolveConfig('/p', {}).billing).toBe('subscription');
    expect(resolveConfig('/p', { billing: 'api' }).billing).toBe('api');
  });

  it('lets the file override defaults', () => {
    const config = resolveConfig('/p', { parallel: 5, provider: 'claude-code' });
    expect(config.parallel).toBe(5);
    expect(config.provider).toBe('claude-code');
  });

  it('lets CLI overrides beat the file', () => {
    const config = resolveConfig('/p', { parallel: 5, provider: 'claude-code' }, { parallel: 2 });
    expect(config.parallel).toBe(2);
    expect(config.provider).toBe('claude-code');
  });

  it('omits optional commands entirely when unset', () => {
    const config = resolveConfig('/p', {});
    expect('verifyCommand' in config).toBe(false);
    expect('buildCommand' in config).toBe(false);
  });

  it('carries through verify and build commands when set', () => {
    const config = resolveConfig('/p', { verifyCommand: 'bun run test' });
    expect(config.verifyCommand).toBe('bun run test');
  });
});

describe('loadConfigFile', () => {
  let dir: string;

  beforeEach(() => {
    dir = makeTempDir();
  });

  afterEach(() => {
    removeTempDir(dir);
  });

  it('treats an absent config file as empty, not an error', async () => {
    await expect(loadConfigFile(dir)).resolves.toEqual({});
  });

  it('reads a config file from the project directory', async () => {
    await writeFile(join(dir, CONFIG_FILENAME), JSON.stringify({ parallel: 3 }), 'utf8');
    await expect(loadConfigFile(dir)).resolves.toEqual({ parallel: 3 });
  });

  it('surfaces a malformed config file as a ConfigError', async () => {
    await writeFile(join(dir, CONFIG_FILENAME), '{ nope', 'utf8');
    await expect(loadConfigFile(dir)).rejects.toThrow(ConfigError);
  });

  it('loadConfig layers file settings over defaults', async () => {
    await writeFile(join(dir, CONFIG_FILENAME), JSON.stringify({ parallel: 7 }), 'utf8');
    const config = await loadConfig(dir, { provider: 'mock' });
    expect(config.parallel).toBe(7);
    expect(config.provider).toBe('mock');
    expect(config.projectPath).toBe(dir);
  });
});
