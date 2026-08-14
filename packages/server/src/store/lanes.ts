import {
  ACCEPTANCE_STALE_MS,
  compareGoals,
  DEFAULT_PROJECT,
  globToRegExp,
  isAwaitingAcceptance,
  LANE_CONTENDING_STATES,
  LANE_TERMINAL_STATES,
  resolveStakesDefault,
  type Goal,
  type Lane,
  type LaneState,
  type LaneWarning,
  type OpenLane,
  type UpdateLane,
} from '@musterd/protocol';
import type { Database } from 'better-sqlite3';
import { ulid } from 'ulid';
import type { AuditRow } from './audit.js';
import { listGoals } from './goals.js';
import { getPolicy } from './teams.js';

/**
 * Coordination lanes, Phase 1 (ADR 083) — store CRUD + the two warn-only contention checks.
 * Declarations only: `surface_globs` ∩ and `depends_on` state are the whole engine. Checks are
 * computed live (the board always reflects current state); the *delivery* dedup — warn once until the
 * condition clears or changes — falls out of diffing warnings before/after a mutation (route layer).
 */

interface LaneRow {
  id: string;
  team_id: string;
  project: string;
  title: string;
  detail: string | null;
  /** Lane kind (spec 2026-08-14); null on pre-v41 rows ⇒ ordinary lane. */
  kind: string | null;
  owner_seat: string | null;
  role: string | null;
  surface_globs: string;
  depends_on: string;
  branch: string | null;
  goal_id: string | null;
  /** JSON array of declared risk tags (ADR 169); null on pre-v24 rows ⇒ []. */
  risk: string | null;
  /** Declared acceptance stakes (ADR 234); null on pre-v32 rows ⇒ 'normal' — absence IS the default. */
  stakes: string | null;
  /** Who set `stakes` (ADR 244); null ⇒ 'declared' — every pre-policy lane got its value from a seat
   *  or from silence, and ADR 234 §2 rules that silence IS the worker's declaration. */
  stakes_provenance: string | null;
  /** The worker's merge attestation captured at awaiting_acceptance (ADR 192); null until lane_submit. */
  merged_json: string | null;
  state: string;
  created_by: string;
  created_at: number;
  claimed_at: number | null;
  resolved_at: number | null;
  updated_at: number;
}

function rowToLane(row: LaneRow, teamSlug: string): Lane {
  return {
    id: row.id,
    team: teamSlug,
    project: row.project,
    title: row.title,
    detail: row.detail,
    // Absence reads as "ordinary lane" — same skew posture as stakes below (ADR 148).
    kind: (row.kind as Lane['kind']) ?? null,
    owner_seat: row.owner_seat,
    role: row.role,
    surface_globs: JSON.parse(row.surface_globs) as string[],
    depends_on: JSON.parse(row.depends_on) as string[],
    branch: row.branch,
    goal_id: row.goal_id,
    risk: row.risk ? (JSON.parse(row.risk) as string[]) : [],
    // Absence reads as the default rather than as missing data, so every pre-234 lane keeps its
    // current meaning without a backfill (ADR 148 skew posture).
    stakes: (row.stakes as Lane['stakes']) ?? 'normal',
    // Same skew posture one field over: absence is 'declared', never missing data (ADR 244).
    stakes_provenance: (row.stakes_provenance as Lane['stakes_provenance']) ?? 'declared',
    merged: row.merged_json ? (JSON.parse(row.merged_json) as Lane['merged']) : null,
    state: row.state as LaneState,
    created_by: row.created_by,
    created_at: row.created_at,
    claimed_at: row.claimed_at,
    resolved_at: row.resolved_at,
    updated_at: row.updated_at,
  };
}

/** States that participate in contention (ADR 169: shared constant — includes ready_for_review). */
const CONTENDING: ReadonlySet<string> = LANE_CONTENDING_STATES;

export function openLane(
  db: Database,
  teamId: string,
  teamSlug: string,
  createdBy: string,
  input: OpenLane,
  now: number = Date.now(),
): Lane {
  const claim = input.claim === true;
  // ADR 244: an admin's default-stakes rule fires HERE, at open, and never again. Resolving it late
  // — at submit, or at close — would make a policy able to rewrite what a lane already was, which is
  // the exact trap ADR 234 increment 2 named for the close edge: only a RECORDED fact earns a label.
  // An explicit declaration always wins, in EITHER direction: a seat that thinks its web change
  // deserves eyes must be able to say so without an admin, and a seat that says `low` on a lane
  // policy would have left `normal` has still declared it themselves.
  const surfaces = input.surface_globs ?? [];
  const rule =
    input.stakes === undefined
      ? resolveStakesDefault(getPolicy(db, teamId).stakes_defaults, surfaces)
      : undefined;
  const stakes = input.stakes ?? rule?.stakes ?? 'normal';
  const row: LaneRow = {
    id: ulid(),
    team_id: teamId,
    project: input.project ?? 'default',
    title: input.title,
    detail: input.detail ?? null,
    kind: input.kind ?? null,
    owner_seat: claim ? createdBy : null,
    role: input.role ?? null,
    surface_globs: JSON.stringify(input.surface_globs ?? []),
    depends_on: JSON.stringify(input.depends_on ?? []),
    branch: input.branch ?? null,
    goal_id: input.goal_id ?? null,
    risk: input.risk && input.risk.length > 0 ? JSON.stringify(input.risk) : null,
    // Store only an explicit non-default declaration; null means "did not say", which reads back as
    // 'normal'. Keeps "never declared" and "declared normal" indistinguishable ON PURPOSE — nothing
    // in increment 1 should be able to tell them apart, because nothing should act on the difference.
    stakes: stakes !== 'normal' ? stakes : null,
    // Written only where a policy actually fired. `declared` is the default on read, so a policy
    // that defaulted a lane to `normal` still records `defaulted` — the Eval must be able to see a
    // rule that fired even when it changed nothing, or "policy is inert here" becomes unfalsifiable.
    stakes_provenance: rule ? 'defaulted' : null,
    merged_json: null,
    state: claim ? 'claimed' : 'open',
    created_by: createdBy,
    created_at: now,
    claimed_at: claim ? now : null,
    resolved_at: null,
    updated_at: now,
  };
  db.prepare(
    `INSERT INTO lanes (id, team_id, project, title, detail, kind, owner_seat, role, surface_globs,
                        depends_on, branch, goal_id, risk, stakes, stakes_provenance, merged_json, state, created_by, created_at, claimed_at, resolved_at, updated_at)
     VALUES (@id, @team_id, @project, @title, @detail, @kind, @owner_seat, @role, @surface_globs,
             @depends_on, @branch, @goal_id, @risk, @stakes, @stakes_provenance, @merged_json, @state, @created_by, @created_at, @claimed_at, @resolved_at, @updated_at)`,
  ).run(row);
  return rowToLane(row, teamSlug);
}

export function getLane(db: Database, teamId: string, id: string, teamSlug: string): Lane | null {
  const row = db
    .prepare<[string, string], LaneRow>('SELECT * FROM lanes WHERE team_id = ? AND id = ?')
    .get(teamId, id);
  return row ? rowToLane(row, teamSlug) : null;
}

/**
 * Apply a partial update (lane_update / claim / handoff / resolve are all this seam). Stamps
 * claimed_at on first ownership and resolved_at on done/abandoned. Returns null when unknown.
 */
export function updateLane(
  db: Database,
  teamId: string,
  id: string,
  teamSlug: string,
  patch: UpdateLane,
  now: number = Date.now(),
): Lane | null {
  const existing = getLane(db, teamId, id, teamSlug);
  if (!existing) return null;
  const owned = patch.owner_seat !== undefined ? patch.owner_seat : existing.owner_seat;
  // Taking ownership of an `open` lane implies `claimed` unless the patch names a state itself.
  let state: LaneState =
    patch.state ??
    (patch.owner_seat !== undefined && existing.state === 'open' ? 'claimed' : existing.state);
  // ADR 192: coerce the legacy ADR 169 spelling on write so new rows are canonical.
  if (state === 'ready_for_review') state = 'awaiting_acceptance';
  // The release invariant: `open` means unowned, so moving a lane back to `open` lets go of it —
  // owner and the claim stamp both clear. Without this the state machine admits (open, owner=X),
  // and the board then states a false fact: a lane nobody is working, rendered as someone's. This
  // transition *is* the release verb (no `owner_seat: null` on the patch surface — that would also
  // let a caller assign an arbitrary owner, which lane_claim is for).
  const ownerSeat = state === 'open' ? null : owned;
  // ADR 192: a merge attestation on a patch that *enters or sits in* awaiting_acceptance is the
  // worker's stage-one claim — persist it so a counterpart's later accept carries it. (A terminal
  // patch's `merged` keeps its ADR 109 meaning and flows to the audit at the route layer; persisting
  // it here too is harmless and keeps the lane's last attestation readable.)
  const merged = patch.merged !== undefined ? patch.merged : existing.merged;
  const risk = patch.risk ?? existing.risk;
  const stakes = patch.stakes ?? existing.stakes;
  // ADR 244: editing stakes takes OWNERSHIP of the value. A worker overriding a policy-defaulted
  // lane has made their own judgement, and leaving it `defaulted` would keep counting that lane
  // toward the very policy it was overriding — inflating the policy bucket with its own refutations.
  // Untouched otherwise, so a patch to some other field never launders provenance.
  const stakesProvenance = patch.stakes !== undefined ? 'declared' : existing.stakes_provenance;
  const next = {
    id,
    team_id: teamId,
    project: patch.project ?? existing.project,
    // ADR 240: the title is correctable — opt-in, like `detail`, so every other patch leaves it be.
    title: patch.title !== undefined ? patch.title : existing.title,
    detail: patch.detail !== undefined ? patch.detail : existing.detail,
    owner_seat: ownerSeat,
    surface_globs: JSON.stringify(patch.surface_globs ?? existing.surface_globs),
    depends_on: JSON.stringify(patch.depends_on ?? existing.depends_on),
    branch: patch.branch !== undefined ? patch.branch : existing.branch,
    goal_id: patch.goal_id !== undefined ? patch.goal_id : existing.goal_id,
    risk: risk.length > 0 ? JSON.stringify(risk) : null,
    stakes: stakes !== 'normal' ? stakes : null,
    stakes_provenance: stakesProvenance,
    merged_json: merged ? JSON.stringify(merged) : null,
    state,
    // claimed_at describes the CURRENT tenure: sticky while held, cleared by the release above so a
    // re-claim stamps fresh rather than inheriting the previous holder's timestamp.
    //
    // "Cleared by the release above" only covers owner -> open -> owner. A DIRECT owner -> owner
    // move (a handoff, or the takeover this used to permit) never passes through null, so the new
    // holder inherited the old one's stamp — and the field that should have read "owned since
    // 22:00" instead read as the new holder's own claim. That is not cosmetic: it is precisely what
    // let a takeover be misread as a first claim on 2026-08-01. A new owner always starts a new
    // tenure, so stamp fresh whenever the owner actually changes.
    claimed_at:
      ownerSeat === null
        ? null
        : ownerSeat !== existing.owner_seat
          ? now
          : (existing.claimed_at ?? now),
    resolved_at: LANE_TERMINAL_STATES.has(state as LaneState)
      ? (existing.resolved_at ?? now)
      : null,
    updated_at: now,
  };
  db.prepare(
    `UPDATE lanes SET project=@project, title=@title, detail=@detail, owner_seat=@owner_seat, surface_globs=@surface_globs,
       depends_on=@depends_on, branch=@branch, goal_id=@goal_id, risk=@risk, stakes=@stakes, stakes_provenance=@stakes_provenance, merged_json=@merged_json,
       state=@state, claimed_at=@claimed_at, resolved_at=@resolved_at, updated_at=@updated_at
     WHERE team_id=@team_id AND id=@id`,
  ).run(next);
  return getLane(db, teamId, id, teamSlug);
}

export interface LaneFilter {
  project?: string;
  owner?: string;
  openOnly?: boolean;
  goalId?: string;
}

export function listLanes(
  db: Database,
  teamId: string,
  teamSlug: string,
  filter: LaneFilter = {},
): Lane[] {
  const rows = db
    .prepare<[string], LaneRow>('SELECT * FROM lanes WHERE team_id = ? ORDER BY created_at')
    .all(teamId);
  return rows
    .map((r) => rowToLane(r, teamSlug))
    .filter((l) => (filter.project ? l.project === filter.project : true))
    .filter((l) => (filter.owner ? l.owner_seat === filter.owner : true))
    .filter((l) => (filter.openOnly ? l.state === 'open' : true))
    .filter((l) => (filter.goalId ? l.goal_id === filter.goalId : true));
}

/**
 * What a lane-less `handoff` should carry (ADR 231).
 *
 * `attach` — the sender holds exactly one live lane, so there is nothing to choose between and the
 * daemon writes `meta.lane_handoff` onto the envelope. `ambiguous` — two or more, so the daemon
 * warns and stores the message untouched rather than mis-attributing it. `none` — the genuinely
 * lane-less handoff, which is legal and stays silent.
 */
export type HandoffLaneDerivation =
  | { kind: 'attach'; lane: Lane; basis: HandoffLaneBasis }
  | { kind: 'ambiguous'; candidates: Lane[]; basis: HandoffLaneBasis }
  | { kind: 'none' };

/**
 * Which evidence answered (ADR 243) — audited, never on the wire. `handed_to_recipient` is the
 * strong fact (this sender gave that seat this lane, and they still hold it); `held` is ADR 231's
 * original fallback. Recorded so the two rules can be told apart in a month: a derived population
 * still dominated by `held` means the fallback is doing the real work.
 */
export type HandoffLaneBasis = 'handed_to_recipient' | 'held';

/**
 * Derive the lane a `handoff` from `seat` is about, from the lanes that seat actually holds.
 *
 * Only `lane_handoff` ever wrote `meta.lane_handoff.lane`, so 24 of the first 30 handoffs on the
 * dogfood team named no lane at all — and the orientation `why`, which reads a handoff as a live
 * instruction, has nothing to check those against. It cannot tell a fresh instruction from a
 * four-day-old one whose PR merged, so it serves the stale one (ADR 173's abstain-by-showing: an
 * unjudgeable why is still the human's words, and hiding it is worse).
 *
 * This closes the gap by construction rather than by heuristic — the rejected alternative was to
 * age out an old handoff, which is a number standing in for a fact. Deliberately warn-not-refuse on
 * ambiguity: unlike the un-threaded `accept` (send.ts), where a wrong guess writes a verdict onto
 * the wrong lane and cannot be recovered, declining to attach here leaves the message exactly as it
 * is today — unjudgeable, but never wrong. A message is worth more than a derived field.
 *
 * ADR 243 CORRECTION. Held lanes are the WEAKER evidence and are now the fallback, because
 * `lane_handoff` transfers ownership *before* the explanatory act is sent: the lane the sender means
 * has already left the held set and could never be derived, while an unrelated lane they still hold
 * could — silently, in the confident single-candidate branch. The stronger fact is the pairing the
 * sender just created: `recipient` is who this act is directed at, so a lane this sender handed to
 * THAT seat, which that seat still holds, has an unambiguous referent that "a lane I hold" cannot
 * see. Preferred, not merged into one pool: a held lane must never dilute a handed one into a
 * false ambiguity, and a handed one must never be outvoted by lanes that have nothing to do with
 * this recipient.
 */
export function deriveHandoffLane(
  db: Database,
  teamId: string,
  teamSlug: string,
  seat: string,
  /** The seat this handoff act is directed at, when it is directed at one. */
  recipient?: string,
): HandoffLaneDerivation {
  if (recipient !== undefined && recipient !== seat) {
    const handed = lanesHandedTo(db, teamId, teamSlug, seat, recipient);
    const basis = 'handed_to_recipient' as const;
    if (handed.length === 1) return { kind: 'attach', lane: handed[0]!, basis };
    if (handed.length > 1) return { kind: 'ambiguous', candidates: handed, basis };
  }
  const held = listLanes(db, teamId, teamSlug, { owner: seat }).filter(
    (l) => !LANE_TERMINAL_STATES.has(l.state),
  );
  if (held.length === 0) return { kind: 'none' };
  if (held.length === 1) return { kind: 'attach', lane: held[0]!, basis: 'held' };
  return { kind: 'ambiguous', candidates: held, basis: 'held' };
}

/** How far back the handed-lane read scans the ledger. Ordered by ts DESC, so this is a page size
 *  and not a time window — the qualifying test is current ownership, never age. */
const HANDOFF_LEDGER_SCAN = 200;

/**
 * Lanes `sender` handed to `recipient` that `recipient` still holds and has not closed (ADR 243).
 *
 * Read from the acquisition ledger (ADR 203), which is the only record that distinguishes a handoff
 * from a self-claim — the lane row afterwards shows only who owns it, not who gave it to them. The
 * qualifying condition is deliberately **current state, not recency**: the recipient still owns it
 * and it is still live. An old transfer the recipient has since resolved, released or passed on is
 * gone from the set because the fact stopped being true, not because a timer expired it — the same
 * reason ADR 231 refused to age out an old handoff.
 *
 * `detail` is parsed in JS rather than filtered with `json_extract`, on ADR 173's evidence: a single
 * malformed `detail` makes SQLite raise from the QUERY and takes down every read that scans it.
 */
function lanesHandedTo(
  db: Database,
  teamId: string,
  teamSlug: string,
  sender: string,
  recipient: string,
): Lane[] {
  const rows = db
    .prepare<[string, string, number], AuditRow>(
      `SELECT * FROM audit WHERE team_id = ? AND action = 'lane.claimed' AND actor = ?
       ORDER BY ts DESC, id DESC LIMIT ?`,
    )
    .all(teamId, sender, HANDOFF_LEDGER_SCAN);
  const handedIds = new Set<string>();
  for (const row of rows) {
    let detail: { kind?: unknown; owner?: unknown; lane?: unknown };
    try {
      detail = JSON.parse(row.detail ?? '{}') as typeof detail;
    } catch {
      continue; // an unreadable row is not evidence of anything; never let it break the read
    }
    if (detail.kind !== 'handoff' || detail.owner !== recipient) continue;
    const lane = typeof detail.lane === 'string' ? detail.lane : row.target;
    if (lane) handedIds.add(lane);
  }
  if (handedIds.size === 0) return [];
  return listLanes(db, teamId, teamSlug, { owner: recipient }).filter(
    (l) => handedIds.has(l.id) && !LANE_TERMINAL_STATES.has(l.state),
  );
}

/** Lanes joined to a Goal (ADR 084) — the input to {@link deriveGoalStatus}. */
export function lanesForGoal(
  db: Database,
  teamId: string,
  teamSlug: string,
  goalId: string,
): Lane[] {
  return listLanes(db, teamId, teamSlug, { goalId });
}

/** Lane states that are terminal — a lane no longer being worked (ADR 169: shared constant). */
const TERMINAL: ReadonlySet<string> = LANE_TERMINAL_STATES;

/**
 * The pinned derived-Goal-status rule (ADR 048 as amended by ADR 084): **lanes-authoritative,
 * conjunctive, flap-tolerant.** Given the lanes joined to a Goal:
 *   - `shipped`   ⟺ ≥1 lane, all terminal, and ≥1 reached `done` (not all `abandoned`);
 *   - `in-flight` ⟺ any lane is live (open/claimed/active/blocked/ready_for_review);
 *   - `planned`   ⟺ no lanes.
 * Threads never enter here — they are the fallback the caller uses only when a Goal has zero lanes,
 * so a dead thread-`resolve` (2/21 in practice) can never pin a Goal's status. Live, not a latch:
 * a new lane on a shipped Goal honestly returns it to `in-flight`.
 */
export function deriveGoalStatus(lanes: Lane[]): 'planned' | 'in-flight' | 'shipped' {
  if (lanes.length === 0) return 'planned';
  const allTerminal = lanes.every((l) => TERMINAL.has(l.state));
  const anyDone = lanes.some((l) => l.state === 'done');
  if (allTerminal && anyDone) return 'shipped';
  return 'in-flight';
}

/**
 * Glob-vs-glob surface intersection — cheap path-prefix relation, not a real glob engine (P1 accepts
 * false positives; warn-not-block makes them cheap, ADR 083). Two declared surfaces overlap when one's
 * literal prefix (up to the first wildcard) is a path-prefix of the other's.
 */
export function globsOverlap(a: string, b: string): boolean {
  const prefix = (g: string) => g.split(/[*?[]/, 1)[0]!.replace(/\/+$/, '');
  const pa = prefix(a);
  const pb = prefix(b);
  const isPrefix = (short: string, long: string) =>
    short === long || long.startsWith(short === '' ? '' : short + '/') || short === '';
  return pa.length <= pb.length ? isPrefix(pa, pb) : isPrefix(pb, pa);
}

/**
 * The first **contending** lane (claimed/active/blocked) whose declared `surface_globs` cover the given
 * concrete path — path-vs-glob (a real match of one file against the lane's globs, `globToRegExp` in
 * `path` flavor), NOT the cheap glob-vs-glob prefix `globsOverlap` uses. This is the read behind ADR 150
 * Gate A: "does <seat> own a claimed lane covering this edit?" (pass `owner`), and its blocked cousin
 * "is any seat's lane covering it?" (omit `owner`, for the denial's "owned by X" vs "claim one" copy).
 * The path must arrive repo-relative (the hook normalizes it), matching how lanes declare their globs.
 */
export function laneCoveringPath(
  db: Database,
  teamId: string,
  teamSlug: string,
  path: string,
  opts: { owner?: string } = {},
): Lane | null {
  const lanes = listLanes(db, teamId, teamSlug, {
    ...(opts.owner ? { owner: opts.owner } : {}),
  }).filter((l) => CONTENDING.has(l.state));
  for (const lane of lanes) {
    for (const glob of lane.surface_globs) {
      if (globToRegExp(glob, 'path').test(path)) return lane;
    }
  }
  return null;
}

/**
 * Do two lanes share a surface-space? Same project, or either side unscoped — `'default'` is a
 * wildcard, not a peer project (see `DEFAULT_PROJECT`). Until derivation landed every lane was
 * `'default'`, so without the wildcard a derived-project lane and a legacy one would go mutually
 * blind the day derivation shipped — `project` is stamped at open and the board would simply stop
 * warning, which is the exact failure the scoping exists to prevent, inverted.
 */
function projectsContend(a: string, b: string): boolean {
  return a === b || a === DEFAULT_PROJECT || b === DEFAULT_PROJECT;
}

/**
 * The two Phase-1 checks (ADR 083 §3), computed live for one lane. Warn-only — callers never gate.
 * (a) unmet_dependency: a depends_on target not `done`. (b) surface_overlap: declared globs intersect
 * another *contending* lane's in the same project (an unscoped lane contending with all of them).
 */
/** goals-front-door design: advisory nudge — a lane on no goal while goals are in flight.
 *  `with` = the first unshipped goal in ADR 257 order (a suggestion); owner null = never a directed wake. */
export function noGoalWarning(lane: Lane, goals: Goal[]): LaneWarning | null {
  if (lane.goal_id !== null) return null;
  const unshipped = goals.filter((g) => g.status !== 'shipped');
  if (unshipped.length === 0) return null;
  const suggest = [...unshipped].sort(compareGoals)[0]!;
  return {
    kind: 'no_goal',
    subject: lane.id,
    with: suggest.id,
    owner: null,
    detail: `on no goal — ${unshipped.length} in flight; link it: lane_update {goal_id: "${suggest.id}"} (or another)`,
  };
}

/** When a lane entered the acceptance stage: the latest `lane.ready_for_review` audit row, falling
 *  back to `updated_at` for pre-audit lanes (value-layer design — shared by the warning + brief). */
export function acceptanceEnteredAt(db: Database, teamId: string, lane: Lane): number {
  const row = db
    .prepare<[string, string], { ts: number }>(
      `SELECT ts FROM audit
        WHERE team_id = ? AND action = 'lane.ready_for_review' AND target = ?
        ORDER BY ts DESC LIMIT 1`,
    )
    .get(teamId, lane.id);
  return row?.ts ?? lane.updated_at;
}

/** value-layer design: review debt made visible — a lane waiting on acceptance past the threshold.
 *  Advisory like `no_goal`: owner null, never a directed wake. Entry time = the latest
 *  `lane.ready_for_review` audit row; falls back to `updated_at` for pre-audit lanes. A negative
 *  wait (clock skew) never emits. */
export function staleAcceptanceWarning(
  db: Database,
  teamId: string,
  lane: Lane,
  now: number,
): LaneWarning | null {
  if (!isAwaitingAcceptance(lane.state)) return null;
  const waited = now - acceptanceEnteredAt(db, teamId, lane);
  if (waited < ACCEPTANCE_STALE_MS) return null;
  const hours = Math.floor(waited / 3_600_000);
  return {
    kind: 'stale_acceptance',
    subject: lane.id,
    with: lane.id,
    owner: null,
    detail: `waiting ${hours}h for acceptance — team_next surfaces it; any seat may answer per the acceptance ask`,
  };
}

export function laneWarnings(
  db: Database,
  teamId: string,
  teamSlug: string,
  lane: Lane,
  goals?: Goal[],
  now = Date.now(),
): LaneWarning[] {
  const warnings: LaneWarning[] = [];
  for (const depId of lane.depends_on) {
    const dep = getLane(db, teamId, depId, teamSlug);
    if (!dep || dep.state === 'done') continue;
    warnings.push({
      kind: 'unmet_dependency',
      subject: lane.id,
      with: depId,
      owner: dep.owner_seat,
      detail: `building on "${dep.title}" (owner ${dep.owner_seat ?? 'unowned'}), still ${dep.state}`,
    });
  }
  if (lane.surface_globs.length > 0 && CONTENDING.has(lane.state)) {
    for (const other of listLanes(db, teamId, teamSlug)) {
      if (other.id === lane.id || !CONTENDING.has(other.state)) continue;
      if (!projectsContend(lane.project, other.project)) continue;
      const shared = lane.surface_globs.flatMap((g) =>
        other.surface_globs.filter((og) => globsOverlap(g, og)).map((og) => `${g} ∩ ${og}`),
      );
      if (shared.length > 0) {
        warnings.push({
          kind: 'surface_overlap',
          subject: lane.id,
          with: other.id,
          owner: other.owner_seat,
          detail: `surface overlaps "${other.title}" (owner ${other.owner_seat ?? 'unowned'}): ${shared.join(', ')}`,
        });
      }
    }
  }
  if (CONTENDING.has(lane.state)) {
    const w = noGoalWarning(lane, goals ?? listGoals(db, teamId, teamSlug));
    if (w) warnings.push(w);
  }
  // Independent of the CONTENDING gate: awaiting states are the review queue, not contention.
  const stale = staleAcceptanceWarning(db, teamId, lane, now);
  if (stale) warnings.push(stale);
  return warnings;
}

/** Board-wide warnings: every contending lane's live warnings (GET /lanes annotates with these). */
export function boardWarnings(
  db: Database,
  teamId: string,
  teamSlug: string,
  lanes: Lane[],
): LaneWarning[] {
  const out: LaneWarning[] = [];
  const seen = new Set<string>();
  const goals = listGoals(db, teamId, teamSlug);
  for (const lane of lanes) {
    for (const w of laneWarnings(db, teamId, teamSlug, lane, goals)) {
      // A surface overlap is symmetric — report each pair once (keyed order-independently).
      const key =
        w.kind === 'surface_overlap'
          ? `${w.kind}:${[w.subject, w.with].sort().join(':')}`
          : `${w.kind}:${w.subject}:${w.with}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(w);
    }
  }
  return out;
}

/**
 * In-flight states a departed seat must not keep owning (ADR 196). `awaiting_acceptance` /
 * `ready_for_review` keep the owner name so outcome acceptance can still derive verified-ness.
 */
const RELEASE_ON_DEPART = "('claimed','active','blocked')" as const;

/**
 * Release a seat's in-flight lanes back to `open` (ADR 196 / open ⟺ unowned). Used when the seat
 * soft-leaves the roster so the board cannot assert ownership for a name every list filter drops.
 * Returns the released lane ids + prior state for logging/audit.
 */
export function releaseInFlightClaimsForSeat(
  db: Database,
  teamId: string,
  seatName: string,
  now: number = Date.now(),
): { id: string; state_before: string }[] {
  const rows = db
    .prepare<[string, string], { id: string; state: string }>(
      `SELECT id, state FROM lanes
       WHERE team_id = ? AND owner_seat = ? AND state IN ${RELEASE_ON_DEPART}`,
    )
    .all(teamId, seatName);
  if (rows.length === 0) return [];
  const upd = db.prepare(
    `UPDATE lanes SET state = 'open', owner_seat = NULL, claimed_at = NULL, updated_at = ?
     WHERE team_id = ? AND id = ?`,
  );
  db.transaction(() => {
    for (const r of rows) upd.run(now, teamId, r.id);
  })();
  return rows.map((r) => ({ id: r.id, state_before: r.state }));
}

/**
 * Sweep in-flight lanes whose owner has already soft-left (ADR 196). Clears historical ghosts
 * left by pre-fix `leaveMember` calls; the reaper runs this every tick.
 */
export function releaseDepartedSeatClaims(
  db: Database,
  now: number = Date.now(),
): { team_id: string; seat: string; lane: string; state_before: string }[] {
  const rows = db
    .prepare<[], { lane: string; team_id: string; seat: string; state_before: string }>(
      `SELECT l.id AS lane, l.team_id, l.owner_seat AS seat, l.state AS state_before
       FROM lanes l
       JOIN members m ON m.team_id = l.team_id AND m.name = l.owner_seat
       WHERE m.left_at IS NOT NULL
         AND l.state IN ${RELEASE_ON_DEPART}`,
    )
    .all();
  if (rows.length === 0) return [];
  const upd = db.prepare(
    `UPDATE lanes SET state = 'open', owner_seat = NULL, claimed_at = NULL, updated_at = ?
     WHERE team_id = ? AND id = ?`,
  );
  db.transaction(() => {
    for (const r of rows) upd.run(now, r.team_id, r.lane);
  })();
  return rows;
}
