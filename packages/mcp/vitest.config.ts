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
    env: { MUSTERD_SILENT: '1' },
  },
});
