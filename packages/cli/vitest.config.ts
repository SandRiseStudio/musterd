import { defineConfig } from 'vitest/config';
import { workspaceSrcAliases } from '../../tests/setup/workspace-src-aliases.ts';
import { TEST_TIMEOUT_MS } from '../../vitest.shared.ts';

export default defineConfig({
  // Workspace imports resolve to src, never to gitignored dist/ (mirrors the root config; a
  // package-local vitest run inherits nothing from it). See tests/setup/workspace-src-aliases.ts.
  resolve: { alias: workspaceSrcAliases },
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    // Inherited from nothing: a package-local run reads only THIS file, so the root's tuned
    // ceiling never reached `pnpm -r test`. See vitest.shared.ts for the measurement.
    testTimeout: TEST_TIMEOUT_MS,
    pool: 'forks',
    env: { MUSTERD_SILENT: '1', NO_COLOR: '1' },
    // Machine-wide path isolation (ADR 162 + ADR 190), mirroring the root config. A package-local
    // vitest run inherits NOTHING from the root, so without this line `pnpm --filter @musterd/cli
    // test` reached machineStatePath (src/machinePaths.ts:15) with no override set and ~100 service
    // tests died on "MUSTERD_CONFIG must be set when VITEST is set". That guard was doing its job —
    // failing closed rather than letting the suite write the operator's real ~/.musterd — so what was
    // missing was the isolation it demands, not the demand. The setup file mints its own tmpdir and
    // re-pins both overrides before and after every test, so a suite's afterEach `delete` cannot
    // leave the worker unprotected.
    setupFiles: ['../../tests/setup/isolate-machine-state.ts'],
  },
});
