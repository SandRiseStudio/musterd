/*
 * Submit the pnpm dependency graph to GitHub ourselves — because GitHub stopped doing it.
 *
 *   node scripts/submit-dependency-snapshot.ts --dry-run   — parse the lockfile, print counts, POST nothing
 *   node scripts/submit-dependency-snapshot.ts             — POST the snapshot (needs GITHUB_TOKEN)
 *
 * Why this exists (2026-08-20): the repo's Dependency graph FEATURE was found switched off —
 * GraphQL `dependencyGraphManifests` returned 0 manifests, the SBOM endpoint 404'd, and none of
 * the 21 Dependabot alerts ever raised had closed as `fixed`; every closure was a manual
 * dismissal. With no graph, stale alerts never self-heal and — worse — no NEW vulnerability alert
 * can fire at all. The toggle was re-enabled the same day, but the outage was SILENT for over a
 * week (alerts still listed, they just never moved), so the graph now gets fed and checked from
 * our side too:
 *
 * The dependency-submission API posts the graph directly: we read pnpm-lock.yaml, list every
 * resolved package as a purl, and POST it as a snapshot. Dependabot matches advisories against
 * submitted snapshots exactly as it does a natively-parsed graph. And because this POST answers
 * 404 the moment the feature is disabled, every run of
 * `.github/workflows/dependency-submission.yml` (pushes to main touching the lockfile) is also a
 * liveness check on the control itself — the failure mode that was invisible becomes a red run.
 *
 * Why a hand-rolled parser and not a YAML library: the repo has no yaml dependency, and this must
 * run from a bare checkout with NO install (the workflow posts the snapshot before any pnpm
 * install could be poisoned by the very supply-chain problem alerts exist to catch). pnpm 9/10
 * lockfiles are machine-generated with a fixed shape — every resolved package is a two-space-
 * indented key directly under the top-level `packages:` section, `name@version:` with optional
 * quotes and an optional `(peer)` suffix. We read exactly that and nothing else.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

export interface ResolvedPackage {
  name: string;
  version: string;
}

/**
 * Every `  name@version:` key under the top-level `packages:` section. Peer-dependency suffixes
 * (`vite@5.4.11(@types/node@22.10.0)`) collapse onto the same name@version, so entries dedupe.
 */
export function parsePnpmLock(lock: string): ResolvedPackage[] {
  const lines = lock.split('\n');
  const seen = new Map<string, ResolvedPackage>();
  let inPackages = false;
  for (const line of lines) {
    if (/^packages:\s*$/.test(line)) {
      inPackages = true;
      continue;
    }
    // Any other top-level section (snapshots:, importers:, settings:) ends the packages block.
    if (inPackages && /^\S/.test(line)) inPackages = false;
    if (!inPackages) continue;
    const m = /^ {2}'?([^\s']+?)'?:\s*$/.exec(line);
    if (!m || m[1] === undefined) continue;
    const key = m[1].split('(')[0]!;
    const at = key.lastIndexOf('@');
    if (at <= 0) continue; // no version separator (a leading @ is a scope, not a separator)
    const name = key.slice(0, at);
    const version = key.slice(at + 1);
    if (!name || !version) continue;
    seen.set(`${name}@${version}`, { name, version });
  }
  return [...seen.values()];
}

/** purl for an npm package — the scope's `@` percent-encodes per the purl spec. */
export function npmPurl(pkg: ResolvedPackage): string {
  const name = pkg.name.startsWith('@') ? `%40${pkg.name.slice(1)}` : pkg.name;
  return `pkg:npm/${name}@${pkg.version}`;
}

export interface SnapshotIdentity {
  sha: string;
  ref: string;
  runId: string;
  scanned: string;
}

/** The dependency-submission API body — one manifest, keyed exactly like the real lockfile. */
export function buildSnapshot(packages: ResolvedPackage[], id: SnapshotIdentity): object {
  const resolved: Record<string, object> = {};
  for (const pkg of packages) {
    resolved[`${pkg.name}@${pkg.version}`] = { package_url: npmPurl(pkg) };
  }
  return {
    version: 0,
    sha: id.sha,
    ref: id.ref,
    job: { correlator: 'dependency-snapshot', id: id.runId },
    detector: {
      name: 'musterd-pnpm-lock',
      version: '1.0.0',
      url: 'https://github.com/SandRiseStudio/musterd',
    },
    scanned: id.scanned,
    manifests: {
      'pnpm-lock.yaml': {
        name: 'pnpm-lock.yaml',
        file: { source_location: 'pnpm-lock.yaml' },
        resolved,
      },
    },
  };
}

async function main(): Promise<void> {
  const lockPath = new URL('../pnpm-lock.yaml', import.meta.url).pathname;
  const packages = parsePnpmLock(readFileSync(lockPath, 'utf8'));
  if (packages.length === 0)
    throw new Error('parsed 0 packages from pnpm-lock.yaml — parser broke');
  if (process.argv.includes('--dry-run')) {
    console.log(`dry run: ${packages.length} resolved packages, POST skipped`);
    return;
  }
  const token = process.env['GITHUB_TOKEN'];
  if (!token) throw new Error('GITHUB_TOKEN is required to POST the snapshot');
  const repo = process.env['GITHUB_REPOSITORY'] ?? 'SandRiseStudio/musterd';
  const snapshot = buildSnapshot(packages, {
    sha: process.env['GITHUB_SHA'] ?? gitHead(),
    ref: process.env['GITHUB_REF'] ?? 'refs/heads/main',
    runId: process.env['GITHUB_RUN_ID'] ?? `local-${Date.now()}`,
    scanned: new Date().toISOString(),
  });
  const res = await fetch(`https://api.github.com/repos/${repo}/dependency-graph/snapshots`, {
    method: 'POST',
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${token}`,
      'x-github-api-version': '2022-11-28',
    },
    body: JSON.stringify(snapshot),
  });
  const body = (await res.json()) as { id?: number; message?: string; result?: string };
  if (!res.ok) throw new Error(`snapshot POST failed: HTTP ${res.status} ${body.message ?? ''}`);
  console.log(
    `snapshot ${body.id}: ${body.result} — ${packages.length} packages under pnpm-lock.yaml`,
  );
}

function gitHead(): string {
  // Only reached locally; in Actions GITHUB_SHA is always set.
  return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
}

if (process.argv[1]?.endsWith('submit-dependency-snapshot.ts')) {
  main().catch((err: Error) => {
    console.error(err.message);
    process.exitCode = 1;
  });
}
