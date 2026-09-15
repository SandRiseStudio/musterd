/**
 * Runtime install boundary helpers (ADR 156): Node ≥22 gate + packaged-vs-checkout detection.
 * Shared voice with `service install` ABI messaging — keep the PATH/`node@22` line identical.
 */
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { GUIDANCE_CONTENT_VERSION } from '@musterd/protocol';

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

/**
 * Warn-only doctor notes for packaged installs (ADR 118 + 156).
 *
 * The second half of this note is the one that matters, and it exists because the doctor's guidance
 * check is SELF-REFERENTIAL: `inspectGuidance` compares each file's stamp against
 * `GUIDANCE_CONTENT_VERSION`, the constant compiled into the CLI doing the comparing. A binary that
 * writes v21 therefore pronounces v21 files current — correctly, and uselessly, if v22 is on main.
 *
 * Every other staleness surface is blind in the same place. `buildSkewNotes` compares against the
 * daemon (same image on a cloud VM — no skew) and against `origin/main` (needs a git checkout — a
 * packaged install has none). So on a packaged install or a baked image, a seat a version behind
 * gets `✓ provisioning is coherent` and no comparison line at all. Green is worse than quiet: quiet
 * invites a second look. Measured by delta on the cloud seat `/data/musterd-delta`, 2026-09-06 —
 * `SKILL.md` at v21, image built from `4636b396`, which is not an ancestor of the v22 bump, so
 * `--refresh-guidance` there would have written v21 over v21 and left the doctor satisfied.
 *
 * So state the CEILING, which is the one true thing this binary knows: guidance ships inside the
 * CLI, `--refresh-guidance` can only ever write what this binary carries, and a newer version
 * arrives by replacing the binary. How that happens differs per install kind, and naming only one
 * silently excludes the others (ADR 118 names the source-checkout path; npm/brew and a baked image
 * are the other two, and `isPackagedCliInstall` cannot tell those two apart — so name both).
 */
export function packagedInstallNotes(binPath: string = process.argv[1] ?? ''): string[] {
  if (!isPackagedCliInstall(binPath)) return [];
  return [
    'this musterd is a packaged install (npm/brew or a baked image), not a git checkout — update ' +
      'with `npm i -g @musterd/cli@latest` / `brew upgrade musterd`, or by redeploying the image ' +
      'if this machine runs one. `musterd service refresh` only works from a source checkout ' +
      '(ADR 118).',
    `this binary writes guidance v${String(GUIDANCE_CONTENT_VERSION)}, and that is a CEILING: ` +
      'guidance ships inside the CLI, so `musterd init --refresh-guidance` can only ever write ' +
      'what this binary carries, and the doctor can only compare your files against it. A ✓ here ' +
      'means "your guidance matches this CLI" — NOT "your guidance is current with main". If a ' +
      'newer version has shipped, the repair is a newer CLI, not a refresh.',
  ];
}
