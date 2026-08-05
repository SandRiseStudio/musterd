import {
  modelFamily,
  MODEL_UNKNOWN,
  wakeabilityFromFacts,
  type FamilyPosture,
  type FamilyPostureState,
  type ReviewGrade,
  reviewGrade,
  type WakeCandidate,
  type Lane,
} from '@musterd/protocol';
import type { Database } from 'better-sqlite3';
import { listMembers } from './members.js';
import { hasLivePresence } from './presence.js';
import {
  lastActionByActor,
  resolveQuiescence,
  QUIESCENCE_DEFAULT_QUIET_AFTER_MS,
} from './quiescence.js';
import { listWakeableMemberIds } from './residency.js';
import { type MemberRow } from './rows.js';

/**
 * The review counterpart picker (ADR 169 §4) — who gets the standard-tier `approve` ask when a lane
 * goes `ready_for_review`. One function so the policy can evolve without touching the transition
 * machinery. Precedence:
 *
 *   1. a **high-risk** lane (any declared `risk` tag) routes to a live HUMAN seat, and only to one
 *      — declared, never inferred. Human review is its own requirement class for risky work
 *      (user-facing / expensive / destructive / prod-touching — ADR 172, decided by nick
 *      2026-07-28), and admins can only be humans (same ruling), so a cross-family agent is NOT a
 *      substitute: with no live human the pick is null and the close records `human_review_missed`,
 *      loudly, rather than an agent review quietly standing in for the one that was required.
 *      (Never a wedge: the close itself is still possible — a record, not a lock.)
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
  /** Why this seat: 'human_admin' (risk route) or 'cross_family'. Historical two-value field —
   *  kept for wire compat; `grade` (ADR 188) carries the finer truth. */
  route: 'human_admin' | 'cross_family';
  /** The achieved rung of the diversity ladder (ADR 188). 'human' for a human counterpart —
   *  cross-family by construction, and named honestly rather than folded into cross_family. */
  grade: ReviewGrade | 'human';
  /** The reviewer's family ('human' for human seats) — the audit's reviewer_family. */
  reviewer_family: string;
}

/** One seat's last attestation, whichever source proved it. */
interface Attestation {
  model: string | null;
  /** When it was attested; null when there is none. Age is the reader's to judge, not ours to expire. */
  at: number | null;
}

const NO_ATTESTATION: Attestation = { model: null, at: null };

/**
 * Every seat's last attested model, from the **durable** record (ADR 187). `presence` carries the
 * attestation only while a seat is live and is reaped when it goes offline — so reading it alone made
 * every idle seat's family `unknown`, which is what silently emptied the cross-family pool.
 *
 * The `occupancy.model_attested` audit row is the house-correct source: `route.ts` already names the
 * occupancy attestation the *source* and the per-act `meta.model` stamp the *dataset*. One query per
 * posture (not one per seat), index-ordered by `idx_audit_team_action_ts` (v25), folded newest-wins.
 * The scan is bounded by one team's attestation history — 661 rows at ~30/day when this shipped, so
 * it stays cheap for years; if that ever stops being true the fix is a per-seat projection, not a
 * different source.
 */
function durableAttestations(db: Database, teamId: string): Map<string, Attestation> {
  const rows = db
    .prepare<[string], { target: string | null; model: string | null; ts: number }>(
      `SELECT target, json_extract(detail, '$.new') AS model, ts
         FROM audit
        WHERE team_id = ? AND action = 'occupancy.model_attested'
        ORDER BY ts ASC`,
    )
    .all(teamId);
  const out = new Map<string, Attestation>();
  for (const r of rows) {
    if (!r.target || !r.model) continue; // a de-attestation (new: null) proves nothing
    out.set(r.target, { model: r.model, at: r.ts }); // newest wins
  }
  return out;
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

/**
 * A member's diversity family: 'human' for human seats, else the family its **live** occupancy
 * attests. Deliberately NOT durable-aware, and that is the load-bearing part (ADR 187).
 *
 * This is the predicate the review picker routes on, and it must only ever speak about a session
 * that is running now. A live seat whose current occupancy attested nothing reads `unknown` and is
 * ineligible — falling back to what it attested last week would let a *stale memory* certify a live
 * review as cross-family, which is the one failure mode durable attestation must not introduce: a
 * review whose diversity claim is false is worse than no review at all (ADR 056). The durable record
 * answers a different question — "what would waking this idle seat bring" — and lives in
 * {@link durableAttestations}, reachable only from the wake pool.
 */
export function memberFamily(db: Database, member: MemberRow): string {
  return member.kind === 'human' ? 'human' : modelFamily(latestAttestedModel(db, member.id));
}

/** The worker's family looked up by seat name — the `worker_family` half of the audit pair. */
export function workerFamily(db: Database, teamId: string, worker: string): string {
  const m = listMembers(db, teamId).find((x) => x.name === worker);
  return m ? memberFamily(db, m) : MODEL_UNKNOWN;
}

/**
 * A seat's live attested model by name, or null — presence-only, deliberately (ADR 187's split:
 * the durable record answers "what would waking this seat bring", never "what is it running now").
 * The close edge grades with this (ADR 188); a human seat has no model and grades as 'human' there.
 */
export function memberModelByName(db: Database, teamId: string, name: string): string | null {
  const m = listMembers(db, teamId).find((x) => x.name === name);
  return m ? latestAttestedModel(db, m.id) : null;
}

/** Is this seat name a human? The close edge needs the kind, not just the model. */
export function memberIsHuman(db: Database, teamId: string, name: string): boolean {
  return listMembers(db, teamId).find((x) => x.name === name)?.kind === 'human';
}

/**
 * The team's model-family posture (ADR 172) — derived at read time, never stored, because a seat is
 * a **name**, not a model: what it runs can change between sessions, so the only honest statement is
 * about who is attesting what right now, stamped with when.
 *
 * Counting rules, each load-bearing:
 *   - Family comes from an attestation, never inferred from a seat's name (`grokbot` is a name, not
 *     a guarantee). For a LIVE seat that is its occupancy's attestation; for an idle one it is the
 *     durable `occupancy.model_attested` record (ADR 187), which is why `wake_pool` can say what
 *     waking a seat would bring instead of listing anonymous names.
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
  const wake_pool: WakeCandidate[] = [];
  const durable = durableAttestations(db, teamId);
  const enrolled = listWakeableMemberIds(db, teamId);
  // ADR 219: the wake pool is built from seats PRESENCE calls offline — but presence lapses
  // for reasons other than going away, and a seat whose audit trail shows it acting seconds ago is
  // not idle, it is mid-something with a stale heartbeat. Waking it is not a remedy, it is a
  // duplicate. Read once for the whole roster; the per-seat lookup below is a Map hit.
  const lastAction = lastActionByActor(db, teamId);
  const now = Date.now();
  let attesting = 0;
  let unattested = 0;
  let humans_live = 0;
  for (const m of listMembers(db, teamId)) {
    if (m.observer) continue;
    // Ledger seats (ADR 232) attest no model, correctly — they are not evidence holes, not
    // wake-pool candidates (you cannot wake a LaunchAgent, and trying costs a lease), and never
    // rungs on the review ladder. Counting one as `unattested` would be the exact "just reuse
    // kind: agent" bug the kind exists to prevent.
    if (m.kind === 'service') continue;
    const live = hasLivePresence(db, m.id, presenceTimeoutMs);
    if (m.kind === 'human') {
      if (live) humans_live += 1;
      continue;
    }
    if (!live) {
      // ADR 187: what this seat would bring, not just that it exists. The durable attestation is a
      // memory, not an observation — so it rides with the timestamp that lets a reader discount it.
      // ADR 189: mark whether dispatch can wake it (enrollment), never filter it out — an unenrolled
      // cross-family seat is still the diversity gap, just not a spend target yet.
      const last = durable.get(m.name) ?? NO_ATTESTATION;
      // ADR 215: omit the fact when there is no evidence — `unknown` is not quiet, and asserting
      // quiet-by-absence here would be exactly the license-to-act the absent-vs-unknown rule bans.
      const actedAt = lastAction.get(m.name);
      wake_pool.push({
        seat: m.name,
        family: modelFamily(last.model),
        attested_at: last.at,
        wakeability: wakeabilityFromFacts({
          enrolled: enrolled.has(m.id),
          ...(actedAt === undefined
            ? {}
            : {
                seat_quiet:
                  resolveQuiescence(actedAt, now, QUIESCENCE_DEFAULT_QUIET_AFTER_MS).state ===
                  'quiet',
              }),
        }),
      });
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

/**
 * ADR 234 increment 2: the fraction of declared-`low` submits that route an acceptance ask ANYWAY.
 *
 * A named constant because it is a sample size, not a magic number. Exempting the low tier outright
 * would destroy the ability to learn whether low lanes WOULD have been answered — the
 * sample-starvation confound ADR 234 named, arriving by choice rather than by accident. Widen it if
 * the low tier starves; the Eval reads the draw off the ready row either way.
 */
export const ACCEPTANCE_EXEMPT_SAMPLE_RATE = 0.2;

/** What the submit edge decided about a lane's acceptance exemption (ADR 234 increment 2). */
export interface AcceptanceExemption {
  /** Route no ask at all: declared `low`, not risky, and not drawn into the sample. */
  exempt: boolean;
  /** Declared `low` and eligible, but drawn into the 1-in-5 hole — routes exactly like `normal`. */
  sampled: boolean;
}

/**
 * Does this submit skip acceptance (ADR 234 increment 2)?
 *
 * Two rules, and the second is a judgement this ADR had to make:
 *
 * 1. Only a `low` DECLARATION exempts. Never the surface, never the diff size — ADR 234 rejects
 *    inference-from-surface by name, because surface complexity predicts review COST, not review
 *    VALUE.
 * 2. **A risk tag outranks the declaration.** ADR 172 makes human review a REQUIREMENT on a risky
 *    lane, not a preference, and a worker's own "this is small" must not be able to dissolve a
 *    requirement they also declared. Without this clause `stakes: low` would be a second, quieter
 *    way to clear `risk` — precisely the shared-predicate collision ADR 225 and ADR 234 §3 built two
 *    separate fields to avoid, rebuilt at the consumer instead of at the schema.
 *
 * The draw is per-SUBMIT and deliberately not derived from the lane id: hashing the id would make
 * the same lane always-exempt or never-exempt, which is a fixed subpopulation rather than a sample,
 * and a lane bounced back and resubmitted would keep drawing the same answer. `rand` is injectable
 * so a test can pin the draw without pinning the whole clock.
 */
export function acceptanceExemption(
  lane: Lane,
  rand: () => number = Math.random,
): AcceptanceExemption {
  if (lane.stakes !== 'low' || lane.risk.length > 0) return { exempt: false, sampled: false };
  const sampled = rand() < ACCEPTANCE_EXEMPT_SAMPLE_RATE;
  return { exempt: !sampled, sampled };
}

export function pickReviewCounterpart(
  db: Database,
  teamId: string,
  lane: Lane,
  worker: string,
  presenceTimeoutMs: number,
): ReviewPick | null {
  const candidates = listMembers(db, teamId).filter(
    // A service seat is never an acceptance candidate (ADR 232 / ADR 158): a cron cannot judge a
    // landed outcome. Belt-and-braces — the ladder would drop it as ungradeable anyway, but the
    // exclusion is a kind-level fact, not an accident of a missing attestation.
    (m) =>
      m.name !== worker &&
      !m.observer &&
      m.kind !== 'service' &&
      hasLivePresence(db, m.id, presenceTimeoutMs),
  );

  if (lane.risk.length > 0) {
    // ADR 188 two-stage: a risky lane's FIRST review is the peer (agents-only ladder — humans are
    // stage two, reached when the peer's accept lands, so their scarce attention reviews an
    // already-screened change). The human requirement (ADR 172) is unchanged in strength: the
    // caller records it at ready time either way, and the close still derives
    // `human_review_missed` when no human ever confirmed. With no eligible peer the caller falls
    // back to pickHumanReviewer directly — the requirement is not gated behind a stage that
    // cannot happen.
    return pickLadder(db, teamId, worker, candidates, { agentsOnly: true });
  }

  return pickLadder(db, teamId, worker, candidates, { agentsOnly: false });
}

/**
 * The graded ladder (ADR 188). Decorrelation is a spectrum, and the old boolean rule treated
 * its middle as its bottom: 16 of the first 17 review episodes closed no_candidate on an
 * all-claude roster while a *different claude model* was live and would have caught different
 * mistakes. Order: human (cross-family by construction, and the stronger claim) > cross_family >
 * cross_model. same_model and ungradeable seats are never routed — a same-checkpoint review
 * re-runs the worker's blind spots, and an unattested seat cannot prove anything (ADR 158).
 * `agentsOnly` is the risky lane's stage-one shape: humans are stage two there, not rungs here.
 */
function pickLadder(
  db: Database,
  teamId: string,
  worker: string,
  candidates: MemberRow[],
  opts: { agentsOnly: boolean },
): ReviewPick | null {
  const workerSeat = listMembers(db, teamId).find((x) => x.name === worker);
  const workerModel = workerSeat ? latestAttestedModel(db, workerSeat.id) : null;
  const LADDER = ['human', 'cross_family', 'cross_model'] as const;
  const graded = candidates
    .filter((m) => !opts.agentsOnly || m.kind !== 'human')
    .map((m) => ({
      m,
      grade:
        m.kind === 'human'
          ? ('human' as const)
          : reviewGrade(workerModel, latestAttestedModel(db, m.id)),
    }))
    .filter(
      (c): c is { m: MemberRow; grade: (typeof LADDER)[number] } =>
        c.grade !== null && c.grade !== 'same_model',
    )
    // Stable sort: among equal grades the roster order stands — no new tie-break policy here.
    .sort((a, b) => LADDER.indexOf(a.grade) - LADDER.indexOf(b.grade));
  const best = graded[0];
  if (!best) return null;
  return {
    reviewer: best.m.name,
    // Wire-compat: `route` keeps its historical value on this path; `grade` carries the finer truth.
    route: 'cross_family',
    grade: best.grade,
    reviewer_family: memberFamily(db, best.m),
  };
}

/**
 * The stage-two (or no-peer fallback) human reviewer for a risky lane (ADR 172/188): a live human
 * seat, kind-only — never `is_admin`, which a stale agent row can still carry.
 */
export function pickHumanReviewer(
  db: Database,
  teamId: string,
  worker: string,
  presenceTimeoutMs: number,
): ReviewPick | null {
  const human = listMembers(db, teamId).find(
    (m) =>
      m.name !== worker &&
      !m.observer &&
      m.kind === 'human' &&
      hasLivePresence(db, m.id, presenceTimeoutMs),
  );
  if (!human) return null;
  return {
    reviewer: human.name,
    route: 'human_admin',
    grade: 'human',
    reviewer_family: memberFamily(db, human),
  };
}

/**
 * Offline reviewer from the marked wake_pool (ADR 191). Same ladder as the live picker (ADR 188),
 * graded against the worker's live attestation and each idle seat's *durable* model (ADR 187).
 * Only `wakeability === 'wakeable'` seats are spendable (ADR 189). Never routes same_model /
 * ungradeable / the worker themselves.
 */
export function pickWakeReviewer(
  db: Database,
  teamId: string,
  worker: string,
  posture: FamilyPosture,
): ReviewPick | null {
  const workerSeat = listMembers(db, teamId).find((x) => x.name === worker);
  const workerModel = workerSeat ? latestAttestedModel(db, workerSeat.id) : null;
  const durable = durableAttestations(db, teamId);
  const LADDER = ['cross_family', 'cross_model'] as const;
  const graded = posture.wake_pool
    .filter((c) => c.wakeability === 'wakeable' && c.seat !== worker)
    .map((c) => ({
      c,
      grade: reviewGrade(workerModel, durable.get(c.seat)?.model ?? null),
    }))
    .filter(
      (x): x is { c: WakeCandidate; grade: (typeof LADDER)[number] } =>
        x.grade === 'cross_family' || x.grade === 'cross_model',
    )
    .sort((a, b) => LADDER.indexOf(a.grade) - LADDER.indexOf(b.grade));
  const best = graded[0];
  if (!best) return null;
  return {
    reviewer: best.c.seat,
    route: 'cross_family',
    grade: best.grade,
    reviewer_family: best.c.family,
  };
}

/** Circuit-breaker trip threshold (ADR 191 §5) — after this many ready entries, wake no more. */
export const REVIEW_LOOP_BREAKER_N = 3;

/** How many times this lane has entered `ready_for_review` (each is one bounce into the review loop). */
export function reviewLoopBounceCount(db: Database, teamId: string, laneId: string): number {
  const row = db
    .prepare<[string, string], { n: number }>(
      `SELECT COUNT(*) AS n FROM audit
        WHERE team_id = ? AND action = 'lane.ready_for_review' AND target = ?`,
    )
    .get(teamId, laneId);
  return row?.n ?? 0;
}
