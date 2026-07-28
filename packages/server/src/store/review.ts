import { modelFamily, MODEL_UNKNOWN, type Lane } from '@musterd/protocol';
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
