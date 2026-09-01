import { makeEnvelope, type Act } from '@musterd/protocol';
import type { Database } from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { openDb } from '../db/open.js';
import { appendAudit } from './audit.js';
import { setCursor } from './cursors.js';
import {
  actDelivery,
  crossedBySeen,
  handoffNamedLaneOutOfPlay,
  openDirectedLedger,
} from './delivery.js';
import { openLane, updateLane } from './lanes.js';
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
    // Receipt order IS the fixture's order: the cursor walks created_at, so stamp it with the ts.
    { now: ts },
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
    setCursor(db, ada.id, 'h1');
    d = actDelivery(db, team.id, 'h1', 10_000)!;
    expect(d.recipients[0]!.state).toBe('seen');
    expect(d.recipients[0]!.seen_by).not.toBeNull();

    // Answered: ada's accept names the act via meta.in_reply_to.
    msg(db, team, ada, nick, 'accept', 'a1', 2_000, { meta: { in_reply_to: 'h1' } });
    d = actDelivery(db, team.id, 'h1', 10_000)!;
    expect(d.recipients[0]!.state).toBe('answered');
    expect(d.recipients[0]!.answered).toMatchObject({ act: 'accept', id: 'a1', ts: 2_000 });
  });

  /**
   * A read cursor is a `(ts, id)` point, not a ts (ADR 290's 2026-08-20 amendment). `seen` compared
   * on ts alone with `>=`, so an act sharing the cursor row's millisecond reported as SEEN although
   * the reader was never handed it — while `listInbox` reports that same act UNREAD. One message,
   * both at once, and `seen` is the answer the ADR 090 ledger exists to give.
   */
  it('an act tied with the cursor row is not seen — the reader was never handed it', () => {
    const { db, team, nick, ada } = seed();
    msg(db, team, nick, ada, 'handoff', 'h1', 1_000);
    msg(db, team, nick, ada, 'handoff', 'h2', 1_000); // same millisecond, never delivered

    setCursor(db, ada.id, 'h1'); // ada read h1, and only h1

    expect(actDelivery(db, team.id, 'h1', 10_000)!.recipients[0]!.state).toBe('seen');
    const tied = actDelivery(db, team.id, 'h2', 10_000)!.recipients[0]!;
    expect(tied.state).toBe('logged');
    expect(tied.seen_by).toBeNull();
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

describe('handoffNamedLaneOutOfPlay (#745 discharge rule, shared with orientation why)', () => {
  function metaFor(laneId: string): string {
    return JSON.stringify({ lane_handoff: { lane: laneId } });
  }

  it('is false for a bare handoff, a missing lane, and a still-live named lane', () => {
    const { db, team } = seed();
    const lane = openLane(db, team.id, team.slug, 'nick', { title: 'live', claim: true });
    expect(handoffNamedLaneOutOfPlay(db, team.id, null)).toBe(false);
    expect(handoffNamedLaneOutOfPlay(db, team.id, '{}')).toBe(false);
    expect(handoffNamedLaneOutOfPlay(db, team.id, metaFor('no-such-lane'))).toBe(false);
    expect(handoffNamedLaneOutOfPlay(db, team.id, metaFor(lane.id))).toBe(false);
  });

  it('is true once the named lane is awaiting acceptance or terminal', () => {
    const { db, team } = seed();
    const lane = openLane(db, team.id, team.slug, 'nick', { title: 'handed', claim: true });
    const meta = metaFor(lane.id);
    updateLane(db, team.id, lane.id, team.slug, { state: 'awaiting_acceptance' });
    expect(handoffNamedLaneOutOfPlay(db, team.id, meta)).toBe(true);
    updateLane(db, team.id, lane.id, team.slug, { state: 'done' });
    expect(handoffNamedLaneOutOfPlay(db, team.id, meta)).toBe(true);
    updateLane(db, team.id, lane.id, team.slug, { state: 'abandoned' });
    expect(handoffNamedLaneOutOfPlay(db, team.id, meta)).toBe(true);
  });
});

/**
 * ADR 231 (#662, 2026-08-04) made a handoff act name its lane in meta, and every handoff since
 * carries one. The 24 that predate it never will — and because a bare handoff is always "in play",
 * the newest one wins the `why` slot permanently and no future event can retire it. Measured on the
 * live db 2026-08-12: 34 handoffs, 24 bare, 7 of those naming a lane in their BODY, and the oldest
 * still being served as a live instruction 16 days after its lane shipped.
 *
 * A lane id in prose is not prose: it either resolves to a lane row or it does not. Ids are rendered
 * TRUNCATED (`01KYJ8B5AB` for `01KYJ8B5AB9MNZY8T35E2KKTTY`), so this is prefix resolution, and the
 * discipline that makes it a recorded fact rather than a guess is unique resolution — an ambiguous
 * prefix proves nothing and abstains.
 */
describe('a bare handoff whose BODY names its lane (the pre-ADR-231 population)', () => {
  it('discharges when every lane the body names has left play', () => {
    const { db, team } = seed();
    const lane = openLane(db, team.id, team.slug, 'nick', { title: 'recall arm', claim: true });
    const body = `Lane ${lane.id.slice(0, 10)} — ADR 163 recall arm, yours.`;
    expect(handoffNamedLaneOutOfPlay(db, team.id, null, body)).toBe(false);
    updateLane(db, team.id, lane.id, team.slug, { state: 'done' });
    expect(handoffNamedLaneOutOfPlay(db, team.id, null, body)).toBe(true);
  });

  // THE hazard, and the reason this is all-or-nothing. Real handoffs name more than one lane: the
  // one being handed off AND a lane it overlaps or supersedes. Discharging on "some named lane is
  // done" would silence a live handoff because it mentioned a finished one in passing — work
  // dropped on the floor, which this file's own comment calls the unrecoverable direction.
  it('keeps showing when ANY lane the body names is still in play', () => {
    const { db, team } = seed();
    const shipped = openLane(db, team.id, team.slug, 'nick', { title: 'shipped', claim: true });
    const live = openLane(db, team.id, team.slug, 'nick', { title: 'still going', claim: true });
    updateLane(db, team.id, shipped.id, team.slug, { state: 'done' });
    const body = `Lane ${shipped.id.slice(0, 10)} is yours. Note it overlaps ${live.id.slice(0, 10)}.`;
    expect(handoffNamedLaneOutOfPlay(db, team.id, null, body)).toBe(false);
  });

  it('abstains on an id-shaped token that resolves to no lane', () => {
    const { db, team } = seed();
    expect(handoffNamedLaneOutOfPlay(db, team.id, null, 'see 01ZZZZZZZZ for context')).toBe(false);
  });

  // An ambiguous prefix is not evidence. Two lanes sharing it means the body picked out neither.
  it('abstains when a prefix resolves to more than one lane', () => {
    const { db, team } = seed();
    const a = openLane(db, team.id, team.slug, 'nick', { title: 'a', claim: true });
    const b = openLane(db, team.id, team.slug, 'nick', { title: 'b', claim: true });
    updateLane(db, team.id, a.id, team.slug, { state: 'done' });
    updateLane(db, team.id, b.id, team.slug, { state: 'done' });
    // ULIDs are time-ordered, so two lanes opened in the same millisecond band share a long prefix.
    const shared = a.id.slice(0, 6);
    if (b.id.startsWith(shared)) {
      expect(handoffNamedLaneOutOfPlay(db, team.id, null, `lane ${shared}`)).toBe(false);
    }
  });

  // Structured meta is the authority when present: it says which lane the handoff IS about, where
  // the body only says which lanes it mentions.
  it('lets structured meta win over the body', () => {
    const { db, team } = seed();
    const named = openLane(db, team.id, team.slug, 'nick', { title: 'named', claim: true });
    const mentioned = openLane(db, team.id, team.slug, 'nick', { title: 'mentioned', claim: true });
    updateLane(db, team.id, mentioned.id, team.slug, { state: 'done' });
    const meta = JSON.stringify({ lane_handoff: { lane: named.id } });
    const body = `see also ${mentioned.id.slice(0, 10)}`;
    expect(handoffNamedLaneOutOfPlay(db, team.id, meta, body)).toBe(false);
  });

  it('is unchanged when no body is passed at all', () => {
    const { db, team } = seed();
    expect(handoffNamedLaneOutOfPlay(db, team.id, null)).toBe(false);
  });
});

describe('the eligible set (ADR 254): obligation narrows, and any one answer discharges', () => {
  /** seed() gives nick/Ada/bob; a fourth seat is what distinguishes "the named few" from "everyone". */
  function seed4() {
    const s = seed();
    const cy = addMember(s.db, s.team, { name: 'cy', kind: 'agent' }).row;
    return { ...s, cy };
  }

  it('is owed by the named seats, not the roster', () => {
    const { db, team, nick } = seed4();
    msg(db, team, nick, null, 'message', 'e1', 1_000, { meta: { eligible: ['Ada', 'bob'] } });
    const d = actDelivery(db, team.id, 'e1', 10_000)!;
    expect(d.recipients.map((r) => r.seat).sort()).toEqual(['Ada', 'bob']);
  });

  it('regression: a plain team act is still owed by the whole roster', () => {
    const { db, team, nick } = seed4();
    msg(db, team, nick, null, 'message', 't1', 1_000);
    const d = actDelivery(db, team.id, 't1', 10_000)!;
    expect(d.recipients.map((r) => r.seat).sort()).toEqual(['Ada', 'bob', 'cy']);
  });

  // The load-bearing one. `answerBy` is scoped per recipient (`from_member = recipientId`), so
  // without an any-of clause bob's answer leaves Ada owing forever — the primitive's whole promise
  // ("either of you") would be false at the ledger.
  it('one seat answering discharges it for every eligible seat', () => {
    const { db, team, nick, bob } = seed4();
    msg(db, team, nick, null, 'message', 'e2', 1_000, { meta: { eligible: ['Ada', 'bob'] } });
    msg(db, team, bob, nick, 'accept', 'a1', 2_000, { meta: { in_reply_to: 'e2' } });

    const d = actDelivery(db, team.id, 'e2', 10_000)!;
    expect(d.recipients.map((r) => r.state)).toEqual(['answered', 'answered']);
    expect(d.recipients.every((r) => r.answered?.id === 'a1')).toBe(true);
  });

  it('regression: on a plain team act, one seat answering does NOT answer for the others', () => {
    const { db, team, nick, bob } = seed4();
    msg(db, team, nick, null, 'request_help', 't2', 1_000);
    msg(db, team, bob, nick, 'accept', 'a2', 2_000, { meta: { in_reply_to: 't2' } });

    const d = actDelivery(db, team.id, 't2', 10_000)!;
    const byName = Object.fromEntries(d.recipients.map((r) => [r.seat, r.state]));
    expect(byName['bob']).toBe('answered');
    expect(byName['Ada']).not.toBe('answered');
  });

  it('names a seat that has since left — the set is pinned in the envelope', () => {
    const { db, team, nick } = seed4();
    msg(db, team, nick, null, 'message', 'e3', 1_000, { meta: { eligible: ['Ada', 'bob'] } });
    db.prepare("UPDATE members SET left_at = 5000 WHERE name = 'bob'").run();
    const d = actDelivery(db, team.id, 'e3', 10_000)!;
    expect(d.recipients.map((r) => r.seat).sort()).toEqual(['Ada', 'bob']);
  });
});
