import { readBuildStamp } from '@musterd/protocol';
import { createRequire } from 'node:module';

/**
 * The `@musterd/cli` version, read from the package's own `package.json` at runtime (ADR 067). A
 * fresh agent reaches for `musterd --version` first to confirm what it's running; this is the single
 * source for it. `createRequire(import.meta.url)` resolves `../package.json` from both `src/` (tests)
 * and `dist/` (the published bin), which sit one level under the package root. Falls back to `0.0.0`
 * if the file can't be read, so `--version` never throws.
 */
export function cliVersion(): string {
  try {
    const require = createRequire(import.meta.url);
    const pkg = require('../package.json') as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

let memoBuild: string | undefined | null = null; // null = not yet read; undefined = read, unstamped

/**
 * The git build ref this CLI dist was built from (ADR 135) — the `dist/build.json` stamp written by
 * `scripts/stamp-build.mjs` at build time. Unlike `cliVersion()` (a slow-moving package version),
 * this names the exact commit, so skew against the daemon or `origin/main` is decidable. Read once
 * per process; `undefined` when unstamped (published tarball, stripped dist) — consumers stay silent.
 */
export function cliBuild(): string | undefined {
  if (memoBuild === null) memoBuild = readBuildStamp(import.meta.url);
  return memoBuild;
}
