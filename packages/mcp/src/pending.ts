import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  BINDING_DIR,
  BINDING_FILE,
  PENDING_DIR,
  RESOLVED_SUFFIX,
  ResolvedSessionSchema,
  type PendingSession,
  type ResolvedSession,
} from '@musterd/protocol';
import type { McpConfig } from './config.js';

/**
 * Pending-presence markers (ADR 033). When an adapter loads into an unclaimed folder it is reachable
 * but holds no seat; it drops a marker at `<workspace>/.musterd/pending/<code>.json` so the L2
 * `musterd claim` can see it, list it among several, and disambiguate with `--for <code>`. No token
 * (no seat yet) → not secret. The reader/consumer lives in the CLI; the schema in `@musterd/protocol`
 * locks the shape (the ADR 018 duplicate-reader precedent).
 */

/**
 * The `.musterd` dir this workspace's markers belong to: the nearest ancestor holding a
 * `binding.json` (a bound workspace root), else `startDir/.musterd`. Matching on the **binding file**
 * (not the bare dir) keeps an unbound folder from resolving up to the global `~/.musterd` config dir
 * (which holds `config.json`, not a binding) — resolving there leaked markers into the global dir and
 * let `musterd claim` see other workspaces' pending sessions (the 2026-07-01 dogfood bug). Kept in
 * lockstep with the CLI's copy (ADR 018 duplicate-reader precedent).
 */
function nearestMusterdDir(startDir: string): string {
  let dir = startDir;
  for (;;) {
    const candidate = join(dir, BINDING_DIR);
    if (existsSync(join(candidate, BINDING_FILE))) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return join(startDir, BINDING_DIR);
    dir = parent;
  }
}

function markerPath(startDir: string, code: string): string {
  return join(nearestMusterdDir(startDir), PENDING_DIR, `${code}.json`);
}

function resolutionPath(startDir: string, code: string): string {
  return join(nearestMusterdDir(startDir), PENDING_DIR, `${code}${RESOLVED_SUFFIX}`);
}

/**
 * Pick up a resolution `musterd claim --for <code>` left for *this* session, if any (ADR 034). Reads
 * `<code>.resolved.json`, then **deletes it immediately** (and the marker) so the token's on-disk life
 * is one poll interval. Returns the seat to adopt, or null when nothing is waiting / it's malformed.
 */
export function readAndConsumeResolution(
  config: McpConfig,
  startDir: string = process.cwd(),
): ResolvedSession | null {
  const p = resolutionPath(startDir, config.claimCode);
  if (!existsSync(p)) return null;
  let parsed: ResolvedSession | null = null;
  try {
    parsed = ResolvedSessionSchema.parse(JSON.parse(readFileSync(p, 'utf8')));
  } catch {
    parsed = null; // malformed/partial write — drop it below and keep waiting
  }
  try {
    rmSync(p, { force: true });
  } catch {
    // best-effort
  }
  if (parsed) clearPendingMarker(config, startDir);
  return parsed;
}

/** Write this session's pending marker. Best-effort: a write failure never blocks the session. */
export function writePendingMarker(
  config: McpConfig,
  startDir: string = process.cwd(),
): string | null {
  const session: PendingSession = {
    code: config.claimCode,
    team: config.team,
    workspace: config.workspace,
    surface: config.surface,
    ...(config.driver ? { driver: config.driver } : {}),
    connId: config.connId,
    ts: Date.now(),
  };
  try {
    const p = markerPath(startDir, config.claimCode);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify(session, null, 2) + '\n', 'utf8');
    return p;
  } catch {
    return null;
  }
}

/** Remove this session's pending marker once it has claimed a seat. Best-effort. */
export function clearPendingMarker(config: McpConfig, startDir: string = process.cwd()): void {
  try {
    rmSync(markerPath(startDir, config.claimCode), { force: true });
  } catch {
    // already gone / unwritable — nothing to do
  }
}
