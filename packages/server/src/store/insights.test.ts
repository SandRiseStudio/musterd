import { makeEnvelope } from '@musterd/protocol';
import { describe, expect, it } from 'vitest';
import { openDb } from '../db/open.js';
import { flowMetrics, waitingOn } from './insights.js';
import { openLane, updateLane } from './lanes.js';
import { addMember } from './members.js';
import { insertMessage } from './messages.js';
import { createTeam } from './teams.js';

function seed() {
  const db = openDb(':memory:');
  const team = createTeam(db, { slug: 'revive' });
  const nick = addMember(db, team, { name: 'nick', kind: 'human' }).row;
  const ada = addMember(db, team, { name: 'ada', kind: 'agent' }).row;
  return { db, team, nick, ada };
}

describe('flowMetrics (ADR 050 Part 5, from lane timestamps)', () => {
  it('counts throughput/WIP and averages cycle time over done lanes', () => {
    const { db, team } = seed();
    const now = 10_000_000;
    // A done lane: claimed at now-5m, resolved at now-2m → cycle 3m; done within the week → throughput.
    const done = openLane(
      db,
      team.id,
      'revive',
      'ada',
      { title: 'a', claim: true },
      now - 5 * 60_000,
    );
    updateLane(db, team.id, done.id, 'revive', { state: 'done' }, now - 2 * 60_000);
    // A live (active) lane → WIP; created 4m ago → oldest_wip_age ~4m.
    const live = openLane(
      db,
      team.id,
      'revive',
      'ada',
      { title: 'b', claim: true },
      now - 4 * 60_000,
    );
    updateLane(db, team.id, live.id, 'revive', { state: 'active' }, now - 4 * 60_000);

    const f = flowMetrics(db, team.id, now);
    expect(f.throughput_7d).toBe(1);
    expect(f.cycle_time_ms).toBe(3 * 60_000);
    expect(f.wip).toBe(1);
    expect(f.oldest_wip_age_ms).toBe(4 * 60_000);
  });

  it('is empty-safe: null cycle time and oldest age when nothing qualifies', () => {
    const { db, team } = seed();
    const f = flowMetrics(db, team.id, 1000);
    expect(f).toEqual({ throughput_7d: 0, cycle_time_ms: null, wip: 0, oldest_wip_age_ms: null });
  });

  it('excludes done lanes older than 7 days from throughput', () => {
    const { db, team } = seed();
    const now = 100 * 24 * 60 * 60 * 1000;
    const old = openLane(
      db,
      team.id,
      'revive',
      'ada',
      { title: 'old', claim: true },
      now - 30 * 24 * 60 * 60 * 1000,
    );
    updateLane(db, team.id, old.id, 'revive', { state: 'done' }, now - 30 * 24 * 60 * 60 * 1000);
    expect(flowMetrics(db, team.id, now).throughput_7d).toBe(0);
  });
});

describe('waitingOn (ADR 050 Part 6 — the bottleneck view)', () => {
  const ask = (
    db: ReturnType<typeof seed>['db'],
    teamId: string,
    fromId: string,
    toName: string,
    toId: string,
    id: string,
    ts: number,
    thread?: string,
  ) =>
    insertMessage(
      db,
      teamId,
      fromId,
      toId,
      makeEnvelope({
        id,
        team: 'revive',
        from: 'nick',
        to: { kind: 'member', name: toName },
        act: 'request_help',
        body: 'need you',
        ts,
        ...(thread ? { thread } : {}),
      }),
    );

  it('aggregates unresolved directed asks by recipient, oldest first', () => {
    const { db, team, nick, ada } = seed();
    const now = 40 * 86_400_000;
    // two threads waiting on ada (oldest 3d), one on nick (1d)
    ask(db, team.id, nick.id, 'ada', ada.id, 'a1', now - 3 * 86_400_000);
    ask(db, team.id, nick.id, 'ada', ada.id, 'a2', now - 1 * 86_400_000);
    ask(db, team.id, ada.id, 'nick', nick.id, 'n1', now - 1 * 86_400_000);
    const w = waitingOn(db, team.id, now);
    expect(w).toEqual([
      { member: 'ada', threads: 2, oldest_age_ms: 3 * 86_400_000 },
      { member: 'nick', threads: 1, oldest_age_ms: 1 * 86_400_000 },
    ]);
  });

  it('a resolve on the thread clears it from the waiting-on view', () => {
    const { db, team, nick, ada } = seed();
    const now = 40 * 86_400_000;
    ask(db, team.id, nick.id, 'ada', ada.id, 'root', now - 86_400_000);
    expect(waitingOn(db, team.id, now)).toHaveLength(1);
    // ada resolves the thread (root id) → no longer waiting.
    insertMessage(
      db,
      team.id,
      ada.id,
      null,
      makeEnvelope({
        id: 'res1',
        team: 'revive',
        from: 'ada',
        to: { kind: 'team' },
        act: 'resolve',
        body: 'done',
        thread: 'root',
        ts: now,
      }),
    );
    expect(waitingOn(db, team.id, now)).toHaveLength(0);
  });

  it('counts a multi-message thread once, dated from its oldest ask', () => {
    const { db, team, nick, ada } = seed();
    const now = 40 * 86_400_000;
    ask(db, team.id, nick.id, 'ada', ada.id, 'root', now - 2 * 86_400_000);
    ask(db, team.id, nick.id, 'ada', ada.id, 'followup', now - 1 * 86_400_000, 'root');
    const w = waitingOn(db, team.id, now);
    expect(w).toEqual([{ member: 'ada', threads: 1, oldest_age_ms: 2 * 86_400_000 }]);
  });
});
