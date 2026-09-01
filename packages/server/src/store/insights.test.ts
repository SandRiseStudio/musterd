import { makeEnvelope, type Act } from '@musterd/protocol';
import { describe, expect, it } from 'vitest';
import { openDb } from '../db/open.js';
import { appendAudit } from './audit.js';
import {
  coordinationDensity,
  deriveReport,
  deriveSteeringMetrics,
  deriveWakeMetrics,
  flowMetrics,
  goalFlowMetrics,
  waitingOn,
} from './insights.js';
import { openLane, updateLane } from './lanes.js';
import { addMember } from './members.js';
import { insertMessage } from './messages.js';
import { enrollResidency } from './residency.js';
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
    expect(f).toEqual({
      throughput_7d: 0,
      cycle_time_ms: null,
      wip: 0,
      oldest_wip_age_ms: null,
      backlog: 0,
    });
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

  // ADR 295: the engine kept its own SQL literal for the contending set and never followed ADR
  // 169/192 when acceptance became a stage. A lane merged and waiting on a counterpart is in
  // flight — counting it as idle is what made review debt invisible to flow.
  it('counts a lane awaiting acceptance as WIP', () => {
    const { db, team } = seed();
    const now = 10_000_000;
    const lane = openLane(
      db,
      team.id,
      'revive',
      'ada',
      { title: 'merged, unaccepted', claim: true },
      now - 6 * 60_000,
    );
    updateLane(db, team.id, lane.id, 'revive', { state: 'awaiting_acceptance' }, now - 60_000);

    const f = flowMetrics(db, team.id, now);
    expect(f.wip).toBe(1);
    expect(f.oldest_wip_age_ms).toBe(6 * 60_000);
  });

  it('reports the backlog — lanes still open, declared and unowned', () => {
    const { db, team } = seed();
    const now = 10_000_000;
    openLane(db, team.id, 'revive', 'ada', { title: 'queued a' }, now - 60_000);
    openLane(db, team.id, 'revive', 'ada', { title: 'queued b' }, now - 60_000);
    openLane(db, team.id, 'revive', 'ada', { title: 'taken', claim: true }, now - 60_000);

    expect(flowMetrics(db, team.id, now).backlog).toBe(2);
  });
});

describe('goalFlowMetrics (ADR 295 — flow dimensioned by Goal)', () => {
  it('groups the same flow numbers by the goal its lanes name', () => {
    const { db, team } = seed();
    const now = 10_000_000;
    // launch: one done lane (cycle 3m) and one live lane created 4m ago.
    const shipped = openLane(
      db,
      team.id,
      'revive',
      'ada',
      { title: 'a', claim: true, goal_id: 'launch' },
      now - 5 * 60_000,
    );
    updateLane(db, team.id, shipped.id, 'revive', { state: 'done' }, now - 2 * 60_000);
    openLane(
      db,
      team.id,
      'revive',
      'ada',
      { title: 'b', claim: true, goal_id: 'launch' },
      now - 4 * 60_000,
    );
    // research: one queued lane only.
    openLane(db, team.id, 'revive', 'ada', { title: 'c', goal_id: 'research' }, now - 60_000);

    const byGoal = goalFlowMetrics(db, team.id, now);
    const launch = byGoal.find((g) => g.goal_id === 'launch');
    const research = byGoal.find((g) => g.goal_id === 'research');

    expect(launch?.flow).toEqual({
      throughput_7d: 1,
      cycle_time_ms: 3 * 60_000,
      wip: 1,
      oldest_wip_age_ms: 4 * 60_000,
      backlog: 0,
    });
    expect(research?.flow).toEqual({
      throughput_7d: 0,
      cycle_time_ms: null,
      wip: 0,
      oldest_wip_age_ms: null,
      backlog: 1,
    });
  });

  it('collects goal-less lanes under a null entry, not under a goal', () => {
    const { db, team } = seed();
    const now = 10_000_000;
    openLane(
      db,
      team.id,
      'revive',
      'ada',
      { title: 'on a goal', claim: true, goal_id: 'launch' },
      now - 60_000,
    );
    openLane(db, team.id, 'revive', 'ada', { title: 'orphan', claim: true }, now - 2 * 60_000);

    const byGoal = goalFlowMetrics(db, team.id, now);
    const pool = byGoal.find((g) => g.goal_id === null);
    expect(pool?.flow.wip).toBe(1);
    expect(pool?.flow.oldest_wip_age_ms).toBe(2 * 60_000);
    expect(byGoal.filter((g) => g.goal_id === 'launch')[0]?.flow.wip).toBe(1);
  });

  it('sorts oldest-WIP first, so the dragging goal reads first', () => {
    const { db, team } = seed();
    const now = 10_000_000;
    openLane(
      db,
      team.id,
      'revive',
      'ada',
      { title: 'recent', claim: true, goal_id: 'fresh' },
      now - 60_000,
    );
    openLane(
      db,
      team.id,
      'revive',
      'ada',
      { title: 'ancient', claim: true, goal_id: 'dragging' },
      now - 90 * 60_000,
    );

    expect(goalFlowMetrics(db, team.id, now).map((g) => g.goal_id)).toEqual(['dragging', 'fresh']);
  });

  it('says nothing about a goal with no lanes — the roster lives in report.goals', () => {
    const { db, team } = seed();
    expect(goalFlowMetrics(db, team.id, 1000)).toEqual([]);
  });

  it('rides the one projection — deriveReport carries the goal_flow block', () => {
    const { db, team } = seed();
    const now = 10_000_000;
    openLane(
      db,
      team.id,
      'revive',
      'ada',
      { title: 'a', claim: true, goal_id: 'launch' },
      now - 60_000,
    );

    const report = deriveReport(db, team.id, 'revive', now);
    expect(report.goal_flow).toEqual([
      {
        goal_id: 'launch',
        flow: {
          throughput_7d: 0,
          cycle_time_ms: null,
          wip: 1,
          oldest_wip_age_ms: 60_000,
          backlog: 0,
        },
      },
    ]);
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

  it('does not count an unrelated owner status_update as catching a stale wake (ADR 126)', () => {
    const { db, team, nick, ada } = seed();
    const lane = openLane(
      db,
      team.id,
      'revive',
      'ada',
      { title: 'warned work', claim: true, goal_id: 'goal-x' },
      NOW - 20 * 60_000,
    );
    insertMessage(
      db,
      team.id,
      nick.id,
      ada.id,
      makeEnvelope({
        id: 'wake-unrelated',
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
    // Routine journal about other work — must NOT count as caught.
    insertMessage(
      db,
      team.id,
      ada.id,
      null,
      makeEnvelope({
        id: 'other-work',
        team: 'revive',
        from: 'ada',
        to: { kind: 'team' },
        act: 'status_update',
        body: 'working on something else',
        ts: NOW - 5 * 60_000,
      }),
    );
    const s = deriveSteeringMetrics(db, team.id, NOW);
    expect(s.stale_wakes).toBe(1);
    expect(s.stale_caught).toBe(0);
  });

  it('counts a wake as caught when the owner replies to it or names its goal (ADR 126)', () => {
    const { db, team, nick, ada } = seed();
    const lane = openLane(
      db,
      team.id,
      'revive',
      'ada',
      { title: 'warned work', claim: true, goal_id: 'goal-x' },
      NOW - 20 * 60_000,
    );
    insertMessage(
      db,
      team.id,
      nick.id,
      ada.id,
      makeEnvelope({
        id: 'wake-scoped',
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
    insertMessage(
      db,
      team.id,
      ada.id,
      null,
      makeEnvelope({
        id: 'recheck',
        team: 'revive',
        from: 'ada',
        to: { kind: 'team' },
        act: 'status_update',
        body: 're-checking direction on goal-x',
        ts: NOW - 5 * 60_000,
        meta: { goal_id: 'goal-x' },
      }),
    );
    expect(deriveSteeringMetrics(db, team.id, NOW).stale_caught).toBe(1);
  });
});

describe('deriveWakeMetrics (ADR 131 inc 5) — latency, answer rate, cost, budgets', () => {
  const NOW = 10_000_000_000;

  function wakeSeed() {
    const { db, team, nick, ada } = seed();
    enrollResidency(db, team.id, {
      member_id: ada.id,
      harness: 'claude-code',
      host: 'mac.lan',
      grant_id: 'g1',
      authorized_by: 'nick',
    });
    return { db, team, nick, ada };
  }

  /** A residency audit row with detail + a backdated ts (appendAudit stamps now). */
  function residencyRow(
    db: ReturnType<typeof openDb>,
    teamId: string,
    action:
      | 'residency.woke'
      | 'residency.wake_failed'
      | 'residency.wake_deferred'
      | 'residency.wake_exhausted'
      | 'residency.wake_cost',
    seat: string,
    detail: Record<string, unknown>,
    ts: number,
  ) {
    appendAudit(db, teamId, {
      actor: null,
      action,
      target: seat,
      result: action === 'residency.woke' || action === 'residency.wake_cost' ? 'allow' : 'deny',
      detail,
    });
    db.prepare(
      'UPDATE audit SET ts = ? WHERE rowid = (SELECT rowid FROM audit ORDER BY rowid DESC LIMIT 1)',
    ).run(ts);
  }

  function directed(
    db: ReturnType<typeof openDb>,
    team: { id: string; slug?: string },
    from: { id: string; name: string },
    to: { id: string; name: string },
    act: Act,
    id: string,
    ts: number,
    meta: Record<string, unknown> | null = null,
  ) {
    insertMessage(
      db,
      team.id,
      from.id,
      to.id,
      makeEnvelope({
        id,
        team: 'revive',
        from: from.name,
        to: { kind: 'member', name: to.name },
        act,
        body: 'x',
        ts,
        meta,
      }),
    );
  }

  it('empty window ⇒ zero counts and nulls, never NaN', () => {
    const { db, team } = wakeSeed();
    const k = deriveWakeMetrics(db, team.id, NOW);
    expect(k).toMatchObject({
      wakes: 0,
      resumed: 0,
      failed: 0,
      deferred: 0,
      exhausted: 0,
      answered: 0,
      answer_rate: null,
      latency_median_ms: null,
      cost_usd_total: null,
      cost_usd_per_wake: null,
      cost_reported: 0,
      by_seat: [],
    });
  });

  it('latency = trigger ts → seat first act; attempts dedupe to one sample per act', () => {
    const { db, team, nick, ada } = wakeSeed();
    directed(db, team, nick, ada, 'handoff', 'h1', NOW - 60 * 60_000);
    // Two woke rows for the SAME act (a retry) — one latency sample, classified by the last row.
    residencyRow(
      db,
      team.id,
      'residency.woke',
      'ada',
      { act: 'h1', lease_id: 'L1' },
      NOW - 50 * 60_000,
    );
    residencyRow(
      db,
      team.id,
      'residency.woke',
      'ada',
      { act: 'h1', lease_id: 'L2', session: 'resumed' },
      NOW - 40 * 60_000,
    );
    // ada's first act after the trigger: 5 minutes later.
    directed(db, team, ada, nick, 'accept', 'a1', NOW - 55 * 60_000, { in_reply_to: 'h1' });

    const k = deriveWakeMetrics(db, team.id, NOW);
    expect(k.wakes).toBe(1);
    expect(k.resumed).toBe(1);
    expect(k.latency_median_ms).toBe(5 * 60_000);
    expect(k.answered).toBe(1); // the accept names h1 in the LIVE ledger
    expect(k.answer_rate).toBe(1);
  });

  it('answer rate reads the ledger live, not the report-time snapshot', () => {
    const { db, team, nick, ada } = wakeSeed();
    directed(db, team, nick, ada, 'handoff', 'h1', NOW - 60 * 60_000);
    // The host reported answered:false at verify time (honest but stale)…
    residencyRow(
      db,
      team.id,
      'residency.woke',
      'ada',
      { act: 'h1', lease_id: 'L1', answered: false },
      NOW - 50 * 60_000,
    );
    const before = deriveWakeMetrics(db, team.id, NOW);
    expect(before.answered).toBe(0);
    // …then the woken session answered AFTER the report settled — the metric must see it.
    directed(db, team, ada, nick, 'accept', 'a1', NOW - 30 * 60_000, { in_reply_to: 'h1' });
    const after = deriveWakeMetrics(db, team.id, NOW);
    expect(after.answered).toBe(1);
  });

  it('cost dedupes by lease, preferring the supplementary wake_cost row; counters count', () => {
    const { db, team, nick, ada } = wakeSeed();
    directed(db, team, nick, ada, 'handoff', 'h1', NOW - 60 * 60_000);
    directed(db, team, nick, ada, 'steer', 's2', NOW - 59 * 60_000);
    // Wake 1: primary report carried a (stale, partial) cost; the supplement corrects it.
    residencyRow(
      db,
      team.id,
      'residency.woke',
      'ada',
      { act: 'h1', lease_id: 'L1', cost_usd: 0.1 },
      NOW - 50 * 60_000,
    );
    residencyRow(
      db,
      team.id,
      'residency.wake_cost',
      'ada',
      { act: 'h1', lease_id: 'L1', cost_usd: 0.9, duration_ms: 30_000 },
      NOW - 49 * 60_000,
    );
    // Wake 2: no cost ever reported (crash) — the honesty denominator must show 1 of 2.
    residencyRow(
      db,
      team.id,
      'residency.woke',
      'ada',
      { act: 's2', lease_id: 'L2' },
      NOW - 45 * 60_000,
    );
    // Quiet counters.
    residencyRow(
      db,
      team.id,
      'residency.wake_failed',
      'ada',
      { act: 's2', lease_id: 'L3' },
      NOW - 44 * 60_000,
    );
    residencyRow(
      db,
      team.id,
      'residency.wake_deferred',
      'ada',
      { act: 's2', lease_id: 'L4' },
      NOW - 43 * 60_000,
    );
    residencyRow(db, team.id, 'residency.wake_exhausted', 'ada', { act: 'h0' }, NOW - 42 * 60_000);

    const k = deriveWakeMetrics(db, team.id, NOW);
    expect(k.wakes).toBe(2);
    expect(k.failed).toBe(1);
    expect(k.deferred).toBe(1);
    expect(k.exhausted).toBe(1);
    expect(k.cost_usd_total).toBeCloseTo(0.9); // L1 deduped to the supplement, L2 costless
    expect(k.cost_reported).toBe(1);
    expect(k.cost_usd_per_wake).toBeCloseTo(0.9);
  });

  // ADR 252: cost only ever arrives on the report path, so a lease that spawned a session and then
  // expired unreported reads as free. The session's attested lease token is what makes that spend
  // sayable — as a COUNT, never as an invented dollar figure folded into the totals.
  it('counts a lease that paid for a session and reported no cost as unpriced, not as free', () => {
    const { db, team, nick, ada } = wakeSeed();
    directed(db, team, nick, ada, 'handoff', 'h1', NOW - 60 * 60_000);
    // A wake that spawned a session and then died on its lease: the expiry row carries the fact.
    residencyRow(
      db,
      team.id,
      'residency.wake_failed',
      'ada',
      { act: 'h1', lease_id: 'L1', reason: 'lease_expired', session_captured: true },
      NOW - 50 * 60_000,
    );
    // A second wake that also spawned a session but DID report its cost — priced, so not counted.
    residencyRow(
      db,
      team.id,
      'residency.wake_failed',
      'ada',
      { act: 'h1', lease_id: 'L2', reason: 'lease_expired', session_captured: true },
      NOW - 49 * 60_000,
    );
    residencyRow(
      db,
      team.id,
      'residency.wake_cost',
      'ada',
      { act: 'h1', lease_id: 'L2', cost_usd: 0.4 },
      NOW - 48 * 60_000,
    );
    // A third expiry with no session evidence at all stays silent — absence is not a zero.
    residencyRow(
      db,
      team.id,
      'residency.wake_failed',
      'ada',
      { act: 'h1', lease_id: 'L3', reason: 'lease_expired' },
      NOW - 47 * 60_000,
    );

    const k = deriveWakeMetrics(db, team.id, NOW);
    expect(k.unpriced_sessions).toBe(1);
    // The totals are untouched: the unpriced wake contributes no fabricated spend.
    expect(k.cost_usd_total).toBeCloseTo(0.4);
    expect(k.cost_reported).toBe(1);
  });

  it('by_seat flags over_budget against the effective budget_usd (a per-run report bound)', () => {
    const { db, team, nick, ada } = wakeSeed();
    // Seat override: budget $0.50 per wake.
    enrollResidency(db, team.id, {
      member_id: ada.id,
      harness: 'claude-code',
      host: 'mac.lan',
      grant_id: 'g1',
      authorized_by: 'nick',
      policy: { budget_usd: 0.5 },
    });
    directed(db, team, nick, ada, 'handoff', 'h1', NOW - 60 * 60_000);
    residencyRow(
      db,
      team.id,
      'residency.woke',
      'ada',
      { act: 'h1', lease_id: 'L1', cost_usd: 0.8 },
      NOW - 50 * 60_000,
    );
    const k = deriveWakeMetrics(db, team.id, NOW);
    expect(k.by_seat).toEqual([
      { seat: 'ada', wakes: 1, cost_usd_total: 0.8, budget_usd: 0.5, over_budget: true },
    ]);
  });

  it('window excludes older rows; deriveReport carries the wake block', () => {
    const { db, team, nick, ada } = wakeSeed();
    directed(db, team, nick, ada, 'handoff', 'h1', NOW - 10 * 24 * 60 * 60_000);
    residencyRow(
      db,
      team.id,
      'residency.woke',
      'ada',
      { act: 'h1', lease_id: 'L1' },
      NOW - 9 * 24 * 60 * 60_000, // 9 days ago — outside the 7d window
    );
    const k = deriveWakeMetrics(db, team.id, NOW);
    expect(k.wakes).toBe(0);
    const report = deriveReport(db, team.id, 'revive', NOW);
    expect(report.wake).toBeDefined();
    expect(report.wake!.window_days).toBe(7);
  });

  // The ADR 209/210 Eval split. The property that matters is NOT the counts — it is that an
  // unmeasured cohort stays distinguishable from a measured-zero one. Every wake in the real ledger
  // on 2026-08-04 predated ADR 209 and reported no delivery; if that rendered as `0 fresh`, a
  // baseline doc would record a measured result where there was no measurement at all.
  it('splits woken acts by delivery outcome and exact-match result', () => {
    const { db, team, nick, ada } = wakeSeed();
    directed(db, team, nick, ada, 'message', 'a1', NOW - 60_000);
    directed(db, team, nick, ada, 'message', 'a2', NOW - 60_000);
    directed(db, team, nick, ada, 'message', 'a3', NOW - 60_000);
    residencyRow(
      db,
      team.id,
      'residency.woke',
      'ada',
      { act: 'a1', lease_id: 'L1', delivery_outcome: 'fresh', exact_match: 'missing' },
      NOW - 50_000,
    );
    residencyRow(
      db,
      team.id,
      'residency.woke',
      'ada',
      { act: 'a2', lease_id: 'L2', delivery_outcome: 'resumed', exact_match: 'bound' },
      NOW - 50_000,
    );
    residencyRow(
      db,
      team.id,
      'residency.woke',
      'ada',
      { act: 'a3', lease_id: 'L3', delivery_outcome: 'fresh_fallback', exact_match: 'stale' },
      NOW - 50_000,
    );

    const k = deriveWakeMetrics(db, team.id, NOW);
    expect(k.wakes).toBe(3);
    expect(k.delivery).toEqual({ fresh: 1, resumed: 1, fresh_fallback: 1 });
    expect(k.delivery_measured).toBe(3);
    expect(k.exact_match).toEqual({ bound: 1, missing: 1, mismatched: 0, stale: 1 });
    expect(k.exact_match_measured).toBe(3);
  });

  it('reports an UNMEASURED cohort as measured=0, not as a row of zeros', () => {
    const { db, team, nick, ada } = wakeSeed();
    directed(db, team, nick, ada, 'message', 'b1', NOW - 60_000);
    // A pre-ADR-209 wake: it occupied, but carried no delivery axis at all.
    residencyRow(
      db,
      team.id,
      'residency.woke',
      'ada',
      { act: 'b1', lease_id: 'L9', session: 'fresh' },
      NOW - 50_000,
    );

    const k = deriveWakeMetrics(db, team.id, NOW);
    expect(k.wakes).toBe(1);
    // The counts are zero AND the denominator is zero — the pair is what says "no data".
    expect(k.delivery).toEqual({ fresh: 0, resumed: 0, fresh_fallback: 0 });
    expect(k.delivery_measured).toBe(0);
    expect(k.exact_match_measured).toBe(0);
  });

  it('a supplementary wake_cost row restating the delivery does not double-count', () => {
    const { db, team, nick, ada } = wakeSeed();
    directed(db, team, nick, ada, 'message', 'c1', NOW - 60_000);
    residencyRow(
      db,
      team.id,
      'residency.woke',
      'ada',
      { act: 'c1', lease_id: 'L5', delivery_outcome: 'resumed', exact_match: 'bound' },
      NOW - 50_000,
    );
    residencyRow(
      db,
      team.id,
      'residency.wake_cost',
      'ada',
      {
        act: 'c1',
        lease_id: 'L5',
        cost_usd: 1.2,
        delivery_outcome: 'resumed',
        exact_match: 'bound',
      },
      NOW - 40_000,
    );

    const k = deriveWakeMetrics(db, team.id, NOW);
    expect(k.delivery_measured).toBe(1);
    expect(k.exact_match_measured).toBe(1);
    expect(k.delivery.resumed).toBe(1);
  });
});

describe('deriveReviewMetrics (ADR 169) — the review eval, without an admin credential', () => {
  /** One audit row of the two-stage-close shape. */
  const row = (
    db: ReturnType<typeof seed>['db'],
    teamId: string,
    action: 'lane.ready_for_review' | 'lane.closed' | 'lane.review_sent_back',
    detail: Record<string, unknown>,
  ) => appendAudit(db, teamId, { actor: 'ada', action, target: 'lane-x', result: 'allow', detail });

  it('separates a routed review from a no-counterpart degradation — the whole point', () => {
    const { db, team } = seed();
    // Two lanes entered review: one found a counterpart, one did not.
    row(db, team.id, 'lane.ready_for_review', {
      lane: 'a',
      reviewer: 'gee',
      route: 'cross_family',
    });
    row(db, team.id, 'lane.ready_for_review', { lane: 'b', no_candidate: true });
    row(db, team.id, 'lane.closed', { lane: 'a', reason: 'counterpart_confirm', verified: true });
    row(db, team.id, 'lane.closed', { lane: 'b', reason: 'no_candidate', verified: false });

    const m = deriveReport(db, team.id, 'revive').review!;
    expect(m.ready).toBe(2);
    expect(m.routed).toBe(1);
    expect(m.no_candidate).toBe(1);
    expect(m.closed.counterpart_confirm).toBe(1);
    expect(m.closed.no_candidate).toBe(1);
    // The catch rate a consumer computes is sent_back/routed — 0/1 here, an honest zero over a real
    // denominator. Over lanes-marked-ready it would read 0/2 and mean nothing.
    expect(m.sent_back).toBe(0);
  });

  it('counts a HAND-ROUTED ask as its own outcome — out of the picker denominator, not unknown', () => {
    // ADR 348 decision 4, and it was violated the day the ADR was written (izzo's review of #1152):
    // a named row carries a `reviewer`, so it landed in `routed` — the catch rate's denominator,
    // which is a statement about the PICKER's asks. Hand-routed asks go where someone expects a
    // careful read, so mixing them changes what "caught N%" measures without changing what it says.
    //
    // The second assertion is the trap for whoever fixes the first: split `named` out of `routed`
    // WITHOUT adding it to the report's subtraction and every hand-routed lane is reported as
    // predating a 2026-07 fix — the exact ADR 234 bug, fourth outcome.
    const { db, team } = seed();
    row(db, team.id, 'lane.ready_for_review', { lane: 'a', reviewer: 'ghost', route: 'named' });
    row(db, team.id, 'lane.ready_for_review', { lane: 'b', reviewer: 'izzo', route: 'cross_family' });
    row(db, team.id, 'lane.review_sent_back', { lane: 'b' });

    const m = deriveReport(db, team.id, 'revive').review!;
    expect(m.ready).toBe(2);
    expect(m.named).toBe(1);
    // The picker routed ONE ask, and the catch rate is 1/1 over it — not 1/2 diluted by an ask the
    // picker never sent.
    expect(m.routed).toBe(1);
    expect(m.sent_back).toBe(1);
    expect(m.no_candidate).toBe(0);
    // Nothing left "unknown": the report's subtraction must include `named`.
    expect(m.ready - m.routed - m.no_candidate - m.acceptance_exempt - m.named).toBe(0);
  });

  it('counts an exemption as its own outcome — not routed, not no-candidate, not unknown', () => {
    // ADR 234 increment 2. An exempt ready row carries neither `reviewer` nor `no_candidate`, so
    // without its own clause it would land in the abstain bucket and the report would call a
    // designed exemption "predates routing-outcome recording" — an unknown asserted about the one
    // row that knows exactly what it did. And its close, left to the `else`, would count as
    // `unknown_reason`: "written by a newer build, upgrade the reader", for a reason this build
    // writes itself.
    const { db, team } = seed();
    row(db, team.id, 'lane.ready_for_review', {
      lane: 'a',
      acceptance_exempt: true,
      stakes: 'low',
    });
    row(db, team.id, 'lane.closed', { lane: 'a', reason: 'acceptance_exempt', verified: false });

    const m = deriveReport(db, team.id, 'revive').review!;
    expect(m.ready).toBe(1);
    expect(m.acceptance_exempt).toBe(1);
    expect(m.routed).toBe(0);
    expect(m.no_candidate).toBe(0); // the degradation count must not absorb a design choice
    expect(m.ready - m.routed - m.no_candidate - m.acceptance_exempt).toBe(0); // nothing left "unknown"
    expect(m.closed.acceptance_exempt).toBe(1);
    expect(m.closed.no_candidate).toBe(0);
    expect(m.closed.self_close).toBe(0);
    expect(m.closed.unknown_reason).toBe(0);
    expect(m.closed.legacy_unlabelled).toBe(0);
  });

  it('counts a sampled-in low lane as ROUTED, and separately as the sample', () => {
    // The 1-in-5 hole routes exactly like `normal`, so it belongs in the catch rate's denominator.
    // `exempt_sampled` rides beside it as the sample size the low tier is producing — the number
    // that says whether the tier is still being measured at all.
    const { db, team } = seed();
    row(db, team.id, 'lane.ready_for_review', {
      lane: 'a',
      reviewer: 'gee',
      route: 'cross_family',
      stakes: 'low',
      exempt_sampled: true,
    });
    const m = deriveReport(db, team.id, 'revive').review!;
    expect(m.routed).toBe(1);
    expect(m.exempt_sampled).toBe(1);
    expect(m.acceptance_exempt).toBe(0); // it was NOT exempt — it was drawn in and asked
  });

  it('counts a review catch, and keeps timeout distinct from no-counterpart', () => {
    const { db, team } = seed();
    row(db, team.id, 'lane.ready_for_review', {
      lane: 'a',
      reviewer: 'gee',
      route: 'cross_family',
    });
    row(db, team.id, 'lane.review_sent_back', { lane: 'a', reviewer: 'gee', owner: 'ada' });
    row(db, team.id, 'lane.ready_for_review', {
      lane: 'b',
      reviewer: 'gee',
      route: 'cross_family',
    });
    row(db, team.id, 'lane.closed', { lane: 'b', reason: 'review_timeout', verified: false });

    const m = deriveReport(db, team.id, 'revive').review!;
    expect(m.sent_back).toBe(1);
    expect(m.routed).toBe(2);
    expect(m.closed.review_timeout).toBe(1);
    expect(m.closed.no_candidate).toBe(0); // a timeout is NOT a missing counterpart
  });

  // ADR 217: the two halves the old `review_timeout` conflated each get a bucket, and the old label
  // survives as the abstention for rows whose promised window was never recorded. All three must be
  // matched EXPLICITLY — if either new reason fell to the `else` it would be counted as
  // `unknown_reason`, and the metric would report ignorance about rows that stated themselves
  // plainly (the ADR 173 failure this projection has already made twice).
  it('counts the cut-short and unanswered halves apart, and keeps the abstention distinct', () => {
    const { db, team } = seed();
    row(db, team.id, 'lane.closed', { lane: 'a', reason: 'review_unanswered', verified: false });
    row(db, team.id, 'lane.closed', { lane: 'b', reason: 'review_cut_short', verified: false });
    row(db, team.id, 'lane.closed', { lane: 'c', reason: 'review_cut_short', verified: false });
    row(db, team.id, 'lane.closed', { lane: 'd', reason: 'review_timeout', verified: false });

    const m = deriveReport(db, team.id, 'revive').review!;
    expect(m.closed.review_unanswered).toBe(1);
    expect(m.closed.review_cut_short).toBe(2);
    expect(m.closed.review_timeout).toBe(1);
    expect(m.closed.unknown_reason).toBe(0);
    expect(m.closed.total).toBe(4);
  });

  it('legacy rows abstain from the routed/no-candidate split rather than being guessed', () => {
    const { db, team } = seed();
    // Written before the routing outcome was recorded (pre-#450): neither field present.
    row(db, team.id, 'lane.ready_for_review', { lane: 'a', owner: 'ada' });
    row(db, team.id, 'lane.closed', { lane: 'a', verified: false }); // and no reason at all

    const m = deriveReport(db, team.id, 'revive').review!;
    expect(m.ready).toBe(1);
    expect(m.routed).toBe(0);
    expect(m.no_candidate).toBe(0); // counted in neither — we do not know
    expect(m.closed.total).toBe(1);
    // This used to assert `self_close`, which reads as "never entered review" — a positive claim
    // about a row that recorded nothing. It abstains now: the ready split already refuses to guess
    // for this row, and the close bucket has to refuse on the same evidence or the two disagree.
    expect(m.closed.legacy_unlabelled).toBe(1);
    expect(m.closed.self_close).toBe(0);
  });

  it('is zero-shaped on a team that has never used review', () => {
    const { db, team } = seed();
    const m = deriveReport(db, team.id, 'revive').review!;
    expect(m.ready).toBe(0);
    expect(m.closed.total).toBe(0);
    expect(m.window_ms).toBeGreaterThan(0);
  });

  // ADR 172's counter-metric was invisible in the one report meant to show it: `human_review_missed`
  // had no bucket, so the reason-ladder's `else` swept those closes into `self_close` — "never
  // entered review", of a lane that demonstrably entered review and whose required human never came.
  it('counts a human_review_missed close as itself, NOT as a self-close', () => {
    const { db, team } = seed();
    row(db, team.id, 'lane.ready_for_review', {
      lane: 'a',
      no_candidate: true,
      human_required: true,
    });
    row(db, team.id, 'lane.closed', {
      lane: 'a',
      reason: 'human_review_missed',
      human_review_missed: true,
      verified: false,
    });

    const m = deriveReport(db, team.id, 'revive').review!;
    expect(m.closed.human_review_missed).toBe(1);
    expect(m.closed.self_close).toBe(0); // the miscount this replaces
    expect(m.closed.no_candidate).toBe(0); // and not folded into the sanctioned degradation either
  });

  // Clause 4: an abstention must be VISIBLE, not merely absent from a count. The close edge records
  // that it could not tell; the report carries the total so a reader knows how much the
  // human_review_missed number abstained over.
  it('surfaces how many closes could not tell whether a human was required', () => {
    const { db, team } = seed();
    row(db, team.id, 'lane.ready_for_review', { lane: 'a', no_candidate: true }); // pre-#462 row
    row(db, team.id, 'lane.closed', {
      lane: 'a',
      reason: 'no_candidate',
      human_required_unknown: true,
      verified: false,
    });
    row(db, team.id, 'lane.closed', { lane: 'b', reason: 'self_close', verified: false });

    const m = deriveReport(db, team.id, 'revive').review!;
    expect(m.closed.human_required_unknown).toBe(1);
    expect(m.closed.human_review_missed).toBe(0); // never inferred from an abstention
  });

  // The residual #517 left behind, one level below the bucket it added. `self_close` is a REAL
  // recorded reason — "never entered review" — so the ladder's `else` must not also absorb the two
  // ways of not knowing. They are different facts with different remedies (nothing to do about a
  // legacy row; upgrade the reader for a reason a newer build wrote), so clause 1 gives them
  // different names rather than one `unknown`.
  it('separates an unrecognised reason from one that was never recorded, and from a real self-close', () => {
    const { db, team } = seed();
    row(db, team.id, 'lane.closed', { lane: 'a', reason: 'some_future_reason', verified: false });
    row(db, team.id, 'lane.closed', { lane: 'b', verified: false }); // no reason at all
    row(db, team.id, 'lane.closed', { lane: 'c', reason: 'self_close', verified: false });

    const m = deriveReport(db, team.id, 'revive').review!;
    expect(m.closed.unknown_reason).toBe(1);
    expect(m.closed.legacy_unlabelled).toBe(1);
    expect(m.closed.self_close).toBe(1); // only an EXPLICIT self_close is one
    expect(m.closed.total).toBe(3);
  });

  // The arithmetic a reader does on this panel has to close, or an abstention that is merely
  // uncounted is as misleading as one that is miscounted.
  it('the reason buckets sum to total, so nothing hides in a rounding gap', () => {
    const { db, team } = seed();
    row(db, team.id, 'lane.closed', { lane: 'a', reason: 'counterpart_confirm', verified: true });
    row(db, team.id, 'lane.closed', { lane: 'b', reason: 'review_timeout', verified: false });
    row(db, team.id, 'lane.closed', { lane: 'c', reason: 'no_candidate', verified: false });
    row(db, team.id, 'lane.closed', { lane: 'd', reason: 'human_review_missed', verified: false });
    row(db, team.id, 'lane.closed', { lane: 'e', reason: 'self_close', verified: false });
    row(db, team.id, 'lane.closed', { lane: 'f', reason: 'abandoned', verified: false });
    row(db, team.id, 'lane.closed', { lane: 'g', reason: 'who_knows', verified: false });
    row(db, team.id, 'lane.closed', { lane: 'h', verified: false });

    const c = deriveReport(db, team.id, 'revive').review!.closed;
    const summed =
      c.counterpart_confirm +
      c.review_timeout +
      c.no_candidate +
      c.human_review_missed +
      c.self_close +
      c.abandoned +
      c.unknown_reason +
      c.legacy_unlabelled;
    expect(summed).toBe(c.total);
    expect(c.total).toBe(8);
  });
});
