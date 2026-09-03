import { Box, Text, render } from 'ink';
import React, { useEffect, useState } from 'react';
import type { Orchestrator, RunSummary } from '../core/orchestrator.js';
import type { Task, TaskStatus } from '../core/types.js';
import { statusSymbol } from './output.js';

/**
 * The live table shown while `agentrun run` works.
 *
 * Falls back to plain line output when stdout is not a TTY or `--no-tui` is
 * passed — see `shouldUseTui`. Ink is the only place in src/ allowed to render
 * directly to the terminal.
 */

export function shouldUseTui(noTui: boolean | undefined): boolean {
  if (noTui) return false;
  return process.stdout.isTTY === true;
}

type Row = Pick<Task, 'id' | 'title' | 'status'>;

function colorFor(status: TaskStatus): string {
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
    default:
      return 'gray';
  }
}

interface TableProps {
  orchestrator: Orchestrator;
  initial: Row[];
}

function RunTable({ orchestrator, initial }: TableProps): React.ReactElement {
  const [rows, setRows] = useState<Row[]>(initial);
  const [summary, setSummary] = useState<RunSummary | undefined>();

  useEffect(() => {
    const patch = (id: string, status: TaskStatus): void => {
      setRows((current) => current.map((row) => (row.id === id ? { ...row, status } : row)));
    };

    orchestrator.on('taskStart', (e) => patch(e.task.id, 'running'));
    orchestrator.on('taskEnd', (e) => patch(e.task.id, e.status));
    orchestrator.on('runEnd', (e) => setSummary(e));
  }, [orchestrator]);

  const width = Math.max(...rows.map((row) => row.id.length), 4);

  return (
    <Box flexDirection="column">
      {rows.map((row) => (
        <Box key={row.id}>
          <Text color={colorFor(row.status)}>[{statusSymbol(row.status)}] </Text>
          <Text>{row.id.padEnd(width)} </Text>
          <Text dimColor>{row.title}</Text>
        </Box>
      ))}
      {summary ? (
        <Box marginTop={1}>
          <Text color={summary.ok ? 'green' : 'red'}>
            {summary.ok
              ? `all ${summary.done.length} task(s) done`
              : `done ${summary.done.length}, failed ${summary.failed.length}, blocked ${summary.blocked.length}`}
          </Text>
        </Box>
      ) : null}
    </Box>
  );
}

/** Render the live table for a run and resolve once it has been drawn out. */
export async function renderRun(orchestrator: Orchestrator, tasks: Task[]): Promise<void> {
  const initial: Row[] = tasks.map((task) => ({
    id: task.id,
    title: task.title,
    status: task.status,
  }));

  const instance = render(<RunTable orchestrator={orchestrator} initial={initial} />);
  await new Promise<void>((resolve) => {
    orchestrator.on('runEnd', () => {
      // Let the final frame paint before tearing the tree down.
      setTimeout(() => {
        instance.unmount();
        resolve();
      }, 50);
    });
  });
  await instance.waitUntilExit();
}
