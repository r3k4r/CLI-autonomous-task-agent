/**
 * The CLI's user-facing output.
 *
 * NOTE: this is the one place in src/ that writes to stdout — the pino logger
 * is for diagnostics, not for the text a user reads. Colour is applied only
 * when stdout is a TTY, so piped output carries no ANSI escapes.
 */

import type { Task, TaskStatus } from '../core/types.js';

export interface OutputOptions {
  /** Overrides TTY detection. Tests pass false to assert clean output. */
  color?: boolean;
}

const CODES = {
  reset: '[0m',
  dim: '[2m',
  bold: '[1m',
  red: '[31m',
  green: '[32m',
  yellow: '[33m',
  blue: '[34m',
  grey: '[90m',
} as const;

export type ColorName = Exclude<keyof typeof CODES, 'reset'>;

export function isColorEnabled(options: OutputOptions = {}): boolean {
  if (options.color !== undefined) return options.color;
  if (process.env.NO_COLOR !== undefined && process.env.NO_COLOR !== '') return false;
  return process.stdout.isTTY === true;
}

export function paint(text: string, color: ColorName, options: OutputOptions = {}): string {
  if (!isColorEnabled(options)) return text;
  return `${CODES[color]}${text}${CODES.reset}`;
}

/** A stable single-character marker per status, readable without colour. */
export function statusSymbol(status: TaskStatus): string {
  switch (status) {
    case 'done':
      return '+';
    case 'failed':
      return 'x';
    case 'running':
      return '>';
    case 'verifying':
      return '?';
    case 'blocked':
      return '-';
    case 'skipped':
      return 's';
    case 'cancelled':
      return 'c';
    case 'pending':
      return '.';
  }
}

export function statusColor(status: TaskStatus): ColorName {
  switch (status) {
    case 'done':
      return 'green';
    case 'failed':
      return 'red';
    case 'running':
    case 'verifying':
      return 'blue';
    case 'blocked':
    case 'cancelled':
      return 'yellow';
    case 'skipped':
    case 'pending':
      return 'grey';
  }
}

/** One task as a single line: `[+] task-id  Title  (needs: a, b)`. */
export function formatTaskLine(task: Task, options: OutputOptions = {}): string {
  const marker = paint(`[${statusSymbol(task.status)}]`, statusColor(task.status), options);
  const id = task.id.padEnd(24);
  const parts = [`${marker} ${id} ${task.title}`];

  if (task.dependsOn.length > 0) {
    parts.push(paint(`(needs: ${task.dependsOn.join(', ')})`, 'grey', options));
  }
  if (task.status === 'failed' && task.error) {
    parts.push(paint(`- ${task.error}`, 'red', options));
  }
  return parts.join('  ');
}

export function print(message = ''): void {
  console.log(message);
}

export function printError(message: string): void {
  console.error(message);
}
