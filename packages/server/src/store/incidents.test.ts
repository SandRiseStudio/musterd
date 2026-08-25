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
    expect(lane.scope).toEqual([]);
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

/**
 * ADR 325 prereq follow-up (ryder, #1071 acceptance): the v45 migration mints ULIDs through a
 * monotonic factory to preserve arrival order, and the runtime insert must keep the same promise —
 * plain ulid() gives two same-millisecond reports independent random suffixes, so the pool's
 * `ORDER BY id` could invert them where AUTOINCREMENT never did.
 */
describe('incident report ids preserve arrival order (ADR 325 prereq)', () => {
  it('same-timestamp reports sort by id in insertion order, every time', () => {
    const { db, team } = seed();
    const now = Date.now();
    // Same `now` for every insert; many pairs so a random-suffix inversion cannot hide.
    for (let i = 0; i < 50; i++) {
      recordBlockedReport(db, team.id, 'revive', `seat-${i}-a`, report(), `m${i}a`, now);
      recordBlockedReport(db, team.id, 'revive', `seat-${i}-b`, report(), `m${i}b`, now);
    }
    const seats = db
      .prepare<[string], { seat: string }>(
        'SELECT seat FROM incident_reports WHERE team_id = ? ORDER BY id',
      )
      .all(team.id)
      .map((r) => r.seat);
    const inserted = Array.from({ length: 50 }, (_, i) => [`seat-${i}-a`, `seat-${i}-b`]).flat();
    expect(seats).toEqual(inserted);
  });
});
