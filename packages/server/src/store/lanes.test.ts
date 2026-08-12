import { ACCEPTANCE_STALE_MS, makeEnvelope, type Lane } from '@musterd/protocol';
import { describe, expect, it } from 'vitest';
import { openDb } from '../db/open.js';
import { appendAudit } from './audit.js';
import {
  boardWarnings,
  deriveGoalStatus,
  deriveHandoffLane,
  getLane,
  globsOverlap,
  laneWarnings,
  lanesForGoal,
  listLanes,
  openLane,
  releaseDepartedSeatClaims,
  releaseInFlightClaimsForSeat,
  staleAcceptanceWarning,
  updateLane,
} from './lanes.js';
import { addMember } from './members.js';
import { insertMessage } from './messages.js';
import { createTeam } from './teams.js';

function seed() {
  const db = openDb(':memory:');
  const team = createTeam(db, { slug: 'bravo' });
  return { db, team };
}

/**
 * Transfer a lane the way the PATCH handler does: the store move plus the `lane.claimed` audit row
 * that marks it a handoff rather than a self-claim. The audit row is the only record of WHO handed
 * WHAT to WHOM, so a derivation that reads it must be tested against the real pair, not the move
 * alone.
 */
function recordHandoff(
  db: ReturnType<typeof openDb>,
  teamId: string,
  teamSlug: string,
  laneId: string,
  from: string,
  to: string,
): void {
  updateLane(db, teamId, laneId, teamSlug, { owner_seat: to });
  appendAudit(db, teamId, {
    actor: from,
    action: 'lane.claimed',
    target: laneId,
    result: 'allow',
    detail: { lane: laneId, owner: to, previous_owner: from, kind: 'handoff' },
  });
}

describe('globsOverlap (cheap prefix intersection, ADR 083)', () => {
  it('overlaps on shared path prefixes, either direction', () => {
    expect(globsOverlap('packages/server/src/store/**', 'packages/server/**')).toBe(true);
    expect(globsOverlap('packages/server/**', 'packages/server/src/store/migrations.ts')).toBe(
      true,
    );
    expect(globsOverlap('a/b/c', 'a/b/c')).toBe(true);
  });
  it('does not overlap disjoint paths', () => {
    expect(globsOverlap('packages/server/**', 'packages/cli/**')).toBe(false);
    expect(globsOverlap('packages/serverless/**', 'packages/server/**')).toBe(false); // no partial-segment match
  });
});

/**
 * ADR 240. A lane's title is what the board renders, what a handoff announces, and what a seat
 * reads when deciding whether a lane is theirs — and it was the one field with no escape hatch.
 * Live instance 2026-08-05: lane 01KZ9HR001 was opened with a title built on a misreading, and the
 * only available correction was a note at the top of the detail saying the title is wrong.
 */
describe('a lane title is correctable (ADR 240)', () => {
  it('patches the title, and leaves it alone when the patch omits one', () => {
    const { db, team } = seed();
    const lane = openLane(db, team.id, 'bravo', 'June', { title: 'wrong from the start' });

    const retitled = updateLane(db, team.id, lane.id, 'bravo', { title: 'what it actually is' });
    expect(retitled?.title).toBe('what it actually is');

    // An unrelated patch must not disturb it — the field is opt-in, like `detail` and `project`.
    const later = updateLane(db, team.id, lane.id, 'bravo', { state: 'active' });
    expect(later?.title).toBe('what it actually is');
    expect(getLane(db, team.id, lane.id, 'bravo')?.title).toBe('what it actually is');
  });
});

describe('lane lifecycle + the two checks (spec §8 acceptance scenarios)', () => {
  it('scenario 1 — the dependency-revert: unmet_dependency warns while the dep is active', () => {
    const { db, team } = seed();
    const june = openLane(db, team.id, 'bravo', 'June', {
      title: 'P3.1 schema',
      project: 'musterd',
      surface_globs: ['packages/server/src/store/**'],
      claim: true,
    });
    updateLane(db, team.id, june.id, 'bravo', { state: 'active' });
    const cleo = openLane(db, team.id, 'bravo', 'Cleo', {
      title: 'P3.2 handshake',
      project: 'musterd',
      depends_on: [june.id],
      claim: true,
    });
    const warnings = laneWarnings(db, team.id, 'bravo', cleo);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.kind).toBe('unmet_dependency');
    expect(warnings[0]!.with).toBe(june.id);
    expect(warnings[0]!.owner).toBe('June');
    expect(warnings[0]!.detail).toContain('still active');

    // ADR 169: ready_for_review does NOT clear it — a dependent building on unreviewed work is
    // exactly when the warning earns its keep (advisory, so keeping it wedges nothing).
    updateLane(db, team.id, june.id, 'bravo', { state: 'ready_for_review' });
    const still = laneWarnings(db, team.id, 'bravo', cleo);
    expect(still).toHaveLength(1);
    expect(still[0]!.detail).toContain('still awaiting_acceptance');

    // The dep resolving clears the warning (dedup-until-cleared is a diff over this).
    updateLane(db, team.id, june.id, 'bravo', { state: 'done' });
    expect(laneWarnings(db, team.id, 'bravo', cleo)).toHaveLength(0);
  });

  it('ADR 192: awaiting_acceptance persists the stage-one attestation and stays unresolved', () => {
    const { db, team } = seed();
    const lane = openLane(db, team.id, 'bravo', 'riley', {
      title: 'two-stage',
      project: 'musterd',
      branch: 'riley/two-stage',
      claim: true,
    });
    const ready = updateLane(db, team.id, lane.id, 'bravo', {
      state: 'ready_for_review', // legacy spelling coerces on write
      merged: { pr: 7, sha: 'deadbeef', authorized_by: 'nick' },
    })!;
    expect(ready.state).toBe('awaiting_acceptance');
    expect(ready.merged).toEqual({ pr: 7, sha: 'deadbeef', authorized_by: 'nick' });
    expect(ready.resolved_at).toBeNull();
    // The attestation survives an unrelated later patch (rebuild-from-existing carry).
    const noted = updateLane(db, team.id, lane.id, 'bravo', { detail: 'note' })!;
    expect(noted.merged).toEqual({ pr: 7, sha: 'deadbeef', authorized_by: 'nick' });
  });

  it('scenario 2 — the redone lane: handoff carries the branch', () => {
    const { db, team } = seed();
    const lane = openLane(db, team.id, 'bravo', 'riley', {
      title: 'BindingSchema',
      project: 'musterd',
      branch: 'agent/riley',
      claim: true,
    });
    const handed = updateLane(db, team.id, lane.id, 'bravo', {
      owner_seat: 'June',
      branch: 'agent/riley',
    })!;
    expect(handed.owner_seat).toBe('June');
    expect(handed.branch).toBe('agent/riley');
    // The board shows the lane with its branch — June builds on it instead of re-deriving.
    const board = listLanes(db, team.id, 'bravo', { owner: 'June' });
    expect(board[0]!.branch).toBe('agent/riley');
  });

  it('scenario 3 — the clean independent lane stays silent', () => {
    const { db, team } = seed();
    openLane(db, team.id, 'bravo', 'June', {
      title: 'store work',
      project: 'musterd',
      surface_globs: ['packages/server/src/store/**'],
      claim: true,
    });
    const jasmine = openLane(db, team.id, 'bravo', 'Jasmine', {
      title: 'governance',
      project: 'musterd',
      surface_globs: ['packages/protocol/src/capabilities.ts'],
      claim: true,
    });
    expect(laneWarnings(db, team.id, 'bravo', jasmine)).toHaveLength(0);
  });

  it('scenario 3b — surface overlap warns, once per pair on the board', () => {
    const { db, team } = seed();
    const a = openLane(db, team.id, 'bravo', 'June', {
      title: 'schema',
      project: 'musterd',
      surface_globs: ['packages/server/src/store/**'],
      claim: true,
    });
    const b = openLane(db, team.id, 'bravo', 'Cleo', {
      title: 'also schema',
      project: 'musterd',
      surface_globs: ['packages/server/**'],
      claim: true,
    });
    const w = laneWarnings(db, team.id, 'bravo', b);
    expect(
      w.some((x) => x.kind === 'surface_overlap' && x.with === a.id && x.owner === 'June'),
    ).toBe(true);
    // Board dedups the symmetric pair to one warning.
    const lanes = listLanes(db, team.id, 'bravo');
    const board = boardWarnings(db, team.id, 'bravo', lanes);
    expect(board.filter((x) => x.kind === 'surface_overlap')).toHaveLength(1);
  });

  it('scenario 4 — cross-project non-collision', () => {
    const { db, team } = seed();
    openLane(db, team.id, 'bravo', 'June', {
      title: 'members',
      project: 'musterd',
      surface_globs: ['store/members.ts'],
      claim: true,
    });
    const cleo = openLane(db, team.id, 'bravo', 'Cleo', {
      title: 'members elsewhere',
      project: 'izzocam',
      surface_globs: ['store/members.ts'],
      claim: true,
    });
    expect(laneWarnings(db, team.id, 'bravo', cleo)).toHaveLength(0);
  });

  /**
   * The mixed-era case that project *derivation* creates: before it existed every lane was
   * `'default'`, so a scoped lane and a legacy one must not go mutually blind — an unscoped lane
   * means "I didn't say", and a warning system should fail toward the false positive.
   */
  it("scenario 4b — an unscoped 'default' lane still contends with every project", () => {
    const { db, team } = seed();
    const legacy = openLane(db, team.id, 'bravo', 'June', {
      title: 'members (opened before derivation)',
      surface_globs: ['store/members.ts'],
      claim: true,
    });
    expect(legacy.project).toBe('default');
    const scoped = openLane(db, team.id, 'bravo', 'Cleo', {
      title: 'members',
      project: 'musterd',
      surface_globs: ['store/members.ts'],
      claim: true,
    });
    // Both directions — the wildcard is symmetric.
    expect(laneWarnings(db, team.id, 'bravo', scoped)).toHaveLength(1);
    expect(laneWarnings(db, team.id, 'bravo', legacy)).toHaveLength(1);

    // …and the escape hatch closes it: re-project the legacy lane and they stop contending.
    const moved = updateLane(db, team.id, legacy.id, 'bravo', { project: 'izzocam' })!;
    expect(moved.project).toBe('izzocam');
    expect(laneWarnings(db, team.id, 'bravo', scoped)).toHaveLength(0);
  });

  it('scenario 5 — non-git: manual resolve closes the loop as a state transition', () => {
    const { db, team } = seed();
    const lane = openLane(db, team.id, 'bravo', 'June', { title: 'work', claim: true });
    const done = updateLane(db, team.id, lane.id, 'bravo', { state: 'done' })!;
    expect(done.state).toBe('done');
    expect(done.resolved_at).not.toBeNull();
    // done lanes stop contending: no overlap warnings from/against them.
    expect(laneWarnings(db, team.id, 'bravo', done)).toHaveLength(0);
  });

  it('claiming an open lane implies claimed + stamps claimed_at', () => {
    const { db, team } = seed();
    const lane = openLane(db, team.id, 'bravo', 'June', { title: 'pool item' });
    expect(lane.state).toBe('open');
    expect(lane.owner_seat).toBeNull();
    const claimed = updateLane(db, team.id, lane.id, 'bravo', { owner_seat: 'Cleo' })!;
    expect(claimed.state).toBe('claimed');
    expect(claimed.owner_seat).toBe('Cleo');
    expect(claimed.claimed_at).not.toBeNull();
  });
});

describe('the release invariant — open ⟺ unowned', () => {
  it('moving an owned lane back to open clears the owner and the claim stamp', () => {
    const { db, team } = seed();
    const lane = openLane(db, team.id, 'bravo', 'June', { title: 'parked work', claim: true });
    expect(lane.owner_seat).toBe('June');
    expect(lane.claimed_at).not.toBeNull();
    const released = updateLane(db, team.id, lane.id, 'bravo', { state: 'open' })!;
    expect(released.state).toBe('open');
    // The whole point: the board must not name a holder for work nobody is doing.
    expect(released.owner_seat).toBeNull();
    expect(released.claimed_at).toBeNull();
  });

  it('a released lane is claimable by a different seat, stamping a fresh tenure', () => {
    const { db, team } = seed();
    const lane = openLane(db, team.id, 'bravo', 'June', { title: 'parked work', claim: true });
    const releasedAt = updateLane(db, team.id, lane.id, 'bravo', { state: 'open' }, 1_000)!;
    expect(releasedAt.owner_seat).toBeNull();
    const reclaimed = updateLane(db, team.id, lane.id, 'bravo', { owner_seat: 'Cleo' }, 5_000)!;
    expect(reclaimed.state).toBe('claimed');
    expect(reclaimed.owner_seat).toBe('Cleo');
    // Not June's original stamp inherited: claimed_at describes the CURRENT tenure.
    expect(reclaimed.claimed_at).toBe(5_000);
  });

  // The direct owner -> owner move never passes through the release that clears the stamp, so the
  // new holder used to inherit the old one's claimed_at. That is what let a takeover read as a first
  // claim on 2026-08-01: the response said "claimed_at 22:00" and the taker read it as their own.
  it("a DIRECT owner-to-owner move stamps a fresh tenure, never the previous holder's", () => {
    const { db, team } = seed();
    const lane = openLane(db, team.id, 'bravo', 'June', { title: 'work', claim: true }, 1_000);
    expect(lane.claimed_at).toBe(1_000);
    const handed = updateLane(db, team.id, lane.id, 'bravo', { owner_seat: 'Cleo' }, 9_000)!;
    expect(handed.owner_seat).toBe('Cleo');
    expect(handed.claimed_at).toBe(9_000); // Cleo's tenure, not June's 1_000
  });

  it('re-patching the SAME owner keeps the original stamp (no tenure restart on an unrelated edit)', () => {
    const { db, team } = seed();
    const lane = openLane(db, team.id, 'bravo', 'June', { title: 'work', claim: true }, 1_000);
    const same = updateLane(db, team.id, lane.id, 'bravo', { owner_seat: 'June' }, 9_000)!;
    expect(same.claimed_at).toBe(1_000);
  });

  it('an owner named on the same patch as state:open still releases — state wins', () => {
    const { db, team } = seed();
    const lane = openLane(db, team.id, 'bravo', 'June', { title: 'parked', claim: true });
    const out = updateLane(db, team.id, lane.id, 'bravo', {
      state: 'open',
      owner_seat: 'Cleo',
    })!;
    expect(out.state).toBe('open');
    expect(out.owner_seat).toBeNull(); // the incoherent tuple is unrepresentable
  });

  it('a terminal close keeps its owner — release is only the open edge', () => {
    const { db, team } = seed();
    const lane = openLane(db, team.id, 'bravo', 'June', { title: 'shipped', claim: true });
    const done = updateLane(db, team.id, lane.id, 'bravo', { state: 'done' })!;
    expect(done.owner_seat).toBe('June'); // ADR 169 derives verified-ness from the owner at close
    expect(done.claimed_at).not.toBeNull();
  });
});

describe('goal_id join (ADR 084)', () => {
  it('round-trips goal_id through open + update, and lanesForGoal filters by it', () => {
    const { db, team } = seed();
    const a = openLane(db, team.id, 'bravo', 'June', {
      title: 'spine migration',
      goal_id: 'orientation-spine',
      claim: true,
    });
    expect(a.goal_id).toBe('orientation-spine');
    // A lane opened without a goal is ungrouped; update can link it later.
    const b = openLane(db, team.id, 'bravo', 'Cleo', { title: 'unlinked', claim: true });
    expect(b.goal_id).toBeNull();
    const linked = updateLane(db, team.id, b.id, 'bravo', { goal_id: 'orientation-spine' })!;
    expect(linked.goal_id).toBe('orientation-spine');
    // update can clear it back to null.
    const cleared = updateLane(db, team.id, b.id, 'bravo', { goal_id: null })!;
    expect(cleared.goal_id).toBeNull();

    const forGoal = lanesForGoal(db, team.id, 'bravo', 'orientation-spine');
    expect(forGoal.map((l) => l.id)).toEqual([a.id]);
  });
});

describe('deriveGoalStatus (the pinned rule, ADR 048 as amended by 084)', () => {
  const lane = (state: string): Lane =>
    ({ state, id: state, title: '', goal_id: 'g' }) as unknown as Lane;

  it('planned when the Goal has no lanes', () => {
    expect(deriveGoalStatus([])).toBe('planned');
  });
  it('in-flight when any lane is live', () => {
    expect(deriveGoalStatus([lane('done'), lane('active')])).toBe('in-flight');
    expect(deriveGoalStatus([lane('open')])).toBe('in-flight');
    expect(deriveGoalStatus([lane('blocked')])).toBe('in-flight');
    // ADR 169: awaiting review is live — a goal is not shipped until its closes land.
    expect(deriveGoalStatus([lane('done'), lane('awaiting_acceptance')])).toBe('in-flight');
  });
  it('shipped only when all lanes are terminal AND at least one is done', () => {
    expect(deriveGoalStatus([lane('done')])).toBe('shipped');
    expect(deriveGoalStatus([lane('done'), lane('abandoned')])).toBe('shipped');
  });
  it('not shipped when every lane is abandoned (no done)', () => {
    expect(deriveGoalStatus([lane('abandoned'), lane('abandoned')])).toBe('in-flight');
  });
  it('flap-tolerant: a new open lane returns a shipped Goal to in-flight', () => {
    const shipped = [lane('done'), lane('done')];
    expect(deriveGoalStatus(shipped)).toBe('shipped');
    expect(deriveGoalStatus([...shipped, lane('open')])).toBe('in-flight');
  });
});

describe('departed-seat claim release (ADR 196)', () => {
  it('releaseInFlightClaimsForSeat opens claimed/active/blocked but keeps awaiting_acceptance', () => {
    const { db, team } = seed();
    const claimed = openLane(db, team.id, 'bravo', 'June', { title: 'wip', claim: true });
    const active = openLane(db, team.id, 'bravo', 'June', { title: 'building', claim: true });
    updateLane(db, team.id, active.id, 'bravo', { state: 'active' });
    const awaiting = openLane(db, team.id, 'bravo', 'June', { title: 'shipped', claim: true });
    updateLane(db, team.id, awaiting.id, 'bravo', { state: 'awaiting_acceptance' });

    const released = releaseInFlightClaimsForSeat(db, team.id, 'June');
    expect(released.map((r) => r.id).sort()).toEqual([active.id, claimed.id].sort());
    expect(getLane(db, team.id, claimed.id, 'bravo')).toMatchObject({
      state: 'open',
      owner_seat: null,
    });
    expect(getLane(db, team.id, active.id, 'bravo')?.owner_seat).toBeNull();
    expect(getLane(db, team.id, awaiting.id, 'bravo')).toMatchObject({
      state: 'awaiting_acceptance',
      owner_seat: 'June',
    });
  });

  it('releaseDepartedSeatClaims sweeps lanes still owned by soft-removed seats', () => {
    const { db, team } = seed();
    const june = addMember(db, team, { name: 'June', kind: 'agent' });
    const lane = openLane(db, team.id, 'bravo', 'June', { title: 'ghost wip', claim: true });
    // Bypass leaveMember's composition — the historical ghost ADR 196's reaper sweep clears.
    db.prepare('UPDATE members SET left_at = ? WHERE id = ?').run(Date.now(), june.row.id);

    const swept = releaseDepartedSeatClaims(db);
    expect(swept).toEqual([
      { team_id: team.id, seat: 'June', lane: lane.id, state_before: 'claimed' },
    ]);
    expect(getLane(db, team.id, lane.id, 'bravo')).toMatchObject({
      state: 'open',
      owner_seat: null,
    });
  });
});

describe('deriveHandoffLane (ADR 231) — a handoff act names the lane it hands off', () => {
  it('attaches when the sender holds exactly one live lane', () => {
    const { db, team } = seed();
    const lane = openLane(db, team.id, 'bravo', 'June', {
      title: 'the one live lane',
      project: 'musterd',
      branch: 'june/the-work',
      claim: true,
    });
    const derived = deriveHandoffLane(db, team.id, 'bravo', 'June');
    expect(derived.kind).toBe('attach');
    if (derived.kind !== 'attach') throw new Error('unreachable');
    expect(derived.lane.id).toBe(lane.id);
    expect(derived.lane.branch).toBe('june/the-work');
  });

  it('abstains as ambiguous when the sender holds two or more — never guesses', () => {
    const { db, team } = seed();
    openLane(db, team.id, 'bravo', 'June', { title: 'first', project: 'musterd', claim: true });
    openLane(db, team.id, 'bravo', 'June', { title: 'second', project: 'musterd', claim: true });
    const derived = deriveHandoffLane(db, team.id, 'bravo', 'June');
    expect(derived.kind).toBe('ambiguous');
    if (derived.kind !== 'ambiguous') throw new Error('unreachable');
    expect(derived.candidates).toHaveLength(2);
  });

  it('says none when the sender holds no live lane — the legal lane-less handoff', () => {
    const { db, team } = seed();
    expect(deriveHandoffLane(db, team.id, 'bravo', 'June').kind).toBe('none');
  });

  it('ignores terminal lanes — a done lane is not what you are handing off', () => {
    const { db, team } = seed();
    const done = openLane(db, team.id, 'bravo', 'June', {
      title: 'shipped',
      project: 'musterd',
      claim: true,
    });
    updateLane(db, team.id, done.id, 'bravo', { state: 'done' });
    const live = openLane(db, team.id, 'bravo', 'June', {
      title: 'still going',
      project: 'musterd',
      claim: true,
    });
    const derived = deriveHandoffLane(db, team.id, 'bravo', 'June');
    expect(derived.kind).toBe('attach');
    if (derived.kind !== 'attach') throw new Error('unreachable');
    expect(derived.lane.id).toBe(live.id);
  });

  it('ignores lanes owned by someone else — you cannot hand off what you do not hold', () => {
    const { db, team } = seed();
    openLane(db, team.id, 'bravo', 'Cleo', {
      title: 'cleo owns it',
      project: 'musterd',
      claim: true,
    });
    expect(deriveHandoffLane(db, team.id, 'bravo', 'June').kind).toBe('none');
  });

  // ADR 243. The candidate set was "lanes the sender still HOLDS", but `lane_handoff` transfers
  // ownership BEFORE the explanatory act is sent — so the intended lane is never a candidate, and a
  // sender who holds exactly one OTHER lane lands in the confident single-candidate branch.
  describe('a lane just handed to this recipient outranks a lane the sender still holds', () => {
    /** The live 2026-08-05 shape: hand one lane away, keep another, then explain the handoff. */
    function handedAndHeld() {
      const { db, team } = seed();
      const handed = openLane(db, team.id, 'bravo', 'June', {
        title: 'the lane actually handed over',
        project: 'musterd',
        branch: 'june/handed',
        claim: true,
      });
      recordHandoff(db, team.id, 'bravo', handed.id, 'June', 'Cleo');
      const kept = openLane(db, team.id, 'bravo', 'June', {
        title: 'my unrelated lane in acceptance',
        project: 'musterd',
        claim: true,
      });
      return { db, team, handed, kept };
    }

    it('attaches the handed lane, not the held one', () => {
      const { db, team, handed } = handedAndHeld();
      const derived = deriveHandoffLane(db, team.id, 'bravo', 'June', 'Cleo');
      expect(derived.kind).toBe('attach');
      if (derived.kind !== 'attach') throw new Error('unreachable');
      expect(derived.lane.id).toBe(handed.id);
      expect(derived.lane.branch).toBe('june/handed');
    });

    it('falls back to the held lane when nothing was handed to THIS recipient', () => {
      const { db, team, kept } = handedAndHeld();
      const derived = deriveHandoffLane(db, team.id, 'bravo', 'June', 'Dara');
      expect(derived.kind).toBe('attach');
      if (derived.kind !== 'attach') throw new Error('unreachable');
      expect(derived.lane.id).toBe(kept.id);
    });

    it('is ambiguous when several lanes went to the same recipient — one referent or none', () => {
      const { db, team } = handedAndHeld();
      const second = openLane(db, team.id, 'bravo', 'June', {
        title: 'a second lane handed to Cleo',
        project: 'musterd',
        claim: true,
      });
      recordHandoff(db, team.id, 'bravo', second.id, 'June', 'Cleo');
      const derived = deriveHandoffLane(db, team.id, 'bravo', 'June', 'Cleo');
      expect(derived.kind).toBe('ambiguous');
      if (derived.kind !== 'ambiguous') throw new Error('unreachable');
      expect(derived.candidates).toHaveLength(2);
    });

    it('ignores a handed lane the recipient no longer owns — the fact expired, not aged out', () => {
      const { db, team, handed, kept } = handedAndHeld();
      updateLane(db, team.id, handed.id, 'bravo', { owner_seat: 'Dara' });
      const derived = deriveHandoffLane(db, team.id, 'bravo', 'June', 'Cleo');
      expect(derived.kind).toBe('attach');
      if (derived.kind !== 'attach') throw new Error('unreachable');
      expect(derived.lane.id).toBe(kept.id);
    });

    it('ignores a handed lane that has since gone terminal', () => {
      const { db, team, handed, kept } = handedAndHeld();
      updateLane(db, team.id, handed.id, 'bravo', { state: 'done' });
      const derived = deriveHandoffLane(db, team.id, 'bravo', 'June', 'Cleo');
      expect(derived.kind).toBe('attach');
      if (derived.kind !== 'attach') throw new Error('unreachable');
      expect(derived.lane.id).toBe(kept.id);
    });

    it('ignores a lane the RECIPIENT claimed for themselves — a claim is not a handoff', () => {
      const { db, team } = seed();
      const claimed = openLane(db, team.id, 'bravo', 'June', {
        title: 'Cleo took this one herself',
        project: 'musterd',
        claim: true,
      });
      updateLane(db, team.id, claimed.id, 'bravo', { owner_seat: 'Cleo' });
      appendAudit(db, team.id, {
        actor: 'Cleo',
        action: 'lane.claimed',
        target: claimed.id,
        result: 'allow',
        detail: { lane: claimed.id, owner: 'Cleo', previous_owner: 'June', kind: 'claim' },
      });
      expect(deriveHandoffLane(db, team.id, 'bravo', 'June', 'Cleo').kind).toBe('none');
    });
  });
});

describe('no_goal warning (goals-front-door design)', () => {
  function seedWithNick() {
    const { db, team } = seed();
    const nick = addMember(db, team, { name: 'nick', kind: 'human' }).row;
    return { db, team, nick };
  }
  let gts = 0;
  function declareGoal(
    db: ReturnType<typeof seed>['db'],
    teamId: string,
    fromId: string,
    goal: { id: string; title: string; wave?: number | 'later' },
  ) {
    const ts = ++gts;
    insertMessage(
      db,
      teamId,
      fromId,
      null,
      makeEnvelope({
        id: `ng${ts}-${goal.id}`,
        team: 'bravo',
        from: 'nick',
        to: { kind: 'team' },
        act: 'message',
        body: `[goal] ${goal.title}`,
        meta: { goal },
        ts,
      }),
    );
  }

  it('a contending goal-less lane warns when an unshipped goal exists', () => {
    const { db, team, nick } = seedWithNick();
    declareGoal(db, team.id, nick.id, { id: 'g1', title: 'Native harness' });
    const lane = openLane(db, team.id, 'bravo', 'June', { title: 'work', claim: true });
    const w = laneWarnings(db, team.id, 'bravo', lane);
    expect(w.some((x) => x.kind === 'no_goal' && x.owner === null && x.with === 'g1')).toBe(true);
  });

  it('never warns: no goals declared / attached lane / backlog lane', () => {
    const { db, team, nick } = seedWithNick();
    const bare = openLane(db, team.id, 'bravo', 'June', { title: 'a', claim: true });
    expect(laneWarnings(db, team.id, 'bravo', bare).some((x) => x.kind === 'no_goal')).toBe(false);
    declareGoal(db, team.id, nick.id, { id: 'g1', title: 'G' });
    const linked = openLane(db, team.id, 'bravo', 'Cleo', {
      title: 'b',
      goal_id: 'g1',
      claim: true,
    });
    expect(laneWarnings(db, team.id, 'bravo', linked).some((x) => x.kind === 'no_goal')).toBe(
      false,
    );
    // backlog (open, unclaimed) lane does not flag on the board:
    const idle = openLane(db, team.id, 'bravo', 'Cleo', { title: 'c' });
    expect(laneWarnings(db, team.id, 'bravo', idle).some((x) => x.kind === 'no_goal')).toBe(false);
  });

  it('never warns when the only goals are shipped', () => {
    const { db, team, nick } = seedWithNick();
    declareGoal(db, team.id, nick.id, { id: 'g1', title: 'G' });
    const shipping = openLane(db, team.id, 'bravo', 'Cleo', {
      title: 'ship it',
      goal_id: 'g1',
      claim: true,
    });
    updateLane(db, team.id, shipping.id, 'bravo', { state: 'done' });
    const lane = openLane(db, team.id, 'bravo', 'June', { title: 'work', claim: true });
    expect(laneWarnings(db, team.id, 'bravo', lane).some((x) => x.kind === 'no_goal')).toBe(false);
  });

  it('board projection carries it once per lane', () => {
    const { db, team, nick } = seedWithNick();
    declareGoal(db, team.id, nick.id, { id: 'g1', title: 'G' });
    openLane(db, team.id, 'bravo', 'June', { title: 'w', claim: true });
    const lanes = listLanes(db, team.id, 'bravo');
    expect(
      boardWarnings(db, team.id, 'bravo', lanes).filter((w) => w.kind === 'no_goal'),
    ).toHaveLength(1);
  });
});

describe('stale_acceptance warning (value-layer design)', () => {
  function insertAuditAt(
    db: ReturnType<typeof seed>['db'],
    teamId: string,
    target: string,
    ts: number,
  ) {
    db.prepare(
      `INSERT INTO audit (id, team_id, ts, actor, action, target, result, detail, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(`sa${ts}-${target}`, teamId, ts, 'June', 'lane.ready_for_review', target, 'allow', null, ts);
  }
  function awaitingLane(db: ReturnType<typeof seed>['db'], teamId: string) {
    const lane = openLane(db, teamId, 'bravo', 'June', { title: 'w', claim: true });
    return updateLane(db, teamId, lane.id, 'bravo', { state: 'awaiting_acceptance' });
  }

  it('warns once a lane has waited past the threshold — advisory, owner null', () => {
    const { db, team } = seed();
    const now = Date.now();
    const lane = awaitingLane(db, team.id);
    insertAuditAt(db, team.id, lane.id, now - ACCEPTANCE_STALE_MS - 60_000);
    const w = staleAcceptanceWarning(db, team.id, lane, now);
    expect(w).toMatchObject({ kind: 'stale_acceptance', subject: lane.id, owner: null });
    expect(w!.detail).toMatch(/waiting 12h/);
  });

  it('stays silent under the threshold', () => {
    const { db, team } = seed();
    const now = Date.now();
    const lane = awaitingLane(db, team.id);
    insertAuditAt(db, team.id, lane.id, now - 60_000);
    expect(staleAcceptanceWarning(db, team.id, lane, now)).toBeNull();
  });

  it('never warns for a non-waiting state, even past threshold', () => {
    const { db, team } = seed();
    const now = Date.now();
    const lane = openLane(db, team.id, 'bravo', 'June', { title: 'w', claim: true });
    insertAuditAt(db, team.id, lane.id, now - ACCEPTANCE_STALE_MS - 60_000);
    expect(staleAcceptanceWarning(db, team.id, lane, now)).toBeNull();
  });

  it('falls back to updated_at with no audit row, and clock skew never emits', () => {
    const { db, team } = seed();
    const lane = awaitingLane(db, team.id); // updated_at ≈ now, no audit row
    expect(staleAcceptanceWarning(db, team.id, lane, Date.now())).toBeNull();
    // updated_at in the future (skew): waited < 0 — never emits.
    expect(staleAcceptanceWarning(db, team.id, lane, lane.updated_at - 60_000)).toBeNull();
  });

  it('rides laneWarnings so the board projection carries it', () => {
    const { db, team } = seed();
    const now = Date.now();
    const lane = awaitingLane(db, team.id);
    insertAuditAt(db, team.id, lane.id, now - ACCEPTANCE_STALE_MS - 60_000);
    const w = laneWarnings(db, team.id, 'bravo', lane, undefined, now);
    expect(w.some((x) => x.kind === 'stale_acceptance')).toBe(true);
  });
});
