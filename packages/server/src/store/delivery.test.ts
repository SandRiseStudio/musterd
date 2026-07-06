import { makeEnvelope, type Act } from '@musterd/protocol';
import type { Database } from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { openDb } from '../db/open.js';
import { appendAudit } from './audit.js';
import { setCursor } from './cursors.js';
import { actDelivery, crossedBySeen, openDirectedLedger } from './delivery.js';
import { addMember } from './members.js';
import { countOpenLoops, insertMessage } from './messages.js';
import type { MemberRow, TeamRow } from './rows.js';
import { createTeam } from './teams.js';

function seed() {
  const db = openDb(':memory:');
  const team = createTeam(db, { slug: 'revive' });
  const nick = addMember(db, team, { name: 'nick', kind: 'human' }).row;
  const ada = addMember(db, team, { name: 'Ada', kind: 'agent' }).row;
  const bob = addMember(db, team, { name: 'bob', kind: 'agent' }).row;
  return { db, team, nick, ada, bob };
}

function msg(
  db: Database,
  team: TeamRow,
  from: MemberRow,
  to: MemberRow | null,
  act: Act,
  id: string,
  ts: number,
  opts: { thread?: string; meta?: Record<string, unknown> } = {},
) {
  insertMessage(
    db,
    team.id,
    from.id,
    to?.id ?? null,
    makeEnvelope({
      id,
      team: team.slug,
      from: from.name,
      to: to ? { kind: 'member', name: to.name } : { kind: 'team' },
      act,
      body: 'x',
      thread: opts.thread ?? null,
      meta: opts.meta ?? null,
      ts,
    }),
  );
}

describe('actDelivery (ADR 090: the per-act ledger, derived)', () => {
  it('walks logged → seen → answered off the log + cursor, keyed on the normalized seat id', () => {
    const { db, team, nick, ada } = seed();
    msg(db, team, nick, ada, 'handoff', 'h1', 1_000);

    // Unseen: cursor never advanced.
    let d = actDelivery(db, team.id, 'h1', 10_000)!;
    expect(d.recipients).toHaveLength(1);
    expect(d.recipients[0]).toMatchObject({
      seat: 'Ada',
      seat_id: 'ada',
      state: 'logged',
      seen_by: null,
      answered: null,
    });
    expect(d.age_ms).toBe(9_000);

    // Seen: ada's cursor crosses the act (watermark semantics — seen_by is the cursor update time).
    setCursor(db, ada.id, 'h1', 1_000);
    d = actDelivery(db, team.id, 'h1', 10_000)!;
    expect(d.recipients[0]!.state).toBe('seen');
    expect(d.recipients[0]!.seen_by).not.toBeNull();

    // Answered: ada's accept names the act via meta.in_reply_to.
    msg(db, team, ada, nick, 'accept', 'a1', 2_000, { meta: { in_reply_to: 'h1' } });
    d = actDelivery(db, team.id, 'h1', 10_000)!;
    expect(d.recipients[0]!.state).toBe('answered');
    expect(d.recipients[0]!.answered).toMatchObject({ act: 'accept', id: 'a1', ts: 2_000 });
  });

  it('a resolve on the thread answers for every recipient', () => {
    const { db, team, nick, ada } = seed();
    msg(db, team, nick, null, 'request_help', 'r1', 1_000, { thread: 't1' });
    msg(db, team, ada, null, 'resolve', 'v1', 3_000, { thread: 't1' });
    const d = actDelivery(db, team.id, 'r1', 10_000)!;
    // Team act fans out to the current roster minus the sender.
    expect(d.recipients.map((r) => r.seat).sort()).toEqual(['Ada', 'bob']);
    for (const r of d.recipients) expect(r.state).toBe('answered');
    expect(d.recipients[0]!.answered).toMatchObject({ act: 'resolve', id: 'v1' });
  });

  it('counts ADR 088 interrupt raises from the audit as attempt history, and reads meta.urgent', () => {
    const { db, team, nick, ada } = seed();
    msg(db, team, nick, ada, 'handoff', 'h2', 1_000, {
      meta: { urgent: true, urgent_reason: 'steer' },
    });
    appendAudit(db, team.id, {
      actor: 'nick',
      action: 'interrupt.raised',
      target: 'Ada',
      result: 'allow',
      detail: { act: 'h2', act_kind: 'handoff', tier: 'urgent', count: 1 },
    });
    const d = actDelivery(db, team.id, 'h2', 5_000)!;
    expect(d.urgent).toBe(true);
    expect(d.recipients[0]!.interrupt_raises).toBe(1);
  });

  it('returns null for an unknown id', () => {
    const { db, team } = seed();
    expect(actDelivery(db, team.id, 'nope')).toBeNull();
  });
});

describe('crossedBySeen (ADR 090: the seen_latency scope)', () => {
  it('covers directed acts AND team/broadcast loop-opening acts, never my own sends or chatter', () => {
    const { db, team, nick, ada } = seed();
    msg(db, team, nick, ada, 'handoff', 'h1', 1_000); // directed at ada → counts
    msg(db, team, nick, null, 'request_help', 'r1', 2_000); // team loop-opening (to_member NULL) → counts
    msg(db, team, nick, null, 'status_update', 's1', 3_000); // team chatter → not the firehose
    msg(db, team, ada, null, 'request_help', 'r2', 4_000); // ada's own send → excluded

    const crossed = crossedBySeen(db, team.id, ada.id, 0, 10_000);
    expect(crossed.map((c) => c.act).sort()).toEqual(['handoff', 'request_help']);
  });

  it('is bounded by the cursor window (fromTs exclusive, toTs inclusive)', () => {
    const { db, team, nick, ada } = seed();
    msg(db, team, nick, ada, 'handoff', 'h1', 1_000);
    msg(db, team, nick, ada, 'handoff', 'h2', 2_000);
    expect(crossedBySeen(db, team.id, ada.id, 1_000, 2_000).map((c) => c.ts)).toEqual([2_000]);
  });
});

describe('openDirectedLedger (ADR 090: the open directed ledger)', () => {
  it('lists loop-opening acts until answered — accept and resolve both close', () => {
    const { db, team, nick, ada, bob } = seed();
    msg(db, team, nick, ada, 'handoff', 'h1', 1_000);
    msg(db, team, nick, null, 'request_help', 'r1', 2_000, { thread: 't1' });
    expect(openDirectedLedger(db, team.id, 10_000).map((d) => d.id)).toEqual(['h1', 'r1']);

    msg(db, team, ada, nick, 'accept', 'a1', 3_000, { meta: { in_reply_to: 'h1' } });
    expect(openDirectedLedger(db, team.id, 10_000).map((d) => d.id)).toEqual(['r1']);

    msg(db, team, bob, null, 'resolve', 'v1', 4_000, { thread: 't1' });
    expect(openDirectedLedger(db, team.id, 10_000)).toHaveLength(0);
  });

  it('includes urgent directed acts of any act type, but not ordinary chatter', () => {
    const { db, team, nick, ada } = seed();
    msg(db, team, nick, ada, 'message', 'm1', 1_000, {
      meta: { urgent: true, urgent_reason: 'steer' },
    });
    msg(db, team, nick, ada, 'message', 'm2', 2_000); // not urgent, not loop-opening
    expect(openDirectedLedger(db, team.id, 10_000).map((d) => d.id)).toEqual(['m1']);
  });

  it('reconciles with the open_loops gauge — two derivations of one truth (the ADR guard)', () => {
    const { db, team, nick, ada } = seed();
    msg(db, team, nick, ada, 'handoff', 'h1', 1_000);
    msg(db, team, nick, null, 'request_help', 'r1', 2_000, { thread: 't1' });
    const loopActs = () =>
      openDirectedLedger(db, team.id, 10_000).filter((d) =>
        ['request_help', 'handoff'].includes(d.act),
      ).length;
    expect(loopActs()).toBe(countOpenLoops(db));

    msg(db, team, ada, null, 'resolve', 'v1', 3_000, { thread: 't1' });
    expect(loopActs()).toBe(countOpenLoops(db));
    expect(countOpenLoops(db)).toBe(1);
  });
});
