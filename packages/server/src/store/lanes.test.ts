import { describe, expect, it } from 'vitest';
import { openDb } from '../db/open.js';
import {
  boardWarnings,
  globsOverlap,
  laneWarnings,
  listLanes,
  openLane,
  updateLane,
} from './lanes.js';
import { createTeam } from './teams.js';

function seed() {
  const db = openDb(':memory:');
  const team = createTeam(db, { slug: 'bravo' });
  return { db, team };
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

    // The dep resolving clears the warning (dedup-until-cleared is a diff over this).
    updateLane(db, team.id, june.id, 'bravo', { state: 'done' });
    expect(laneWarnings(db, team.id, 'bravo', cleo)).toHaveLength(0);
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
