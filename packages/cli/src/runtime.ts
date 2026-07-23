/**
 * Runtime install boundary helpers (ADR 156): Node ≥22 gate + packaged-vs-checkout detection.
 * Shared voice with `service install` ABI messaging — keep the PATH/`node@22` line identical.
 */
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/** Matches monorepo `engines.node` and published package engines (ADR 156). */
export const MIN_NODE_MAJOR = 22;

/** One-line fix shown whenever we refuse Node &lt;22 (bin gate + service install). */
export function nodeUpgradeHint(): string {
  return `export PATH="/opt/homebrew/opt/node@22/bin:$PATH" && musterd <cmd>`;
}

/**
 * If `version` (default `process.version`) is below {@link MIN_NODE_MAJOR}, return a refusal
 * message; otherwise null.
 */
export function nodeVersionTooOld(version: string = process.version): string | null {
  const m = /^v(\d+)\./.exec(version);
  const major = m ? Number(m[1]) : NaN;
  if (!Number.isFinite(major) || major >= MIN_NODE_MAJOR) return null;
  return (
    `musterd needs Node >=${MIN_NODE_MAJOR} (you are on ${version}). ` +
    `Put a matching node first on PATH, e.g.\n  ${nodeUpgradeHint()}`
  );
}

/**
 * Infer whether this `musterd` binary is running from the musterd git monorepo.
 * Walks up from the bin path looking for `pnpm-workspace.yaml` (checkout / linked dogfood).
 * Global npm, npx cache, and Homebrew Cellar installs have no workspace file above them.
 */
export function isPackagedCliInstall(binPath: string = process.argv[1] ?? ''): boolean {
  if (!binPath) return true;
  let dir = dirname(resolve(binPath));
  for (let i = 0; i < 10; i++) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return false;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return true;
}

/** @deprecated Prefer walking via {@link isPackagedCliInstall}; kept for tests that need a fixed root. */
export function inferCliRepoRoot(binPath: string = process.argv[1] ?? ''): string {
  // bin → dist → cli → packages → root (checkout) OR bin → dist → @musterd/cli → node_modules → …
  return resolve(dirname(binPath), '../../../..');
}

/** Warn-only doctor notes for packaged installs (ADR 118 + 156). */
export function packagedInstallNotes(binPath: string = process.argv[1] ?? ''): string[] {
  if (!isPackagedCliInstall(binPath)) return [];
  return [
    'this musterd is a packaged install (npm/brew), not a git checkout — update with ' +
      '`npm i -g @musterd/cli@latest` or `brew upgrade musterd`. ' +
      '`musterd service refresh` only works from a source checkout (ADR 118).',
  ];
}
