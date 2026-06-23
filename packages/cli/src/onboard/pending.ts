import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  BINDING_DIR,
  PENDING_DIR,
  PendingSessionSchema,
  type PendingSession,
} from '@musterd/protocol';

export type PendingMarker = PendingSession;

/**
 * Pending-presence markers (ADR 033) live alongside the binding at `<workspace>/.musterd/pending/`.
 * The MCP adapter writes one when it loads into an unclaimed folder; `musterd claim` reads + clears
 * them to disambiguate ("which waiting session is this?"). They carry no token — a pending session
 * holds no seat yet — so they are not secret. The format is contract-locked by the shared schema in
 * `@musterd/protocol`; the fs reader is duplicated here and in the adapter (the ADR 018 precedent).
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

function pendingDir(startDir: string): string {
  return join(nearestMusterdDir(startDir), PENDING_DIR);
}

/** Write/refresh this session's pending marker (adapter side). Best-effort; never throws to caller. */
export function writePending(startDir: string, session: PendingSession): string {
  const dir = pendingDir(startDir);
  mkdirSync(dir, { recursive: true });
  const p = join(dir, `${session.code}.json`);
  writeFileSync(p, JSON.stringify(session, null, 2) + '\n', 'utf8');
  return p;
}

/** All valid pending markers for a team in this folder (skips unparseable/foreign-team files). */
export function listPendingForWorkspace(startDir: string, team: string): PendingMarker[] {
  const dir = pendingDir(startDir);
  if (!existsSync(dir)) return [];
  const out: PendingMarker[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json')) continue;
    try {
      const parsed = PendingSessionSchema.parse(JSON.parse(readFileSync(join(dir, name), 'utf8')));
      if (parsed.team === team) out.push(parsed);
    } catch {
      // a malformed/partial marker is advisory only — ignore it
    }
  }
  return out.sort((a, b) => a.ts - b.ts);
}

/** Remove a claimed/stale marker by code. Best-effort. */
export function consumePending(startDir: string, code: string): void {
  try {
    rmSync(join(pendingDir(startDir), `${code}.json`), { force: true });
  } catch {
    // already gone / unwritable — nothing to do
  }
}
