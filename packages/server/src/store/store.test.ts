import { describe, expect, it } from 'vitest';
import { makeEnvelope } from '@musterd/protocol';
import { openDb } from '../db/open.js';
import { MusterdError } from '../errors.js';
import { getCursor, setCursor } from './cursors.js';
import { addMember, authMember, hashToken } from './members.js';
import { insertMessage, listInbox } from './messages.js';
import {
  attach,
  clearMemberPresence,
  hasActivePresence,
  hasLivePresence,
  listPresence,
  presenceById,
  reapStale,
  release,
} from './presence.js';
import { createTeam } from './teams.js';

function freshTeam() {
  const db = openDb(':memory:');
  const team = createTeam(db, { slug: 'dawn' });
  return { db, team };
}

describe('teams + members', () => {
  it('rejects a duplicate slug with conflict', () => {
    const { db } = freshTeam();
    expect(() => createTeam(db, { slug: 'dawn' })).toThrow(MusterdError);
    try {
      createTeam(db, { slug: 'dawn' });
    } catch (e) {
      expect((e as MusterdError).code).toBe('conflict');
    }
  });

  it('issues a token whose sha256 matches the stored hash; plaintext not stored', () => {
    const { db, team } = freshTeam();
    const { row, token } = addMember(db, team, { name: 'Ada', kind: 'agent' });
    expect(row.token_hash).toBe(hashToken(token));
    const stored = db.prepare<[string], { token_hash: string }>('SELECT token_hash FROM members WHERE id = ?').get(row.id);
    expect(stored?.token_hash).not.toContain(token);
  });

  it('authMember resolves the right member and rejects bad tokens', () => {
    const { db, team } = freshTeam();
    const { token } = addMember(db, team, { name: 'Ada', kind: 'agent' });
    const ok = authMember(db, 'dawn', token);
    expect(ok.member.name).toBe('Ada');
    expect(() => authMember(db, 'dawn', 'mskd_wrong')).toThrow(MusterdError);
  });

  it('rejects a duplicate member name with conflict', () => {
    const { db, team } = freshTeam();
    addMember(db, team, { name: 'Ada', kind: 'agent' });
    expect(() => addMember(db, team, { name: 'Ada', kind: 'agent' })).toThrow(/already exists/);
  });
});

describe('messages + inbox', () => {
  it('delivers a direct message to the recipient inbox, excluding the sender', () => {
    const { db, team } = freshTeam();
    const ada = addMember(db, team, { name: 'Ada', kind: 'agent' });
    const lin = addMember(db, team, { name: 'Lin', kind: 'agent' });
    const env = makeEnvelope({ id: 'm1', team: 'dawn', from: 'Ada', to: { kind: 'member', name: 'Lin' }, act: 'handoff', body: 'x', ts: 100 });
    insertMessage(db, team.id, ada.row.id, lin.row.id, env);

    const linInbox = listInbox(db, lin.row);
    expect(linInbox.map((m) => m.id)).toEqual(['m1']);
    const adaInbox = listInbox(db, ada.row);
    expect(adaInbox).toEqual([]); // sender doesn't see own message
  });

  it('counts unread relative to a cursor and clears on advance', () => {
    const { db, team } = freshTeam();
    const ada = addMember(db, team, { name: 'Ada', kind: 'agent' });
    const lin = addMember(db, team, { name: 'Lin', kind: 'agent' });
    const env = makeEnvelope({ id: 'm1', team: 'dawn', from: 'Ada', to: { kind: 'member', name: 'Lin' }, act: 'message', body: 'hi', ts: 100 });
    insertMessage(db, team.id, ada.row.id, lin.row.id, env);

    let cur = getCursor(db, lin.row.id);
    expect(listInbox(db, lin.row, { unreadOnly: true, cursorTs: cur.last_read_ts })).toHaveLength(1);
    setCursor(db, lin.row.id, 'm1', 100);
    cur = getCursor(db, lin.row.id);
    expect(listInbox(db, lin.row, { unreadOnly: true, cursorTs: cur.last_read_ts })).toHaveLength(0);
  });

  it('delivers team messages to all members except the sender', () => {
    const { db, team } = freshTeam();
    const ada = addMember(db, team, { name: 'Ada', kind: 'agent' });
    const lin = addMember(db, team, { name: 'Lin', kind: 'agent' });
    const nick = addMember(db, team, { name: 'nick', kind: 'human' });
    const env = makeEnvelope({ id: 'm1', team: 'dawn', from: 'Ada', to: { kind: 'team' }, act: 'status_update', body: 'go', ts: 100 });
    insertMessage(db, team.id, ada.row.id, null, env);
    expect(listInbox(db, lin.row)).toHaveLength(1);
    expect(listInbox(db, nick.row)).toHaveLength(1);
    expect(listInbox(db, ada.row)).toHaveLength(0);
  });
});

describe('presence', () => {
  it('reports online while fresh and offline after reap', () => {
    const { db, team } = freshTeam();
    const ada = addMember(db, team, { name: 'Ada', kind: 'agent' });
    attach(db, ada.row.id, 'claude-code', 'c1');
    expect(hasLivePresence(db, ada.row.id, 45_000)).toBe(true);
    expect(listPresence(db, team.id, 45_000).find((p) => p.member.name === 'Ada')?.status).toBe('online');
    // reap with a 0ms timeout removes everything
    const removed = reapStale(db, 0);
    expect(removed.length).toBe(1);
    expect(hasLivePresence(db, ada.row.id, 45_000)).toBe(false);
  });

  it('single-active: a live attachment is active; releasing frees the slot but keeps a reclaim hold', () => {
    const { db, team } = freshTeam();
    const ada = addMember(db, team, { name: 'Ada', kind: 'agent' });
    const p = attach(db, ada.row.id, 'claude-code', 'c1');
    expect(hasActivePresence(db, ada.row.id)).toBe(true);

    release(db, p.id, 45_000);
    // the active slot is free (a reclaim is allowed) but the hold row still exists...
    expect(hasActivePresence(db, ada.row.id)).toBe(false);
    expect(presenceById(db, p.id)).toBeDefined();
    // ...and is excluded from the live roster, so the member reads offline immediately.
    expect(hasLivePresence(db, ada.row.id, 45_000)).toBe(false);
    expect(listPresence(db, team.id, 45_000).find((s) => s.member.name === 'Ada')?.status).toBe('offline');
  });

  it('a reclaim hold survives the grace window, then the reaper frees it', () => {
    const { db, team } = freshTeam();
    const ada = addMember(db, team, { name: 'Ada', kind: 'agent' });
    const p = attach(db, ada.row.id, 'claude-code', 'c1');

    release(db, p.id, 45_000);
    // within grace: a normal reap leaves the hold in place
    expect(reapStale(db, 45_000)).toHaveLength(0);
    expect(presenceById(db, p.id)).toBeDefined();

    // past grace (held_until in the past): the reaper sweeps it
    release(db, p.id, -1);
    expect(reapStale(db, 45_000)).toHaveLength(1);
    expect(presenceById(db, p.id)).toBeUndefined();
  });

  it('a fresh hello reclaims by clearing any prior holds for the member', () => {
    const { db, team } = freshTeam();
    const ada = addMember(db, team, { name: 'Ada', kind: 'agent' });
    const first = attach(db, ada.row.id, 'claude-code', 'c1');
    release(db, first.id, 45_000);

    clearMemberPresence(db, ada.row.id);
    const second = attach(db, ada.row.id, 'cli', 'c2');
    const rows = listPresence(db, team.id, 45_000).find((s) => s.member.name === 'Ada');
    expect(rows?.presences).toHaveLength(1);
    expect(rows?.presences[0]?.surface).toBe('cli');
    expect(presenceById(db, second.id)).toBeDefined();
    expect(presenceById(db, first.id)).toBeUndefined();
  });
});
