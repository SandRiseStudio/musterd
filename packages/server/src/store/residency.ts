import type {
  Residency,
  ResidencyPolicy,
  ResidencyPolicyOverride,
  WakeLane,
  WakeOrder,
} from '@musterd/protocol';
import { ResidencyPolicyOverrideSchema, ResidencyPolicySchema } from '@musterd/protocol';
import type { Database } from 'better-sqlite3';
import { ulid } from 'ulid';
import { appendAudit } from './audit.js';
import { getCursor } from './cursors.js';
import { openDirectedLedger } from './delivery.js';
import { getMemberById } from './members.js';
import { listInbox, pendingInterrupts, rowToEnvelope } from './messages.js';
import { hasLivePresence, listReclaimableMemberIds } from './presence.js';
import type { MemberRow } from './rows.js';
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
  act_id: string;
  host: string;
  lane: string;
  status: string;
  created_at: number;
  expires_at: number;
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

/** A due-wake candidate before leasing: the triggering act + its lane. */
interface WakeCandidate {
  act_id: string;
  act: string;
  sender: string;
  lane: WakeLane;
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
  lanes: { immediate: boolean; batched: boolean },
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
      });
    }
  }
  return [...immediate, ...batched];
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
    const teamDefaults = getPolicy(db, teamId).residency;
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
      });
      for (const candidate of candidates) {
        if (isExhausted(db, teamId, candidate.act_id)) continue;
        if (attemptsForAct(db, teamId, candidate.act_id) >= policy.attempt_cap) {
          appendAudit(db, teamId, {
            actor: null,
            action: 'residency.wake_exhausted',
            target: member.name,
            result: 'deny',
            detail: {
              act: candidate.act_id,
              sender: candidate.sender,
              attempts: policy.attempt_cap,
            },
          });
          continue;
        }
        const lease: WakeLeaseRow = {
          id: ulid(),
          team_id: teamId,
          member_id: member.id,
          act_id: candidate.act_id,
          host,
          lane: candidate.lane,
          status: 'leased',
          created_at: now,
          expires_at: now + WAKE_LEASE_TTL_MS,
        };
        db.prepare(
          `INSERT INTO wake_leases (id, team_id, member_id, act_id, host, lane, status, created_at, expires_at)
           VALUES (@id, @team_id, @member_id, @act_id, @host, @lane, @status, @created_at, @expires_at)`,
        ).run(lease);
        appendAudit(db, teamId, {
          actor: null,
          action: 'residency.wake_leased',
          target: member.name,
          result: 'allow',
          detail: {
            lease_id: lease.id,
            act: candidate.act_id,
            sender: candidate.sender,
            lane: candidate.lane,
            host,
          },
        });
        orders.push({
          lease_id: lease.id,
          seat: member.name,
          act_id: candidate.act_id,
          act: candidate.act,
          sender: candidate.sender,
          lane: candidate.lane,
          composed_line: composeWakeLine(member.name, teamSlug, candidate.act, candidate.sender),
          expires_at: lease.expires_at,
          tool_policy: policy.tool_policy,
          bounds: {
            timeout_ms: policy.timeout_ms,
            ...(policy.max_turns !== undefined ? { max_turns: policy.max_turns } : {}),
            ...(policy.budget_usd !== undefined ? { budget_usd: policy.budget_usd } : {}),
          },
          transcript_max_bytes: policy.transcript_max_bytes,
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

/**
 * Expire live leases past `expires_at` (the reaper, mirroring `expireRequests`). Returns the expired
 * rows so the reaper can write `residency.wake_failed {reason: 'lease_expired'}` for each — a
 * crashed/hung wake still consumes attempt budget (else a host that dies mid-spawn would retry
 * forever), and the act re-becomes due, still bounded by the derived rate policy.
 */
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
