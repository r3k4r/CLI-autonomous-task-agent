import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { ConfigError } from '../util/errors.js';
import type { RunConfig } from './types.js';

/**
 * `agentrun.config.json`, all fields optional. Anything absent falls back to a
 * default, so a project with no config file at all still runs.
 */
export const CONFIG_FILENAME = 'agentrun.config.json';

export const DEFAULTS = {
  noteFile: 'tasks.md',
  provider: 'mock',
  parallel: 1,
  maxAttempts: 2,
  writeBack: 'auto',
  baseBranch: 'main',
  billing: 'subscription',
  timeoutMs: 15 * 60 * 1000,
} as const;

const configSchema = z
  .object({
    noteFile: z.string().min(1).optional(),
    provider: z.string().min(1).optional(),
    parallel: z.number().int().positive().optional(),
    maxAttempts: z.number().int().positive().optional(),
    writeBack: z.enum(['auto', 'none']).optional(),
    verifyCommand: z.string().min(1).optional(),
    buildCommand: z.string().min(1).optional(),
    baseBranch: z.string().min(1).optional(),
    /**
     * Subscription billing is the default on purpose: it makes the CLI strip
     * ANTHROPIC_API_KEY from spawned agents. Opting into 'api' is explicit.
     */
    billing: z.enum(['subscription', 'api']).optional(),
    timeoutMs: z.number().int().positive().optional(),
  })
  .strict();

export type FileConfig = z.infer<typeof configSchema>;

/** Everything a run needs, including the fields only some phases care about. */
export interface ResolvedConfig extends RunConfig {
  billing: 'subscription' | 'api';
  timeoutMs: number;
}

/** Parse and validate raw config JSON text. */
export function parseConfig(raw: string): FileConfig {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (cause) {
    throw new ConfigError(
      `${CONFIG_FILENAME} is not valid JSON: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }

  const result = configSchema.safeParse(json);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new ConfigError(`${CONFIG_FILENAME} has invalid settings:\n${issues}`);
  }
  return result.data;
}

/** Read the config file if it exists; an absent file is not an error. */
export async function loadConfigFile(projectPath: string): Promise<FileConfig> {
  try {
    const raw = await readFile(join(projectPath, CONFIG_FILENAME), 'utf8');
    return parseConfig(raw);
  } catch (cause) {
    if (cause instanceof ConfigError) throw cause;
    if (
      typeof cause === 'object' &&
      cause !== null &&
      'code' in cause &&
      (cause as { code: unknown }).code === 'ENOENT'
    ) {
      return {};
    }
    throw new ConfigError(
      `Could not read ${CONFIG_FILENAME}: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
}

/** Layer defaults, the config file, and CLI overrides into a run config. */
export function resolveConfig(
  projectPath: string,
  file: FileConfig,
  overrides: Partial<RunConfig> = {},
): ResolvedConfig {
  const resolved: ResolvedConfig = {
    projectPath,
    noteFile: overrides.noteFile ?? file.noteFile ?? DEFAULTS.noteFile,
    provider: overrides.provider ?? file.provider ?? DEFAULTS.provider,
    parallel: overrides.parallel ?? file.parallel ?? DEFAULTS.parallel,
    maxAttempts: overrides.maxAttempts ?? file.maxAttempts ?? DEFAULTS.maxAttempts,
    writeBack: overrides.writeBack ?? file.writeBack ?? DEFAULTS.writeBack,
    baseBranch: overrides.baseBranch ?? file.baseBranch ?? DEFAULTS.baseBranch,
    billing: file.billing ?? DEFAULTS.billing,
    timeoutMs: file.timeoutMs ?? DEFAULTS.timeoutMs,
  };

  const verifyCommand = overrides.verifyCommand ?? file.verifyCommand;
  if (verifyCommand !== undefined) resolved.verifyCommand = verifyCommand;

  const buildCommand = overrides.buildCommand ?? file.buildCommand;
  if (buildCommand !== undefined) resolved.buildCommand = buildCommand;

  return resolved;
}

/** Load and resolve in one step. */
export async function loadConfig(
  projectPath: string,
  overrides: Partial<RunConfig> = {},
): Promise<ResolvedConfig> {
  return resolveConfig(projectPath, await loadConfigFile(projectPath), overrides);
}
