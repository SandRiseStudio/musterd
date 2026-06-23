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
      // Per-package line gates (06-testing.md "Coverage gates"), enforced at their
      // documented targets — all met. The cli/mcp 75% target was reached by adding
      // behavioral tests for the interactive onboarding wizard (cli/src/onboard) and
      // the MCP tool handlers (mcp/src/tools); the floors only ever ratchet up. See ADR 013.
      thresholds: {
        'packages/protocol/src/**': { lines: 95 },
        'packages/server/src/**': { lines: 85 },
        'packages/cli/src/**': { lines: 75 },
        'packages/mcp/src/**': { lines: 75 },
      },
    },
  },
});
