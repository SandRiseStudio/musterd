import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/**/*.test.ts', 'tests/**/*.test.ts'],
    environment: 'node',
    pool: 'forks',
    env: { MUSTERD_SILENT: '1' },
    coverage: {
      provider: 'v8',
      // Only the shipped source counts — not tests, build output, or pure barrels.
      include: ['packages/*/src/**'],
      exclude: ['**/*.test.ts', '**/dist/**', 'packages/*/src/index.ts'],
      reporter: ['text', 'text-summary'],
      // Per-package line gates (06-testing.md "Coverage gates").
      // protocol/server are enforced at their documented targets (both already met).
      // cli/mcp are enforced as regression-ratchet floors at current coverage; the
      // documented 75% target is tracked as a follow-up (interactive onboarding +
      // tool handlers need behavioral tests). See ADR 013.
      thresholds: {
        'packages/protocol/src/**': { lines: 95 },
        'packages/server/src/**': { lines: 85 },
        'packages/cli/src/**': { lines: 44 },
        'packages/mcp/src/**': { lines: 57 },
      },
    },
  },
});
