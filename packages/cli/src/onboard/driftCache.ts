import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DriftCacheSchema, type DriftCache } from '@musterd/protocol';
import { writeJsonAtomic } from './atomicWrite.js';

/**
 * The provisioning-drift cache (spec 2026-09-16, ADR 408, increment 4).
 *
 * Increment 3 made a stale workspace repair itself at session start. This is the other half: what
 * is STILL wrong afterwards has to reach the seat during the session, not only in the one line it
 * printed before the first turn. The reporting surface is the inbox check, and the inspection is
 * three file reads — cheap once, wasteful at every inbox check a busy seat makes. So the CLI writes
 * what it measured here and the adapter reads it; the adapter never inspects and never imports this
 * package (`@musterd/cli` is not on its dependency path, by design — see `format.ts`).
 *
 * Deliberately a LEAF: the inspection and the tombstone read arrive as injected functions rather
 * than as imports of `doctor.ts` and `declined.ts`. Those two sit inside the existing
 * `doctor → selfHeal → doctor` cycle, and importing them from here put this file in that cycle too,
 * which reordered module evaluation enough to break an unrelated suite's `node:child_process` mock.
 * A cache has no business depending on the thing it caches; `defaultDriftDeps` in `doctor.ts` is
 * where the real wiring lives.
 */
export const DRIFT_CACHE_TTL_MS = 10 * 60 * 1000;

export function driftCachePath(cwd: string): string {
  return join(cwd, '.musterd', 'drift.json');
}

/** The cache as written, or null when it is absent, unreadable or not the shape we wrote. */
export function readDriftCache(cwd: string): DriftCache | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(driftCachePath(cwd), 'utf8'));
    const res = DriftCacheSchema.safeParse(parsed);
    return res.success ? res.data : null;
  } catch {
    return null;
  }
}

export interface RefreshDriftDeps {
  /** The daemon's build, or undefined when it is unknown — which never invalidates. */
  daemonBuild: string | undefined;
  now: number;
  /** The drift inspection — `inspectArtifactDrift` in production, injected to keep this a leaf. */
  inspect: (cwd: string) => { guidance: string[]; hooks: string[]; permissions: string[] };
  /** Whether this folder carries the self-heal tombstone. */
  declined: (cwd: string) => boolean;
}

/**
 * Re-inspect and rewrite when the cache is absent, older than the TTL, or was written against a
 * DIFFERENT daemon build — a build change is what moves the target the drift is measured against,
 * so it is worth an immediate re-read where it is known.
 *
 * An UNKNOWN daemon build (`undefined`) is deliberately not a mismatch. The interrupt-check probe
 * rides every tool call and does not reach the daemon for a build; treating its silence as "the
 * build changed" would re-inspect the workspace at every tool boundary, which is precisely the cost
 * this file exists to avoid.
 */
export function refreshDriftCache(cwd: string, deps: RefreshDriftDeps): DriftCache {
  const cached = readDriftCache(cwd);
  if (cached && isFresh(cached, deps)) return cached;

  const found = deps.inspect(cwd);
  const next: DriftCache = {
    inspected_at: deps.now,
    build: deps.daemonBuild ?? '',
    guidance: found.guidance.length,
    hooks: found.hooks.length,
    permissions: found.permissions.length,
    declined: deps.declined(cwd),
  };
  // A clean folder is written too: absent and clean are different states, and only a written zero
  // lets a reader distinguish "inspected, nothing wrong" from "nothing has ever looked".
  //
  // A folder with no `.musterd` is not one of ours. It is not an error — an unprovisioned folder
  // inspects clean — but creating the directory would plant seat state wherever a probe happened
  // to run, so the measurement is returned and nothing is written.
  if (existsSync(join(cwd, '.musterd'))) {
    writeJsonAtomic(driftCachePath(cwd), next, (p) => DriftCacheSchema.safeParse(p).success);
  }
  return next;
}

function isFresh(cached: DriftCache, deps: RefreshDriftDeps): boolean {
  if (deps.now - cached.inspected_at >= DRIFT_CACHE_TTL_MS) return false;
  if (deps.daemonBuild !== undefined && deps.daemonBuild !== cached.build) return false;
  return true;
}
