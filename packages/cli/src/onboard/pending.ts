import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import {
  BINDING_DIR,
  BINDING_FILE,
  PENDING_DIR,
  PendingSessionSchema,
  RESOLVED_SUFFIX,
  type PendingSession,
  type ResolvedSession,
} from '@musterd/protocol';

export type PendingMarker = PendingSession;

/**
 * Pending-presence markers (ADR 033) live alongside the binding at `<workspace>/.musterd/pending/`.
 * The MCP adapter writes one when it loads into an unclaimed folder; `musterd claim` reads + clears
 * them to disambiguate ("which waiting session is this?"). They carry no token — a pending session
 * holds no seat yet — so they are not secret. The format is contract-locked by the shared schema in
 * `@musterd/protocol`; the fs reader is duplicated here and in the adapter (the ADR 018 precedent).
 */

/**
 * How long a pending marker stays believable (ADR 033). **Deliberately not in `@musterd/protocol`:**
 * the marker SCHEMA is the cross-implementation contract and it is unchanged here — this is a policy
 * of the one component that reaps, and another implementation reading markers is free to choose its
 * own window. Putting it in the protocol package would assert a wire-contract change that this is not. Nothing has ever reaped these files: the
 * adapter writes one at boot and only a claim that *adopts* that code removes it, so a session that
 * exits unclaimed leaves its marker on disk forever. Measured 2026-09-04: 189 markers across 15
 * `.musterd/pending/` dirs on one machine, 176 of them older than a week — and a stale one is not
 * inert, because `musterd claim` refuses with "several unclaimed sessions are waiting here" the
 * moment two markers match the folder, which is the documented repair for an expired session lease.
 *
 * **Seven days, deliberately generous.** `ts` is stamped once at adapter boot and never refreshed
 * (`writePendingMarker`), so it is a session START time, not a heartbeat — a session genuinely still
 * waiting to be claimed can carry an old `ts`, and reaping its marker would strand it, because the
 * ADR 034 resolution sidecar it is waiting on is keyed by that marker's code. The asymmetry decides
 * the number: offering a two-day-old marker costs one `--for` flag, while dropping a live one breaks
 * a session's only path online. Seven days sits far outside any plausible waiting window and still
 * clears 176 of the 189 measured files.
 */
export const PENDING_MARKER_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * The `.musterd` dir this workspace's markers belong to: the nearest ancestor that holds a
 * `binding.json` (a bound workspace root), else `startDir/.musterd`. Mirrors {@link findBinding}'s
 * walk so markers land next to the binding — and, critically, matching on the **binding file** (not
 * the bare dir) means an unbound folder never resolves up to the global `~/.musterd` config dir,
 * which holds `config.json`, not a `binding.json`. Resolving there leaked markers into the global dir
 * and made `musterd claim` see other workspaces' pending sessions (the 2026-07-01 dogfood bug).
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

/**
 * All LIVE, valid pending markers for a team in this folder (skips unparseable/foreign-team files,
 * and reaps expired ones — see `PENDING_MARKER_TTL_MS`). When
 * `workspace` is given, markers for a *different* workspace are also skipped: a marker's `.musterd`
 * dir can be shared across sibling launches (e.g. a subdir session and the workspace root resolve to
 * the same bound root), so team alone doesn't prove a marker belongs to *this* session's workspace —
 * without the filter, `musterd claim` would list (and demand `--for` on) another workspace's pending
 * sessions (the 2026-07-01 dogfood bug).
 */
export function listPendingForWorkspace(
  startDir: string,
  team: string,
  workspace?: string,
  now: number = Date.now(),
): PendingMarker[] {
  const dir = pendingDir(startDir);
  if (!existsSync(dir)) return [];
  const out: PendingMarker[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json') || name.endsWith(RESOLVED_SUFFIX)) continue;
    try {
      const parsed = PendingSessionSchema.parse(JSON.parse(readFileSync(join(dir, name), 'utf8')));
      // Expiry is a property of the MARKER, not of this query, so an expired file is reaped whatever
      // team or workspace it names — the team/workspace filters below decide what this caller is
      // shown, and using them to decide what to delete would leave the dir growing for every seat
      // but the one that happened to read it. This read IS the reaper: no timer, no new process,
      // and it runs on exactly the path that suffers from the mess (ADR 033).
      if (now - parsed.ts > PENDING_MARKER_TTL_MS) {
        try {
          rmSync(join(dir, name), { force: true });
        } catch {
          // an unwritable dir just means the marker is skipped, not cleared — still correct
        }
        continue;
      }
      if (parsed.team !== team) continue;
      if (workspace !== undefined && parsed.workspace !== workspace) continue;
      out.push(parsed);
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

/**
 * Hand a freshly-claimed identity to an *already-running* pending session (ADR 034): drop a 0600
 * resolution sidecar `<code>.resolved.json` next to the marker so the adapter watching that code
 * adopts the seat and goes online. Carries the token → 0600; the adapter deletes it on pickup, so
 * its on-disk life is one poll interval. Best-effort: a write failure just means the running session
 * picks the seat up on its next launch / `team_join` (the binding is still written).
 */
export function writeResolution(startDir: string, code: string, resolved: ResolvedSession): void {
  try {
    const dir = pendingDir(startDir);
    mkdirSync(dir, { recursive: true });
    const p = join(dir, `${code}${RESOLVED_SUFFIX}`);
    writeFileSync(p, JSON.stringify(resolved) + '\n', 'utf8');
    try {
      chmodSync(p, 0o600);
    } catch {
      // best-effort on platforms without chmod semantics
    }
  } catch {
    // delivery to a live session is best-effort; the binding is the durable channel
  }
}
