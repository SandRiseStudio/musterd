import { defineConfig } from 'vitest/config';
import { workspaceSrcAliases } from '../../tests/setup/workspace-src-aliases.ts';

// Package-local include, as protocol/server/cli/mcp each have. Without it this package falls back to
// the ROOT config, whose globs are root-relative (`packages/**/*.test.ts`) — and from cwd
// `packages/telemetry` that would have to match `packages/telemetry/packages/…`, so vitest matched
// nothing and exited 1 with "No test files found". The tests were always there and always passed
// under a root `pnpm test`; only `pnpm -r test` saw a package that appeared to have none.
export default defineConfig({
  // Workspace imports resolve to src, never to gitignored dist/ (mirrors the root config; a
  // package-local vitest run inherits nothing from it). See tests/setup/workspace-src-aliases.ts.
  resolve: { alias: workspaceSrcAliases },
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    pool: 'forks',
  },
});
