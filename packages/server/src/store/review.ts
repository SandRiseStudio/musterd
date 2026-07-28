import {
  modelFamily,
  MODEL_UNKNOWN,
  type FamilyPosture,
  type FamilyPostureState,
  type Lane,
} from '@musterd/protocol';
import type { Database } from 'better-sqlite3';
import { listMembers } from './members.js';
import { hasLivePresence } from './presence.js';
import { resolveCapabilities, type MemberRow } from './rows.js';

/**
 * The review counterpart picker (ADR 169 §4) — who gets the standard-tier `approve` ask when a lane
 * goes `ready_for_review`. One function so the policy can evolve without touching the transition
 * machinery. Precedence:
 *
 *   1. a **high-risk** lane (any declared `risk` tag) routes to a live human/admin seat first —
 *      declared, never inferred;
 *   2. otherwise a live seat whose **model family differs from the worker's** (ADR 056: correlated
 *      models make correlated mistakes, so a same-family review re-runs the worker's blind spots).
 *      Family comes from the occupancy's attested model (ADR 158 observed-over-declared); a seat
 *      attesting `unknown` is NOT eligible — it cannot prove diversity, and musterd would rather
 *      say nothing than something false. A human seat is always cross-family by construction.
 *   3. nobody qualifies → `null`: the caller emits no ask and the verb response sanctions
 *      self-close (the ADR 145 degradation — never a wedge).
 */

export interface ReviewPick {
  /** The chosen counterpart's seat name. */
  reviewer: string;
  /** Why this seat: 'human_admin' (risk route) or 'cross_family'. */
  route: 'human_admin' | 'cross_family';
  /** The reviewer's family ('human' for human seats) — the audit's reviewer_family. */
  reviewer_family: string;
}

/** The attested model of a member's most recent live occupancy (ADR 101/158), or null. */
function latestAttestedModel(db: Database, memberId: string): string | null {
  const row = db
    .prepare<
      [string],
      { model: string | null }
    >('SELECT model FROM presence WHERE member_id = ? AND held_until IS NULL ORDER BY last_seen_at DESC LIMIT 1')
    .get(memberId);
  return row?.model ?? null;
}

/** A member's diversity family: 'human' for human seats, else the attested model's family. */
export function memberFamily(db: Database, member: MemberRow): string {
  return member.kind === 'human' ? 'human' : modelFamily(latestAttestedModel(db, member.id));
}

/** The worker's family looked up by seat name — the `worker_family` half of the audit pair. */
export function workerFamily(db: Database, teamId: string, worker: string): string {
  const m = listMembers(db, teamId).find((x) => x.name === worker);
  return m ? memberFamily(db, m) : MODEL_UNKNOWN;
}

/**
 * The team's model-family posture (ADR 172) — derived at read time, never stored, because a seat is
 * a **name**, not a model: what it runs can change between sessions, so the only honest statement is
 * about who is attesting what right now, stamped with when.
 *
 * Counting rules, each load-bearing:
 *   - Family comes from the live occupancy's attestation only — never inferred from a seat's name
 *     (`grokbot` is a name, not a guarantee).
 *   - A live agent attesting `unknown` counts in `unattested`, never in the denominator — it cannot
 *     prove diversity, and a wrong guess here poisons the posture the way a wrong attestation
 *     poisons ADR 056 conclusions. Same rule the review picker applies per-seat.
 *   - Humans ride beside the posture (`humans_live`), never inside it: human review is its own
 *     requirement class (the ADR 169 risk route), not a diversity substitute.
 *   - Observers are invisible here as everywhere (ADR 063).
 *
 * Three states: `diverse` (≥2 distinct families attesting), `monoculture` (≥2 attesting, all one),
 * `unknown` (<2 attesting — with one or zero data points you cannot tell, and saying `monoculture`
 * would collapse "everyone HERE is claude" into "everyone ON THE TEAM is claude").
 */
export function teamFamilyPosture(
  db: Database,
  teamId: string,
  presenceTimeoutMs: number,
): FamilyPosture {
  const families: Record<string, number> = {};
  const wake_pool: string[] = [];
  let attesting = 0;
  let unattested = 0;
  let humans_live = 0;
  for (const m of listMembers(db, teamId)) {
    if (m.observer) continue;
    const live = hasLivePresence(db, m.id, presenceTimeoutMs);
    if (m.kind === 'human') {
      if (live) humans_live += 1;
      continue;
    }
    if (!live) {
      wake_pool.push(m.name);
      continue;
    }
    const family = modelFamily(latestAttestedModel(db, m.id));
    if (family === MODEL_UNKNOWN) {
      unattested += 1;
    } else {
      attesting += 1;
      families[family] = (families[family] ?? 0) + 1;
    }
  }
  const distinct = Object.keys(families).length;
  const state: FamilyPostureState =
    distinct >= 2 ? 'diverse' : attesting >= 2 ? 'monoculture' : 'unknown';
  return {
    state,
    attesting,
    families,
    unattested,
    wake_pool,
    humans_live,
    computed_at: Date.now(),
  };
}

/**
 * The board's verified annotation (ADR 169): lane id → whether its latest `lane.closed` audit row
 * derived `verified: true`. One indexed query per board read; lanes with no close row (pre-169
 * history, non-terminal lanes) are simply absent — the projection says nothing rather than guessing.
 */
export function verifiedCloses(db: Database, teamId: string): Map<string, boolean> {
  const rows = db
    .prepare<
      [string],
      { target: string | null; detail: string | null }
    >("SELECT target, detail FROM audit WHERE team_id = ? AND action = 'lane.closed' ORDER BY ts")
    .all(teamId);
  const out = new Map<string, boolean>();
  for (const r of rows) {
    if (!r.target || !r.detail) continue;
    try {
      const d = JSON.parse(r.detail) as { verified?: boolean };
      if (typeof d.verified === 'boolean') out.set(r.target, d.verified); // newest row wins
    } catch {
      /* a malformed detail annotates nothing */
    }
  }
  return out;
}

export function pickReviewCounterpart(
  db: Database,
  teamId: string,
  lane: Lane,
  worker: string,
  presenceTimeoutMs: number,
): ReviewPick | null {
  const candidates = listMembers(db, teamId).filter(
    (m) => m.name !== worker && !m.observer && hasLivePresence(db, m.id, presenceTimeoutMs),
  );

  if (lane.risk.length > 0) {
    const authority = candidates.find((m) => m.kind === 'human' || resolveCapabilities(m).is_admin);
    if (authority) {
      return {
        reviewer: authority.name,
        route: 'human_admin',
        reviewer_family: memberFamily(db, authority),
      };
    }
    // No live authority for a risky lane: fall through to cross-family rather than dropping the
    // review entirely — a diverse agent review beats none, and the audit records which route ran.
  }

  const mine = workerFamily(db, teamId, worker);
  // Humans first within the cross-family pool: a human counterpart is the stronger "this is what
  // I wanted" claim when one happens to be live, and is cross-family by construction.
  const pool = [...candidates].sort(
    (a, b) => Number(b.kind === 'human') - Number(a.kind === 'human'),
  );
  for (const m of pool) {
    const family = memberFamily(db, m);
    if (family === MODEL_UNKNOWN) continue; // can't prove diversity — ineligible (ADR 158 posture)
    if (family !== mine) {
      return { reviewer: m.name, route: 'cross_family', reviewer_family: family };
    }
  }
  return null;
}
