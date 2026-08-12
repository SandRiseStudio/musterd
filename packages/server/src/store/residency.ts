import type {
  Residency,
  ResidencyPolicy,
  ResidencyPolicyOverride,
  WakeContextPacket,
  WakeContextRequest,
  WakeDerivation,
  WakeLane,
  WakeOrder,
} from '@musterd/protocol';
import {
  isAwaitingAcceptance,
  LANE_TERMINAL_STATES,
  ResidencyPolicyOverrideSchema,
  ResidencyPolicySchema,
} from '@musterd/protocol';
import type { Database } from 'better-sqlite3';
import { ulid } from 'ulid';
import { MusterdError } from '../errors.js';
import { appendAudit } from './audit.js';
import { getCursor } from './cursors.js';
import { openDirectedLedger } from './delivery.js';
import { getLane, listLanes } from './lanes.js';
import { getMemberById } from './members.js';
import { memoryEnvelope } from './memory.js';
import {
  deferrals,
  listInbox,
  listTeamMessages,
  pendingInterrupts,
  raisedDeferrals,
  rowToEnvelope,
} from './messages.js';
import { hasLivePresence, listReclaimableMemberIds } from './presence.js';
import type { MemberRow, MessageRow } from './rows.js';
import { getPolicy } from './teams.js';

/**
 * The wake ledger (ADR 131, increment 2). The daemon side of harness residency: enrollment rows
 * (which seats are wakeable, on which host, under whose authority) and **wake leases** — the stored
 * mutual-exclusion record for wake actuation. Leases follow the `requests` precedent (short TTL,
 * reaper-expired), because actuation needs correctness the best-effort audit log cannot bear; every
 * *rate-shaped* decision (cooldown, hourly cap, per-act attempt cap) is DERIVED from
 * `residency.woke`/`residency.wake_failed` audit rows (the `hasInterruptRaised` pattern), never
 * stored. The daemon orders wakes; it never spawns a process (`musterd host`, increment 3, acts).
 */

/** Lease TTL: a wake the host hasn't reported within this window re-becomes due (crash-safe).
 *  Mechanism, not owner policy — deliberately NOT a `ResidencyPolicySchema` knob. */
export const WAKE_LEASE_TTL_MS = 120_000;
/** The launch-default wake policy (increment 5): every rate gate — cooldown, hourly cap, attempt
 *  cap, lanes — now reads from the effective policy (team defaults ⊕ per-seat override), and the
 *  defaults live in ONE place, the protocol schema. */
export const WAKE_POLICY_DEFAULTS: ResidencyPolicy = ResidencyPolicySchema.parse({});
/** After a host defers a wake for a live local session, the seat derives no new lease for this
 *  window (increment 4's local-session guard) — else a working human generates a lease+defer pair
 *  every poll tick. Deferrals consume NO attempt/cooldown/hourly budget (they are neither
 *  `residency.woke` nor `residency.wake_failed`), so the act stays fully due afterwards. */
export const WAKE_DEFER_SNOOZE_MS = 5 * 60_000;
/**
 * ADR 236: a gap between reaper ticks this long means the loop did not run — it was not merely late.
 * Six times `REAPER_INTERVAL_MS`: far above scheduler jitter or a long GC pause, far below the
 * 12–16 minute gaps a suspended host produces (measured across every overnight lease expiry in the
 * live ledger, against a 0.2–0.3 minute daytime cluster). The threshold discriminates a host that
 * reported a failure from a host that was not there — the first burns wake budget, the second must
 * not, or an act is retired before anyone could answer it.
 */
export const HOST_SUSPEND_GAP_MS = 90_000;
/**
 * ADR 236: the bound on deferring for an unreachable host, measured in HOST-AWAKE time since the
 * act's first lease — wall-clock elapsed minus every recorded suspension. Past this, an expiry burns
 * attempt budget again, so termination stays provable. Six hours of a host actually being up is far
 * more than the attempt cap needs (three attempts at the 30-minute cooldown fit in ninety minutes),
 * yet short enough that a genuinely broken host is still retired within a working day of uptime.
 */
export const WAKE_UNREACHABLE_CEILING_MS = 6 * 3_600_000;
/**
 * How far back the wake derivation scans for deferring `wait`s (ADR 211 §4). Matches the inbox
 * read's bound: past this a deferral stops suppressing, and the act becomes a wake reason again —
 * the pre-ADR-211 behaviour.
 *
 * Note this is the inverse of `WAKE_DEFER_SNOOZE_MS` above despite the shared word: that one is the
 * host's local-session guard, which suppresses a wake for a window and leaves the act fully due.
 * This one is the recipient's own decision to postpone one named act.
 */
const DEFERRAL_SCAN_LIMIT = 2000;

export interface ResidencyRow {
  id: string;
  team_id: string;
  member_id: string;
  harness: string;
  host: string;
  grant_id: string | null;
  authorized_by: string | null;
  policy: string | null;
  /** Harness class of the last session-capture attestation (v17, ADR 131 §5) — class only, never an id. */
  resumable_harness: string | null;
  /** When the seat last attested a capturable session (v17). Null until the first capture. */
  resumable_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface WakeLeaseRow {
  id: string;
  team_id: string;
  member_id: string;
  /** Null on board-continuation work-orders (ADR 199). */
  act_id: string | null;
  /** Lane id for work-orders; used when act_id is null for exhaustion keys. */
  lane_id: string | null;
  host: string;
  lane: string;
  status: string;
  created_at: number;
  expires_at: number;
}

/** Rate/exhaustion key: message id, or `lane:<id>` for board continuation (ADR 199). */
export function wakeExhaustionKey(
  actId: string | null | undefined,
  laneId?: string | null,
): string {
  if (actId) return actId;
  if (laneId) return `lane:${laneId}`;
  return '?';
}

/**
 * Parse a stored per-seat policy override — **leniently**: the write side validated strictly, so an
 * unparseable blob here is drift (a hand-edit, a downgrade), and the honest read is "no override"
 * rather than a wake pipeline that throws. `residency status` names the drift separately.
 */
export function parsePolicyOverride(raw: string | null): ResidencyPolicyOverride | null {
  if (!raw) return null;
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return null;
  }
  const parsed = ResidencyPolicyOverrideSchema.safeParse(json);
  return parsed.success ? parsed.data : null;
}

/**
 * The effective wake policy for one enrollment: launch defaults ⊕ team defaults ⊕ seat override
 * (ADR 131 §3). Team defaults arrive already default-filled (`getPolicy` parses with defaults);
 * the sparse override contributes only its explicitly-set keys.
 */
export function effectiveWakePolicy(
  teamDefaults: ResidencyPolicy,
  storedOverride: string | null,
): ResidencyPolicy {
  const override = parsePolicyOverride(storedOverride);
  if (!override) return teamDefaults;
  const merged: ResidencyPolicy = { ...teamDefaults };
  for (const [key, value] of Object.entries(override)) {
    if (value !== undefined) (merged as Record<string, unknown>)[key] = value;
  }
  return merged;
}

/**
 * Derive ADR 209's bounded orientation index for one recipient. It intentionally reads canonical
 * rows only: an Act body or memory body never crosses this seam. An unauthorized target is
 * indistinguishable from a missing one to the caller.
 */
export function buildWakeContext(
  db: Database,
  team: { id: string; slug: string },
  recipient: MemberRow,
  request: WakeContextRequest,
): WakeContextPacket {
  if (request.act_id !== undefined) {
    const row = db
      .prepare<[string, string], MessageRow>('SELECT * FROM messages WHERE team_id = ? AND id = ?')
      .get(team.id, request.act_id);
    if (!row || row.to_kind !== 'member' || row.to_member !== recipient.id)
      throw new MusterdError('forbidden', 'forbidden wake context target');
    const threadId = row.thread_id ?? row.id;
    const meta = JSON.parse(row.meta ?? '{}') as {
      lane_handoff?: { lane?: string };
      lane_review?: { lane?: string };
    };
    const laneId = meta.lane_review?.lane ?? meta.lane_handoff?.lane;
    const lane = laneId ? getLane(db, team.id, laneId, team.slug) : null;
    const counts = db
      .prepare<[string, string, string, string], { participants: number; unread: number }>(
        `SELECT COUNT(DISTINCT from_member) AS participants,
                SUM(CASE WHEN to_member = ? THEN 1 ELSE 0 END) AS unread
           FROM messages WHERE team_id = ? AND (id = ? OR thread_id = ?)`,
      )
      .get(recipient.id, team.id, row.id, threadId);
    const memory = memoryEnvelope(db, recipient.id);
    const kind = meta.lane_review ? 'review' : meta.lane_handoff ? 'handoff' : 'reply';
    return {
      version: 1,
      wake: { kind, act_id: row.id },
      objective: {
        action: kind === 'review' ? 'review' : kind === 'handoff' ? 'continue_lane' : 'reply',
      },
      state: {
        thread: {
          id: threadId,
          participant_count: counts?.participants ?? 0,
          unread_count: counts?.unread ?? 0,
          latest_act: row.act,
        },
        ...(lane
          ? {
              lane: {
                id: lane.id,
                state: lane.state,
                owner_seat: lane.owner_seat,
                ...(lane.branch ? { branch: lane.branch } : {}),
              },
            }
          : {}),
        ...(memory ? { memory } : {}),
      },
      fetch: [
        'inbox_thread',
        ...(lane ? (['lane_detail', 'git_artifact'] as const) : []),
        'seat_memory',
      ],
      delivery: { requirement: 'portable', intended: 'fresh' },
    };
  }
  const lane = getLane(db, team.id, request.lane_id!, team.slug);
  if (!lane || lane.owner_seat !== recipient.name)
    throw new MusterdError('forbidden', 'forbidden wake context target');
  const memory = memoryEnvelope(db, recipient.id);
  return {
    version: 1,
    wake: { kind: 'work_order', lane_id: lane.id },
    objective: { action: lane.state === 'claimed' ? 'begin_lane' : 'continue_lane' },
    state: {
      lane: {
        id: lane.id,
        state: lane.state,
        owner_seat: lane.owner_seat,
        ...(lane.branch ? { branch: lane.branch } : {}),
      },
      ...(memory ? { memory } : {}),
    },
    fetch: ['lane_detail', 'git_artifact', 'seat_memory'],
    delivery: { requirement: 'portable', intended: 'fresh' },
  };
}

/** Project a stored enrollment to the public shape (seat name resolved by the caller-provided row). */
export function toResidency(row: ResidencyRow, teamSlug: string, seatName: string): Residency {
  return {
    id: row.id,
    team: teamSlug,
    seat: seatName,
    harness: row.harness,
    host: row.host,
    grant_id: row.grant_id,
    authorized_by: row.authorized_by,
    resumable_at: row.resumable_at,
    policy: parsePolicyOverride(row.policy),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/**
 * Enroll a seat into residency — an **upsert** keyed on the member (one enrollment per seat, one
 * host per seat): re-enrolling moves the seat to the new host/harness/grant (last-enrolled-wins,
 * ADR 131 §4 — the displaced host is told it is not the actuator by simply deriving nothing).
 * Returns the row plus the previous enrollment (if any) so the route can revoke the superseded
 * grant and audit the host swap.
 */
export function enrollResidency(
  db: Database,
  teamId: string,
  input: {
    member_id: string;
    harness: string;
    host: string;
    grant_id: string | null;
    authorized_by: string | null;
    /** Sparse knob override (increment 5). `undefined` = preserve the existing override on a
     *  re-enroll (a drift-fixing `residency on` must not nuke tuning); an object = replace
     *  wholesale; `{}` = clear back to team defaults (stored as NULL, not `'{}'`). */
    policy?: Record<string, unknown>;
  },
): { row: ResidencyRow; previous: ResidencyRow | null } {
  const now = Date.now();
  const policyJson =
    input.policy === undefined
      ? undefined
      : Object.keys(input.policy).length === 0
        ? null
        : JSON.stringify(input.policy);
  const previous =
    db
      .prepare<[string], ResidencyRow>('SELECT * FROM residency WHERE member_id = ?')
      .get(input.member_id) ?? null;
  if (previous) {
    db.prepare(
      `UPDATE residency SET harness = ?, host = ?, grant_id = ?, authorized_by = ?, policy = ?, updated_at = ?
       WHERE id = ?`,
    ).run(
      input.harness,
      input.host,
      input.grant_id,
      input.authorized_by,
      policyJson === undefined ? previous.policy : policyJson,
      now,
      previous.id,
    );
    const row = db
      .prepare<[string], ResidencyRow>('SELECT * FROM residency WHERE id = ?')
      .get(previous.id)!;
    return { row, previous };
  }
  const row: ResidencyRow = {
    id: ulid(),
    team_id: teamId,
    member_id: input.member_id,
    harness: input.harness,
    host: input.host,
    grant_id: input.grant_id,
    authorized_by: input.authorized_by,
    policy: policyJson ?? null,
    resumable_harness: null,
    resumable_at: null,
    created_at: now,
    updated_at: now,
  };
  db.prepare(
    `INSERT INTO residency (id, team_id, member_id, harness, host, grant_id, authorized_by, policy, resumable_harness, resumable_at, created_at, updated_at)
     VALUES (@id, @team_id, @member_id, @harness, @host, @grant_id, @authorized_by, @policy, @resumable_harness, @resumable_at, @created_at, @updated_at)`,
  ).run(row);
  return { row, previous: null };
}

/**
 * Record a session-capture attestation (ADR 131 §5, increment 4) on the seat's enrollment row —
 * harness class + timestamp only; the daemon never sees an id or a path. Returns whether the seat
 * is enrolled (an unenrolled capture updates nothing but the caller still audits it). Only the
 * `start` event lands here — `end` is advisory and audit-only (resumability never depends on it).
 */
export function recordSessionAttestation(
  db: Database,
  teamId: string,
  memberId: string,
  harness: string,
  now = Date.now(),
): boolean {
  const info = db
    .prepare(
      `UPDATE residency SET resumable_harness = ?, resumable_at = ?
        WHERE team_id = ? AND member_id = ?`,
    )
    .run(harness, now, teamId, memberId);
  return info.changes > 0;
}

/** Revoke a seat's enrollment (the `residency off` kill switch). Returns the removed row, or null. */
export function revokeResidency(
  db: Database,
  teamId: string,
  memberId: string,
): ResidencyRow | null {
  const row = db
    .prepare<
      [string, string],
      ResidencyRow
    >('SELECT * FROM residency WHERE team_id = ? AND member_id = ?')
    .get(teamId, memberId);
  if (!row) return null;
  db.prepare('DELETE FROM residency WHERE id = ?').run(row.id);
  return row;
}

export function getResidency(db: Database, teamId: string, memberId: string): ResidencyRow | null {
  return (
    db
      .prepare<
        [string, string],
        ResidencyRow
      >('SELECT * FROM residency WHERE team_id = ? AND member_id = ?')
      .get(teamId, memberId) ?? null
  );
}

export function listResidency(db: Database, teamId: string): ResidencyRow[] {
  return db
    .prepare<
      [string],
      ResidencyRow
    >('SELECT * FROM residency WHERE team_id = ? ORDER BY created_at ASC, id ASC')
    .all(teamId);
}

/** Member ids enrolled in residency — the roster's `wakeable` flag (`offline · wakeable`). */
export function listWakeableMemberIds(db: Database, teamId: string): Set<string> {
  const rows = db
    .prepare<[string], { member_id: string }>('SELECT member_id FROM residency WHERE team_id = ?')
    .all(teamId);
  return new Set(rows.map((r) => r.member_id));
}

/** A seat's live (unexpired, unreported) lease, if any — the mutual-exclusion read. */
function liveLease(db: Database, memberId: string, now: number): WakeLeaseRow | null {
  return (
    db
      .prepare<
        [string, number],
        WakeLeaseRow
      >("SELECT * FROM wake_leases WHERE member_id = ? AND status = 'leased' AND expires_at > ? LIMIT 1")
      .get(memberId, now) ?? null
  );
}

/** Completed wake actuations (reported or expired-as-failed) for a seat since `sinceTs` — the
 *  derived rate-policy read (ADR 131 §4: `residency.woke`/`wake_failed` rows ARE the rate state). */
function wakesSince(db: Database, teamId: string, seatName: string, sinceTs: number): number {
  const row = db
    .prepare<[string, string, number], { n: number }>(
      `SELECT COUNT(*) AS n FROM audit
        WHERE team_id = ? AND action IN ('residency.woke','residency.wake_failed')
          AND target = ? AND ts > ?`,
    )
    .get(teamId, seatName, sinceTs);
  return row?.n ?? 0;
}

/** Was this seat's last wake deferred for a live local session within the snooze window? Derived
 *  from `residency.wake_deferred` audit rows (increment 4's guard) — deliberately NOT part of
 *  `wakesSince`/`attemptsForAct`: a deferral burns no rate or attempt budget, it only snoozes. */
function deferredSince(db: Database, teamId: string, seatName: string, sinceTs: number): boolean {
  const row = db
    .prepare<[string, string, number], { one: number }>(
      `SELECT 1 AS one FROM audit
        WHERE team_id = ? AND action = 'residency.wake_deferred'
          AND target = ? AND ts > ? LIMIT 1`,
    )
    .get(teamId, seatName, sinceTs);
  return row != null;
}

/** Actuation attempts recorded for one act (woke + failed) — drives the per-act attempt cap. */
function attemptsForAct(db: Database, teamId: string, actId: string): number {
  const row = db
    .prepare<[string, string], { n: number }>(
      `SELECT COUNT(*) AS n FROM audit
        WHERE team_id = ? AND action IN ('residency.woke','residency.wake_failed')
          AND json_extract(detail, '$.act') = ?`,
    )
    .get(teamId, actId);
  return row?.n ?? 0;
}

/** Has this act already been declared exhausted? (One terminal row per act, ever.) */
function isExhausted(db: Database, teamId: string, actId: string): boolean {
  const row = db
    .prepare<[string, string], { one: number }>(
      `SELECT 1 AS one FROM audit
        WHERE team_id = ? AND action = 'residency.wake_exhausted'
          AND json_extract(detail, '$.act') = ? LIMIT 1`,
    )
    .get(teamId, actId);
  return row != null;
}

/**
 * The daemon-composed spawn line (ADR 088 §4 injection bar): structured fields only — act enum,
 * delimited sender/seat names, one instruction to read the inbox through the governed tools. The
 * triggering act's **body never appears here** (nor anywhere in a lease response, ADR 128).
 */
function composeWakeLine(seat: string, teamSlug: string, act: string, sender: string): string {
  return (
    `musterd wake — you are seat "${seat}" on team "${teamSlug}": a ${act} from "${sender}" is ` +
    `waiting. Read it now via team_inbox_check (or 'musterd inbox') and respond.`
  );
}

/** Work-order line (ADR 179 / 191 / 199): lane id only — never a title, never free text. */
function composeWorkOrderLine(
  seat: string,
  teamSlug: string,
  laneId: string,
  kind: 'review' | 'dispatch',
): string {
  if (kind === 'review') {
    return (
      `musterd wake — you are seat "${seat}" on team "${teamSlug}": lane ${laneId} needs your ` +
      `review. Orient via team_next / team_inbox_check and begin.`
    );
  }
  return (
    `musterd wake — you are seat "${seat}" on team "${teamSlug}": lane ${laneId} is yours — ` +
    `orient via team_next and begin.`
  );
}

/** A due-wake candidate before leasing. Act fields optional on board continuation (ADR 199). */
interface WakeCandidate {
  act_id?: string;
  act?: string;
  sender?: string;
  lane: WakeLane;
  derivation: WakeDerivation;
  lane_id?: string;
  work_order_kind?: 'review' | 'dispatch';
  /** ADR 210: set only when the triggering act is a reply INTO an existing thread. The thread id
   *  itself never leaves the daemon on the order — it is read here purely to judge eligibility. */
  thread_id?: string;
  /** ADR 210: when the triggering act was sent, for the eligibility recency test. */
  act_ts?: number;
}

/** ADR 209 rollout: typed handoff/review/work-order wakes are portable now. Ordinary inbox
 * deliveries enter the fresh cohort only when the team has explicitly enabled it. */
function isPortableWakeCandidate(candidate: WakeCandidate, portableInboxReplies: boolean): boolean {
  return (
    candidate.derivation === 'work_order' || candidate.act === 'handoff' || portableInboxReplies
  );
}

/**
 * ADR 210: may this wake even be *considered* for a local resume?
 *
 * This is the daemon's whole contribution, and it is deliberately tiny. The daemon knows the thread
 * but never the session — so it cannot decide to resume, only decline to rule it out. Everything
 * that could prove causality (session id, transcript path, harness class) lives on the host and
 * stays there.
 *
 * Eligible means all of: the master switch is on, the wake is an ordinary directed reply (not a
 * work-order, review, or handoff — those are portable by ADR 209 and stay that way), the triggering
 * act sits INSIDE an existing thread, and it is recent enough that a live session plausibly still
 * holds that dialogue. Sender text is never consulted.
 */
function isResumeEligible(
  candidate: WakeCandidate,
  policy: { exact_match_resume: boolean; resume_eligible_ms: number },
  now: number,
): boolean {
  if (!policy.exact_match_resume) return false;
  if (candidate.derivation === 'work_order') return false;
  if (candidate.act === 'handoff') return false;
  if (candidate.thread_id === undefined) return false;
  if (candidate.act_ts === undefined) return false;
  return now - candidate.act_ts <= policy.resume_eligible_ms;
}

/**
 * Unanswered lane-acceptance asks addressed to this seat whose lane is still awaiting acceptance
 * (ADR 191 work_order derivation / ADR 192 vocab). Oldest first. Deliberately NOT folded into
 * `openDirectedLedger` — arbitrary asks stay non-wakeable; only this board edge spends.
 */
function dueReviewWorkOrders(
  db: Database,
  teamId: string,
  teamSlug: string,
  member: MemberRow,
): WakeCandidate[] {
  const rows = db
    .prepare<[string, string], MessageRow>(
      `SELECT m.* FROM messages m
        WHERE m.team_id = ?
          AND m.act = 'ask'
          AND m.to_kind = 'member'
          AND m.to_member = ?
          AND json_extract(m.meta, '$.lane_review.lane') IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM messages r
             WHERE r.team_id = m.team_id AND r.act IN ('accept','decline')
               AND json_extract(r.meta, '$.in_reply_to') = m.id)
          AND NOT EXISTS (
            SELECT 1 FROM messages v
             WHERE v.team_id = m.team_id AND v.act = 'resolve'
               AND v.thread_id = COALESCE(m.thread_id, m.id))
        ORDER BY m.ts ASC`,
    )
    .all(teamId, member.id);
  const out: WakeCandidate[] = [];
  for (const row of rows) {
    let laneId: string | undefined;
    try {
      laneId = (JSON.parse(row.meta ?? '{}') as { lane_review?: { lane?: string } }).lane_review
        ?.lane;
    } catch {
      continue;
    }
    if (!laneId) continue;
    const lane = getLane(db, teamId, laneId, teamSlug);
    if (!lane || !isAwaitingAcceptance(lane.state)) continue;
    const sender = getMemberById(db, row.from_member);
    out.push({
      act_id: row.id,
      act: row.act,
      sender: sender?.name ?? '?',
      lane: 'batched',
      derivation: 'work_order',
      lane_id: laneId,
      work_order_kind: 'review',
    });
  }
  return out;
}

/**
 * Unanswered lane handoffs to this seat (ADR 199 dispatch handoff edge). Oldest first. Not folded
 * into inbox candidates — when the dispatch loop is on they become work_orders; when off they
 * still wake as reply doorbells via `dueCandidates` / `openDirectedLedger`.
 */
function dueDispatchHandoffWorkOrders(
  db: Database,
  teamId: string,
  teamSlug: string,
  member: MemberRow,
): WakeCandidate[] {
  const rows = db
    .prepare<[string, string], MessageRow>(
      `SELECT m.* FROM messages m
        WHERE m.team_id = ?
          AND m.act = 'handoff'
          AND m.to_kind = 'member'
          AND m.to_member = ?
          AND json_extract(m.meta, '$.lane_handoff.lane') IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM messages r
             WHERE r.team_id = m.team_id AND r.act IN ('accept','decline')
               AND json_extract(r.meta, '$.in_reply_to') = m.id)
          AND NOT EXISTS (
            SELECT 1 FROM messages v
             WHERE v.team_id = m.team_id AND v.act = 'resolve'
               AND v.thread_id = COALESCE(m.thread_id, m.id))
        ORDER BY m.ts ASC`,
    )
    .all(teamId, member.id);
  const out: WakeCandidate[] = [];
  for (const row of rows) {
    let laneId: string | undefined;
    try {
      laneId = (JSON.parse(row.meta ?? '{}') as { lane_handoff?: { lane?: string } }).lane_handoff
        ?.lane;
    } catch {
      continue;
    }
    if (!laneId) continue;
    const lane = getLane(db, teamId, laneId, teamSlug);
    if (!lane || lane.owner_seat !== member.name) continue;
    if (isAwaitingAcceptance(lane.state) || LANE_TERMINAL_STATES.has(lane.state)) continue;
    const sender = getMemberById(db, row.from_member);
    out.push({
      act_id: row.id,
      act: row.act,
      sender: sender?.name ?? '?',
      lane: 'batched',
      derivation: 'work_order',
      lane_id: laneId,
      work_order_kind: 'dispatch',
    });
  }
  return out;
}

/**
 * Board-owned claimed/active lanes with no triggering act (ADR 199 continuation edge).
 * Never wakes for unowned open work.
 */
function dueDispatchContinuationWorkOrders(
  db: Database,
  teamId: string,
  teamSlug: string,
  member: MemberRow,
): WakeCandidate[] {
  const out: WakeCandidate[] = [];
  for (const lane of listLanes(db, teamId, teamSlug, { owner: member.name })) {
    if (lane.state !== 'claimed' && lane.state !== 'active') continue;
    if (isAwaitingAcceptance(lane.state) || LANE_TERMINAL_STATES.has(lane.state)) continue;
    out.push({
      lane: 'batched',
      derivation: 'work_order',
      lane_id: lane.id,
      work_order_kind: 'dispatch',
    });
  }
  return out;
}

/** Was this act sent from a provenance-`wake` occupancy? Server-stamped at insert (v21) — the
 *  ping-pong demotion read (ADR 131 §4). Null (pre-v21 rows, no live presence at send) ⇒ not wake. */
function sentFromWake(db: Database, actId: string): boolean {
  const row = db
    .prepare<
      [string],
      { from_provenance: string | null }
    >('SELECT from_provenance FROM messages WHERE id = ?')
    .get(actId);
  return row?.from_provenance === 'wake';
}

/**
 * Derive this member's due-wake candidates, immediate lane first (ADR 131 §3):
 *
 * - **immediate** — the ADR 088 interrupt predicate (`pendingInterrupts`: urgent or steer, directed,
 *   unresolved) over the seat's unread inbox — the same scarcity and `can_flag_urgent` gate as the
 *   live interrupt line; residency adds a new *state* it reaches, not a new way to command a machine.
 * - **batched** — the ADR 090 open directed ledger (request_help/handoff + urgent directed acts,
 *   unanswered), oldest first, subject to the cooldown checked by the caller.
 *
 * **Ping-pong demotion** (ADR 131 §4, landed increment 5): an interrupt-class act *sent from a
 * provenance-`wake` occupancy* never wakes another seat immediately — it is demoted to the batched
 * lane (kept as a candidate there, ahead of the ledger's, since it is still interrupt-class), so
 * machine-to-machine chains run at cooldown cadence under the caps, without lineage tracking.
 */
function dueCandidates(
  db: Database,
  teamSlug: string,
  member: MemberRow,
  lanes: { immediate: boolean; batched: boolean; raisedDeferralWakes: boolean },
): WakeCandidate[] {
  const immediate: WakeCandidate[] = [];
  const batched: WakeCandidate[] = [];
  const seen = new Set<string>();

  if (lanes.immediate || lanes.batched) {
    const cursor = getCursor(db, member.id);
    const rows = listInbox(db, member, { unreadOnly: true, cursorTs: cursor.last_read_ts });
    const envelopes = rows.map((r) => {
      const from = getMemberById(db, r.from_member);
      const to = r.to_member ? getMemberById(db, r.to_member) : null;
      return rowToEnvelope(r, teamSlug, from?.name ?? '?', to?.name ?? null);
    });
    for (const env of pendingInterrupts(envelopes, member.name)) {
      if (seen.has(env.id)) continue;
      seen.add(env.id);
      const demoted = sentFromWake(db, env.id);
      const candidate: WakeCandidate = {
        act_id: env.id,
        act: env.act,
        sender: env.from,
        lane: demoted ? 'batched' : 'immediate',
        derivation: demoted ? 'batched' : 'immediate',
        // ADR 210: an explicit thread means this act is a reply INTO a dialogue. An act that opens
        // its own thread has no prior exchange to resume into, so it is never eligible.
        ...(env.thread ? { thread_id: env.thread } : {}),
        act_ts: env.ts,
      };
      if (demoted) {
        if (lanes.batched) batched.push(candidate);
      } else if (lanes.immediate) {
        immediate.push(candidate);
      }
    }
  }

  if (lanes.batched) {
    for (const delivery of openDirectedLedger(db, member.team_id)) {
      if (seen.has(delivery.id)) continue;
      const mine = delivery.recipients.find((r) => r.seat === member.name);
      if (!mine || mine.state === 'answered') continue;
      seen.add(delivery.id);
      batched.push({
        act_id: delivery.id,
        act: delivery.act,
        sender: delivery.from,
        lane: 'batched',
        derivation: 'batched',
      });
    }
  }

  // ADR 211 §4: an act its recipient deferred is not a wake reason — they said "not now", and
  // spawning them for it anyway would make the primitive a lie. Suppressed here for BOTH candidate
  // sources above, since either can surface the same act.
  //
  // The fold reads the party-scoped team timeline, not the inbox: `listInbox` excludes the member's
  // own sends and a deferring `wait` IS the member's own send.
  const due = [...immediate, ...batched];
  const scan = listTeamMessages(db, member.team_id, {
    forMemberId: member.id,
    limit: DEFERRAL_SCAN_LIMIT,
  }).map((r) => {
    const from = getMemberById(db, r.from_member);
    const to = r.to_member ? getMemberById(db, r.to_member) : null;
    return rowToEnvelope(r, teamSlug, from?.name ?? '?', to?.name ?? null);
  });
  const held = deferrals(scan, member.name);
  if (held.size === 0) return due;

  // ADR 214 (ADR 211 inc 2): once a deferral's condition fires the act is pending again, and
  // `raised_deferral_wakes`
  // decides whether that also makes it wake-eligible. Off (launch default) keeps every deferred target
  // suppressed, raised or not — the ADR 211 increment-1 behaviour, where a raised act simply waits in
  // the inbox for the seat to return on its own.
  //
  // A raised act is forced onto the **batched** lane regardless of how it was derived: the Member chose
  // to put it down, so its return must not jump the interrupt line their deferral took it out of. That
  // also means a seat pinned to the interrupt lane never receives one — batched is closed for it.
  const raised =
    lanes.raisedDeferralWakes && lanes.batched
      ? raisedDeferrals(scan, member.name)
      : new Set<string>();
  return due.flatMap((c) => {
    if (!c.act_id || !held.has(c.act_id)) return [c];
    if (!raised.has(c.act_id)) return [];
    return [{ ...c, lane: 'batched' as const, derivation: 'batched' as const }];
  });
}

/**
 * The host's poll (`POST …/residency/wake-leases`), run **in one transaction**: derive due wakes for
 * the seats enrolled to `host`, insert a lease per order, and return the orders — two hosts, a crash
 * mid-spawn, or a re-poll race can never double-spawn a seat (ADR 131 §4). Per seat, in order:
 *
 * 1. enrolled to this host (a seat enrolled elsewhere derives nothing here — last-enrolled-wins);
 * 2. **offline** — no live presence AND not held within reclaim grace (a reservation may be
 *    reconnecting on its own; waking it would race the reclaim);
 * 3. no live lease (mutual exclusion — the stored bit);
 * 3b. not snoozed by a recent `residency.wake_deferred` (increment 4's local-session guard —
 *     derived, burns no budget);
 * 4. under the hourly cap (derived); the batched lane additionally respects the cooldown (derived);
 * 5. per act: not exhausted; an act at the attempt cap writes the terminal
 *    `residency.wake_exhausted` (once) and is skipped — termination is provable:
 *    wake → cooldown → cap → exhausted.
 *
 * Every rate gate reads the seat's **effective policy** (team defaults ⊕ enrollment override,
 * increment 5) — and the emitted order carries the actuation knobs (tool policy, bounds, hygiene
 * bound) so the host applies them without ever reading policy itself.
 *
 * One lease per seat per poll (the composed line names one act; the woken session reads its whole
 * inbox anyway). Audit `residency.wake_leased` is written here per lease — actor null (a machine
 * decision), best-effort by `appendAudit`'s contract.
 */
export function claimWakeLeases(
  db: Database,
  teamId: string,
  teamSlug: string,
  host: string,
  presenceTimeoutMs: number,
  now = Date.now(),
): WakeOrder[] {
  const tx = db.transaction((): WakeOrder[] => {
    const orders: WakeOrder[] = [];
    const reclaimable = listReclaimableMemberIds(db, teamId, now);
    const enrollments = listResidency(db, teamId).filter((r) => r.host === host);
    const teamPolicy = getPolicy(db, teamId);
    const teamDefaults = teamPolicy.residency;
    const reviewLoopOn = teamPolicy.loops?.review === true;
    const dispatchLoopOn = teamPolicy.loops?.dispatch === true;
    for (const enrollment of enrollments) {
      const member = getMemberById(db, enrollment.member_id);
      if (!member || member.left_at !== null) continue;
      if (hasLivePresence(db, member.id, presenceTimeoutMs)) continue;
      if (reclaimable.has(member.id)) continue;
      if (liveLease(db, member.id, now)) continue;
      // Local-session guard snooze (increment 4): the host reported a live local session in this
      // seat's workspace — don't re-derive a lease every tick while someone is plainly working there.
      if (deferredSince(db, teamId, member.name, now - WAKE_DEFER_SNOOZE_MS)) continue;
      const policy = effectiveWakePolicy(teamDefaults, enrollment.policy);
      if (wakesSince(db, teamId, member.name, now - 3_600_000) >= policy.hourly_cap) continue;

      const cooled = wakesSince(db, teamId, member.name, now - policy.cooldown_ms) === 0;
      const candidates = dueCandidates(db, teamSlug, member, {
        immediate: policy.lane !== 'batched',
        batched: cooled && policy.lane !== 'interrupt',
        raisedDeferralWakes: policy.raised_deferral_wakes,
      });
      // ADR 199: dispatch work-orders (continuation then handoff — handoff unshifted last so it
      // leads). ADR 191: review work-orders prefer ahead of both + inbox.
      if (dispatchLoopOn && policy.flow === 'auto' && cooled) {
        candidates.unshift(...dueDispatchContinuationWorkOrders(db, teamId, teamSlug, member));
        candidates.unshift(...dueDispatchHandoffWorkOrders(db, teamId, teamSlug, member));
      }
      if (reviewLoopOn && policy.flow === 'auto' && cooled) {
        candidates.unshift(...dueReviewWorkOrders(db, teamId, teamSlug, member));
      }
      for (const candidate of candidates) {
        const exhKey = wakeExhaustionKey(candidate.act_id, candidate.lane_id);
        if (isExhausted(db, teamId, exhKey)) continue;
        if (attemptsForAct(db, teamId, exhKey) >= policy.attempt_cap) {
          appendAudit(db, teamId, {
            actor: null,
            action: 'residency.wake_exhausted',
            target: member.name,
            result: 'deny',
            detail: {
              act: exhKey,
              sender: candidate.sender ?? 'board',
              attempts: policy.attempt_cap,
              derivation: candidate.derivation,
              ...(candidate.lane_id !== undefined ? { lane_id: candidate.lane_id } : {}),
            },
          });
          continue;
        }
        const lease: WakeLeaseRow = {
          id: ulid(),
          team_id: teamId,
          member_id: member.id,
          act_id: candidate.act_id ?? null,
          lane_id: candidate.lane_id ?? null,
          host,
          lane: candidate.lane,
          status: 'leased',
          created_at: now,
          expires_at: now + WAKE_LEASE_TTL_MS,
        };
        db.prepare(
          `INSERT INTO wake_leases (id, team_id, member_id, act_id, lane_id, host, lane, status, created_at, expires_at)
           VALUES (@id, @team_id, @member_id, @act_id, @lane_id, @host, @lane, @status, @created_at, @expires_at)`,
        ).run(lease);
        appendAudit(db, teamId, {
          actor: null,
          action: 'residency.wake_leased',
          target: member.name,
          result: 'allow',
          detail: {
            lease_id: lease.id,
            act: exhKey,
            sender: candidate.sender ?? 'board',
            lane: candidate.lane,
            host,
            derivation: candidate.derivation,
            ...(isPortableWakeCandidate(candidate, policy.portable_inbox_replies)
              ? { continuity_requirement: 'portable', intended_delivery: 'fresh' }
              : {}),
            // ADR 210: the eligibility BIT is audited; the thread id that produced it is not. The
            // ledger records that a resume was permitted, never anything about the local session.
            ...(isResumeEligible(candidate, policy, now) ? { resume_eligible: true } : {}),
            ...(candidate.lane_id !== undefined ? { lane_id: candidate.lane_id } : {}),
          },
        });
        const isWorkOrder = candidate.derivation === 'work_order';
        const isPortable = isPortableWakeCandidate(candidate, policy.portable_inbox_replies);
        const kind = candidate.work_order_kind ?? 'dispatch';
        orders.push({
          lease_id: lease.id,
          seat: member.name,
          ...(candidate.act_id !== undefined ? { act_id: candidate.act_id } : {}),
          ...(candidate.act !== undefined ? { act: candidate.act } : {}),
          ...(candidate.sender !== undefined ? { sender: candidate.sender } : {}),
          lane: candidate.lane,
          composed_line: isWorkOrder
            ? composeWorkOrderLine(member.name, teamSlug, candidate.lane_id!, kind)
            : composeWakeLine(
                member.name,
                teamSlug,
                candidate.act ?? 'message',
                candidate.sender ?? '?',
              ),
          expires_at: lease.expires_at,
          tool_policy: isWorkOrder ? 'seat-policy' : policy.tool_policy,
          bounds: {
            timeout_ms: isWorkOrder ? policy.work_timeout_ms : policy.timeout_ms,
            ...(policy.max_turns !== undefined ? { max_turns: policy.max_turns } : {}),
            ...(policy.budget_usd !== undefined ? { budget_usd: policy.budget_usd } : {}),
          },
          transcript_max_bytes: policy.transcript_max_bytes,
          ...(isPortable
            ? { continuity_requirement: 'portable' as const, intended_delivery: 'fresh' as const }
            : {}),
          // The mark and the key it needs travel together: an eligible wake carries the thread id
          // so the host can look for an exact local binding. Never audited, never returned.
          ...(isResumeEligible(candidate, policy, now)
            ? { resume_eligible: true as const, thread_id: candidate.thread_id! }
            : {}),
          derivation: candidate.derivation,
          ...(candidate.lane_id !== undefined ? { lane_id: candidate.lane_id } : {}),
        });
        break; // one lease per seat per poll
      }
    }
    return orders;
  });
  return tx();
}

/**
 * Settle a lease from the host's `WakeOutcome` report. `leased` (or `expired` — a slow-but-honest
 * report after the reaper gave up on it) transitions to `reported`; returns the lease row or null
 * for unknown/already-reported (the caller 404s/409s). The route writes the outcome audit
 * (`residency.woke` / `residency.wake_failed`) — this only settles the stored bit.
 */
export function settleWakeLease(
  db: Database,
  teamId: string,
  leaseId: string,
): WakeLeaseRow | null {
  const row = db
    .prepare<
      [string, string],
      WakeLeaseRow
    >('SELECT * FROM wake_leases WHERE team_id = ? AND id = ?')
    .get(teamId, leaseId);
  if (!row || row.status === 'reported') return null;
  db.prepare("UPDATE wake_leases SET status = 'reported' WHERE id = ?").run(row.id);
  return row;
}

/** One captured native-loop turn (ADR 251 §7), read back with usage/transcript deserialized. */
export interface WakeTurnRow {
  lease_id: string;
  member_id: string;
  turn: number;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens?: number | undefined;
    cache_creation_input_tokens?: number | undefined;
  };
  cost_usd: number | null;
  stop_reason: string | null;
  transcript: unknown;
  created_at: number;
}

/**
 * Append one native-loop turn against a lease (ADR 251 §7). The lease may be in ANY status —
 * `outcome` settles at verification while the loop runs on, so most turns land on a `reported`
 * lease. Idempotent per (lease, turn): a retried post overwrites. Returns null for an unknown
 * lease (the route 404s).
 */
export function appendWakeTurn(
  db: Database,
  teamId: string,
  body: {
    lease_id: string;
    turn: number;
    usage: WakeTurnRow['usage'];
    cost_usd?: number | undefined;
    stop_reason?: string | undefined;
    transcript?: unknown;
  },
  now = Date.now(),
): { member_id: string } | null {
  const lease = db
    .prepare<
      [string, string],
      { member_id: string }
    >('SELECT member_id FROM wake_leases WHERE team_id = ? AND id = ?')
    .get(teamId, body.lease_id);
  if (!lease) return null;
  db.prepare(
    `INSERT INTO wake_turns (id, team_id, lease_id, member_id, turn, usage_json, cost_usd, stop_reason, transcript_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(lease_id, turn) DO UPDATE SET
       usage_json = excluded.usage_json,
       cost_usd = excluded.cost_usd,
       stop_reason = excluded.stop_reason,
       transcript_json = excluded.transcript_json,
       created_at = excluded.created_at`,
  ).run(
    ulid(),
    teamId,
    body.lease_id,
    lease.member_id,
    body.turn,
    JSON.stringify(body.usage),
    body.cost_usd ?? null,
    body.stop_reason ?? null,
    body.transcript === undefined ? null : JSON.stringify(body.transcript),
    now,
  );
  return { member_id: lease.member_id };
}

/** The captured turns for one lease, in turn order — the resume substrate and the cost ledger. */
export function listWakeTurns(db: Database, teamId: string, leaseId: string): WakeTurnRow[] {
  return db
    .prepare<
      [string, string],
      {
        lease_id: string;
        member_id: string;
        turn: number;
        usage_json: string;
        cost_usd: number | null;
        stop_reason: string | null;
        transcript_json: string | null;
        created_at: number;
      }
    >('SELECT * FROM wake_turns WHERE team_id = ? AND lease_id = ? ORDER BY turn ASC')
    .all(teamId, leaseId)
    .map((r) => ({
      lease_id: r.lease_id,
      member_id: r.member_id,
      turn: r.turn,
      usage: JSON.parse(r.usage_json) as WakeTurnRow['usage'],
      cost_usd: r.cost_usd,
      stop_reason: r.stop_reason,
      transcript: r.transcript_json === null ? null : (JSON.parse(r.transcript_json) as unknown),
      created_at: r.created_at,
    }));
}

/**
 * Expire live leases past `expires_at` (the reaper, mirroring `expireRequests`). Returns the expired
 * rows so the reaper can CLASSIFY each one (ADR 236): a host that was up and did not report burns
 * attempt budget as `residency.wake_failed {reason: 'lease_expired'}` (else a host that dies
 * mid-spawn would retry forever); a host that was not there at all defers instead. Either way the
 * act re-becomes due, still bounded by the derived rate policy.
 */
/** Teams with at least one residency enrollment — who a host suspension concerns (ADR 236). */
export function listResidencyTeamIds(db: Database): string[] {
  return db
    .prepare<[], { team_id: string }>('SELECT DISTINCT team_id FROM residency')
    .all()
    .map((r) => r.team_id);
}

/**
 * Milliseconds the daemon was demonstrably ABSENT within `[from, to]` — the sum of every recorded
 * `residency.host_suspended` interval clipped to that window (ADR 236). Derived from the ledger, in
 * the ADR 131 §4 shape: the audit rows ARE the state, and they survive a daemon restart, which
 * in-memory tick bookkeeping does not.
 */
export function hostAsleepMs(db: Database, teamId: string, from: number, to: number): number {
  const row = db
    .prepare<[number, number, string, number], { ms: number }>(
      `SELECT COALESCE(SUM(MAX(0,
                MIN(json_extract(detail, '$.to'), ?) - MAX(json_extract(detail, '$.from'), ?))), 0) AS ms
         FROM audit
        WHERE team_id = ? AND action = 'residency.host_suspended' AND ts >= ?`,
    )
    .get(to, from, teamId, from);
  return row?.ms ?? 0;
}

/** Host-awake milliseconds since `since` (ADR 236): elapsed time minus every recorded suspension. */
export function awakeMsSince(db: Database, teamId: string, since: number, now: number): number {
  return Math.max(0, now - since - hostAsleepMs(db, teamId, since, now));
}

/** When this act was FIRST leased for actuation, from the ledger — the ceiling's clock start. */
export function firstWakeLeaseTs(db: Database, teamId: string, actKey: string): number | null {
  const row = db
    .prepare<[string, string], { ts: number }>(
      `SELECT MIN(ts) AS ts FROM audit
        WHERE team_id = ? AND action = 'residency.wake_leased'
          AND json_extract(detail, '$.act') = ?`,
    )
    .get(teamId, actKey);
  return row?.ts ?? null;
}

/**
 * Did a session ever attest that it was spawned by this lease (ADR 252)? The join is by IDENTITY —
 * the `MUSTERD_WAKE_LEASE` token the actuator stamps on the woken child, carried through the
 * session attestation onto `residency.session_captured` — never by timing, which would re-admit the
 * "any fresh presence is my evidence" inference ADR 238→241 spent two increments removing.
 *
 * **True is evidence; false is silence.** A pre-ADR-252 CLI attests no token, so a `false` here
 * means "no session claimed this lease", not "no session ran". Every counter derived from this must
 * read as a floor.
 */
export function leaseCapturedSession(db: Database, teamId: string, leaseId: string): boolean {
  const row = db
    .prepare<[string, string], { n: number }>(
      `SELECT COUNT(*) AS n FROM audit
        WHERE team_id = ? AND action = 'residency.session_captured'
          AND json_extract(detail, '$.wake_lease') = ?`,
    )
    .get(teamId, leaseId);
  return (row?.n ?? 0) > 0;
}

export function expireWakeLeases(db: Database, now = Date.now()): WakeLeaseRow[] {
  const rows = db
    .prepare<
      [number],
      WakeLeaseRow
    >("SELECT * FROM wake_leases WHERE status = 'leased' AND expires_at < ?")
    .all(now);
  if (rows.length > 0) {
    db.prepare(
      "UPDATE wake_leases SET status = 'expired' WHERE status = 'leased' AND expires_at < ?",
    ).run(now);
  }
  return rows;
}
