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
      // Per-package line gates (06-testing.md "Coverage gates"), now **CI-enforced** via `pnpm coverage`
      // in the `gates` job (ADR 106) so coverage can't silently drop. Set at the current floor: server
      // and cli drifted below the former 85/75 targets while no CI ran coverage (server ~82, cli ~74) —
      // the floors freeze that reality and only ratchet **up**; 85 / 75 are the ratchet goals to earn
      // back with tests, never lower. See ADR 013.
      thresholds: {
        'packages/protocol/src/**': { lines: 95 },
        'packages/server/src/**': { lines: 82 }, // ratchet goal: 85
        'packages/cli/src/**': { lines: 73 }, // ratchet goal: 75
        'packages/mcp/src/**': { lines: 75 },
      },
    },
  },
});
