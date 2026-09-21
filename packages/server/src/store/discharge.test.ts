import { makeEnvelope, type Act } from '@musterd/protocol';
import type { Database } from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { openDb } from '../db/open.js';
import { actDelivery, openDirectedLedger } from './delivery.js';
import { addMember } from './members.js';
import { countOpenLoops, insertMessage, listInbox } from './messages.js';
import type { MemberRow, TeamRow } from './rows.js';
import { createTeam } from './teams.js';

/**
 * ADR 434 — one discharge predicate, four readers, and the two shapes they did not all know.
 *
 * ryder answered a threaded steer IN THE THREAD (no `in_reply_to`) and was woken for it again
 * sixteen minutes later; gptbot answered an urgent steer by `message` with `in_reply_to`, twice,
 * and was leased for it three times and then declared exhausted. Each reader below spelled its
 * own discharge; these cases pin that they now agree, on both shapes, and that a third party's
 * chatter still discharges nothing.
 */
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
    { now: ts },
  );
}

const pinnedIds = (db: Database, m: MemberRow) =>
  listInbox(db, m, { unreadOnly: true, cursorTs: 0, limit: 1 }).map((r) => r.id);
const ledgerIds = (db: Database, team: TeamRow) =>
  openDirectedLedger(db, team.id, 100_000).map((d) => d.id);
const adaState = (db: Database, team: TeamRow, id: string) =>
  actDelivery(db, team.id, id, 100_000)!.recipients.find((r) => r.seat === 'Ada')!.state;

describe("ADR 434: the recipient's in-thread reply discharges — ryder's shape", () => {
  it('a threaded handoff answered by a plain message in its thread is discharged for every reader', () => {
    const { db, team, nick, ada } = seed();
    msg(db, team, nick, null, 'message', 'root', 1_000);
    msg(db, team, nick, ada, 'handoff', 'h1', 1_001, { thread: 'root' });
    for (let i = 0; i < 5; i++) msg(db, team, nick, null, 'message', `n${i}`, 2_000 + i);
    expect(pinnedIds(db, ada)).toContain('h1');
    expect(ledgerIds(db, team)).toContain('h1');
    expect(countOpenLoops(db)).toBe(1);
    expect(adaState(db, team, 'h1')).toBe('logged');

    msg(db, team, ada, null, 'message', 'reply', 3_000, { thread: 'root' });
    expect(pinnedIds(db, ada)).not.toContain('h1');
    expect(ledgerIds(db, team)).not.toContain('h1');
    expect(countOpenLoops(db)).toBe(0);
    expect(adaState(db, team, 'h1')).toBe('answered');
    expect(actDelivery(db, team.id, 'h1', 100_000)!.recipients[0]!.answered).toMatchObject({
      act: 'message',
      id: 'reply',
    });
  });

  it("a reply in the thread OLDER than the act is not an answer — ryder's earlier turn did not answer stanley's later steer", () => {
    const { db, team, nick, ada } = seed();
    msg(db, team, nick, null, 'message', 'root', 1_000);
    msg(db, team, ada, null, 'message', 'earlier', 1_500, { thread: 'root' });
    msg(db, team, nick, ada, 'handoff', 'h1', 2_000, { thread: 'root' });
    expect(ledgerIds(db, team)).toContain('h1');
    expect(adaState(db, team, 'h1')).toBe('logged');
  });

  it('an act that opens its own thread is answered by a reply threaded on its id', () => {
    const { db, team, nick, ada } = seed();
    msg(db, team, nick, ada, 'handoff', 'h1', 1_000);
    msg(db, team, ada, null, 'status_update', 'r', 2_000, { thread: 'h1' });
    expect(ledgerIds(db, team)).not.toContain('h1');
    expect(adaState(db, team, 'h1')).toBe('answered');
  });
});

describe("ADR 434: the recipient's in_reply_to on ANY act discharges — gptbot's shape", () => {
  it('an urgent directed act answered by a `message` carrying in_reply_to leaves the ledger', () => {
    const { db, team, nick, ada } = seed();
    msg(db, team, nick, ada, 'steer', 's1', 1_000, { meta: { urgent: true, urgent_reason: 'r' } });
    expect(ledgerIds(db, team)).toContain('s1');
    msg(db, team, ada, nick, 'message', 'standing-down', 2_000, { meta: { in_reply_to: 's1' } });
    expect(ledgerIds(db, team)).not.toContain('s1');
    expect(adaState(db, team, 's1')).toBe('answered');
  });
});

describe('ADR 434: what still does NOT discharge', () => {
  it("a third party's message in the thread or naming the act is chatter, not an answer", () => {
    const { db, team, nick, ada, bob } = seed();
    msg(db, team, nick, ada, 'handoff', 'h1', 1_000, { thread: 't' });
    msg(db, team, bob, null, 'message', 'c1', 2_000, { thread: 't' });
    msg(db, team, bob, nick, 'message', 'c2', 3_000, { meta: { in_reply_to: 'h1' } });
    expect(pinnedIds(db, ada)).toContain('h1');
    expect(ledgerIds(db, team)).toContain('h1');
    expect(countOpenLoops(db)).toBe(1);
    expect(adaState(db, team, 'h1')).toBe('logged');
  });

  it('a @team request_help is not discharged by one seat talking in its thread — ADR 254 needs an answer', () => {
    const { db, team, nick, ada } = seed();
    msg(db, team, nick, null, 'request_help', 'r1', 1_000, { thread: 't' });
    msg(db, team, ada, null, 'message', 'c1', 2_000, { thread: 't' });
    expect(ledgerIds(db, team)).toContain('r1');
    expect(countOpenLoops(db)).toBe(1);
    msg(db, team, ada, nick, 'accept', 'a1', 3_000, { meta: { in_reply_to: 'r1' } });
    expect(ledgerIds(db, team)).not.toContain('r1');
    expect(countOpenLoops(db)).toBe(0);
  });
});
