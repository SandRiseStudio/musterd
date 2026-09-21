import { makeEnvelope, WAKE_CONTEXT_BUDGET, type Act } from '@musterd/protocol';
import type { Database } from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { openDb } from '../db/open.js';
import { openLane } from './lanes.js';
import { addMember } from './members.js';
import { saveMemory } from './memory.js';
import { insertMessage } from './messages.js';
import type { MemberRow, TeamRow } from './rows.js';
import { createTeam } from './teams.js';
import { deriveContext, truncateBytes, truncateChars } from './wakeContextBody.js';

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
  opts: { thread?: string; body?: string; meta?: Record<string, unknown> } = {},
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
      body: opts.body ?? 'x',
      thread: opts.thread ?? null,
      meta: opts.meta ?? null,
      ts,
    }),
  );
}

describe('truncation helpers (ADR 430)', () => {
  it('cuts at the limit and flags it, and leaves short text alone', () => {
    expect(truncateChars('abcdef', 4)).toEqual({ text: 'abcd', truncated: true });
    expect(truncateChars('abc', 4)).toEqual({ text: 'abc', truncated: false });
    // bytes: a multi-byte character is never split
    expect(truncateBytes('aé€', 4)).toEqual({ text: 'aé', truncated: true });
    expect(truncateBytes('aé€', 6)).toEqual({ text: 'aé€', truncated: false });
  });
});

describe('deriveContext (ADR 430)', () => {
  it("carries the waking thread oldest→newest, attributed, including the recipient's own acts", () => {
    const { db, team, nick, ada } = seed();
    msg(db, team, nick, ada, 'message', 'm1', 1_000, { body: 'first' });
    msg(db, team, ada, nick, 'message', 'm2', 1_001, { thread: 'm1', body: 'my reply' });
    msg(db, team, nick, ada, 'steer', 'm3', 1_002, { thread: 'm1', body: 'do the thing' });
    const { context, fetch } = deriveContext(db, team, ada, { threadId: 'm1' });
    expect(context.thread?.acts.map((a) => [a.from, a.act, a.body])).toEqual([
      ['nick', 'message', 'first'],
      ['Ada', 'message', 'my reply'],
      ['nick', 'steer', 'do the thing'],
    ]);
    expect(context.thread?.omitted).toBe(0);
    expect(fetch).not.toContain('inbox_thread');
  });

  it('keeps the last 8 acts and counts the rest as omitted', () => {
    const { db, team, nick, ada } = seed();
    msg(db, team, nick, ada, 'message', 't0', 1_000);
    for (let i = 1; i <= 11; i++)
      msg(db, team, nick, ada, 'message', `t${i}`, 1_000 + i, { thread: 't0', body: `n${i}` });
    const { context, fetch } = deriveContext(db, team, ada, { threadId: 't0' });
    expect(context.thread?.acts).toHaveLength(WAKE_CONTEXT_BUDGET.thread_acts);
    expect(context.thread?.acts[0]?.id).toBe('t4');
    expect(context.thread?.omitted).toBe(4);
    expect(fetch).toContain('inbox_thread');
  });

  it('cuts a long body at 600 chars and flags it', () => {
    const { db, team, nick, ada } = seed();
    msg(db, team, nick, ada, 'message', 'l1', 1_000, { body: 'y'.repeat(1_000) });
    const { context } = deriveContext(db, team, ada, { threadId: 'l1' });
    expect(context.thread?.acts[0]).toMatchObject({ truncated: true });
    expect(context.thread?.acts[0]?.body).toHaveLength(WAKE_CONTEXT_BUDGET.act_body_chars);
  });

  it('lists open directed asks and owned lanes, titles only, oldest first', () => {
    const { db, team, nick, ada, bob } = seed();
    msg(db, team, bob, ada, 'ask', 'q1', 500, {
      body: 'can you review #12?\nsecond line never shows',
      meta: { species: 'consult', tier: 'advisory' },
    });
    msg(db, team, nick, ada, 'request_help', 'r1', 600, { body: 'help with the plist' });
    msg(db, team, nick, ada, 'ask', 'q2', 700, {
      body: 'answered one',
      meta: { species: 'consult', tier: 'advisory' },
    });
    msg(db, team, ada, nick, 'accept', 'a2', 701, { thread: 'q2', meta: { in_reply_to: 'q2' } }); // q2 is answered
    const lane = openLane(db, team.id, team.slug, ada.name, { title: 'My lane', claim: true });
    const { context } = deriveContext(db, team, ada, {});
    expect(context.open.map((o) => [o.kind, o.id, o.from])).toEqual([
      ['ask', 'q1', 'bob'],
      ['request_help', 'r1', 'nick'],
      ['lane', lane.id, undefined],
    ]);
    expect(context.open[0]?.title).toBe('can you review #12?');
    for (const o of context.open) expect(o.title.length).toBeLessThanOrEqual(120);
  });

  it('classifies a review ask and a handoff by their meta', () => {
    const { db, team, nick, ada } = seed();
    const lane = openLane(db, team.id, team.slug, nick.name, { title: 'Theirs' });
    msg(db, team, nick, ada, 'ask', 'rv', 500, {
      meta: { species: 'approve', tier: 'standard', lane_review: { lane: lane.id } },
    });
    msg(db, team, nick, ada, 'handoff', 'ho', 600, { meta: { lane_handoff: { lane: lane.id } } });
    const { context } = deriveContext(db, team, ada, {});
    expect(context.open.map((o) => o.kind)).toEqual(['review', 'handoff']);
  });

  it("carries the lane detail and the recipient's own last status_update naming it", () => {
    const { db, team, ada } = seed();
    const lane = openLane(db, team.id, team.slug, ada.name, {
      title: 'Lane',
      detail: 'ACCEPTANCE: x',
      claim: true,
    });
    msg(db, team, ada, null, 'status_update', 's1', 900, { body: `on ${lane.id}: halfway` });
    msg(db, team, ada, null, 'status_update', 's2', 950, { body: 'unrelated' });
    const { context } = deriveContext(db, team, ada, { laneId: lane.id });
    expect(context.lane).toEqual({
      detail: 'ACCEPTANCE: x',
      truncated: false,
      last_status_update: { ts: 900, body: `on ${lane.id}: halfway`, truncated: false },
    });
  });

  it('carries the memory body whole when it fits, else the first 3 KiB flagged and named in fetch', () => {
    const { db, team, ada } = seed();
    saveMemory(db, ada.id, { headline: 'short', body: 'carrying nothing' });
    expect(deriveContext(db, team, ada, {}).context.memory).toEqual({
      body: 'carrying nothing',
      truncated: false,
    });
    saveMemory(db, ada.id, { headline: 'long', body: 'z'.repeat(5_000) });
    const { context, fetch } = deriveContext(db, team, ada, {});
    expect(context.memory?.truncated).toBe(true);
    expect(Buffer.byteLength(context.memory!.body, 'utf8')).toBeLessThanOrEqual(
      WAKE_CONTEXT_BUDGET.memory,
    );
    expect(fetch).toContain('seat_memory');
  });

  it('never exceeds the 12 KiB cap and names what it dropped', () => {
    const { db, team, nick, ada, bob } = seed();
    saveMemory(db, ada.id, { headline: 'h', body: 'm'.repeat(3_000) });
    msg(db, team, nick, ada, 'message', 'b0', 1_000, { body: 'b'.repeat(600) });
    for (let i = 1; i <= 8; i++)
      msg(db, team, nick, ada, 'message', `b${i}`, 1_000 + i, {
        thread: 'b0',
        body: 'b'.repeat(600),
      });
    for (let i = 0; i < 40; i++)
      msg(db, team, bob, ada, 'ask', `o${i}`, 2_000 + i, {
        body: 'o'.repeat(120),
        meta: { species: 'consult', tier: 'advisory' },
      });
    const { context, used_bytes, fetch } = deriveContext(db, team, ada, { threadId: 'b0' });
    expect(used_bytes).toBeLessThanOrEqual(WAKE_CONTEXT_BUDGET.limit_bytes);
    expect(Buffer.byteLength(JSON.stringify(context), 'utf8')).toBe(used_bytes);
    expect(context.thread?.acts.length).toBeGreaterThan(0);
    expect(context.open.length).toBeLessThanOrEqual(WAKE_CONTEXT_BUDGET.open_items);
    expect(fetch).toContain('open_items');
  });
});
