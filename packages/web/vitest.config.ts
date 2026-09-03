import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig } from 'vitest/config';
import { workspaceSrcAliases } from '../../tests/setup/workspace-src-aliases.ts';
import { TEST_TIMEOUT_MS } from '../../vitest.shared.ts';

/**
 * Why this file exists (lane 01M1JPSTXA): with no vitest config here, `npx vitest run`
 * inside packages/web fell back to vite.config.ts — which loads the TanStack Start plugin.
 * Its client environment sends @tanstack/* through the dep optimizer, and esbuild 0.28.1
 * (the lockfile's `esbuild@<0.28.1` override) refuses to lower their destructuring to the
 * optimizer's old browser targets: "Build failed with 4 errors". The root config never trips
 * it (node environment, no app plugins), which is why CI stayed green while the in-package
 * run was red.
 *
 * So this config runs web's tests the way the root does — node environment, workspace-src
 * aliases (never stale dist), machine-state isolation — and keeps the app plugins (prerender,
 * dev proxy) where they belong: dev and build only. Per-package values stay single-sourced
 * in vitest.shared.ts; tests/vitest-config-parity.test.ts fails if this drifts off it.
 */
export default defineConfig({
  resolve: { alias: workspaceSrcAliases },
  test: {
    environment: 'node',
    pool: 'forks',
    testTimeout: TEST_TIMEOUT_MS,
    setupFiles: ['../../tests/setup/isolate-machine-state.ts'],
    env: {
      MUSTERD_SILENT: '1',
      NO_COLOR: '1',
      MUSTERD_CONFIG: join(tmpdir(), `musterd-vitest-config-${process.pid}.json`),
      MUSTERD_HOST_REGISTRY: join(tmpdir(), `musterd-vitest-host-registry-${process.pid}.json`),
    },
  },
});
