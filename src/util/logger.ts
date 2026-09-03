import pino from 'pino';

/**
 * NOTE: the CLI prints user-facing output itself; the logger is for diagnostics.
 * It writes to stderr so it never mixes into piped command output, and stays
 * silent unless AGENTRUN_LOG_LEVEL is set.
 */
export const logger = pino(
  {
    level: process.env.AGENTRUN_LOG_LEVEL ?? 'silent',
    base: undefined,
  },
  pino.destination(2),
);

export type Logger = typeof logger;
