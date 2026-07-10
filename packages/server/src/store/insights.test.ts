import { makeEnvelope, type Act } from '@musterd/protocol';
import { describe, expect, it } from 'vitest';
import { openDb } from '../db/open.js';
import { coordinationDensity, deriveSteeringMetrics, flowMetrics, waitingOn } from './insights.js';
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

describe('coordinationDensity (the P3 broadcast-journal signal)', () => {
  const NOW = 40 * 86_400_000;
  let n = 0;
  const post = (
    db: ReturnType<typeof seed>['db'],
    teamId: string,
    fromId: string,
    act: Act,
    to: { kind: 'team' } | { kind: 'member'; name: string; id: string },
    thread?: string,
  ) =>
    insertMessage(
      db,
      teamId,
      fromId,
      to.kind === 'member' ? to.id : null,
      makeEnvelope({
        id: `c${n++}`,
        team: 'revive',
        from: 'nick',
        to: to.kind === 'member' ? { kind: 'member', name: to.name } : { kind: 'team' },
        act,
        body: 'x',
        ts: NOW - 1000,
        ...(thread ? { thread } : {}),
      }),
    );

  it('flags a journal-heavy, exchange-light window', () => {
    const { db, team, nick } = seed();
    // 12 broadcast status_updates, no directed/threaded exchange → journal 100%, exchange 0%.
    for (let i = 0; i < 12; i++) post(db, team.id, nick.id, 'status_update', { kind: 'team' });
    const c = coordinationDensity(db, team.id, NOW);
    expect(c.acts).toBe(12);
    expect(c.journal).toBe(12);
    expect(c.journal_ratio).toBe(1);
    expect(c.exchange_ratio).toBe(0);
    expect(c.flag).toBe(true);
  });

  it('does not flag when there is healthy directed + threaded exchange', () => {
    const { db, team, nick, ada } = seed();
    for (let i = 0; i < 6; i++) post(db, team.id, nick.id, 'status_update', { kind: 'team' });
    // 6 directed request_help → exchange 50%.
    for (let i = 0; i < 6; i++)
      post(db, team.id, nick.id, 'request_help', { kind: 'member', name: 'ada', id: ada.id });
    const c = coordinationDensity(db, team.id, NOW);
    expect(c.directed).toBe(6);
    expect(c.exchange_ratio).toBe(0.5);
    expect(c.flag).toBe(false);
  });

  it('does not flag a tiny sample below the minimum, even if all journal', () => {
    const { db, team, nick } = seed();
    for (let i = 0; i < 3; i++) post(db, team.id, nick.id, 'status_update', { kind: 'team' });
    const c = coordinationDensity(db, team.id, NOW);
    expect(c.journal_ratio).toBe(1);
    expect(c.flag).toBe(false); // 3 < COORD_MIN_ACTS
  });

  it('is empty-safe: zero ratios, no flag, no NaN', () => {
    const { db, team } = seed();
    const c = coordinationDensity(db, team.id, NOW);
    expect(c).toMatchObject({ acts: 0, journal_ratio: 0, exchange_ratio: 0, flag: false });
  });
});

describe('deriveSteeringMetrics (ADR 125 — interrupt-line arc metrics)', () => {
  const NOW = 40 * 86_400_000;

  it('is empty-safe: zeros and null latencies', () => {
    const { db, team } = seed();
    expect(deriveSteeringMetrics(db, team.id, NOW)).toEqual({
      window_days: 7,
      steers: 0,
      acked: 0,
      latency_median_ms: null,
      latency_p95_ms: null,
      superseded_acts: 0,
      stale_wakes: 0,
      stale_caught: 0,
    });
  });

  it('measures steer→ack latency from the recipient’s next act', () => {
    const { db, team, nick, ada } = seed();
    // nick steers ada; ada’s next status_update 2m later is the ack.
    insertMessage(
      db,
      team.id,
      nick.id,
      ada.id,
      makeEnvelope({
        id: 'steer1',
        team: 'revive',
        from: 'nick',
        to: { kind: 'member', name: 'ada' },
        act: 'steer',
        body: 'use v2',
        ts: NOW - 5 * 60_000,
      }),
    );
    insertMessage(
      db,
      team.id,
      ada.id,
      null,
      makeEnvelope({
        id: 'ack1',
        team: 'revive',
        from: 'ada',
        to: { kind: 'team' },
        act: 'status_update',
        body: 'switching to v2',
        ts: NOW - 3 * 60_000,
      }),
    );
    const s = deriveSteeringMetrics(db, team.id, NOW);
    expect(s.steers).toBe(1);
    expect(s.acked).toBe(1);
    expect(s.latency_median_ms).toBe(2 * 60_000);
    expect(s.latency_p95_ms).toBe(2 * 60_000);
  });

  it('counts an unacked steer without inventing a latency', () => {
    const { db, team, nick, ada } = seed();
    insertMessage(
      db,
      team.id,
      nick.id,
      ada.id,
      makeEnvelope({
        id: 'steer-open',
        team: 'revive',
        from: 'nick',
        to: { kind: 'member', name: 'ada' },
        act: 'steer',
        body: 'stop',
        ts: NOW - 60_000,
      }),
    );
    const s = deriveSteeringMetrics(db, team.id, NOW);
    expect(s.steers).toBe(1);
    expect(s.acked).toBe(0);
    expect(s.latency_median_ms).toBeNull();
  });

  it('counts acts that reply to a superseded steer', () => {
    const { db, team, nick, ada } = seed();
    insertMessage(
      db,
      team.id,
      nick.id,
      ada.id,
      makeEnvelope({
        id: 's-old',
        team: 'revive',
        from: 'nick',
        to: { kind: 'member', name: 'ada' },
        act: 'steer',
        body: 'do A',
        ts: NOW - 10 * 60_000,
      }),
    );
    insertMessage(
      db,
      team.id,
      nick.id,
      ada.id,
      makeEnvelope({
        id: 's-new',
        team: 'revive',
        from: 'nick',
        to: { kind: 'member', name: 'ada' },
        act: 'steer',
        body: 'do B instead',
        ts: NOW - 5 * 60_000,
      }),
    );
    // ada accepts the OLD steer after the new one landed — contradictory-stack failure.
    insertMessage(
      db,
      team.id,
      ada.id,
      nick.id,
      makeEnvelope({
        id: 'bad-ack',
        team: 'revive',
        from: 'ada',
        to: { kind: 'member', name: 'nick' },
        act: 'accept',
        body: 'doing A',
        ts: NOW - 4 * 60_000,
        meta: { in_reply_to: 's-old' },
      }),
    );
    expect(deriveSteeringMetrics(db, team.id, NOW).superseded_acts).toBe(1);
  });

  it('counts a same-ts superseded steer via id tie-break (ADR 103 / Bugbot #216)', () => {
    const { db, team, nick, ada } = seed();
    const ts = NOW - 5 * 60_000;
    // Two steers in the same millisecond — higher id wins (ULID order), matching pendingInterrupts.
    insertMessage(
      db,
      team.id,
      nick.id,
      ada.id,
      makeEnvelope({
        id: 's-a',
        team: 'revive',
        from: 'nick',
        to: { kind: 'member', name: 'ada' },
        act: 'steer',
        body: 'do A',
        ts,
      }),
    );
    insertMessage(
      db,
      team.id,
      nick.id,
      ada.id,
      makeEnvelope({
        id: 's-b',
        team: 'revive',
        from: 'nick',
        to: { kind: 'member', name: 'ada' },
        act: 'steer',
        body: 'do B instead',
        ts,
      }),
    );
    insertMessage(
      db,
      team.id,
      ada.id,
      nick.id,
      makeEnvelope({
        id: 'bad-same-ts',
        team: 'revive',
        from: 'ada',
        to: { kind: 'member', name: 'nick' },
        act: 'accept',
        body: 'doing A',
        ts: ts + 1000,
        meta: { in_reply_to: 's-a' },
      }),
    );
    expect(deriveSteeringMetrics(db, team.id, NOW).superseded_acts).toBe(1);
  });

  it('counts a stale wake as caught when the subject lane is later abandoned', () => {
    const { db, team, nick, ada } = seed();
    const lane = openLane(
      db,
      team.id,
      'revive',
      'ada',
      { title: 'stale work', claim: true },
      NOW - 20 * 60_000,
    );
    insertMessage(
      db,
      team.id,
      nick.id,
      ada.id,
      makeEnvelope({
        id: 'wake1',
        team: 'revive',
        from: 'nick',
        to: { kind: 'member', name: 'ada' },
        act: 'message',
        body: '[lane] plan moved',
        ts: NOW - 10 * 60_000,
        meta: {
          lane_warning: {
            kind: 'stale_plan',
            subject: lane.id,
            with: 'goal-x',
            owner: 'ada',
            detail: 'plan moved',
          },
        },
      }),
    );
    updateLane(db, team.id, lane.id, 'revive', { state: 'abandoned' }, NOW - 5 * 60_000);
    const s = deriveSteeringMetrics(db, team.id, NOW);
    expect(s.stale_wakes).toBe(1);
    expect(s.stale_caught).toBe(1);
  });

  it('does not count a stale wake as caught when the lane stays live untouched', () => {
    const { db, team, nick, ada } = seed();
    const lane = openLane(
      db,
      team.id,
      'revive',
      'ada',
      { title: 'still building', claim: true },
      NOW - 20 * 60_000,
    );
    insertMessage(
      db,
      team.id,
      nick.id,
      ada.id,
      makeEnvelope({
        id: 'wake2',
        team: 'revive',
        from: 'nick',
        to: { kind: 'member', name: 'ada' },
        act: 'message',
        body: '[lane] dep moved',
        ts: NOW - 10 * 60_000,
        meta: {
          lane_warning: {
            kind: 'stale_dependency',
            subject: lane.id,
            with: 'other-lane',
            owner: 'ada',
            detail: 'dep moved',
          },
        },
      }),
    );
    const s = deriveSteeringMetrics(db, team.id, NOW);
    expect(s.stale_wakes).toBe(1);
    expect(s.stale_caught).toBe(0);
  });
});
