import { isObligationAct, makeEnvelope, type Act } from '@musterd/protocol';
import { describe, expect, it } from 'vitest';
import { openDb } from '../db/open.js';
import { addMember } from './members.js';
import { insertMessage, listInbox, PINNED_DEFAULT_LIMIT } from './messages.js';
import { createTeam } from './teams.js';

/**
 * ADR 429 — the pinned set is the OBLIGATION class, bounded, and folded for discharge in SQL.
 *
 * A bounded page unions a pinned set on top of the newest tail so an act that is WAITING on the
 * reader cannot fall off the bottom. Before this ADR the pin predicate was `to_kind = 'member' AND
 * act NOT IN ('message','resolve')` with no LIMIT, which is a salience test doing a retention job:
 * it pinned every unread `accept`, `decline` and directed `status_update` forever, and `limit` did
 * not bound the reply at all. Measured on the laptop daemon 2026-09-21 — 370 pinned rows / 327 KB
 * for one seat at `limit: 8`, 183 of those rows answers and reports owed to nobody.
 *
 * Nothing in the suite covered any of it: this whole file is the hole that let it land.
 */

let seq = 0;
function seed() {
  const db = openDb(':memory:');
  const team = createTeam(db, { slug: 'revive' });
  const nick = addMember(db, team, { name: 'nick', kind: 'human' }).row;
  const ada = addMember(db, team, { name: 'Ada', kind: 'agent' }).row;
  const bo = addMember(db, team, { name: 'Bo', kind: 'agent' }).row;
  seq = 0;
  const send = (
    act: Act,
    opts: {
      to?: 'Ada' | 'team';
      from?: { id: string; name: string };
      meta?: Record<string, unknown>;
      id?: string;
      thread?: string;
    } = {},
  ) => {
    const from = opts.from ?? { id: nick.id, name: 'nick' };
    const id = opts.id ?? `m${String(seq).padStart(3, '0')}`;
    const toAda = (opts.to ?? 'Ada') === 'Ada';
    // The act-meta rules the envelope schema enforces (SPEC A.6). Only what each act REQUIRES —
    // a fixture that argued with the schema here would be testing the wrong thing.
    const required: Partial<Record<Act, Record<string, unknown>>> = {
      ask: { species: 'consult', tier: 'standard' },
      defer: { goal_id: 'g1' },
      insight: { headline: 'h' },
      accept: { in_reply_to: 'x' },
      decline: { in_reply_to: 'x' },
    };
    insertMessage(
      db,
      team.id,
      from.id,
      toAda ? ada.id : null,
      makeEnvelope({
        id,
        team: team.slug,
        from: from.name,
        to: toAda ? { kind: 'member', name: 'Ada' } : { kind: 'team' },
        act,
        body: 'x',
        thread: opts.thread ?? null,
        meta: { ...(required[act] ?? {}), ...(opts.meta ?? {}) },
        ts: 1_000 + seq,
      }),
      { now: 1_000 + seq },
    );
    seq += 1;
    return id;
  };
  return { db, team, ada, nick, bo, send };
}

/** The bounded read every agent surface makes: a named `limit`, unread only, from the origin. */
const bounded = (
  db: ReturnType<typeof seed>['db'],
  ada: { id: string; team_id: string },
  limit = 1,
) => listInbox(db, ada, { unreadOnly: true, cursorTs: 0, limit }).map((r) => r.id);

describe('ADR 429: pinning is an obligation rule', () => {
  it('pins an ask and a request_help past the limit — the retention rule still holds', () => {
    const { db, ada, send } = seed();
    const ask = send('ask');
    const help = send('request_help', { to: 'team' });
    for (let i = 0; i < 20; i++) send('message');
    const rows = bounded(db, ada);
    expect(rows).toContain(ask);
    expect(rows).toContain(help);
  });

  it('pins the directed steering trio and a handoff', () => {
    const { db, ada, send } = seed();
    const owed = (['handoff', 'steer', 'challenge', 'defer'] as const).map((a) => send(a));
    for (let i = 0; i < 20; i++) send('message');
    const rows = bounded(db, ada);
    for (const id of owed) expect(rows).toContain(id);
  });

  it('does NOT pin an answer or a report — accept/decline/status_update/wait/insight', () => {
    const { db, ada, send } = seed();
    // The exact acts that made up 183 of one seat's 370 pinned rows.
    const notOwed = (['accept', 'decline', 'status_update', 'wait', 'insight'] as const).map((a) =>
      send(a),
    );
    for (let i = 0; i < 20; i++) send('message');
    const rows = bounded(db, ada);
    for (const id of notOwed) expect(rows).not.toContain(id);
    // Still UNREAD, not lost: an unbounded read returns every one of them.
    const all = listInbox(db, ada, { unreadOnly: true, cursorTs: 0 }).map((r) => r.id);
    for (const id of notOwed) expect(all).toContain(id);
  });

  it('bounds the pinned set, so `limit` finally bounds the reply', () => {
    const { db, ada, send } = seed();
    for (let i = 0; i < PINNED_DEFAULT_LIMIT + 25; i++) send('ask');
    const rows = listInbox(db, ada, { unreadOnly: true, cursorTs: 0, limit: 1 });
    // The pinned union plus the newest-tail — never the whole unread pile.
    expect(rows.length).toBeLessThanOrEqual(PINNED_DEFAULT_LIMIT + 1);
    const explicit = listInbox(db, ada, {
      unreadOnly: true,
      cursorTs: 0,
      limit: 1,
      pinnedLimit: 5,
    });
    expect(explicit.length).toBeLessThanOrEqual(6);
  });

  it('keeps the OLDEST obligations when it bounds — the longest wait is the one not to drop', () => {
    const { db, ada, send } = seed();
    const ids = Array.from({ length: 10 }, () => send('ask'));
    const rows = listInbox(db, ada, {
      unreadOnly: true,
      cursorTs: 0,
      limit: 1,
      pinnedLimit: 3,
    }).map((r) => r.id);
    for (const id of ids.slice(0, 3)) expect(rows).toContain(id);
  });
});

describe('ADR 429: discharge is folded before marshalling', () => {
  it('drops an obligation any seat has accepted (ADR 254: first answer discharges the set)', () => {
    const { db, ada, bo, send } = seed();
    const ask = send('ask', { id: 'the-ask' });
    // Bo answers, not Ada — a second eligible seat is not a party to the reply and could never fold
    // this client-side, which is exactly why the server owes it.
    send('accept', { from: { id: bo.id, name: 'Bo' }, to: 'team', meta: { in_reply_to: ask } });
    for (let i = 0; i < 20; i++) send('message');
    expect(bounded(db, ada)).not.toContain(ask);
  });

  it('drops an obligation this member has already replied to, whatever act the reply rode', () => {
    const { db, ada, send } = seed();
    const steer = send('steer', { id: 'the-steer' });
    // Clause 7(iv): a steer has no accept/decline — the addressee's reply IS the answer.
    send('status_update', {
      from: { id: ada.id, name: 'Ada' },
      to: 'team',
      meta: { in_reply_to: steer },
    });
    for (let i = 0; i < 20; i++) send('message');
    expect(bounded(db, ada)).not.toContain(steer);
  });

  it('keeps an obligation a THIRD party merely commented on', () => {
    const { db, ada, bo, send } = seed();
    const ask = send('ask', { id: 'still-owed' });
    // A `message` is not an answer, whoever sent it.
    send('message', { from: { id: bo.id, name: 'Bo' }, to: 'team', meta: { in_reply_to: ask } });
    for (let i = 0; i < 20; i++) send('message');
    expect(bounded(db, ada)).toContain(ask);
  });

  it('does not match a row against itself — the correlated subquery names the outer table', () => {
    const { db, ada, send } = seed();
    // An `accept` whose own id is somehow its in_reply_to would self-discharge under an unqualified
    // `id` inside the EXISTS. The obligation here has no reply at all and must survive.
    const ask = send('ask', { id: 'lonely' });
    for (let i = 0; i < 20; i++) send('message');
    expect(bounded(db, ada)).toContain(ask);
  });
});

describe('isObligationAct — the one list both readers are built from', () => {
  it('admits the any-recipient obligations whatever they are addressed to', () => {
    for (const act of ['request_help', 'ask'] as const) {
      expect(isObligationAct(act, true)).toBe(true);
      expect(isObligationAct(act, false)).toBe(true);
    }
  });

  it('admits the directed obligations only when directed', () => {
    for (const act of ['handoff', 'steer', 'challenge', 'defer'] as const) {
      expect(isObligationAct(act, true)).toBe(true);
      expect(isObligationAct(act, false)).toBe(false);
    }
  });

  it('refuses every answer, report and terminal act', () => {
    for (const act of [
      'accept',
      'decline',
      'wait',
      'resolve',
      'status_update',
      'message',
      'insight',
    ] as const) {
      expect(isObligationAct(act, true)).toBe(false);
      expect(isObligationAct(act, false)).toBe(false);
    }
  });
});

describe('ADR 432: a resolve on the thread discharges the obligation', () => {
  it('drops an obligation whose thread carries a resolve — the gap ADR 429 shipped with', () => {
    // `countOpenLoops` has honoured thread-resolve since ADR 090 and the CLI's `openActionNeeded`
    // always has; ADR 429's pinned fold did not. So a resolved obligation was excluded from the
    // open-loops gauge and from the human's banner while STILL being pinned into every bounded
    // agent read — three readers, two agreeing and the newest one not.
    const { db, ada, send } = seed();
    const help = send('request_help', { to: 'team', id: 'the-help' });
    send('resolve', { to: 'team', thread: 'the-help' });
    for (let i = 0; i < 20; i++) send('message');
    expect(bounded(db, ada)).not.toContain(help);
  });

  it('is how a SERVICE seat discharges its own raise — guardian cannot accept (ADR 232)', () => {
    // The shape ADR 432 relies on: guardian raises an `ask`, the condition clears, and guardian
    // closes the thread itself. Nothing accepts, because nothing may.
    const { db, ada, bo, send } = seed();
    const incident = send('ask', {
      to: 'team',
      id: 'daemon-down',
      from: { id: bo.id, name: 'Bo' },
    });
    for (let i = 0; i < 20; i++) send('message');
    expect(bounded(db, ada)).toContain(incident);

    const { db: db2, ada: ada2, bo: bo2, send: send2 } = seed();
    const inc2 = send2('ask', { to: 'team', id: 'daemon-down', from: { id: bo2.id, name: 'Bo' } });
    send2('resolve', { to: 'team', thread: 'daemon-down', from: { id: bo2.id, name: 'Bo' } });
    for (let i = 0; i < 20; i++) send2('message');
    expect(bounded(db2, ada2)).not.toContain(inc2);
  });

  it('keeps an obligation whose thread carries a resolve for a DIFFERENT thread', () => {
    const { db, ada, send } = seed();
    const help = send('request_help', { to: 'team', id: 'still-open' });
    send('request_help', { to: 'team', id: 'other' });
    send('resolve', { to: 'team', thread: 'other' });
    for (let i = 0; i < 20; i++) send('message');
    expect(bounded(db, ada)).toContain(help);
  });
});
