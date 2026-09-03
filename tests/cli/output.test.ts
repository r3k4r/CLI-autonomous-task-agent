import { afterEach, describe, expect, it } from 'vitest';
import { formatTaskLine, isColorEnabled, paint, statusSymbol } from '../../src/cli/output.js';
import { shouldUseTui } from '../../src/cli/tui.js';
import type { TaskStatus } from '../../src/core/types.js';
import { makeTask } from '../helpers/fixtures.js';

// Detecting an escape code is the point of these assertions, so the control
// character is deliberate.
// eslint-disable-next-line no-control-regex
const ANSI = /\[[0-9;]*m/;
const originalIsTty = process.stdout.isTTY;

afterEach(() => {
  process.stdout.isTTY = originalIsTty;
  delete process.env.NO_COLOR;
});

describe('colour handling', () => {
  it('adds no escape codes when colour is off', () => {
    expect(paint('hello', 'red', { color: false })).toBe('hello');
  });

  it('adds escape codes when colour is on', () => {
    expect(paint('hello', 'red', { color: true })).toMatch(ANSI);
  });

  it('is off for a non-TTY stdout', () => {
    process.stdout.isTTY = false;
    expect(isColorEnabled()).toBe(false);
  });

  it('is on for a TTY stdout', () => {
    process.stdout.isTTY = true;
    expect(isColorEnabled()).toBe(true);
  });

  it('respects NO_COLOR even on a TTY', () => {
    process.stdout.isTTY = true;
    process.env.NO_COLOR = '1';
    expect(isColorEnabled()).toBe(false);
  });

  it('lets an explicit option beat TTY detection', () => {
    process.stdout.isTTY = false;
    expect(isColorEnabled({ color: true })).toBe(true);
  });
});

describe('statusSymbol', () => {
  it('gives every status a distinct marker readable without colour', () => {
    const statuses: TaskStatus[] = [
      'pending',
      'blocked',
      'running',
      'verifying',
      'done',
      'failed',
      'skipped',
      'cancelled',
    ];
    const symbols = statuses.map(statusSymbol);
    expect(symbols.every((s) => s.length === 1)).toBe(true);
    expect(new Set(symbols).size).toBe(statuses.length);
  });
});

describe('formatTaskLine', () => {
  it('shows the id and title', () => {
    const line = formatTaskLine(makeTask('login', { title: 'Create a login page' }), {
      color: false,
    });
    expect(line).toContain('login');
    expect(line).toContain('Create a login page');
  });

  it('shows dependencies', () => {
    const line = formatTaskLine(makeTask('b', { dependsOn: ['a', 'c'] }), { color: false });
    expect(line).toContain('needs: a, c');
  });

  it('shows the error for a failed task', () => {
    const line = formatTaskLine(makeTask('a', { status: 'failed', error: 'tests failed' }), {
      color: false,
    });
    expect(line).toContain('tests failed');
  });

  it('emits no ANSI escapes with colour off', () => {
    const line = formatTaskLine(makeTask('a', { status: 'done', dependsOn: ['b'] }), {
      color: false,
    });
    expect(line).not.toMatch(ANSI);
  });
});

describe('shouldUseTui', () => {
  it('is off when --no-tui is passed, even on a TTY', () => {
    process.stdout.isTTY = true;
    expect(shouldUseTui(true)).toBe(false);
  });

  it('is off when stdout is not a TTY', () => {
    process.stdout.isTTY = false;
    expect(shouldUseTui(false)).toBe(false);
    expect(shouldUseTui(undefined)).toBe(false);
  });

  it('is on for an interactive terminal', () => {
    process.stdout.isTTY = true;
    expect(shouldUseTui(undefined)).toBe(true);
  });
});
