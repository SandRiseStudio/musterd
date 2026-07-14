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
});
