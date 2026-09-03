import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  {
    ignores: ['dist/**', 'node_modules/**', 'coverage/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector: 'ExportDefaultDeclaration',
          message: 'Named exports only, no default exports.',
        },
      ],
    },
  },
  {
    // Config files at the repo root are allowed default exports.
    files: ['*.config.ts', '*.config.js'],
    rules: { 'no-restricted-syntax': 'off' },
  },
  {
    // No console.log in src/ — diagnostics go through the pino logger. The
    // exceptions are the two modules whose whole job is user-facing terminal
    // output: the ink TUI, and the CLI's print helpers.
    files: ['src/**/*.ts', 'src/**/*.tsx'],
    ignores: ['src/cli/tui.tsx', 'src/cli/output.ts'],
    rules: {
      'no-console': 'error',
    },
  },
);
