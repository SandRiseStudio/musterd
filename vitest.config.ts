import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig } from 'vitest/config';
import { workspaceSrcAliases } from './tests/setup/workspace-src-aliases.ts';
import { TEST_TIMEOUT_MS } from './vitest.shared.ts';

export default defineConfig({
  // Workspace imports resolve to src, never to gitignored dist/ — a stale dist must not be able to
  // fail (or pass) a test run. See tests/setup/workspace-src-aliases.ts for the incident history.
  resolve: { alias: workspaceSrcAliases },
  test: {
    // `content/` earns its own glob: roadmap.data.ts moved out of packages/web when the roadmap map
    // was dropped from the UI, and its ADR 177 invariant tests moved with it. Without this line they
    // would still pass locally and silently stop running in CI, which is the worst way to lose a gate.
    // `workers/` earns its line for the same reason as `content/` (ADR 248): the seeds relay deploys
    // with wrangler and lives outside the pnpm workspace so it adds no monorepo dependencies, but its
    // pure helpers are still shipped logic and their gate must run in CI, not just on the author's box.
    include: [
      'packages/**/*.test.ts',
      'tests/**/*.test.ts',
      'content/**/*.test.ts',
      'workers/**/*.test.ts',
      'scripts/**/*.test.ts',
    ],
    environment: 'node',
    pool: 'forks',
    // The timeout and its measured rationale live in vitest.shared.ts, so every package config
    // gets the same number — a value tuned only here reached `pnpm test` and nothing else.
    testTimeout: TEST_TIMEOUT_MS,
    // NO_COLOR pins picocolors OFF in tests so render assertions (plain `▌`/lengths) are deterministic
    // regardless of the runner — CI sets `CI=1`, which otherwise makes picocolors emit ANSI and breaks
    // the row/clip render tests. Production color is unaffected (test-env only). See ADR 106.
    //
    // Machine-wide path isolation (ADR 162 + ADR 190): MUSTERD_CONFIG / MUSTERD_HOST_REGISTRY must
    // never resolve to the operator's ~/.musterd under vitest. The `env` pin is the start-of-worker
    // belt; `setupFiles` re-asserts both overrides before/after every test so a suite's afterEach
    // `delete` cannot leave the worker unprotected. configPath()/hostRegistryPath() throw if the
    // override is missing while VITEST is set.
    setupFiles: ['tests/setup/isolate-machine-state.ts'],
    env: {
      MUSTERD_SILENT: '1',
      NO_COLOR: '1',
      MUSTERD_CONFIG: join(tmpdir(), `musterd-vitest-config-${process.pid}.json`),
      MUSTERD_HOST_REGISTRY: join(tmpdir(), `musterd-vitest-host-registry-${process.pid}.json`),
    },
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
