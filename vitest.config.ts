import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/**/*.test.ts', 'tests/**/*.test.ts'],
    environment: 'node',
    pool: 'forks',
    // NO_COLOR pins picocolors OFF in tests so render assertions (plain `▌`/lengths) are deterministic
    // regardless of the runner — CI sets `CI=1`, which otherwise makes picocolors emit ANSI and breaks
    // the row/clip render tests. Production color is unaffected (test-env only). See ADR 106.
    env: { MUSTERD_SILENT: '1', NO_COLOR: '1' },
    coverage: {
      provider: 'v8',
      // Only the shipped source counts — not tests, build output, or pure barrels.
      include: ['packages/*/src/**'],
      // packages/web is the prerendered roadmap UI — no coverage floor (verified by build + tsc).
      exclude: ['**/*.test.ts', '**/dist/**', 'packages/*/src/index.ts', 'packages/web/**'],
      reporter: ['text', 'text-summary'],
      // Per-package line gates (06-testing.md "Coverage gates"), **CI-enforced** via `pnpm coverage`
      // in the `gates` job (ADR 106) so coverage can't silently drop. The 85 / 75 targets that server
      // and cli had drifted below (to ~82 / ~74 while no CI ran coverage) are now earned back and the
      // floors are ratcheted to meet them — the seat/claim HTTP handshake + request-lane decide routes
      // and the reaper/watcher units got direct in-package tests, and the untested CLI commands (lane,
      // goal, next, done, report) got behavioral tests. Floors only ratchet **up**, never lower to make
      // a change pass. See ADR 013.
      thresholds: {
        'packages/protocol/src/**': { lines: 95 },
        'packages/server/src/**': { lines: 85 },
        'packages/cli/src/**': { lines: 75 },
        'packages/mcp/src/**': { lines: 75 },
      },
    },
  },
});
