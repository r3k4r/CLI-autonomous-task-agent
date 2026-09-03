import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/cli/index.ts'],
  format: ['esm'],
  target: 'node20',
  platform: 'node',
  clean: true,
  sourcemap: true,
  dts: false,
  splitting: false,
  banner: { js: '#!/usr/bin/env node' },
  // NOTE: better-sqlite3 is a native addon; tsup must not try to bundle it.
  external: ['better-sqlite3', 'hono', 'grammy'],
});
