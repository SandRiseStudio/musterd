import type { Lane, LaneState, LaneWarning, OpenLane, UpdateLane } from '@musterd/protocol';
import type { Database } from 'better-sqlite3';
import { ulid } from 'ulid';

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
  owner_seat: string | null;
  role: string | null;
  surface_globs: string;
  depends_on: string;
  branch: string | null;
  goal_id: string | null;
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
    owner_seat: row.owner_seat,
    role: row.role,
    surface_globs: JSON.parse(row.surface_globs) as string[],
    depends_on: JSON.parse(row.depends_on) as string[],
    branch: row.branch,
    goal_id: row.goal_id,
    state: row.state as LaneState,
    created_by: row.created_by,
    created_at: row.created_at,
    claimed_at: row.claimed_at,
    resolved_at: row.resolved_at,
    updated_at: row.updated_at,
  };
}

/** States that participate in contention — an owned/worked lane, not done/abandoned/unowned-idle. */
const CONTENDING: ReadonlySet<string> = new Set(['claimed', 'active', 'blocked']);

export function openLane(
  db: Database,
  teamId: string,
  teamSlug: string,
  createdBy: string,
  input: OpenLane,
  now: number = Date.now(),
): Lane {
  const claim = input.claim === true;
  const row: LaneRow = {
    id: ulid(),
    team_id: teamId,
    project: input.project ?? 'default',
    title: input.title,
    detail: input.detail ?? null,
    owner_seat: claim ? createdBy : null,
    role: input.role ?? null,
    surface_globs: JSON.stringify(input.surface_globs ?? []),
    depends_on: JSON.stringify(input.depends_on ?? []),
    branch: input.branch ?? null,
    goal_id: input.goal_id ?? null,
    state: claim ? 'claimed' : 'open',
    created_by: createdBy,
    created_at: now,
    claimed_at: claim ? now : null,
    resolved_at: null,
    updated_at: now,
  };
  db.prepare(
    `INSERT INTO lanes (id, team_id, project, title, detail, owner_seat, role, surface_globs,
                        depends_on, branch, goal_id, state, created_by, created_at, claimed_at, resolved_at, updated_at)
     VALUES (@id, @team_id, @project, @title, @detail, @owner_seat, @role, @surface_globs,
             @depends_on, @branch, @goal_id, @state, @created_by, @created_at, @claimed_at, @resolved_at, @updated_at)`,
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
  const ownerSeat = patch.owner_seat !== undefined ? patch.owner_seat : existing.owner_seat;
  // Taking ownership of an `open` lane implies `claimed` unless the patch names a state itself.
  const state: LaneState =
    patch.state ??
    (patch.owner_seat !== undefined && existing.state === 'open' ? 'claimed' : existing.state);
  const next = {
    id,
    team_id: teamId,
    detail: patch.detail !== undefined ? patch.detail : existing.detail,
    owner_seat: ownerSeat,
    surface_globs: JSON.stringify(patch.surface_globs ?? existing.surface_globs),
    depends_on: JSON.stringify(patch.depends_on ?? existing.depends_on),
    branch: patch.branch !== undefined ? patch.branch : existing.branch,
    goal_id: patch.goal_id !== undefined ? patch.goal_id : existing.goal_id,
    state,
    claimed_at: existing.claimed_at ?? (ownerSeat !== null ? now : null),
    resolved_at: state === 'done' || state === 'abandoned' ? (existing.resolved_at ?? now) : null,
    updated_at: now,
  };
  db.prepare(
    `UPDATE lanes SET detail=@detail, owner_seat=@owner_seat, surface_globs=@surface_globs,
       depends_on=@depends_on, branch=@branch, goal_id=@goal_id, state=@state, claimed_at=@claimed_at,
       resolved_at=@resolved_at, updated_at=@updated_at
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

/** Lanes joined to a Goal (ADR 084) — the input to {@link deriveGoalStatus}. */
export function lanesForGoal(
  db: Database,
  teamId: string,
  teamSlug: string,
  goalId: string,
): Lane[] {
  return listLanes(db, teamId, teamSlug, { goalId });
}

/** Lane states that are terminal — a lane no longer being worked. */
const TERMINAL: ReadonlySet<string> = new Set(['done', 'abandoned']);

/**
 * The pinned derived-Goal-status rule (ADR 048 as amended by ADR 084): **lanes-authoritative,
 * conjunctive, flap-tolerant.** Given the lanes joined to a Goal:
 *   - `shipped`   ⟺ ≥1 lane, all terminal, and ≥1 reached `done` (not all `abandoned`);
 *   - `in-flight` ⟺ any lane is live (open/claimed/active/blocked);
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
 * The two Phase-1 checks (ADR 083 §3), computed live for one lane. Warn-only — callers never gate.
 * (a) unmet_dependency: a depends_on target not `done`. (b) surface_overlap: declared globs intersect
 * another *contending* lane's in the same project.
 */
export function laneWarnings(
  db: Database,
  teamId: string,
  teamSlug: string,
  lane: Lane,
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
    for (const other of listLanes(db, teamId, teamSlug, { project: lane.project })) {
      if (other.id === lane.id || !CONTENDING.has(other.state)) continue;
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
  for (const lane of lanes) {
    for (const w of laneWarnings(db, teamId, teamSlug, lane)) {
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
