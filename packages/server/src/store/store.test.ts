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
  mintCredential,
  reapStaleObservers,
} from './members.js';
import { insertMessage, latestStatusUpdate, listInbox, listTeamMessages } from './messages.js';
import {
  attach,
  clearMemberPresence,
  countLivePresences,
  currentAttestedModel,
  reattestModel,
  hasActivePresence,
  hasLivePresence,
  listPresence,
  listReclaimableMemberIds,
  presenceById,
  reapStale,
  release,
  touchAmbientPresence,
} from './presence.js';
import { createTeam, rotateAgentKey } from './teams.js';

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

  it('rejects the removed v0.2 per-seat token (mskd_ cutover, ADR 069)', () => {
    const { db, team } = freshTeam();
    const { token } = addMember(db, team, { name: 'Ada', kind: 'agent' });
    expect(token).toMatch(/^mskd_/); // addMember still mints the durable seat token_hash …
    // … but it no longer authenticates — the team agent key + human credential are the only paths now.
    expect(() => authMember(db, 'dawn', token)).toThrow(MusterdError);
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

  it('re-adding a soft-removed name revives it instead of dead-ending on UNIQUE (ADR 065)', () => {
    const { db, team } = freshTeam();
    const first = addMember(db, team, { name: 'Ada', kind: 'human' });
    leaveMember(db, first.row.id);

    // The bug this guards: a tombstoned (team, name) row used to make re-add throw a UNIQUE error
    // with no CLI escape. Re-add now revives: same id (history continuous), new kind/role, fresh token.
    const revived = addMember(db, team, { name: 'Ada', kind: 'agent', role: 'engineer' });
    expect(revived.row.id).toBe(first.row.id);
    expect(revived.row.kind).toBe('agent');
    expect(revived.row.role).toBe('engineer');
    expect(revived.row.left_at).toBeNull();
    expect(revived.token).not.toBe(first.token); // deletion was a revocation — token re-minted
    expect(listMembers(db, team.id).map((m) => m.name)).toContain('Ada');
  });
});

// v0.3 P3 (ADR 077, SPEC A.7 §253): authMember dispatches on the secret prefix. The agent key (mskey_)
// authenticates the harness and names the acting seat out-of-band; the human credential (mscr_) is
// self-identifying; the legacy per-seat token (mskd_) is untouched. The upgrade is additive.
describe('authMember v0.3 prefix-dispatch (ADR 077)', () => {
  it('agent key + acting seat resolves to the named seat', () => {
    const { db, team } = freshTeam();
    addMember(db, team, { name: 'Ada', kind: 'agent' });
    const { agent_key } = rotateAgentKey(db, team.id);

    const ok = authMember(db, 'dawn', agent_key, 'Ada');
    expect(ok.member.name).toBe('Ada');
    // The agent-key path must NOT depend on bound_at/presence (claim never sets it; gating on it would
    // regress ADR 057). A freshly-added, never-touched seat authenticates fine.
    expect(ok.member.bound_at).toBeNull();
  });

  it('agent key without an acting seat is unauthorized (the key is not a seat)', () => {
    const { db, team } = freshTeam();
    addMember(db, team, { name: 'Ada', kind: 'agent' });
    const { agent_key } = rotateAgentKey(db, team.id);
    expect(() => authMember(db, 'dawn', agent_key)).toThrow(MusterdError);
  });

  it('agent key naming a non-existent or left seat is unauthorized', () => {
    const { db, team } = freshTeam();
    const ada = addMember(db, team, { name: 'Ada', kind: 'agent' });
    const { agent_key } = rotateAgentKey(db, team.id);
    expect(() => authMember(db, 'dawn', agent_key, 'Nobody')).toThrow(MusterdError);
    leaveMember(db, ada.row.id);
    expect(() => authMember(db, 'dawn', agent_key, 'Ada')).toThrow(MusterdError);
  });

  it('a wrong agent key is unauthorized', () => {
    const { db, team } = freshTeam();
    addMember(db, team, { name: 'Ada', kind: 'agent' });
    rotateAgentKey(db, team.id);
    expect(() => authMember(db, 'dawn', 'mskey_bogus', 'Ada')).toThrow(MusterdError);
  });

  it('the team agent key cannot act as a HUMAN seat — escalation guard (security focal point 2)', () => {
    const { db, team } = freshTeam();
    addMember(db, team, { name: 'nick', kind: 'human' }); // a human admin seat
    const { agent_key } = rotateAgentKey(db, team.id);
    // The shared agent key naming a human seat must be refused as `forbidden` — otherwise any agent
    // could set x-musterd-seat:<admin> and impersonate the human admin (privilege escalation).
    expect(() => authMember(db, 'dawn', agent_key, 'nick')).toThrow(MusterdError);
    try {
      authMember(db, 'dawn', agent_key, 'nick');
    } catch (e) {
      expect((e as MusterdError).code).toBe('forbidden');
    }
  });

  it('a human credential is self-identifying (no acting seat needed)', () => {
    const { db, team } = freshTeam();
    const human = addMember(db, team, { name: 'Nick', kind: 'human' });
    const { credential } = mintCredential(db, human.row.id);

    const ok = authMember(db, 'dawn', credential);
    expect(ok.member.name).toBe('Nick');
    // A matching x-musterd-seat is accepted; a mismatching one is forbidden (the credential is authority).
    expect(authMember(db, 'dawn', credential, 'Nick').member.name).toBe('Nick');
    expect(() => authMember(db, 'dawn', credential, 'Ada')).toThrow(MusterdError);
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

  it('listReclaimableMemberIds: a held-within-grace seat is reclaimable though it reads offline (ADR 105)', () => {
    const { db, team } = freshTeam();
    const ada = addMember(db, team, { name: 'Ada', kind: 'agent' });
    const bo = addMember(db, team, { name: 'Bo', kind: 'agent' });
    const pa = attach(db, ada.row.id, 'claude-code', 'c1');
    attach(db, bo.row.id, 'cli', 'c2'); // Bo stays live

    // Nothing held while both are live.
    expect(listReclaimableMemberIds(db, team.id, Date.now())).toEqual(new Set());

    // Ada releases → held within grace: a reservation, reads offline on the roster but IS reclaimable.
    release(db, pa.id, 45_000);
    const set = listReclaimableMemberIds(db, team.id, Date.now());
    expect(set.has(ada.row.id)).toBe(true); // held within grace
    expect(set.has(bo.row.id)).toBe(false); // live, not a hold
    expect(listPresence(db, team.id, 45_000).find((s) => s.member.name === 'Ada')?.status).toBe(
      'offline',
    );

    // Past grace (held_until in the past): no longer a reservation.
    release(db, pa.id, -1);
    expect(listReclaimableMemberIds(db, team.id, Date.now()).has(ada.row.id)).toBe(false);
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

describe('model attestation (ADR 101)', () => {
  it('attach records the attested model; absent attestation reads null (unknown)', () => {
    const { db, team } = freshTeam();
    const ada = addMember(db, team, { name: 'Ada', kind: 'agent' });
    attach(db, ada.row.id, 'claude-code', 'c1', { model: 'claude-opus-4-8' });
    const summary = listPresence(db, team.id, 45_000).find((s) => s.member.name === 'Ada');
    expect(summary?.presences[0]?.model).toBe('claude-opus-4-8');
    expect(currentAttestedModel(db, ada.row.id)).toBe('claude-opus-4-8');

    const bo = addMember(db, team, { name: 'Bo', kind: 'agent' });
    attach(db, bo.row.id, 'cli', 'c2'); // no attestation — legal, never blocks
    expect(currentAttestedModel(db, bo.row.id)).toBeNull();
  });

  it('reattestModel updates on a real change, no-ops on same value / missing row', () => {
    const { db, team } = freshTeam();
    const ada = addMember(db, team, { name: 'Ada', kind: 'agent' });
    const p = attach(db, ada.row.id, 'claude-code', 'c1', { model: 'claude-sonnet-5' });

    // Same value — no write, no audit noise.
    expect(reattestModel(db, p.id, 'claude-sonnet-5')).toBeUndefined();
    // A real switch — returns the previous value for the audit trail.
    expect(reattestModel(db, p.id, 'claude-opus-4-8')).toEqual({ previous: 'claude-sonnet-5' });
    expect(currentAttestedModel(db, ada.row.id)).toBe('claude-opus-4-8');
    // Missing row — undefined, never throws.
    expect(reattestModel(db, 'nope', 'claude-opus-4-8')).toBeUndefined();
  });

  it('currentAttestedModel keyed on a presence id reads that occupancy only (no cross-session bleed)', () => {
    const { db, team } = freshTeam();
    // A human fans out (ADR 042): two live sessions, different attested models.
    const nick = addMember(db, team, { name: 'nick', kind: 'human' });
    const older = attach(db, nick.row.id, 'cli', 'c1', { model: 'gpt-5.2' });
    const newer = attach(db, nick.row.id, 'web', 'c2', { model: 'claude-opus-4-8' });
    // Keyed on the specific occupancy — each stamps its own model, not the newest.
    expect(currentAttestedModel(db, nick.row.id, older.id)).toBe('gpt-5.2');
    expect(currentAttestedModel(db, nick.row.id, newer.id)).toBe('claude-opus-4-8');
    // An unattested occupancy stamps nothing even if a sibling session attests.
    const bare = attach(db, nick.row.id, 'ios', 'c3');
    expect(currentAttestedModel(db, nick.row.id, bare.id)).toBeNull();
    // No presence id → best-effort newest-*attested* fallback (the stateless HTTP path): it never
    // returns the unattested session's null, only one of the attested models.
    expect(['gpt-5.2', 'claude-opus-4-8']).toContain(currentAttestedModel(db, nick.row.id));
  });

  it('ambient touch preserves the attested model (sticky across authed HTTP requests)', () => {
    const { db, team } = freshTeam();
    const ada = addMember(db, team, { name: 'Ada', kind: 'agent' });
    // An HTTP claim attaches a connectionless presence that attested a model.
    attach(db, ada.row.id, 'cli', null, { model: 'claude-opus-4-8' });
    // A later authed request touches ambient presence with no model in context.
    touchAmbientPresence(db, ada.row.id, 'cli', 45_000, {});
    // The attestation must survive — COALESCE keeps it, so per-act stamping still works.
    expect(currentAttestedModel(db, ada.row.id)).toBe('claude-opus-4-8');
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

describe('observer seat reaping (ADR 064)', () => {
  it('reaps idle observer seats but keeps fresh, live, message-referenced, and participant seats', () => {
    const { db, team } = freshTeam();
    const now = Date.now();
    const old = now - 100_000;

    const nick = addMember(db, team, { name: 'nick', kind: 'human' }); // participant, never reaped
    const obOld = addMember(db, team, { name: 'web-old', kind: 'human', observer: true });
    addMember(db, team, { name: 'web-fresh', kind: 'human', observer: true }); // fresh updated_at → kept
    const obLive = addMember(db, team, { name: 'web-live', kind: 'human', observer: true });
    const obRef = addMember(db, team, { name: 'web-ref', kind: 'human', observer: true });

    // Age out everyone except the freshly-created observer.
    for (const id of [nick.row.id, obOld.row.id, obLive.row.id, obRef.row.id]) {
      db.prepare('UPDATE members SET updated_at = ? WHERE id = ?').run(old, id);
    }
    // web-live holds a live presence → protected despite an old updated_at.
    attach(db, obLive.row.id, 'web', 'conn-live', {
      provenance: null,
      workspace: null,
      driver: null,
    });
    // web-ref was sent a directed message → no to_member cascade, so it must be skipped (FK safety).
    insertMessage(
      db,
      team.id,
      nick.row.id,
      obRef.row.id,
      makeEnvelope({
        id: 'r1',
        team: 'dawn',
        from: 'nick',
        to: { kind: 'member', name: 'web-ref' },
        act: 'message',
        body: 'hi',
        ts: 100,
      }),
    );

    const reaped = reapStaleObservers(db, now - 5_000, now - 45_000);

    expect(reaped.map((m) => m.name)).toEqual(['web-old']);
    const remaining = listMembers(db, team.id)
      .map((m) => m.name)
      .sort();
    expect(remaining).toEqual(['nick', 'web-fresh', 'web-live', 'web-ref'].sort());
  });
});

describe('listTeamMessages (firehose backfill window)', () => {
  // Seed `count` team messages at ts = 1..count (id `m<ts>`, zero-padded so id order == ts order).
  function seed(
    db: ReturnType<typeof freshTeam>['db'],
    team: ReturnType<typeof freshTeam>['team'],
    count: number,
  ) {
    const ada = addMember(db, team, { name: 'Ada', kind: 'agent' });
    for (let ts = 1; ts <= count; ts++) {
      const env = makeEnvelope({
        id: `m${String(ts).padStart(4, '0')}`,
        team: 'dawn',
        from: 'Ada',
        to: { kind: 'team' },
        act: 'message',
        body: `#${ts}`,
        ts,
      });
      insertMessage(db, team.id, ada.row.id, null, env);
    }
  }

  it('returns the NEWEST `limit` messages (not the oldest) in ascending order when over cap', () => {
    const { db, team } = freshTeam();
    seed(db, team, 217); // over a 200 cap, like the busy team that surfaced this
    const rows = listTeamMessages(db, team.id, { limit: 200 });
    expect(rows).toHaveLength(200);
    // Ascending display order…
    expect(rows[0]!.ts).toBe(18); // 217 - 200 + 1 — the oldest 17 are dropped, not the newest
    expect(rows[rows.length - 1]!.ts).toBe(217); // …and the very newest IS present (the bug was that it wasn't)
  });

  it('returns everything ascending when under the cap', () => {
    const { db, team } = freshTeam();
    seed(db, team, 5);
    const rows = listTeamMessages(db, team.id, { limit: 200 });
    expect(rows.map((r) => r.ts)).toEqual([1, 2, 3, 4, 5]);
  });

  it('pages forward from a `since` cursor: oldest-after-since first, no gap skipped', () => {
    const { db, team } = freshTeam();
    seed(db, team, 10);
    const rows = listTeamMessages(db, team.id, { since: 3, limit: 2 });
    // strictly after ts=3, oldest first, capped at 2 — so a cursor holder walks forward without skipping
    expect(rows.map((r) => r.ts)).toEqual([4, 5]);
  });
});
