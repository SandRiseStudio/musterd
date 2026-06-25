import { makeEnvelope } from '@musterd/protocol';
import { describe, expect, it } from 'vitest';
import { openDb } from '../db/open.js';
import { MusterdError } from '../errors.js';
import { resolveActivity } from './activity.js';
import { getCursor, setCursor } from './cursors.js';
import {
  addMember,
  authMember,
  getMemberByName,
  hashToken,
  leaveMember,
  listMembers,
} from './members.js';
import { insertMessage, latestStatusUpdate, listInbox } from './messages.js';
import {
  attach,
  clearMemberPresence,
  countLivePresences,
  hasActivePresence,
  hasLivePresence,
  listPresence,
  presenceById,
  reapStale,
  release,
  touchAmbientPresence,
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
    const stored = db
      .prepare<[string], { token_hash: string }>('SELECT token_hash FROM members WHERE id = ?')
      .get(row.id);
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

  it('leaveMember soft-removes from the roster but keeps the row (ADR 019)', () => {
    const { db, team } = freshTeam();
    const ada = addMember(db, team, { name: 'Ada', kind: 'agent' });
    expect(listMembers(db, team.id).map((m) => m.name)).toContain('Ada');

    leaveMember(db, ada.row.id);
    // Off the live roster ...
    expect(listMembers(db, team.id).map((m) => m.name)).not.toContain('Ada');
    // ... but the row survives (history/provenance), now stamped with left_at.
    const row = getMemberByName(db, team.id, 'Ada');
    expect(row).toBeDefined();
    expect(row?.left_at).not.toBeNull();
  });
});

describe('messages + inbox', () => {
  it('delivers a direct message to the recipient inbox, excluding the sender', () => {
    const { db, team } = freshTeam();
    const ada = addMember(db, team, { name: 'Ada', kind: 'agent' });
    const lin = addMember(db, team, { name: 'Lin', kind: 'agent' });
    const env = makeEnvelope({
      id: 'm1',
      team: 'dawn',
      from: 'Ada',
      to: { kind: 'member', name: 'Lin' },
      act: 'handoff',
      body: 'x',
      ts: 100,
    });
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
    const env = makeEnvelope({
      id: 'm1',
      team: 'dawn',
      from: 'Ada',
      to: { kind: 'member', name: 'Lin' },
      act: 'message',
      body: 'hi',
      ts: 100,
    });
    insertMessage(db, team.id, ada.row.id, lin.row.id, env);

    let cur = getCursor(db, lin.row.id);
    expect(listInbox(db, lin.row, { unreadOnly: true, cursorTs: cur.last_read_ts })).toHaveLength(
      1,
    );
    setCursor(db, lin.row.id, 'm1', 100);
    cur = getCursor(db, lin.row.id);
    expect(listInbox(db, lin.row, { unreadOnly: true, cursorTs: cur.last_read_ts })).toHaveLength(
      0,
    );
  });

  it('delivers team messages to all members except the sender', () => {
    const { db, team } = freshTeam();
    const ada = addMember(db, team, { name: 'Ada', kind: 'agent' });
    const lin = addMember(db, team, { name: 'Lin', kind: 'agent' });
    const nick = addMember(db, team, { name: 'nick', kind: 'human' });
    const env = makeEnvelope({
      id: 'm1',
      team: 'dawn',
      from: 'Ada',
      to: { kind: 'team' },
      act: 'status_update',
      body: 'go',
      ts: 100,
    });
    insertMessage(db, team.id, ada.row.id, null, env);
    expect(listInbox(db, lin.row)).toHaveLength(1);
    expect(listInbox(db, nick.row)).toHaveLength(1);
    expect(listInbox(db, ada.row)).toHaveLength(0);
  });

  it('persists a resolve act, closing a thread (ADR 025 — schema v5 widened the act CHECK)', () => {
    const { db, team } = freshTeam();
    const ada = addMember(db, team, { name: 'Ada', kind: 'agent' });
    const lin = addMember(db, team, { name: 'Lin', kind: 'agent' });
    // Lin asks; Ada closes the thread once done. `resolve` carries the thread id it closes.
    const ask = makeEnvelope({
      id: 'm1',
      team: 'dawn',
      from: 'Lin',
      to: { kind: 'team' },
      act: 'request_help',
      body: 'review auth?',
      ts: 100,
    });
    insertMessage(db, team.id, lin.row.id, null, ask);
    const done = makeEnvelope({
      id: 'm2',
      team: 'dawn',
      from: 'Ada',
      to: { kind: 'team' },
      act: 'resolve',
      thread: 'm1',
      body: 'merged',
      ts: 200,
    });
    expect(() => insertMessage(db, team.id, ada.row.id, null, done)).not.toThrow();
    const linInbox = listInbox(db, lin.row);
    expect(linInbox.map((m) => `${m.act}:${m.thread_id ?? ''}`)).toContain('resolve:m1');
  });
});

describe('activity (two-clocks)', () => {
  it('resolveActivity: offline when not live; online when live with no status; working with a status', () => {
    expect(resolveActivity(false, { state: 'x', ts: 1 })).toEqual({
      activity: 'offline',
      state: null,
      last_status_at: null,
    });
    expect(resolveActivity(true, null)).toEqual({
      activity: 'online',
      state: null,
      last_status_at: null,
    });
    expect(resolveActivity(true, { state: 'refactoring auth', ts: 100 })).toEqual({
      activity: 'working',
      state: 'refactoring auth',
      last_status_at: 100,
    });
  });

  it('latestStatusUpdate: takes the newest status_update, prefers meta.state, else body', () => {
    const { db, team } = freshTeam();
    const ada = addMember(db, team, { name: 'Ada', kind: 'agent' });
    expect(latestStatusUpdate(db, ada.row.id)).toBeNull();

    // body-only status
    insertMessage(
      db,
      team.id,
      ada.row.id,
      null,
      makeEnvelope({
        id: 's1',
        team: 'dawn',
        from: 'Ada',
        to: { kind: 'team' },
        act: 'status_update',
        body: 'scaffolding',
        ts: 100,
      }),
    );
    expect(latestStatusUpdate(db, ada.row.id)).toEqual({ state: 'scaffolding', ts: 100 });

    // newer status with meta.state wins over body
    insertMessage(
      db,
      team.id,
      ada.row.id,
      null,
      makeEnvelope({
        id: 's2',
        team: 'dawn',
        from: 'Ada',
        to: { kind: 'team' },
        act: 'status_update',
        body: 'ignored body',
        meta: { state: 'refactoring auth', progress: 0.5 },
        ts: 200,
      }),
    );
    expect(latestStatusUpdate(db, ada.row.id)).toEqual({ state: 'refactoring auth', ts: 200 });

    // a non-status_update message does not change the label
    insertMessage(
      db,
      team.id,
      ada.row.id,
      null,
      makeEnvelope({
        id: 'm3',
        team: 'dawn',
        from: 'Ada',
        to: { kind: 'team' },
        act: 'message',
        body: 'just chatting',
        ts: 300,
      }),
    );
    expect(latestStatusUpdate(db, ada.row.id)).toEqual({ state: 'refactoring auth', ts: 200 });
  });
});

describe('presence', () => {
  it('reports online while fresh and offline after reap', () => {
    const { db, team } = freshTeam();
    const ada = addMember(db, team, { name: 'Ada', kind: 'agent' });
    attach(db, ada.row.id, 'claude-code', 'c1');
    expect(hasLivePresence(db, ada.row.id, 45_000)).toBe(true);
    expect(listPresence(db, team.id, 45_000).find((p) => p.member.name === 'Ada')?.status).toBe(
      'online',
    );
    // reap with a 0ms timeout removes everything
    const removed = reapStale(db, 0);
    expect(removed.length).toBe(1);
    expect(hasLivePresence(db, ada.row.id, 45_000)).toBe(false);
  });

  it('countLivePresences counts distinct live members across all teams, ignoring offline/held (ADR 047)', () => {
    const { db, team } = freshTeam();
    const other = createTeam(db, { slug: 'dusk' });
    const ada = addMember(db, team, { name: 'Ada', kind: 'agent' });
    const bo = addMember(db, other, { name: 'Bo', kind: 'human' });

    expect(countLivePresences(db, 45_000)).toBe(0);

    // a member fanned out over two surfaces still counts once
    attach(db, ada.row.id, 'claude-code', 'c1');
    attach(db, ada.row.id, 'cli', 'c2');
    expect(countLivePresences(db, 45_000)).toBe(1);

    // a second member on another team adds to the cross-team count
    const boP = attach(db, bo.row.id, 'cli', 'c3');
    expect(countLivePresences(db, 45_000)).toBe(2);

    // a release hold no longer counts as live
    release(db, boP.id, 45_000);
    expect(countLivePresences(db, 45_000)).toBe(1);

    // an expired (stale) heartbeat doesn't count
    expect(countLivePresences(db, 0)).toBe(0);
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
    expect(listPresence(db, team.id, 45_000).find((s) => s.member.name === 'Ada')?.status).toBe(
      'offline',
    );
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

describe('ambient presence (ADR 057)', () => {
  function presenceRows(db: ReturnType<typeof freshTeam>['db'], memberId: string) {
    return db
      .prepare('SELECT id, surface, conn_id, status, provenance FROM presence WHERE member_id = ?')
      .all(memberId) as {
      id: string;
      surface: string;
      conn_id: string | null;
      status: string;
      provenance: string | null;
    }[];
  }

  it('a touch on an offline member flips it present, and reports the transition', () => {
    const { db, team } = freshTeam();
    const ada = addMember(db, team, { name: 'Ada', kind: 'agent' });
    expect(hasLivePresence(db, ada.row.id, 45_000)).toBe(false);

    const flipped = touchAmbientPresence(db, ada.row.id, 'cli', 45_000);
    expect(flipped).toBe(true);
    expect(hasLivePresence(db, ada.row.id, 45_000)).toBe(true);
    expect(listPresence(db, team.id, 45_000).find((s) => s.member.name === 'Ada')?.status).toBe(
      'online',
    );
    const rows = presenceRows(db, ada.row.id);
    expect(rows).toHaveLength(1);
    // ambient rows are connectionless and stamped with session provenance
    expect(rows[0]?.conn_id).toBeNull();
    expect(rows[0]?.provenance).toBe('session');
  });

  it('upserts a single row — many commands never accumulate rows', () => {
    const { db, team } = freshTeam();
    const ada = addMember(db, team, { name: 'Ada', kind: 'agent' });
    for (let i = 0; i < 5; i++) {
      const flipped = touchAmbientPresence(db, ada.row.id, 'cli', 45_000);
      // only the first touch is a transition; the rest just refresh the one row
      expect(flipped).toBe(i === 0);
    }
    expect(presenceRows(db, ada.row.id)).toHaveLength(1);
  });

  it('is a no-op when a resident (connected) session already owns liveness', () => {
    const { db, team } = freshTeam();
    const ada = addMember(db, team, { name: 'Ada', kind: 'agent' });
    attach(db, ada.row.id, 'claude-code', 'c1'); // a real watch socket

    const flipped = touchAmbientPresence(db, ada.row.id, 'cli', 45_000);
    expect(flipped).toBe(false);
    // no second row was added — the resident session is left alone
    const rows = presenceRows(db, ada.row.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.surface).toBe('claude-code');
    expect(rows[0]?.conn_id).toBe('c1');
  });

  it('refreshes a stale ambient row (the reaper later sweeps it like any live row)', () => {
    const { db, team } = freshTeam();
    const ada = addMember(db, team, { name: 'Ada', kind: 'agent' });
    touchAmbientPresence(db, ada.row.id, 'cli', 45_000);

    // the member went idle past the window: it now reads offline...
    expect(hasLivePresence(db, ada.row.id, 0)).toBe(false);
    // ...and a fresh command re-flips it present (a transition again), still one row
    const flipped = touchAmbientPresence(db, ada.row.id, 'cli', 0);
    expect(flipped).toBe(true);
    expect(presenceRows(db, ada.row.id)).toHaveLength(1);

    // and a 0ms reap removes the connectionless ambient row (held_until is null → a real offline)
    const removed = reapStale(db, 0);
    expect(removed).toHaveLength(1);
    expect(removed[0]?.held_until).toBeNull();
  });

  it('does not displace or touch a reclaim hold (newest-session-wins stays the only eviction)', () => {
    const { db, team } = freshTeam();
    const ada = addMember(db, team, { name: 'Ada', kind: 'agent' });
    const p = attach(db, ada.row.id, 'claude-code', 'c1');
    release(db, p.id, 45_000); // a hold during the grace window

    // a one-shot command must not resurrect or overwrite the hold; it adds its own ambient row
    const flipped = touchAmbientPresence(db, ada.row.id, 'cli', 45_000);
    expect(flipped).toBe(true);
    const hold = presenceById(db, p.id);
    expect(hold?.held_until).not.toBeNull(); // the hold is intact, untouched
    const ambient = presenceRows(db, ada.row.id).find((r) => r.id !== p.id);
    expect(ambient?.conn_id).toBeNull();
  });
});
