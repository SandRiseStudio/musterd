import {
  AvailabilitySchema,
  type Availability,
  type DoorbellPolicy,
  type DoorbellPrefs,
  DoorbellPrefsSchema,
  type DoorbellRecord,
  DoorbellRecordSchema,
  type DoorbellSink,
} from '@musterd/protocol';
import type { Database } from 'better-sqlite3';
import { ulid } from 'ulid';
import { answeredByAnyoneSql, resolvedThreadSql } from './discharge.js';
import type { MemberRow } from './rows.js';
import { getPolicy, getStoredPolicy } from './teams.js';

/**
 * The doorbell's durable state (ADR 443): the ring queue (`doorbell_rings`), a human's own prefs
 * (`members.doorbell_prefs`), and the team policy with ADR 149's `ask_slack_webhook` read through.
 * Nothing here holds a body; prefs may hold a personal URL and are returned only to their owner by
 * the HTTP layer.
 */

export type RingState = 'held' | 'queued' | 'done';

export interface RingRow {
  id: string;
  team_id: string;
  member_id: string;
  act_id: string;
  record: string;
  sinks: string;
  state: RingState;
  host: string | null;
  created_at: number;
}

/** A ring with its JSON columns parsed. */
export interface Ring {
  id: string;
  team_id: string;
  member_id: string;
  act_id: string;
  record: DoorbellRecord;
  sinks: DoorbellSink[];
  state: RingState;
  host: string | null;
  created_at: number;
}

function toRing(row: RingRow): Ring {
  return {
    ...row,
    record: DoorbellRecordSchema.parse(JSON.parse(row.record)),
    sinks: JSON.parse(row.sinks) as DoorbellSink[],
  };
}

export function insertRing(
  db: Database,
  ring: Omit<Ring, 'id' | 'created_at'> & { created_at?: number },
): Ring {
  const row: RingRow = {
    id: ulid(),
    team_id: ring.team_id,
    member_id: ring.member_id,
    act_id: ring.act_id,
    record: JSON.stringify(DoorbellRecordSchema.parse(ring.record)),
    sinks: JSON.stringify(ring.sinks),
    state: ring.state,
    host: ring.host,
    created_at: ring.created_at ?? Date.now(),
  };
  db.prepare(
    `INSERT INTO doorbell_rings (id, team_id, member_id, act_id, record, sinks, state, host, created_at)
     VALUES (@id, @team_id, @member_id, @act_id, @record, @sinks, @state, @host, @created_at)`,
  ).run(row);
  return toRing(row);
}

export function setRingState(db: Database, id: string, state: RingState): void {
  db.prepare('UPDATE doorbell_rings SET state = ? WHERE id = ?').run(state, id);
}

/** Every held ring for one member, oldest first. */
export function listHeldRings(db: Database, memberId: string): Ring[] {
  return db
    .prepare<
      [string],
      RingRow
    >("SELECT * FROM doorbell_rings WHERE member_id = ? AND state = 'held' ORDER BY created_at, id")
    .all(memberId)
    .map(toRing);
}

/** Members (any team) with at least one held ring — the sweep's candidates for a lapsed hold. */
export function listMembersWithHeldRings(db: Database): { member_id: string; team_id: string }[] {
  return db
    .prepare<
      [],
      { member_id: string; team_id: string }
    >("SELECT DISTINCT member_id, team_id FROM doorbell_rings WHERE state = 'held'")
    .all();
}

/** How long a finished or never-claimed ring is kept (ADR 443 §4, retention). */
export const DOORBELL_RING_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Delete `done` and `queued` rings older than the retention window, so the ring table does not only
 * grow. A `queued` ring that old has no host left to claim it. `held` rings are kept: they wait on
 * a human's own hold, however long. Returns the number deleted.
 */
export function pruneRings(db: Database, now: number): number {
  const cutoff = now - DOORBELL_RING_RETENTION_MS;
  return db
    .prepare("DELETE FROM doorbell_rings WHERE state IN ('done', 'queued') AND created_at < ?")
    .run(cutoff).changes;
}

/** Every ring for a team, oldest first (tests and the audit-side read). */
export function listRings(db: Database, teamId: string): Ring[] {
  return db
    .prepare<
      [string],
      RingRow
    >('SELECT * FROM doorbell_rings WHERE team_id = ? ORDER BY created_at, id')
    .all(teamId)
    .map(toRing);
}

/**
 * Has this act been answered — an `accept`/`decline` naming it in `meta.in_reply_to`, or a
 * `resolve` of its thread (dolly's review of ADR 443, change d)? The same two shapes the discharge
 * ledger uses, so a held ring and the open-loops gauge cannot disagree about what "answered" means.
 */
export function actAnsweredOrResolved(db: Database, teamId: string, actId: string): boolean {
  const row = db
    .prepare<[string, string], { n: number }>(
      `SELECT COUNT(*) AS n FROM messages m
        WHERE m.team_id = ? AND m.id = ?
          AND (EXISTS (${answeredByAnyoneSql('m')}) OR EXISTS (${resolvedThreadSql('m')}))`,
    )
    .get(teamId, actId);
  return (row?.n ?? 0) > 0;
}

/** A member's parsed availability; a malformed or legacy blob reads as none (implicit available). */
export function memberAvailability(m: MemberRow): Availability | null {
  if (!m.availability) return null;
  try {
    return AvailabilitySchema.safeParse(JSON.parse(m.availability)).data ?? null;
  } catch {
    return null;
  }
}

/** A member's own doorbell prefs; a malformed blob reads as no overrides. */
export function memberDoorbellPrefs(m: MemberRow): DoorbellPrefs | undefined {
  if (!m.doorbell_prefs) return undefined;
  try {
    return DoorbellPrefsSchema.safeParse(JSON.parse(m.doorbell_prefs)).data;
  } catch {
    return undefined;
  }
}

export function setDoorbellPrefs(db: Database, memberId: string, prefs: DoorbellPrefs): void {
  db.prepare('UPDATE members SET doorbell_prefs = ?, updated_at = ? WHERE id = ?').run(
    JSON.stringify(prefs),
    Date.now(),
    memberId,
  );
}

/**
 * The team's effective doorbell policy (ADR 443 §6). When `doorbell.slack_url` is unset, ADR 149's
 * `ask_slack_webhook` is read through as the team's `slack` URL — and, when no admin has chosen the
 * doorbell defaults, `slack` joins them, so a team that set the old knob keeps posting to Slack with
 * no admin action. The stored blob is never rewritten.
 */
export function getDoorbellPolicy(db: Database, teamId: string): DoorbellPolicy {
  const policy = getPolicy(db, teamId);
  const doorbell = policy.doorbell;
  if (doorbell.slack_url || !policy.ask_slack_webhook) return doorbell;
  const storedDefaults = getStoredPolicy(db, teamId).doorbell?.defaults;
  const defaults =
    storedDefaults || doorbell.defaults.includes('slack')
      ? doorbell.defaults
      : [...doorbell.defaults, 'slack' as const];
  return { ...doorbell, slack_url: policy.ask_slack_webhook, defaults };
}
