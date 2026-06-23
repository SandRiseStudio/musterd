import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  BINDING_DIR,
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

/** The nearest `.musterd` dir at/above `startDir`, or `startDir/.musterd` when none exists yet. */
function nearestMusterdDir(startDir: string): string {
  let dir = startDir;
  for (;;) {
    const candidate = join(dir, BINDING_DIR);
    if (existsSync(candidate)) return candidate;
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
