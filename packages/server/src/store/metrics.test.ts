import { makeEnvelope } from '@musterd/protocol';
import { describe, expect, it } from 'vitest';
import { openDb } from '../db/open.js';
import { setCursor } from './cursors.js';
import { addMember } from './members.js';
import { countOpenLoops, getMessageTs, insertMessage } from './messages.js';
import { activePresenceBySurface, slowestInboxLagMs } from './metrics.js';
import { attach } from './presence.js';
import { createTeam } from './teams.js';

const TIMEOUT = 45_000;

function seed() {
  const db = openDb(':memory:');
  const team = createTeam(db, { slug: 'dawn' });
  const nick = addMember(db, team, { name: 'nick', kind: 'human' }).row;
  const ada = addMember(db, team, { name: 'Ada', kind: 'agent' }).row;
  return { db, team, nick, ada };
}

describe('activePresenceBySurface', () => {
  it('counts live presences grouped by surface, ignoring stale + held rows', () => {
    const { db, nick, ada } = seed();
    attach(db, nick.id, 'cli', 'c1');
    attach(db, ada.id, 'claude-code', 'c2');
    // A held (released) presence and a stale one must not count.
    const held = attach(db, ada.id, 'cursor', 'c3');
    db.prepare('UPDATE presence SET held_until = ? WHERE id = ?').run(Date.now() + 10_000, held.id);
    const stale = attach(db, nick.id, 'web', 'c4');
    db.prepare('UPDATE presence SET last_seen_at = ? WHERE id = ?').run(
      Date.now() - TIMEOUT - 1,
      stale.id,
    );

    const rows = activePresenceBySurface(db, TIMEOUT);
    const bySurface = Object.fromEntries(rows.map((r) => [r.surface, r.count]));
    expect(bySurface).toEqual({ cli: 1, 'claude-code': 1 });
  });
});

describe('slowestInboxLagMs', () => {
  it('is 0 when nobody has unread messages', () => {
    const { db } = seed();
    expect(slowestInboxLagMs(db)).toBe(0);
  });

  it('returns the age of the oldest unread message addressed to a member', () => {
    const { db, team, nick, ada } = seed();
    const now = 1_000_000;
    // nick sends a team message at t=now-30s → unread for Ada (and not for nick, the sender).
    insertMessage(
      db,
      team.id,
      nick.id,
      null,
      makeEnvelope({
        id: 'm1',
        team: 'dawn',
        from: 'nick',
        to: { kind: 'team' },
        act: 'request_help',
        body: 'help',
        ts: now - 30_000,
      }),
    );
    expect(slowestInboxLagMs(db, now)).toBe(30_000);

    // After Ada advances her cursor past it, the inbox is caught up → lag 0.
    setCursor(db, ada.id, 'm1', now - 30_000);
    expect(slowestInboxLagMs(db, now)).toBe(0);
  });
});

describe('countOpenLoops / getMessageTs (ADR 082 slice 3)', () => {
  it('counts directed acts without an answering accept/decline; getMessageTs resolves ts', () => {
    const { db, team, nick, ada } = seed();
    const send = (
      id: string,
      from: string,
      fromId: string,
      act: 'request_help' | 'handoff' | 'accept' | 'status_update',
      meta?: Record<string, unknown>,
    ) =>
      insertMessage(
        db,
        team.id,
        fromId,
        null,
        makeEnvelope({
          id,
          team: 'dawn',
          from,
          to: { kind: 'team' },
          act,
          body: 'x',
          meta: meta ?? null,
          ts: 500,
        }),
      );

    send('r1', 'nick', nick.id, 'request_help');
    send('h1', 'nick', nick.id, 'handoff');
    send('s1', 'Ada', ada.id, 'status_update'); // not a loop
    expect(countOpenLoops(db)).toBe(2);

    // Ada accepts the request → one loop closes; the handoff stays open.
    send('a1', 'Ada', ada.id, 'accept', { in_reply_to: 'r1' });
    expect(countOpenLoops(db)).toBe(1);

    expect(getMessageTs(db, team.id, 'r1')).toBe(500);
    expect(getMessageTs(db, team.id, 'nope')).toBeNull();
  });
});
