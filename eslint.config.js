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
    ignores: ['**/dist/**', '**/node_modules/**', '**/coverage/**', 'npm-reserve/**', 'docs/**'],
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
    // Tests may use throwaway bindings and looser typing.
    files: ['**/*.test.ts', 'tests/**', 'examples/**'],
    rules: { '@typescript-eslint/no-explicit-any': 'off' },
  },
  prettier,
);
