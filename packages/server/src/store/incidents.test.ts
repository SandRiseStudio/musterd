import type { BlockedBy, Lane } from '@musterd/protocol';
import { describe, expect, it } from 'vitest';
import { openDb } from '../db/open.js';
import {
  CLUSTER_THRESHOLD,
  incidentReporters,
  openIncidents,
  recordBlockedReport,
} from './incidents.js';
import { updateLane } from './lanes.js';
import { createTeam } from './teams.js';

const GATE = 'ci:gates/A11y contrast';
const report = (over: Partial<BlockedBy> = {}): BlockedBy => ({
  gate: GATE,
  sig: 'lc 2.83',
  ref: 'pr#828',
  ...over,
});

function seed() {
  const db = openDb(':memory:');
  const team = createTeam(db, { slug: 'revive' });
  return { db, team };
}

describe('incident clustering (spec 2026-08-14 inc 1)', () => {
  it('exports the spec default threshold', () => {
    expect(CLUSTER_THRESHOLD).toBe(2);
  });

  it('first report records without opening', () => {
    const { db, team } = seed();
    expect(recordBlockedReport(db, team.id, 'revive', 'izzo', report(), 'm1').kind).toBe(
      'recorded',
    );
    expect(openIncidents(db, team.id, 'revive')).toHaveLength(0);
  });

  it('second distinct seat opens one incident lane, seeded with both sigs', () => {
    const { db, team } = seed();
    recordBlockedReport(db, team.id, 'revive', 'izzo', report(), 'm1');
    const out = recordBlockedReport(
      db,
      team.id,
      'revive',
      'dolly',
      report({ ref: 'pr#829', sig: 'lc 2.85' }),
      'm2',
    );
    expect(out.kind).toBe('opened');
    const lane = (out as { lane: Lane }).lane;
    expect(lane.kind).toBe('incident');
    expect(lane.stakes).toBe('high');
    expect(lane.owner_seat).toBeNull();
    expect(lane.surface_globs).toEqual([]);
    expect(lane.title).toBe('incident: ' + GATE);
    expect(lane.detail).toContain('izzo: lc 2.83 [pr#828]');
    expect(lane.detail).toContain('dolly: lc 2.85 [pr#829]');
    expect(incidentReporters(db, team.id, lane.id)).toEqual(
      expect.arrayContaining(['izzo', 'dolly']),
    );
  });

  it('same seat twice does not open', () => {
    const { db, team } = seed();
    recordBlockedReport(db, team.id, 'revive', 'izzo', report(), 'm1');
    expect(recordBlockedReport(db, team.id, 'revive', 'izzo', report(), 'm2').kind).toBe(
      'recorded',
    );
    expect(openIncidents(db, team.id, 'revive')).toHaveLength(0);
  });

  it('third report appends to the open incident, never opens a second', () => {
    const { db, team } = seed();
    recordBlockedReport(db, team.id, 'revive', 'izzo', report(), 'm1');
    recordBlockedReport(db, team.id, 'revive', 'dolly', report(), 'm2');
    const out = recordBlockedReport(
      db,
      team.id,
      'revive',
      'stanley',
      report({ sig: 'lc 2.11', ref: 'pr#830' }),
      'm3',
    );
    expect(out.kind).toBe('appended');
    expect(openIncidents(db, team.id, 'revive')).toHaveLength(1);
    expect((out as { lane: Lane }).lane.detail).toContain('stanley: lc 2.11 [pr#830]');
    expect(incidentReporters(db, team.id, (out as { lane: Lane }).lane.id)).toHaveLength(3);
  });

  it('a terminal incident does not absorb new reports — the pool restarts', () => {
    const { db, team } = seed();
    recordBlockedReport(db, team.id, 'revive', 'izzo', report(), 'm1');
    const opened = recordBlockedReport(db, team.id, 'revive', 'dolly', report(), 'm2') as {
      lane: Lane;
    };
    updateLane(db, team.id, opened.lane.id, 'revive', { state: 'abandoned' });
    expect(recordBlockedReport(db, team.id, 'revive', 'miley', report(), 'm3').kind).toBe(
      'recorded',
    );
    expect(openIncidents(db, team.id, 'revive')).toHaveLength(0);
  });

  it('different gates cluster independently', () => {
    const { db, team } = seed();
    recordBlockedReport(db, team.id, 'revive', 'izzo', report(), 'm1');
    expect(
      recordBlockedReport(db, team.id, 'revive', 'dolly', report({ gate: 'ci:gates/other' }), 'm2')
        .kind,
    ).toBe('recorded');
  });

  it('reports without sig or ref still seed a legible detail line', () => {
    const { db, team } = seed();
    recordBlockedReport(db, team.id, 'revive', 'izzo', { gate: GATE }, 'm1');
    const out = recordBlockedReport(db, team.id, 'revive', 'dolly', { gate: GATE }, 'm2') as {
      lane: Lane;
    };
    expect(out.lane.detail).toContain('izzo: (no sig)');
  });
});
