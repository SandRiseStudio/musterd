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
