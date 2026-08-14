import type { Lane } from '@musterd/protocol';
import type { Database } from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import { resolveConfig } from '../config.js';
import type { Ctx } from '../context.js';
import { openDb } from '../db/open.js';
import { announceIncidentResolved, announceIncidentRouted } from '../protocol/route.js';
import { openIncidents, recordBlockedReport, routeUnclaimedIncidents } from './incidents.js';
import { openLane } from './lanes.js';
import { addMember, getMemberByRole } from './members.js';
import { createTeam, setPolicy, type TeamRow } from './teams.js';

/**
 * Incident convergence increment 2, spec §3 — the claim window and what happens at its close.
 *
 * The window exists because CONTEXT BEATS ROLE: the seats who hit the red know the most about it,
 * and the a11y episode that motivated the spec was fixed across two surfaces no single role seat
 * should own. So any seat may claim first, and the fallback role is what catches an incident nobody
 * picked up — routing, not monopoly.
 */
describe('claim window and fallback-role assignment', () => {
  const GATE = 'ci:gates/A11y contrast';
  let db: Database;
  let team: TeamRow;
  let teamId: string;

  const WINDOW = 600_000;

  beforeEach(() => {
    db = openDb(':memory:');
    team = createTeam(db, { slug: 'dawn' });
    teamId = team.id;
    for (const [name, role] of [
      ['izzo', 'reviewer'],
      ['dolly', 'reviewer'],
      ['stanley', 'platform'],
    ] as const) {
      addMember(db, team, { name, kind: 'agent', role });
    }
  });

  /** Trip the threshold: two distinct seats on one gate. */
  function openIncident(at: number): string {
    recordBlockedReport(db, teamId, 'dawn', 'izzo', { gate: GATE }, 'm1', at);
    recordBlockedReport(db, teamId, 'dawn', 'dolly', { gate: GATE }, 'm2', at);
    const [lane] = openIncidents(db, teamId, 'dawn');
    expect(lane).toBeDefined();
    return lane!.id;
  }

  it('leaves the incident alone while the window is open', () => {
    const at = 1_000_000;
    openIncident(at);
    expect(routeUnclaimedIncidents(db, teamId, 'dawn', at + WINDOW - 1)).toEqual([]);
    expect(openIncidents(db, teamId, 'dawn')[0]!.owner_seat).toBeNull();
  });

  it('assigns the fallback-role seat once the window closes', () => {
    const at = 1_000_000;
    const laneId = openIncident(at);
    const routed = routeUnclaimedIncidents(db, teamId, 'dawn', at + WINDOW);
    expect(routed.map((r) => [r.lane.id, r.owner])).toEqual([[laneId, 'stanley']]);

    const lane = openIncidents(db, teamId, 'dawn')[0]!;
    expect(lane.owner_seat).toBe('stanley');
    // An owned lane is claimed, not still open — the board must not show it as up for grabs.
    expect(lane.state).toBe('claimed');
  });

  it('never takes an incident away from a seat who claimed it first', () => {
    // The whole point of the window: context beats role. A reviewer who picked it up keeps it, and
    // the platform seat is not handed work someone is already doing.
    const at = 1_000_000;
    const laneId = openIncident(at);
    updateOwner(laneId, 'izzo');
    expect(routeUnclaimedIncidents(db, teamId, 'dawn', at + WINDOW * 10)).toEqual([]);
    expect(openIncidents(db, teamId, 'dawn')[0]!.owner_seat).toBe('izzo');
  });

  it('assigns each incident exactly once, however often the sweeper runs', () => {
    const at = 1_000_000;
    openIncident(at);
    expect(routeUnclaimedIncidents(db, teamId, 'dawn', at + WINDOW)).toHaveLength(1);
    expect(routeUnclaimedIncidents(db, teamId, 'dawn', at + WINDOW + 1)).toEqual([]);
    expect(routeUnclaimedIncidents(db, teamId, 'dawn', at + WINDOW * 5)).toEqual([]);
  });

  it('does nothing when the team opted out', () => {
    const at = 1_000_000;
    openIncident(at);
    setPolicy(db, teamId, { incident: { enabled: false } });
    expect(routeUnclaimedIncidents(db, teamId, 'dawn', at + WINDOW)).toEqual([]);
  });

  it('honours a re-pointed fallback role', () => {
    const at = 1_000_000;
    openIncident(at);
    setPolicy(db, teamId, { incident: { fallback_role: 'reviewer' } });
    const routed = routeUnclaimedIncidents(db, teamId, 'dawn', at + WINDOW);
    expect(routed).toHaveLength(1);
    expect(['izzo', 'dolly']).toContain(routed[0]!.owner);
  });

  it('a zero window assigns at once — role routing without the wait', () => {
    const at = 1_000_000;
    setPolicy(db, teamId, { incident: { claim_window_ms: 0 } });
    openIncident(at);
    expect(routeUnclaimedIncidents(db, teamId, 'dawn', at)).toHaveLength(1);
  });

  describe('when nobody holds the fallback role', () => {
    beforeEach(() => {
      setPolicy(db, teamId, { incident: { fallback_role: 'nobody-holds-this' } });
    });

    it('leaves the incident unowned rather than inventing an owner', () => {
      const at = 1_000_000;
      openIncident(at);
      expect(routeUnclaimedIncidents(db, teamId, 'dawn', at + WINDOW)).toEqual([]);
      // Still open and still unowned — an unrouted incident is a real state, and the banner keeps
      // pointing at it. Assigning it to an arbitrary seat would be worse than leaving it visible.
      expect(openIncidents(db, teamId, 'dawn')[0]!.owner_seat).toBeNull();
    });

    it('records the unfilled route ONCE, not on every sweeper tick', () => {
      const at = 1_000_000;
      openIncident(at);
      for (let i = 0; i < 5; i++) routeUnclaimedIncidents(db, teamId, 'dawn', at + WINDOW + i);
      const rows = db
        .prepare<
          [string],
          { n: number }
        >("SELECT COUNT(*) n FROM audit WHERE team_id = ? AND action = 'incident.route_unfilled'")
        .get(teamId);
      expect(rows!.n).toBe(1);
    });
  });

  function updateOwner(laneId: string, owner: string): void {
    db.prepare('UPDATE lanes SET owner_seat = ?, state = ? WHERE id = ?').run(
      owner,
      'claimed',
      laneId,
    );
  }
});

describe('getMemberByRole (ADR 227)', () => {
  let db: Database;
  let team: TeamRow;
  let teamId: string;

  beforeEach(() => {
    db = openDb(':memory:');
    team = createTeam(db, { slug: 'dawn' });
    teamId = team.id;
  });

  it('finds the seat holding the role', () => {
    addMember(db, team, { name: 'stanley', kind: 'agent', role: 'platform' });
    expect(getMemberByRole(db, teamId, 'platform')?.name).toBe('stanley');
  });

  it('is undefined when nobody holds it', () => {
    addMember(db, team, { name: 'izzo', kind: 'agent', role: 'reviewer' });
    expect(getMemberByRole(db, teamId, 'platform')).toBeUndefined();
  });

  it('reads the ADR 227 roles array, not only the legacy single role', () => {
    // The two inline copies of this query elsewhere match `members.role = ?` and so cannot see a
    // seat whose platform role lives in the roles JSON. A fallback owner that exists but cannot be
    // found is indistinguishable from no owner at all.
    addMember(db, team, { name: 'dolly', kind: 'agent', role: 'reviewer' });
    db.prepare('UPDATE members SET roles = ? WHERE team_id = ? AND name = ?').run(
      JSON.stringify(['reviewer', 'platform']),
      teamId,
      'dolly',
    );
    expect(getMemberByRole(db, teamId, 'platform')?.name).toBe('dolly');
  });

  it('is deterministic when two seats hold the role', () => {
    addMember(db, team, { name: 'aaa', kind: 'agent', role: 'platform' });
    addMember(db, team, { name: 'bbb', kind: 'agent', role: 'platform' });
    const first = getMemberByRole(db, teamId, 'platform')?.name;
    expect(first).toBeDefined();
    for (let i = 0; i < 5; i++) expect(getMemberByRole(db, teamId, 'platform')?.name).toBe(first);
  });

  it('skips a departed seat', () => {
    addMember(db, team, { name: 'stanley', kind: 'agent', role: 'platform' });
    db.prepare('UPDATE members SET left_at = ? WHERE team_id = ? AND name = ?').run(
      Date.now(),
      teamId,
      'stanley',
    );
    expect(getMemberByRole(db, teamId, 'platform')).toBeUndefined();
  });
});

describe('the routed announcement (ADR 270)', () => {
  let db: Database;
  let team: TeamRow;
  const GATE = 'ci:gates/A11y contrast';

  /**
   * A Ctx with a no-op hub: `routeEnvelope` persists to the db and then pushes to live sessions, and
   * only the persistence is under test here — a seat's inbox is the db, and the delivery-hint nudge
   * on top of it is increment 1's, already covered.
   */
  function ctx(): Ctx {
    const hub = new Proxy({}, { get: () => () => undefined }) as Ctx['hub'];
    return { db, hub, config: resolveConfig({ db: ':memory:' }), rosterRoots: [] };
  }

  beforeEach(() => {
    db = openDb(':memory:');
    team = createTeam(db, { slug: 'dawn' });
    for (const [name, role] of [
      ['izzo', 'reviewer'],
      ['dolly', 'reviewer'],
      ['stanley', 'platform'],
    ] as const) {
      addMember(db, team, { name, kind: 'agent', role });
    }
    recordBlockedReport(db, team.id, 'dawn', 'izzo', { gate: GATE }, 'm1', 1_000_000);
    recordBlockedReport(db, team.id, 'dawn', 'dolly', { gate: GATE }, 'm2', 1_000_000);
  });

  /** Directed messages as (sender, recipient, body) — the shape a seat's inbox is actually built from. */
  function directed(): { from: string; to: string; body: string }[] {
    return db
      .prepare<[string], { from: string; to: string; body: string }>(
        `SELECT f.name AS "from", t.name AS "to", m.body AS body
           FROM messages m
           JOIN members f ON f.id = m.from_member
           JOIN members t ON t.id = m.to_member
          WHERE m.team_id = ? AND m.to_kind = 'member'`,
      )
      .all(team.id);
  }

  function route(): { lane: Lane; owner: string } {
    const [routed] = routeUnclaimedIncidents(db, team.id, 'dawn', 1_600_000);
    announceIncidentRouted(ctx(), team, routed!.lane, routed!.owner, 600_000);
    return routed!;
  }

  it('tells the new owner they were routed, and that they may hand it back', () => {
    const routed = route();
    const owned = directed().filter((m) => m.body.startsWith('[incident] routed to you'));
    expect(owned).toHaveLength(1);
    expect(owned[0]!.to).toBe('stanley');
    expect(owned[0]!.body).toContain(routed.lane.id);
    // The assignment is a routing default, not a verdict about who should fix it.
    expect(owned[0]!.body).toMatch(/hand it off or release it/);
  });

  it('tells the reporters their red has an owner, so nobody waits on a human to relay it', () => {
    route();
    const told = directed()
      .filter((m) => m.body.includes('now owned by stanley'))
      .map((m) => m.to)
      .sort();
    expect(told).toEqual(['dolly', 'izzo']);
  });

  it('never sends a seat its own message — a self-send reaches no inbox', () => {
    // The trap increment 1 paid for once. Assignment has ALREADY set owner_seat by the time this
    // runs, so a voice derived from the lane would BE the recipient every time.
    route();
    for (const m of directed()) expect(m.from).not.toBe(m.to);
  });
});

describe('resolve-time reporter fan-out (ADR 270)', () => {
  let db: Database;
  let team: TeamRow;
  const GATE = 'ci:gates/A11y contrast';

  function ctx(): Ctx {
    const hub = new Proxy({}, { get: () => () => undefined }) as Ctx['hub'];
    return { db, hub, config: resolveConfig({ db: ':memory:' }), rosterRoots: [] };
  }

  function directed(): { from: string; to: string; body: string }[] {
    return db
      .prepare<[string], { from: string; to: string; body: string }>(
        `SELECT f.name AS "from", t.name AS "to", m.body AS body
           FROM messages m
           JOIN members f ON f.id = m.from_member
           JOIN members t ON t.id = m.to_member
          WHERE m.team_id = ? AND m.to_kind = 'member'`,
      )
      .all(team.id);
  }

  beforeEach(() => {
    db = openDb(':memory:');
    team = createTeam(db, { slug: 'dawn' });
    for (const name of ['izzo', 'dolly', 'stanley'] as const) {
      addMember(db, team, { name, kind: 'agent', role: 'platform' });
    }
    recordBlockedReport(db, team.id, 'dawn', 'izzo', { gate: GATE, ref: 'pr#828' }, 'm1', 1_000);
    recordBlockedReport(db, team.id, 'dawn', 'dolly', { gate: GATE, ref: 'pr#830' }, 'm2', 1_000);
  });

  function incident(): Lane {
    return openIncidents(db, team.id, 'dawn')[0]!;
  }

  it('tells every reporter the red is cleared, naming what they parked', () => {
    // The fan-out is the point of keeping every report: a seat parked a PR behind this and has no
    // other way to learn it can move again short of a human relaying it.
    announceIncidentResolved(ctx(), team, incident(), 'stanley');
    const told = directed().filter((m) => m.body.includes('[incident] resolved'));
    expect(told.map((m) => m.to).sort()).toEqual(['dolly', 'izzo']);
    expect(told.every((m) => m.body.includes(GATE))).toBe(true);
  });

  it('does not send the closer a note about their own close', () => {
    updateOwnerTo('izzo');
    announceIncidentResolved(ctx(), team, incident(), 'izzo');
    const told = directed().filter((m) => m.body.includes('[incident] resolved'));
    expect(told.map((m) => m.to)).toEqual(['dolly']);
  });

  it('never self-sends', () => {
    announceIncidentResolved(ctx(), team, incident(), 'stanley');
    for (const m of directed()) expect(m.from).not.toBe(m.to);
  });

  it('is silent for an ordinary lane', () => {
    const ordinary = openLane(db, team.id, 'dawn', 'izzo', { title: 'not an incident' });
    announceIncidentResolved(ctx(), team, ordinary, 'stanley');
    expect(directed()).toHaveLength(0);
  });

  function updateOwnerTo(owner: string): void {
    db.prepare('UPDATE lanes SET owner_seat = ? WHERE id = ?').run(owner, incident().id);
  }
});
