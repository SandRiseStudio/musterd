import {
  type CloseReason,
  CloseReasonSchema,
  modelFamily,
  MODEL_UNKNOWN,
  normalizeModelId,
  wakeabilityFromFacts,
  type FamilyPosture,
  type FamilyPostureState,
  type ReviewGrade,
  reviewGrade,
  type WakeCandidate,
  type Lane,
} from '@musterd/protocol';
import type { Database } from 'better-sqlite3';
import { getMemberByName, listMembers } from './members.js';
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
 *   2. otherwise a live **and not busy** seat (quiescence 120s, work-audit; `unknown` kept) whose
 *      **model family differs from the worker's** (ADR 056: correlated models make correlated
 *      mistakes, so a same-family review re-runs the worker's blind spots). Family comes from the
 *      occupancy's attested model (ADR 158 observed-over-declared); a seat attesting `unknown` is
 *      NOT eligible — it cannot prove diversity, and musterd would rather say nothing than something
 *      false. A human seat is always cross-family by construction.
 *   3. nobody qualifies → `null`: the caller emits no ask and the verb response sanctions
 *      self-close (the ADR 145 degradation — never a wedge).
 */

export interface ReviewPick {
  /** The chosen counterpart's seat name. */
  reviewer: string;
  /**
   * Why this seat: 'human_admin' (risk route), 'cross_family', or 'named' — a seat a human routed
   * the acceptance to by hand, which the picker did not choose and cannot vouch for. Historical
   * two-value field widened once, on purpose: folding `named` into `cross_family` would let a
   * hand-routed acceptor be counted as a proven-diverse one.
   *
   * **A `named` row must be excluded from any ADR 056 diversity claim, and from any metric about
   * what the PICKER does.** This warning is on `route` rather than only on `namedAcceptor` because
   * `route` is the field a query meets — izzo's review of #1152 traced `liveRouted`
   * (`scripts/research/adr-260-acceptance-eval.ts`) and found named rows landing squarely in the
   * denominator: `crossFamilyShare` would divide picker hits by picked-OR-named submits, and the
   * pre-registered concentration metric would read a human repeatedly trusting one seat as the
   * picker funnelling — a false positive on the exact hypothesis. Filter on this field, not on
   * grade.
   */
  route: 'human_admin' | 'cross_family' | 'named' | 'ungraded';
  /**
   * The achieved rung of the diversity ladder (ADR 188). 'human' for a human counterpart —
   * cross-family by construction, and named honestly rather than folded into cross_family.
   *
   * On a `named` route this is OBSERVED, never promised: nothing was filtered on it, so it reports
   * the pairing as it stood and abstains to `same_model` when it cannot prove better. It is not a
   * routing decision and must never be read as one.
   *
   * `ungraded` (ADR 351) is the rung below the ladder: the WORKER's live occupancy attests nothing,
   * so no pairing can be graded, and the picker routes to a live attested peer anyway rather than
   * to nobody. It is not one of ADR 188's three grades on purpose — it claims no decorrelation, the
   * close edge abstains on it (`review_grade_unknown`), and its own `route` value keeps it out of
   * the ADR 260 eval's `liveRouted` population.
   */
  grade: PickGrade;
  /** The reviewer's family ('human' for human seats) — the audit's reviewer_family. */
  reviewer_family: string;
}

/**
 * The rung below ADR 188's ladder (ADR 351): routed, and proven nothing about. Kept off
 * `REVIEW_GRADES` so nothing that reasons about decorrelation can mistake it for a grade.
 */
export const UNGRADED = 'ungraded' as const;
export type PickGrade = ReviewGrade | 'human' | typeof UNGRADED;
/** What a selection snapshot can record for a chosen peer — never 'human' (the peer ladder is agents-only). */
export type SnapshotGrade = ReviewGrade | typeof UNGRADED;

/** Why a seat was not the reviewer in a particular, recorded selection. ADR 303 keeps this
 * vocabulary deliberately bounded so an audit row remains evidence, not an unstructured diary. */
export type ReviewSelectionExclusion =
  | 'self'
  | 'service_or_observer'
  | 'no_live_presence'
  | 'not_agent'
  | 'busy'
  /** The WORKER's live occupancy attests nothing, so no candidate can be graded against it. This is
   *  a fact about the asker, filed once per candidate so the set stays complete; it is NOT the
   *  candidate's own `unknown_grade`. Before 2026-09-01 the two were conflated and an unattested
   *  worker read as "the team had nobody" (10 of 129 no_candidate rows, every candidate a known
   *  family). Written on rows from 2026-09-01 to ADR 351 only: since then a gradeable candidate
   *  under an unattested worker is routable at the `ungraded` rung, and loses (if it loses) on
   *  `tie_break`. Kept so historical rows still type. */
  | 'worker_unattested'
  | 'unknown_grade'
  | 'same_model'
  | 'lower_grade'
  | 'tie_break';

/** One seat evaluated by the live peer-review picker at decision time. */
export interface ReviewSelectionCandidate {
  /** Seat name only — never a credential, Presence id, or transcript path. */
  member: string;
  /** Current live model family, or the truthful `unknown` / `human` sentinel. */
  family: string;
  /** Whether this seat won the picker after all routing constraints and ladder precedence. */
  eligible: boolean;
  /** Present only for the selected candidate. */
  grade?: SnapshotGrade;
  /** Present when this candidate was not selected. */
  exclusion?: ReviewSelectionExclusion;
}

/** Decision-time evidence persisted with `lane.ready_for_review` (ADR 303). */
export interface ReviewSelectionSnapshot {
  selected: { reviewer: string; grade: SnapshotGrade } | null;
  /** The asker's live family at decision time (`unknown` when its occupancy attests nothing). The
   *  close row carries the same value later; here so the ready row is readable on its own. */
  worker_family: string;
  candidates: ReviewSelectionCandidate[];
}

export interface ReviewSelection {
  pick: ReviewPick | null;
  snapshot: ReviewSelectionSnapshot;
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

/** What the projection could derive from a lane's latest `lane.closed` row. Either half may abstain. */
export interface CloseVerdict {
  /** ADR 169: was the close a counterpart *acceptance*? */
  verified?: boolean;
  /** ADR 283: WHY it closed that way — the half that tells "nobody asked" from "asked and ignored". */
  reason?: CloseReason;
}

/**
 * The board's close annotation (ADR 169 + ADR 283): lane id → what its latest `lane.closed` audit
 * row recorded. One indexed query per board read; lanes with no close row (pre-169 history,
 * non-terminal lanes) are simply absent — the projection says nothing rather than guessing.
 *
 * The two halves abstain INDEPENDENTLY, and that is the point rather than an accident. A close
 * from before ADR 217 named the reason a way this vocabulary does not cover; a close from before
 * ADR 169 recorded no verified-ness at all. Deriving either from the other would manufacture a
 * claim the ledger never made — and it is precisely the "unconfirmed" word with nothing behind it
 * that ADR 283 exists to take apart.
 */
export function closeVerdicts(db: Database, teamId: string): Map<string, CloseVerdict> {
  const rows = db
    .prepare<
      [string],
      { target: string | null; detail: string | null }
    >("SELECT target, detail FROM audit WHERE team_id = ? AND action = 'lane.closed' ORDER BY ts")
    .all(teamId);
  const out = new Map<string, CloseVerdict>();
  for (const r of rows) {
    if (!r.target || !r.detail) continue;
    try {
      const d = JSON.parse(r.detail) as { verified?: unknown; reason?: unknown };
      const verdict: CloseVerdict = {};
      if (typeof d.verified === 'boolean') verdict.verified = d.verified;
      // Parsed, never cast: a reason this build does not know is dropped, so a newer daemon's
      // vocabulary reaches a reader as "unknown" rather than as a string nothing can render.
      const reason = CloseReasonSchema.safeParse(d.reason);
      if (reason.success) verdict.reason = reason.data;
      // A row that recorded neither annotates nothing — it must not erase a better earlier row.
      if (verdict.verified !== undefined || verdict.reason !== undefined) {
        out.set(r.target, verdict); // newest row wins
      }
    } catch {
      /* a malformed detail annotates nothing */
    }
  }
  return out;
}

/**
 * Apply a close verdict to a lane for the wire (ADR 169 + ADR 283), spreading only the halves that
 * actually derived. One helper so `/lanes` and the orientation brief cannot drift apart — they did
 * once already, which is why the web board showed accepted/unconfirmed chips for two ADRs while
 * the brief a seat reads said only `✓`.
 */
export function annotateClose(lane: Lane, verdict: CloseVerdict | undefined): Lane {
  if (verdict === undefined) return lane;
  return {
    ...lane,
    ...(verdict.verified !== undefined ? { verified: verdict.verified } : {}),
    ...(verdict.reason !== undefined ? { close_reason: verdict.reason } : {}),
  };
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
  return selectReviewCounterpart(db, teamId, lane, worker, presenceTimeoutMs).pick;
}

/**
 * Select a live agent counterpart and retain the full decision-time evidence for the ready audit.
 * This is intentionally a peer-picker only: risky human escalation and wake routing remain distinct
 * paths in the transport, whose explicit outcome is recorded alongside this snapshot.
 */
export function selectReviewCounterpart(
  db: Database,
  teamId: string,
  _lane: Lane,
  worker: string,
  presenceTimeoutMs: number,
): ReviewSelection {
  const lastWork = lastActionByActor(db, teamId, {
    // Claims, credentials, and leases establish authority/Presence; none is work that should make
    // a counterpart busy. This keeps review selection orthogonal to the lease-bound HTTP authority.
    excludeActions: [
      'occupancy.model_attested',
      'claim.occupied',
      'claim.reseated',
      'claim.superseded',
      'agent_seat_credential.minted',
      'agent_seat_credential.rotated',
      'agent_session_lease.minted',
    ],
  });
  const now = Date.now();
  const workerSeat = listMembers(db, teamId).find((x) => x.name === worker);
  const workerModel = workerSeat ? latestAttestedModel(db, workerSeat.id) : null;
  const worker_family = workerSeat ? memberFamily(db, workerSeat) : MODEL_UNKNOWN;
  // A worker whose live occupancy attests nothing cannot be graded against ANY candidate. That is
  // one fact about the asker, not a fact about each candidate — see `worker_unattested`.
  const workerUnattested = normalizeModelId(workerModel) === MODEL_UNKNOWN;
  const candidates: ReviewSelectionCandidate[] = [];
  const selectable: Array<{ index: number; member: MemberRow; grade: SnapshotGrade }> = [];

  for (const member of listMembers(db, teamId)) {
    const candidate: ReviewSelectionCandidate = {
      member: member.name,
      family: memberFamily(db, member),
      eligible: false,
    };
    candidates.push(candidate);
    if (member.name === worker) {
      candidate.exclusion = 'self';
      continue;
    }
    if (member.observer || member.kind === 'service') {
      candidate.exclusion = 'service_or_observer';
      continue;
    }
    if (!hasLivePresence(db, member.id, presenceTimeoutMs)) {
      candidate.exclusion = 'no_live_presence';
      continue;
    }
    // Live peer review is agents-only (ADR 253). Human escalation is a distinct transport path.
    if (member.kind !== 'agent') {
      candidate.exclusion = 'not_agent';
      continue;
    }
    const actedAt = lastWork.get(member.name);
    if (
      actedAt !== undefined &&
      resolveQuiescence(actedAt, now, QUIESCENCE_DEFAULT_QUIET_AFTER_MS).state === 'busy'
    ) {
      candidate.exclusion = 'busy';
      continue;
    }
    const candidateModel = latestAttestedModel(db, member.id);
    const grade = reviewGrade(workerModel, candidateModel);
    if (grade === null) {
      // Attribute the null to the side that owns it. A candidate that attests nothing is its own
      // `unknown_grade` whatever the worker did — never routed, at any rung: two unknowns prove
      // even less than one. A gradeable candidate blinded by an unattested WORKER is a different
      // fact (ADR 303's `worker_unattested`), and since ADR 351 it is routable at the rung below
      // the ladder: an ungraded review beats no review, and the record says exactly that much.
      if (workerUnattested && normalizeModelId(candidateModel) !== MODEL_UNKNOWN) {
        selectable.push({ index: candidates.length - 1, member, grade: UNGRADED });
      } else {
        candidate.exclusion = 'unknown_grade';
      }
      continue;
    }
    if (grade === 'same_model') {
      candidate.exclusion = 'same_model';
      continue;
    }
    selectable.push({ index: candidates.length - 1, member, grade });
  }

  // `ungraded` sits below both rungs (ADR 351). In practice a selection is all-graded or
  // all-ungraded — the worker is attested or it is not — but the order is stated so the ladder
  // reads as one list, not as a rule plus an exception.
  const LADDER: SnapshotGrade[] = ['cross_family', 'cross_model', UNGRADED];
  // Stable sort preserves roster order for an equal-grade tie, which is the pre-ADR-303 policy.
  selectable.sort((a, b) => LADDER.indexOf(a.grade) - LADDER.indexOf(b.grade));
  const best = selectable[0];
  if (!best) return { pick: null, snapshot: { selected: null, worker_family, candidates } };

  for (const option of selectable) {
    const candidate = candidates[option.index]!;
    if (option === best) {
      candidate.eligible = true;
      candidate.grade = option.grade;
    } else {
      candidate.exclusion = option.grade === best.grade ? 'tie_break' : 'lower_grade';
    }
  }
  const pick: ReviewPick = {
    reviewer: best.member.name,
    // Wire-compat: `route` keeps its historical value on the graded path; `grade` carries the finer
    // truth. An ungraded pick gets its OWN route value, on purpose: `route` is the field the ADR 260
    // eval filters its population on (see `route` above), and a rung that proves nothing must not
    // enter the denominator of a diversity claim by silence.
    route: best.grade === UNGRADED ? UNGRADED : 'cross_family',
    grade: best.grade,
    reviewer_family: memberFamily(db, best.member),
  };
  return {
    pick,
    snapshot: {
      selected: { reviewer: pick.reviewer, grade: best.grade },
      worker_family,
      candidates,
    },
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

/** Why a named acceptor was refused — the submit answers with the reason, never a silent fallback
 *  to the picker: a hand-routed acceptance that quietly became a picked one would be the same lie
 *  as a picked one recorded as hand-routed. */
export type NamedAcceptorRefusal = 'unknown_seat' | 'observer' | 'is_the_worker';

/**
 * The acceptor a human named by hand (`acceptor` on the submit patch), rather than one the ladder
 * chose. Presence is deliberately NOT required: the measured case that motivated this had the named
 * seat marked `out`, and it answered within minutes — an ask waiting in an inbox is the normal way
 * an agent seat is reached, and refusing to route to one would rebuild the very gap this closes.
 *
 * The grade is OBSERVED, not promised. The ladder's grade says "this is why I chose this seat"; a
 * named seat was not chosen, so the grade here only reports the pairing as it stands and abstains
 * (`same_model`, honestly) when it cannot prove better. Nothing is filtered on it — the namer's
 * judgement is the authority, and `route: 'named'` is what tells every later reader that.
 */
export function namedAcceptor(
  db: Database,
  teamId: string,
  worker: string,
  name: string,
): ReviewPick | { refused: NamedAcceptorRefusal } {
  const member = getMemberByName(db, teamId, name);
  if (!member) return { refused: 'unknown_seat' };
  if (member.observer) return { refused: 'observer' };
  // An owner naming themselves can never produce a confirmed close — `verified` is derived from
  // closer ≠ owner-at-close — so accepting it would hand back a lane whose acceptance is guaranteed
  // to record as a self-close. Refusing says so at the point the mistake is made.
  if (member.name === worker) return { refused: 'is_the_worker' };
  const grade =
    member.kind === 'human'
      ? ('human' as const)
      : (reviewGrade(memberModelByName(db, teamId, worker), latestAttestedModel(db, member.id)) ??
        'same_model');
  return {
    reviewer: member.name,
    route: 'named',
    grade,
    reviewer_family: memberFamily(db, member),
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
