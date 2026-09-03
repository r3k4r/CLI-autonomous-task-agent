import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    environment: 'node',
    // NOTE: git worktree tests touch a real temp repo; give them room.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
