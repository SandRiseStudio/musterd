import { makeEnvelope } from '@musterd/protocol';
import { describe, expect, it } from 'vitest';
import { REMOTE_PRESENCE_TTL_MS } from '../config.js';
import { openDb } from '../db/open.js';
import { MusterdError } from '../errors.js';
import { resolveActivity } from './activity.js';
import { appendLaneEventRequired, appendReplicatedEvent, listAudit } from './audit.js';
import { getCursor, setCursor } from './cursors.js';
import { getLane, openLane } from './lanes.js';
import {
  addMember,
  authMember,
  getMemberById,
  getMemberByName,
  hashToken,
  leaveMember,
  markSeatReleased,
  markSessionEnded,
  listMembers,
  mintAgentSeatCredential,
  mintCredential,
  reapExcessIdleObservers,
  reapStaleObservers,
} from './members.js';
import { insertMessage, latestStatusUpdate, listInbox, listTeamMessages } from './messages.js';
import {
  attach,
  clearMemberPresence,
  clearPresenceById,
  countLivePresences,
  currentAttestedModel,
  detach,
  heartbeat,
  reattestModel,
  reattestSurface,
  hasActivePresence,
  hasLivePresence,
  listLiveDrivers,
  listPresence,
  listReclaimableMemberIds,
  presenceById,
  reapStale,
  recordUnattestedOccupancy,
  release,
  touchAmbientPresence,
} from './presence.js';
import { mintSessionLease } from './session-leases.js';
import {
  bootstrapCutoverReadiness,
  createTeam,
  cutoverLegacyBootstrap,
  findBootstrapCredential,
  getAgentKeyHash,
  migrateLegacyBootstrapCredential,
  mintBootstrapCredential,
  recordBootstrapCredentialUse,
  requireTeam,
  revokeBootstrapCredential,
  rotateAgentKey,
} from './teams.js';

function freshTeam() {
  const db = openDb(':memory:');
  const team = createTeam(db, { slug: 'dawn' });
  return { db, team };
}

function legacyBootstrap(db: ReturnType<typeof openDb>, teamId: string) {
  return rotateAgentKey(db, teamId).agent_key;
}

describe('teams + members', () => {
  it('records the compatibility Team key as an explicit active legacy credential', () => {
    const { db, team } = freshTeam();
    const legacyKey = legacyBootstrap(db, team.id);
    expect(findBootstrapCredential(db, team.id, legacyKey)).toMatchObject({
      team_id: team.id,
      use_kind: 'legacy',
      state: 'active',
    });
  });

  it('migrates a legacy key only to the seat proven by its agent-seat credential (ADR 350)', () => {
    const { db, team } = freshTeam();
    const ada = addMember(db, team, { name: 'Ada', kind: 'agent' });
    const { seat_credential } = mintAgentSeatCredential(db, ada.row.id);
    const legacyKey = legacyBootstrap(db, team.id);

    const migrated = migrateLegacyBootstrapCredential(db, {
      legacyKey,
      seatCredential: seat_credential,
    });

    expect(migrated.credential).toMatchObject({
      team_id: team.id,
      use_kind: 'claim_seat',
      target: 'Ada',
      migration_target_member_id: ada.row.id,
      first_used_at: null,
    });
    expect(migrated.agent_key).toMatch(/^mskey_/);
    expect(migrated.replaced_credential_id).toBeNull();
  });

  it('replaces only an unused migration successor and never one with scoped use (ADR 350)', () => {
    const { db, team } = freshTeam();
    const ada = addMember(db, team, { name: 'Ada', kind: 'agent' });
    const { seat_credential } = mintAgentSeatCredential(db, ada.row.id);
    const legacyKey = legacyBootstrap(db, team.id);

    const first = migrateLegacyBootstrapCredential(db, {
      legacyKey,
      seatCredential: seat_credential,
    });
    const second = migrateLegacyBootstrapCredential(db, {
      legacyKey,
      seatCredential: seat_credential,
    });
    expect(second.replaced_credential_id).toBe(first.credential.id);
    expect(findBootstrapCredential(db, team.id, first.agent_key)).toBeNull();

    recordBootstrapCredentialUse(db, second.credential.id, 1234);
    expect(() =>
      migrateLegacyBootstrapCredential(db, {
        legacyKey,
        seatCredential: seat_credential,
      }),
    ).toThrow(/already migrated/);
    expect(findBootstrapCredential(db, team.id, second.agent_key)?.first_used_at).toBe(1234);
  });

  it('refuses cross-Team and inactive seat proofs without minting a successor (ADR 350)', () => {
    const { db, team } = freshTeam();
    const other = createTeam(db, { slug: 'dusk' });
    const ada = addMember(db, team, { name: 'Ada', kind: 'agent' });
    const lin = addMember(db, other, { name: 'Lin', kind: 'agent' });
    const adaCredential = mintAgentSeatCredential(db, ada.row.id).seat_credential;
    const linCredential = mintAgentSeatCredential(db, lin.row.id).seat_credential;
    const legacyKey = legacyBootstrap(db, team.id);

    expect(() =>
      migrateLegacyBootstrapCredential(db, {
        legacyKey,
        seatCredential: linCredential,
      }),
    ).toThrow(/same Team/);
    leaveMember(db, ada.row.id);
    expect(() =>
      migrateLegacyBootstrapCredential(db, {
        legacyKey,
        seatCredential: adaCredential,
      }),
    ).toThrow(/agent seat credential/);
    expect(
      db
        .prepare<
          [],
          { count: number }
        >("SELECT COUNT(*) AS count FROM agent_bootstrap_credentials WHERE use_kind = 'claim_seat'")
        .get()?.count,
    ).toBe(0);
  });

  it.each(['disabled', 'banned', 'archived'] as const)(
    'refuses a %s agent seat without minting a successor (ADR 350)',
    (status) => {
      const { db, team } = freshTeam();
      const ada = addMember(db, team, { name: 'Ada', kind: 'agent' });
      const seatCredential = mintAgentSeatCredential(db, ada.row.id).seat_credential;
      const legacyKey = legacyBootstrap(db, team.id);
      db.prepare('UPDATE members SET account_status = ? WHERE id = ?').run(status, ada.row.id);

      expect(() => migrateLegacyBootstrapCredential(db, { legacyKey, seatCredential })).toThrow(
        new RegExp(status),
      );
      expect(
        db
          .prepare<
            [],
            { count: number }
          >("SELECT COUNT(*) AS count FROM agent_bootstrap_credentials WHERE use_kind = 'claim_seat'")
          .get()?.count,
      ).toBe(0);
    },
  );

  it('refuses human, non-legacy, revoked, and expired migration proofs (ADR 350)', () => {
    const humanCase = freshTeam();
    const nick = addMember(humanCase.db, humanCase.team, { name: 'Nick', kind: 'human' });
    const humanCredential = mintCredential(humanCase.db, nick.row.id).credential;
    const humanLegacy = legacyBootstrap(humanCase.db, humanCase.team.id);
    expect(() =>
      migrateLegacyBootstrapCredential(humanCase.db, {
        legacyKey: humanLegacy,
        seatCredential: humanCredential,
      }),
    ).toThrow(/agent seat credential/);

    const scopedCase = freshTeam();
    const ada = addMember(scopedCase.db, scopedCase.team, { name: 'Ada', kind: 'agent' });
    const seatCredential = mintAgentSeatCredential(scopedCase.db, ada.row.id).seat_credential;
    const scopedKey = mintBootstrapCredential(scopedCase.db, {
      teamId: scopedCase.team.id,
      useKind: 'claim_seat',
      target: 'Ada',
    }).agent_key;
    expect(() =>
      migrateLegacyBootstrapCredential(scopedCase.db, {
        legacyKey: scopedKey,
        seatCredential,
      }),
    ).toThrow(/legacy bootstrap/);

    for (const state of ['revoked', 'expired'] as const) {
      const credentialCase = freshTeam();
      const member = addMember(credentialCase.db, credentialCase.team, {
        name: 'Ada',
        kind: 'agent',
      });
      const credential = mintAgentSeatCredential(credentialCase.db, member.row.id).seat_credential;
      const legacy = legacyBootstrap(credentialCase.db, credentialCase.team.id);
      credentialCase.db
        .prepare(
          state === 'revoked'
            ? "UPDATE agent_bootstrap_credentials SET state = 'revoked' WHERE use_kind = 'legacy'"
            : "UPDATE agent_bootstrap_credentials SET expires_at = 1 WHERE use_kind = 'legacy'",
        )
        .run();
      expect(() =>
        migrateLegacyBootstrapCredential(credentialCase.db, {
          legacyKey: legacy,
          seatCredential: credential,
          now: 2,
        }),
      ).toThrow(/legacy bootstrap/);
    }
  });

  it('requires successful scoped use for every held agent seat and enrolled host (ADR 350)', () => {
    const { db, team } = freshTeam();
    legacyBootstrap(db, team.id);
    const ada = addMember(db, team, { name: 'Ada', kind: 'agent' });
    const grace = addMember(db, team, { name: 'Grace', kind: 'agent' });
    const unheld = addMember(db, team, { name: 'Lin', kind: 'agent' });
    const disabled = addMember(db, team, { name: 'Dormant', kind: 'agent' });
    db.prepare('UPDATE members SET bound_at = 1 WHERE id IN (?, ?, ?)').run(
      ada.row.id,
      grace.row.id,
      disabled.row.id,
    );
    db.prepare("UPDATE members SET account_status = 'disabled' WHERE id = ?").run(disabled.row.id);

    const insertResidency = db.prepare(
      `INSERT INTO residency
        (id, team_id, member_id, harness, host, created_at, updated_at)
       VALUES (?, ?, ?, 'cursor', ?, 1, 1)`,
    );
    insertResidency.run('res-ada', team.id, ada.row.id, 'mac-studio');
    insertResidency.run('res-grace', team.id, grace.row.id, 'mac-studio');

    const adaKey = mintBootstrapCredential(db, {
      teamId: team.id,
      useKind: 'claim_seat',
      target: 'Ada',
    });
    const graceKey = mintBootstrapCredential(db, {
      teamId: team.id,
      useKind: 'claim_seat',
      target: 'Grace',
    });
    const hostKey = mintBootstrapCredential(db, {
      teamId: team.id,
      useKind: 'host',
      target: 'mac-studio',
    });
    void unheld;
    recordBootstrapCredentialUse(db, graceKey.credential.id, 10);

    expect(bootstrapCutoverReadiness(db, team.id)).toEqual({
      already_cut_over: false,
      unmet_seats: [{ member_id: ada.row.id, name: 'Ada' }],
      unmet_hosts: ['mac-studio'],
    });

    recordBootstrapCredentialUse(db, adaKey.credential.id, 11);
    recordBootstrapCredentialUse(db, hostKey.credential.id, 12);
    expect(bootstrapCutoverReadiness(db, team.id)).toEqual({
      already_cut_over: false,
      unmet_seats: [],
      unmet_hosts: [],
    });
  });

  it('refuses incomplete cutover unless forced and makes repeated cutover idempotent (ADR 350)', () => {
    const { db, team } = freshTeam();
    legacyBootstrap(db, team.id);
    const ada = addMember(db, team, { name: 'Ada', kind: 'agent' });
    db.prepare('UPDATE members SET bound_at = 1 WHERE id = ?').run(ada.row.id);

    expect(() =>
      cutoverLegacyBootstrap(db, { teamId: team.id, actor: 'Nick', force: false, now: 100 }),
    ).toThrow(/not ready/);
    expect(getAgentKeyHash(db, team.id)).not.toBeNull();

    const forced = cutoverLegacyBootstrap(db, {
      teamId: team.id,
      actor: 'Nick',
      force: true,
      now: 101,
    });
    expect(forced).toEqual({
      already_cut_over: false,
      unmet_seats: [{ member_id: ada.row.id, name: 'Ada' }],
      unmet_hosts: [],
    });
    expect(getAgentKeyHash(db, team.id)).toBeNull();
    expect(requireTeam(db, team.slug).bootstrap_cutover_at).toBe(101);
    expect(() => rotateAgentKey(db, team.id)).toThrow(/already cut over/);
    expect(
      db
        .prepare<
          [],
          { count: number }
        >("SELECT COUNT(*) AS count FROM agent_bootstrap_credentials WHERE use_kind = 'legacy' AND state IN ('active', 'rotated')")
        .get()!.count,
    ).toBe(0);

    expect(
      cutoverLegacyBootstrap(db, {
        teamId: team.id,
        actor: 'Nick',
        force: false,
        now: 102,
      }),
    ).toEqual({
      already_cut_over: true,
      unmet_seats: [{ member_id: ada.row.id, name: 'Ada' }],
      unmet_hosts: [],
    });
    expect(requireTeam(db, team.slug).bootstrap_cutover_at).toBe(101);
  });

  it('rolls back legacy cutover when its audit write fails (ADR 350)', () => {
    const { db, team } = freshTeam();
    legacyBootstrap(db, team.id);
    db.exec(`
      CREATE TRIGGER fail_bootstrap_cutover_audit
      BEFORE INSERT ON audit
      WHEN NEW.action = 'bootstrap_credential.cutover'
      BEGIN
        SELECT RAISE(ABORT, 'injected audit failure');
      END
    `);

    expect(() =>
      cutoverLegacyBootstrap(db, { teamId: team.id, actor: 'Nick', force: false, now: 100 }),
    ).toThrow(/injected audit failure/);
    expect(getAgentKeyHash(db, team.id)).not.toBeNull();
    expect(requireTeam(db, team.slug).bootstrap_cutover_at).toBeNull();
    expect(
      db
        .prepare<
          [],
          { count: number }
        >("SELECT COUNT(*) AS count FROM agent_bootstrap_credentials WHERE use_kind = 'legacy' AND state = 'active'")
        .get()!.count,
    ).toBe(1);
  });

  it('mints and resolves a target-scoped bootstrap credential', () => {
    const { db, team } = freshTeam();
    const minted = mintBootstrapCredential(db, {
      teamId: team.id,
      useKind: 'claim_seat',
      target: 'Ada',
      label: 'ada-workspace',
    });

    expect(findBootstrapCredential(db, team.id, minted.agent_key)).toMatchObject({
      id: minted.credential.id,
      use_kind: 'claim_seat',
      target: 'Ada',
    });
    expect(findBootstrapCredential(db, team.id, 'mskey_wrong')).toBeNull();
  });

  it('revokes a scoped bootstrap credential without affecting another credential', () => {
    const { db, team } = freshTeam();
    const ada = mintBootstrapCredential(db, {
      teamId: team.id,
      useKind: 'claim_seat',
      target: 'Ada',
    });
    const lin = mintBootstrapCredential(db, {
      teamId: team.id,
      useKind: 'claim_seat',
      target: 'Lin',
    });

    expect(revokeBootstrapCredential(db, team.id, ada.credential.id)).toBe(true);
    expect(findBootstrapCredential(db, team.id, ada.agent_key)).toBeNull();
    expect(findBootstrapCredential(db, team.id, lin.agent_key)).toMatchObject({
      id: lin.credential.id,
      state: 'active',
    });
  });

  it('marks a predecessor rotated while keeping both credentials valid for staged migration', () => {
    const { db, team } = freshTeam();
    const predecessor = mintBootstrapCredential(db, {
      teamId: team.id,
      useKind: 'claim_seat',
      target: 'Ada',
    });
    const successor = mintBootstrapCredential(db, {
      teamId: team.id,
      useKind: 'claim_seat',
      target: 'Ada',
    });

    expect(findBootstrapCredential(db, team.id, predecessor.agent_key)).toMatchObject({
      state: 'rotated',
    });
    expect(findBootstrapCredential(db, team.id, successor.agent_key)).toMatchObject({
      state: 'active',
    });
  });

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

  it('leaveMember releases in-flight claims so the board cannot name a ghost owner (ADR 196)', () => {
    const { db, team } = freshTeam();
    const ada = addMember(db, team, { name: 'Ada', kind: 'agent' });
    const wip = openLane(db, team.id, 'dawn', 'Ada', { title: 'wip', claim: true });
    const awaiting = openLane(db, team.id, 'dawn', 'Ada', { title: 'merged', claim: true });
    db.prepare(`UPDATE lanes SET state = 'awaiting_acceptance' WHERE id = ?`).run(awaiting.id);

    leaveMember(db, ada.row.id);
    expect(getLane(db, team.id, wip.id, 'dawn')).toMatchObject({ state: 'open', owner_seat: null });
    expect(getLane(db, team.id, awaiting.id, 'dawn')).toMatchObject({
      state: 'awaiting_acceptance',
      owner_seat: 'Ada',
    });
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

// ADR 337 keeps the team key at the claim bootstrap boundary. Routine agent authority is instead
// self-identifying and bound to the exact Presence that minted its short-lived lease.
describe('authMember credential and lease dispatch (ADR 337)', () => {
  it('agent credential plus its live lease resolves only its named seat', () => {
    const { db, team } = freshTeam();
    const ada = addMember(db, team, { name: 'Ada', kind: 'agent' });
    const presence = attach(db, ada.row.id, 'cli', null);
    const { seat_credential } = mintAgentSeatCredential(db, ada.row.id);
    const { session_lease } = mintSessionLease(db, {
      teamId: team.id,
      memberId: ada.row.id,
      presenceId: presence.id,
    });

    const ok = authMember(db, 'dawn', seat_credential, 'Ada', session_lease);
    expect(ok.member.name).toBe('Ada');
    expect(() => authMember(db, 'dawn', seat_credential, 'Ada')).toThrow(MusterdError);
  });

  it('the team agent key is never routine HTTP authority', () => {
    const { db, team } = freshTeam();
    addMember(db, team, { name: 'Ada', kind: 'agent' });
    const { agent_key } = rotateAgentKey(db, team.id);
    expect(() => authMember(db, 'dawn', agent_key)).toThrow(MusterdError);
  });

  it('the team agent key cannot select a non-existent or left seat', () => {
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

  it('the team agent key cannot act as a HUMAN seat — bootstrap-only', () => {
    const { db, team } = freshTeam();
    addMember(db, team, { name: 'nick', kind: 'human' }); // a human admin seat
    const { agent_key } = rotateAgentKey(db, team.id);
    // The bootstrap-only key must be refused before any caller-selected seat is consulted.
    expect(() => authMember(db, 'dawn', agent_key, 'nick')).toThrow(MusterdError);
    try {
      authMember(db, 'dawn', agent_key, 'nick');
    } catch (e) {
      expect((e as MusterdError).code).toBe('unauthorized');
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
    setCursor(db, lin.row.id, 'm1');
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
  it('resolveActivity: offline when not live; active when live with no status; working with a status', () => {
    expect(resolveActivity(false, { state: 'x', ts: 1 })).toEqual({
      activity: 'offline',
      state: null,
      last_status_at: null,
    });
    expect(resolveActivity(true, null)).toEqual({
      activity: 'active',
      state: null,
      last_status_at: null,
    });
    expect(resolveActivity(true, { state: 'refactoring auth', ts: 100 })).toEqual({
      activity: 'working',
      state: 'refactoring auth',
      last_status_at: 100,
    });
  });

  it('listLiveDrivers: distinct drivers on live team presence; stale/other-team excluded (ADR 155)', () => {
    const { db, team } = freshTeam();
    const other = createTeam(db, { slug: 'dusk' });
    const ada = addMember(db, team, { name: 'Ada', kind: 'agent' }).row;
    const lin = addMember(db, team, { name: 'Lin', kind: 'agent' }).row;
    const far = addMember(db, other, { name: 'Rex', kind: 'agent' }).row;

    attach(db, ada.id, 'claude-code', 'c1', { driver: 'nick' });
    attach(db, lin.id, 'cli', 'c2', { driver: 'nick' }); // same driver, two seats → one entry
    attach(db, far.id, 'cli', 'c3', { driver: 'bo' }); // other team → excluded

    const drivers = listLiveDrivers(db, team.id, 60_000);
    expect([...drivers]).toEqual(['nick']); // distinct + team-scoped
    expect(listLiveDrivers(db, other.id, 60_000).has('bo')).toBe(true);
    // A zero timeout makes every heartbeat stale → no live drivers (the live filter).
    expect(listLiveDrivers(db, team.id, 0).size).toBe(0);
  });

  it('resolveActivity: steering marks you working even without your own heartbeat (ADR 155)', () => {
    // Not live on your own, but steering a live agent seat → working, present (the driver-copresence fix).
    expect(resolveActivity(false, null, true)).toEqual({
      activity: 'working',
      state: null,
      last_status_at: null,
    });
    // Steering keeps your own status text as the working label when you have one.
    expect(resolveActivity(true, { state: 'pairing on gate B', ts: 42 }, true)).toEqual({
      activity: 'working',
      state: 'pairing on gate B',
      last_status_at: 42,
    });
    // steering defaults false — the existing two-clocks behaviour is untouched.
    expect(resolveActivity(true, null).activity).toBe('active');
  });

  it('resolveActivity: the decay window turns a stale working label into active — claim kept with its age (ADR 155 Inc 3, presence-honesty \u00a72.1)', () => {
    const fresh = { state: 'reviewing asks', ts: Date.now() - 1_000 };
    const stale = { state: 'reviewing asks', ts: Date.now() - 46_000 };
    // Within the window the status is a live task label.
    expect(resolveActivity(true, fresh, false, 45_000)).toEqual({
      activity: 'working',
      state: 'reviewing asks',
      last_status_at: fresh.ts,
    });
    // Past it the read decays to active, but the claim is KEPT with its age — the renderer shows
    // `last: "<status>" \u00b7 20m ago`, never an erased history.
    expect(resolveActivity(true, stale, false, 45_000)).toEqual({
      activity: 'active',
      state: 'reviewing asks',
      last_status_at: stale.ts,
    });
    // Steering outranks the decay — a live driver link is a current action, not a stale report.
    expect(resolveActivity(true, stale, true, 45_000).activity).toBe('working');
    // No window keeps the ADR 010 never-silently-revert read (callers now always pass one).
    expect(resolveActivity(true, stale)).toEqual({
      activity: 'working',
      state: 'reviewing asks',
      last_status_at: stale.ts,
    });
    // Not live stays offline regardless of the window.
    expect(resolveActivity(false, stale, false, 45_000).activity).toBe('offline');
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

describe('replicated audit (presence replication, 2026-09-02)', () => {
  it('appendReplicatedEvent stamps a presence.* row from the node allocator, densely with lane rows', () => {
    const { db, team } = freshTeam();
    appendReplicatedEvent(db, team.id, {
      actor: 'ada',
      action: 'presence.attached',
      target: 'ada',
      result: 'allow',
      detail: { presence: 'p1' },
    });
    appendLaneEventRequired(db, team.id, {
      actor: 'ada',
      action: 'lane.opened',
      target: 'l1',
      result: 'allow',
      detail: { lane: 'l1' },
    });
    const seqs = db
      .prepare<
        [],
        { origin_seq: number; action: string }
      >('SELECT origin_seq, action FROM audit WHERE origin_seq > 0 ORDER BY origin_seq')
      .all();
    expect(seqs.map((r) => r.origin_seq)).toEqual([1, 2]);
    expect(seqs[0]!.action).toBe('presence.attached');
  });
});

describe('presence', () => {
  it('presence transitions are stamped audit rows: attach, reattest, detach — and a heartbeat is not', () => {
    const { db, team } = freshTeam();
    const ada = addMember(db, team, { name: 'Ada', kind: 'agent' });
    const row = attach(db, ada.row.id, 'claude-code', 'c1', {
      model: 'claude-opus-5',
      model_source: 'observed',
      workspace: '~/x',
      driver: 'nick',
    });
    heartbeat(db, row.id);
    reattestModel(db, row.id, 'claude-sonnet-5', 'observed');
    detach(db, row.id);
    const rows = db
      .prepare<
        [],
        { action: string; actor: string; detail: string; origin_seq: number }
      >("SELECT action, actor, detail, origin_seq FROM audit WHERE action LIKE 'presence.%' ORDER BY origin_seq")
      .all();
    expect(rows.map((r) => r.action)).toEqual([
      'presence.attached',
      'presence.reattested',
      'presence.detached',
    ]);
    expect(rows.every((r) => r.actor === 'Ada' && r.origin_seq > 0)).toBe(true);
    expect(JSON.parse(rows[0]!.detail)).toMatchObject({
      presence: row.id,
      surface: 'claude-code',
      model: 'claude-opus-5',
      model_source: 'observed',
      workspace: '~/x',
      driver: 'nick',
    });
    expect(JSON.parse(rows[0]!.detail)).not.toHaveProperty('wake_lease');
    expect(JSON.parse(rows[1]!.detail)).toMatchObject({
      presence: row.id,
      model: 'claude-sonnet-5',
      model_source: 'observed',
      surface: 'claude-code',
    });
    expect(JSON.parse(rows[2]!.detail)).toEqual({ presence: row.id, reason: 'goodbye' });
  });

  it('every removal path names its reason; release into grace is not a detach; reap of the grace is', () => {
    const { db, team } = freshTeam();
    const ada = addMember(db, team, { name: 'Ada', kind: 'agent' });
    const a = attach(db, ada.row.id, 'claude-code', 'c1');
    release(db, a.id, 0);
    expect(
      db.prepare("SELECT COUNT(*) AS n FROM audit WHERE action = 'presence.detached'").get(),
    ).toEqual({ n: 0 });
    reapStale(db, 45_000); // held_until already passed
    const b = attach(db, ada.row.id, 'claude-code', 'c2');
    clearPresenceById(db, b.id);
    attach(db, ada.row.id, 'claude-code', 'c3');
    clearMemberPresence(db, ada.row.id);
    const reasons = db
      .prepare<[], { detail: string }>(
        "SELECT detail FROM audit WHERE action = 'presence.detached' ORDER BY origin_seq",
      )
      .all()
      .map((r) => JSON.parse(r.detail).reason);
    expect(reasons).toEqual(['reaped', 'displaced', 'cleared']);
  });

  it('an ambient touch emits attached when it creates a row and nothing when it refreshes one', () => {
    const { db, team } = freshTeam();
    const cy = addMember(db, team, { name: 'Cy', kind: 'agent' });
    touchAmbientPresence(db, cy.row.id, 'cli', 45_000, {});
    touchAmbientPresence(db, cy.row.id, 'cli', 45_000, {});
    expect(
      db.prepare("SELECT COUNT(*) AS n FROM audit WHERE action = 'presence.attached'").get(),
    ).toEqual({ n: 1 });
  });

  it('a remote row is never the subject of a locally emitted transition', () => {
    const { db, team } = freshTeam();
    const ada = addMember(db, team, { name: 'Ada', kind: 'agent' });
    db.prepare(
      "INSERT INTO nodes (id, team_id, label, next_seq, last_seen_at) VALUES ('nB', ?, 'B', 1, 0)",
    ).run(team.id);
    db.prepare(
      "INSERT INTO presence (id, member_id, surface, status, conn_id, last_seen_at, created_at, node) VALUES ('rB', ?, 'codex', 'online', NULL, 1, 1, 'nB')",
    ).run(ada.row.id);
    clearMemberPresence(db, ada.row.id);
    reapStale(db, 45_000);
    expect(
      db.prepare("SELECT COUNT(*) AS n FROM audit WHERE action = 'presence.detached'").get(),
    ).toEqual({ n: 0 });
    // The stale-node sweep removed it silently.
    expect(db.prepare("SELECT COUNT(*) AS n FROM presence WHERE id = 'rB'").get()).toEqual({
      n: 0,
    });
  });

  it('a remote row is live while its node is, and reads its node label (presence replication §3)', () => {
    const { db, team } = freshTeam();
    const ada = addMember(db, team, { name: 'Ada', kind: 'agent' });
    const now = Date.now();
    db.prepare(
      'INSERT INTO nodes (id, team_id, label, next_seq, last_seen_at) VALUES (?, ?, ?, 1, ?)',
    ).run('nB', team.id, 'laptop-b', now);
    db.prepare(
      "INSERT INTO presence (id, member_id, surface, status, conn_id, last_seen_at, created_at, node, model, driver, workspace) VALUES ('rB', ?, 'codex', 'online', NULL, ?, ?, 'nB', 'gpt-5', 'nick', '~/b')",
    ).run(ada.row.id, now - 10 * 60_000, now - 10 * 60_000); // a stale heartbeat would be dead locally
    expect(hasLivePresence(db, ada.row.id, 45_000)).toBe(true);
    const p = listPresence(db, team.id, 45_000).find((s) => s.member.name === 'Ada')!;
    expect(p.status).toBe('online');
    expect(p.presences[0]).toMatchObject({
      node: 'nB',
      node_label: 'laptop-b',
      model: 'gpt-5',
      driver: 'nick',
      workspace: '~/b',
    });
    expect(listLiveDrivers(db, team.id, 45_000).has('nick')).toBe(true);
    expect(countLivePresences(db, 45_000)).toBe(1);
    // The node goes quiet past the TTL: the same row is not live.
    db.prepare('UPDATE nodes SET last_seen_at = ? WHERE id = ?').run(
      now - REMOTE_PRESENCE_TTL_MS - 1,
      'nB',
    );
    expect(hasLivePresence(db, ada.row.id, 45_000)).toBe(false);
    expect(listPresence(db, team.id, 45_000).find((s) => s.member.name === 'Ada')!.status).toBe(
      'offline',
    );
    // A local row folded nowhere still reads node: null on the roster.
    attach(db, ada.row.id, 'claude-code', 'c1');
    const local = listPresence(db, team.id, 45_000).find((s) => s.member.name === 'Ada')!;
    expect(local.presences[0]).toMatchObject({ node: null, node_label: null });
  });

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

  it('round-trips the attested feature epoch, sticky across an ambient touch (ADR 148)', () => {
    const { db, team } = freshTeam();
    const epochOf = (name: string) =>
      listPresence(db, team.id, 45_000).find((s) => s.member.name === name)?.presences[0]?.epoch;

    // Claim path: attach attests epoch 3; listPresence surfaces it on the presence entry.
    const ada = addMember(db, team, { name: 'Ada', kind: 'agent' });
    attach(db, ada.row.id, 'claude-code', 'c1', { epoch: 3 });
    expect(epochOf('Ada')).toBe(3);

    // Ambient path: a fire-and-exit CLI touch attests epoch 2, then a later touch carrying no epoch must
    // NOT clear it — the UPDATE's COALESCE keeps the value attested first, exactly like build/model.
    const cy = addMember(db, team, { name: 'Cy', kind: 'agent' });
    touchAmbientPresence(db, cy.row.id, 'cli', 45_000, { epoch: 2 });
    expect(epochOf('Cy')).toBe(2);
    touchAmbientPresence(db, cy.row.id, 'cli', 45_000, {});
    expect(epochOf('Cy')).toBe(2);

    // An absent epoch (older client) simply reads null — never blocks, never guesses.
    const bo = addMember(db, team, { name: 'Bo', kind: 'agent' });
    attach(db, bo.row.id, 'claude-code', 'c2');
    expect(epochOf('Bo')).toBeNull();
  });

  /**
   * ADR 241. The token is the one presence field that IDENTIFIES rather than describes, so its
   * stickiness rule is deliberately the opposite of model/build/epoch's: it travels with
   * `provenance`, not with attestation. A touch that re-writes provenance re-writes the token in the
   * same breath, because a sticky token under a fresh provenance would keep asserting a lease the
   * session no longer belongs to — and a verifier reads that assertion as proof it spawned the
   * session.
   */
  it('round-trips the wake correlation token, and clears it with provenance (ADR 241)', () => {
    const { db, team } = freshTeam();
    const leaseOf = (name: string) =>
      listPresence(db, team.id, 45_000).find((s) => s.member.name === name)?.presences[0]
        ?.wake_lease;

    // Claim path: the woken adapter attests the lease that spawned it.
    const ada = addMember(db, team, { name: 'Ada', kind: 'agent' });
    attach(db, ada.row.id, 'codex', 'c1', { provenance: 'wake', wake_lease: 'L-1' });
    expect(leaseOf('Ada')).toBe('L-1');

    // Ambient path: the woken session's hook one-shots carry it too — often BEFORE the adapter
    // claims, which is why the header exists at all.
    const cy = addMember(db, team, { name: 'Cy', kind: 'agent' });
    touchAmbientPresence(db, cy.row.id, 'cli', 45_000, { provenance: 'wake', wake_lease: 'L-2' });
    expect(leaseOf('Cy')).toBe('L-2');

    // …and a later touch from a human-driven session takes the row over completely: provenance
    // `session` AND no lease. Keeping the token here would leave the row claiming a wake it is no
    // longer part of — a row that lies is worse than a row that says nothing.
    touchAmbientPresence(db, cy.row.id, 'cli', 45_000, {});
    expect(leaseOf('Cy')).toBeNull();

    // An occupancy no wake caused simply has none. This is the overwhelmingly common case.
    const bo = addMember(db, team, { name: 'Bo', kind: 'agent' });
    attach(db, bo.row.id, 'claude-code', 'c2');
    expect(leaseOf('Bo')).toBeNull();
  });

  /**
   * ADR 246. The gap this closes, measured live on 2026-08-05: seat miley's session released
   * cleanly (ADR 010 leaves the row HELD, attestation intact), a hook one-shot touched fifteen
   * seconds later, `touchAmbientPresence`'s reuse query skipped the held row because it requires
   * `held_until IS NULL`, and so a BRAND NEW row was attached attesting nothing. `latestAttestedModel`
   * reads the newest non-held row and returns its null, so she left the ADR 188 review pool — and
   * the audit table had no row anywhere saying it happened. 1214 `occupancy.model_attested` rows
   * existed at the time and not one carried `new: null`, though `review.ts` has always read that
   * shape ("a de-attestation proves nothing").
   */
  it('records a de-attestation when an occupancy is born unattested after an attested one (ADR 246)', () => {
    const { db, team } = freshTeam();
    const ada = addMember(db, team, { name: 'Ada', kind: 'agent' });
    const attested = attach(db, ada.row.id, 'claude-code', 'c1', { model: 'claude-fable-5' });
    release(db, attested.id, 45_000); // clean disconnect: held, attestation intact

    const born = attach(db, ada.row.id, 'cli', null); // the hook's ambient touch — attests nothing
    expect(recordUnattestedOccupancy(db, team.id, ada.row, born.id, 'ambient')).toBe(true);

    const rows = listAudit(db, team.id, { limit: 10 }).filter(
      (r) => r.action === 'occupancy.model_attested',
    );
    expect(rows).toHaveLength(1);
    const detail = JSON.parse(rows[0]!.detail ?? '{}') as Record<string, unknown>;
    expect(detail).toMatchObject({
      occupancy: born.id,
      old: 'claude-fable-5',
      new: null,
      source: 'ambient',
    });
  });

  it('a seat that never attested drops nothing — silence is not a de-attestation (ADR 246)', () => {
    // The guard on the guard. `unknown` from the start is a different fact from `was X, now
    // nothing`, and only the second is an event. Emitting for the first would fill the ledger with
    // rows about seats that have simply never been able to attest (ADR 158: Codex, today).
    const { db, team } = freshTeam();
    const bo = addMember(db, team, { name: 'Bo', kind: 'agent' });
    const born = attach(db, bo.row.id, 'cli', null);
    expect(recordUnattestedOccupancy(db, team.id, bo.row, born.id, 'claim')).toBe(false);
    // The attach itself is a replicated `presence.attached` row; the de-attestation is what's absent.
    expect(
      listAudit(db, team.id, { limit: 10 }).filter((r) => !r.action.startsWith('presence.')),
    ).toHaveLength(0);
  });

  it('the de-attestation never resurrects the old model as evidence (ADR 187)', () => {
    // `new: null` is load-bearing: review.ts skips these rows when building the durable attestation
    // map, so recording the drop can never become a way for a dead session's model to certify a
    // live review. The row is a RECORD of a loss, never a claim about what is running.
    const { db, team } = freshTeam();
    const ada = addMember(db, team, { name: 'Ada', kind: 'agent' });
    const attested = attach(db, ada.row.id, 'claude-code', 'c1', { model: 'claude-fable-5' });
    release(db, attested.id, 45_000);
    const born = attach(db, ada.row.id, 'cli', null);
    recordUnattestedOccupancy(db, team.id, ada.row, born.id, 'ambient');

    const detail = JSON.parse(
      listAudit(db, team.id, { limit: 10 }).find((r) => r.action === 'occupancy.model_attested')
        ?.detail ?? '{}',
    ) as { new: unknown };
    expect(detail.new).toBeNull();
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

  it('sticky offline reason: release stamps disconnected; re-attach clears; leave stamps left_team (ADR 141 + presence-honesty split)', () => {
    const { db, team } = freshTeam();
    const ada = addMember(db, team, { name: 'Ada', kind: 'agent' });
    expect(getMemberById(db, ada.row.id)?.last_offline_reason).toBeNull();

    const p = attach(db, ada.row.id, 'claude-code', 'c1');
    release(db, p.id, 45_000);
    expect(getMemberById(db, ada.row.id)?.last_offline_reason).toBe('disconnected');

    attach(db, ada.row.id, 'claude-code', 'c2');
    expect(getMemberById(db, ada.row.id)?.last_offline_reason).toBeNull();

    leaveMember(db, ada.row.id);
    expect(getMemberById(db, ada.row.id)?.last_offline_reason).toBe('left_team');
  });

  it('deliberate-exit stamps: unbind stamps seat_released; clean session end stamps session_ended', () => {
    const { db, team } = freshTeam();
    const ada = addMember(db, team, { name: 'Ada', kind: 'agent' });

    markSeatReleased(db, ada.row.id);
    expect(getMemberById(db, ada.row.id)?.last_offline_reason).toBe('seat_released');

    markSessionEnded(db, ada.row.id);
    expect(getMemberById(db, ada.row.id)?.last_offline_reason).toBe('session_ended');
  });

  it('a said goodbye survives the socket close: release does not overwrite a deliberate-exit stamp', () => {
    // The SessionEnd hook stamps session_ended, then the WS drops moments later. If release()
    // stamped unconditionally, every clean exit would still end up wearing crash clothing.
    const { db, team } = freshTeam();
    const ada = addMember(db, team, { name: 'Ada', kind: 'agent' });
    const p = attach(db, ada.row.id, 'claude-code', 'c1');
    markSessionEnded(db, ada.row.id);
    release(db, p.id, 45_000);
    expect(getMemberById(db, ada.row.id)?.last_offline_reason).toBe('session_ended');
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

  it('reattestSurface updates on a real change, no-ops on same value / missing row', () => {
    const { db, team } = freshTeam();
    const ada = addMember(db, team, { name: 'Ada', kind: 'agent' });
    const p = attach(db, ada.row.id, 'claude-code', 'c1');

    expect(reattestSurface(db, p.id, 'claude-code')).toBeUndefined();
    expect(reattestSurface(db, p.id, 'cursor')).toEqual({ previous: 'claude-code' });
    expect(presenceById(db, p.id)?.surface).toBe('cursor');
    expect(reattestSurface(db, 'nope', 'codex')).toBeUndefined();
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

  it('ambient touch after the attested row is reaped re-attests when the client carries a model (ADR 119 / #172)', () => {
    const { db, team } = freshTeam();
    const ada = addMember(db, team, { name: 'Ada', kind: 'agent' });
    // Claim attested a model on a connectionless occupancy…
    attach(db, ada.row.id, 'cli', null, { model: 'qwen2.5:3b-instruct' });
    expect(currentAttestedModel(db, ada.row.id)).toBe('qwen2.5:3b-instruct');
    // …then the reaper clears it (presence aged past the timeout).
    expect(reapStale(db, 0)).toHaveLength(1);
    expect(currentAttestedModel(db, ada.row.id)).toBeNull();
    // A later one-shot without a model attaches a bare ambient row — the pre-119 hole.
    touchAmbientPresence(db, ada.row.id, 'cli', 45_000, {});
    expect(currentAttestedModel(db, ada.row.id)).toBeNull();
    // With the model in AttachContext (authTouch from x-musterd-model), ambient re-attests.
    touchAmbientPresence(db, ada.row.id, 'cli', 45_000, { model: 'qwen2.5:3b-instruct' });
    expect(currentAttestedModel(db, ada.row.id)).toBe('qwen2.5:3b-instruct');
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

  it('reapExcessIdleObservers keeps the freshest N idle seats per team (ADR 196)', () => {
    const { db, team } = freshTeam();
    const now = Date.now();
    for (let i = 0; i < 5; i++) {
      const m = addMember(db, team, { name: `web-${i}`, kind: 'human', observer: true });
      db.prepare('UPDATE members SET updated_at = ? WHERE id = ?').run(
        now - (5 - i) * 1_000,
        m.row.id,
      );
    }
    // Cap of 2 → keep web-4, web-3 (freshest); reap web-0..web-2.
    const reaped = reapExcessIdleObservers(db, 2, now - 45_000);
    expect(reaped.map((m) => m.name).sort()).toEqual(['web-0', 'web-1', 'web-2']);
    expect(
      listMembers(db, team.id)
        .filter((m) => m.observer)
        .map((m) => m.name)
        .sort(),
    ).toEqual(['web-3', 'web-4']);
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
