// Flat ESLint config (ADR 013 follow-on to ADR 004 — strict tsc was the v0.1 gate;
// ESLint now machine-enforces the 07-conventions.md "Lint / format rules").
// Formatting is owned by Prettier; eslint-config-prettier disables stylistic overlap.
import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import importPlugin from 'eslint-plugin-import';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    // packages/web is a React/TSX surface with its own toolchain (TanStack Start + Vite);
    // it is type-checked by its own tsc and not linted by this Node-oriented flat config.
    // TODO: give packages/web a dedicated React/jsx-a11y ESLint config.
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/coverage/**',
      'npm-reserve/**',
      'docs/**',
      'packages/web/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  importPlugin.flatConfigs.recommended,
  {
    languageOptions: {
      globals: { ...globals.node },
    },
    settings: {
      'import/resolver': { typescript: true, node: true },
    },
    rules: {
      // 07-conventions: no `any` without a reason; prefer unknown + narrowing.
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      // 07-conventions: named exports everywhere except a package's bin/config entry.
      'import/no-default-export': 'error',
      // 07-conventions: node builtins → external → @musterd/* → relative.
      'import/order': [
        'error',
        {
          groups: ['builtin', 'external', 'internal', 'parent', 'sibling', 'index'],
          pathGroups: [{ pattern: '@musterd/**', group: 'internal', position: 'before' }],
          'newlines-between': 'never',
          alphabetize: { order: 'asc', caseInsensitive: true },
        },
      ],
      // import/extensions are resolved by tsc/bundler; the import plugin can't see
      // workspace package types without a heavier resolver, so trust tsc here.
      'import/no-unresolved': 'off',
      'import/named': 'off',
    },
  },
  {
    // Bin entries and config files are the sanctioned default-export exceptions.
    files: ['**/*.config.{ts,js,mjs}', '**/bin.ts', 'packages/mcp/src/index.ts'],
    rules: { 'import/no-default-export': 'off' },
  },
  {
    // AGENTS.md hard rule 5 / 00-overview: the CLI and MCP adapter talk to the server **over the
    // wire**. Only `@musterd/protocol` crosses a package boundary. Importing `@musterd/server`
    // links the daemon into a client process — it compiles and the tests pass, so nothing else
    // catches it; this rule does. The single sanctioned exception (`commands/serve.ts`, which
    // launches the daemon in-process per ADR 002) is carved out below.
    files: ['packages/cli/src/**/*.ts', 'packages/mcp/src/**/*.ts'],
    ignores: ['**/*.test.ts', 'packages/cli/src/commands/serve.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@musterd/server', '@musterd/server/**'],
              message:
                'Clients talk to the server over the wire (AGENTS.md hard rule 5). ' +
                'Only commands/serve.ts may import @musterd/server, to launch the daemon in-process (ADR 002).',
            },
          ],
        },
      ],
    },
  },
  {
    // 07-conventions "Error handling"/"Logging": the server emits single-line structured JSON and
    // never `console.log`s an error and continues. A stray console call both breaks that format and
    // is the likeliest way a token (`mskey_`/`msgr_`/`mscr_`) reaches stdout — the one thing
    // AGENTS.md hard rule 4 forbids outright. Zero violations today; this keeps it that way.
    files: ['packages/server/src/**/*.ts'],
    ignores: ['**/*.test.ts'],
    rules: { 'no-console': 'error' },
  },
  {
    // Tests may use throwaway bindings and looser typing.
    files: ['**/*.test.ts', 'tests/**', 'examples/**'],
    rules: { '@typescript-eslint/no-explicit-any': 'off' },
  },
  prettier,
);
