// Flat ESLint config (ADR 013 follow-on to ADR 004 — strict tsc was the v0.1 gate;
// ESLint now machine-enforces the 07-conventions.md "Lint / format rules").
// Formatting is owned by Prettier; eslint-config-prettier disables stylistic overlap.
import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import importPlugin from 'eslint-plugin-import';
import jsxA11y from 'eslint-plugin-jsx-a11y';
import reactHooks from 'eslint-plugin-react-hooks';
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
    // The Node-package conventions. `packages/web` is excluded from THIS block only — it is a
    // browser surface with a different module idiom (its route files are TSX, its globals are
    // `window`/`document`, and TanStack owns its import shape), so `globals.node`, `import/order`'s
    // builtin-first grouping and `no-default-export` are the wrong rules there. It keeps the
    // universal baselines above (js + typescript-eslint recommended) and gains its own block below.
    ignores: ['packages/web/**'],
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
    // ── packages/web: the browser surface ────────────────────────────────────────────────────────
    //
    // This block exists because ADR 180 retired Bugbot, and Bugbot was the ONLY thing looking at web
    // accessibility at all (stanley's handoff, 2026-07-29). The gap was total: `packages/web/**` sat
    // in the global ignore list behind a TODO, so a missing label, an unreachable control or a
    // click handler on a `<div>` shipped unchallenged.
    //
    // `jsx-a11y` is the deterministic half of that bar — it catches the structural failures (labels,
    // roles, keyboard reachability, `alt` text) that a reviewer should never have to spend attention
    // on. The half it CANNOT see stays a human/seat judgement and is worth naming so nobody mistakes
    // a green lint for an accessible UI: colour contrast, visible focus states, tap-target size, and
    // whether the keyboard path through a flow actually makes sense.
    //
    // `react-hooks` rides along because the same files carry the office's rAF loops and subscription
    // effects, where a missing dep is a stale-closure bug that no test here would catch.
    files: ['packages/web/**/*.{ts,tsx}'],
    plugins: { 'jsx-a11y': jsxA11y, 'react-hooks': reactHooks },
    languageOptions: {
      globals: { ...globals.browser },
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    rules: {
      // The mandate: a11y failures are ERRORS and fail the build, same as anywhere else.
      ...jsxA11y.flatConfigs.recommended.rules,
      // react-hooks at full strength — the v7 set, as ERRORS. #493 landed these as warnings so an
      // a11y PR stayed reviewable; the follow-up audit went through all 34 and this is where it
      // came out. Two rules are off, and both for a reason about THIS codebase rather than taste:
      ...reactHooks.configs.recommended.rules,

      // OFF — permanently unactionable here, not merely inconvenient. musterd's web is
      // server-rendered (TanStack Start), and client-only state cannot be read during render or in a
      // `useState` initializer without a hydration mismatch: `localStorage` and `new Date()` do not
      // exist on the server. So the panel-collapse prefs, the board's view/rail prefs and the wall
      // clock all hydrate in a mount effect behind a `typeof window` guard, which is the correct
      // pattern and the one this rule is written to forbid. It flagged 13 sites and every one was
      // that. A rule that can never be satisfied is not a warning, it is noise that hides real ones.
      'react-hooks/set-state-in-effect': 'off',

      // OFF — the five sites are `Date.now()` read while rendering elapsed/remaining time, and the
      // components that need it fresh already force the re-render themselves (AsksStrip runs a 1s
      // tick precisely so its countdown re-reads the clock). Checked before switching it off: none
      // of them are stale. Lifting `now` into shared ticking state would satisfy the rule and change
      // no behaviour, so it stays available as a tidy-up — but it is not a defect, and the byte
      // budget has a claim on any component that re-renders more often than it must.
      'react-hooks/purity': 'off',
      // Grouped `case`s with a comment between them are this codebase's idiom for "these acts share
      // a tone, and here is why" (see format.ts's act→tone map). `allowEmptyCase` permits exactly
      // that shape and still catches the fallthrough that matters — a case with STATEMENTS that
      // slides into the next one.
      'no-fallthrough': ['error', { allowEmptyCase: true }],
      // Vite owns resolution here: `?url` suffixes, workspace packages and the TanStack plugins are
      // all invisible to the import plugin's resolver. Off for exactly the reason the Node block
      // above turns it off — tsc and the bundler already prove these imports.
      'import/no-unresolved': 'off',
      'import/named': 'off',
    },
  },
  {
    // `packages/web` is a browser surface, so it is excluded from the Node block above and its own
    // block gives it `globals.browser` — but its *build tooling* still runs in Node. Without this,
    // a script there lands in the gap between the two blocks: no Node globals, so `console` and
    // `process` fail `no-undef` (which is how `scripts/stage-site.mjs` first failed CI).
    files: ['packages/web/scripts/**/*.mjs'],
    languageOptions: { globals: { ...globals.node } },
  },
  {
    // Tests may use throwaway bindings and looser typing.
    files: ['**/*.test.ts', 'tests/**', 'examples/**'],
    rules: { '@typescript-eslint/no-explicit-any': 'off' },
  },
  prettier,
);
