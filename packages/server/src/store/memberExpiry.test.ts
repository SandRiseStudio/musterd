import { describe, expect, it } from 'vitest';
import { openDb } from '../db/open.js';
import {
  addMember,
  authMember,
  cascadeSponsoredRevocation,
  mintAgentSeatCredential,
  mintCredential,
} from './members.js';
import { mintTokenPair, registerClient } from './oauth.js';
import { resolveAccountStatus } from './rows.js';
import { createTeam } from './teams.js';

/**
 * ADR 449 increment 1 — the two enforcement halves that need no server: a member whose `until`
 * lifecycle has passed is refused on every credential kind, and revoking a sponsor takes their
 * sponsored members (transitively) with them. The member-created-agent surface is increment 2.
 */

const HOUR = 60 * 60 * 1000;

function teamWithExpiringHuman(until: number) {
  const db = openDb(':memory:');
  const team = createTeam(db, { slug: 'acme' });
  const { row } = addMember(db, team, {
    name: 'guest',
    kind: 'human',
    lifecycle: 'until',
    lifecycleUntil: until,
  });
  const { credential } = mintCredential(db, row.id);
  return { db, team, row, credential };
}

describe('lifecycle_until is enforced at auth (ADR 449 §2)', () => {
  it('refuses an expired human on their mscr_ credential', () => {
    const { db, credential } = teamWithExpiringHuman(Date.now() - HOUR);
    expect(() => authMember(db, 'acme', credential)).toThrowError(/membership expired/);
  });

  it('admits the same member before their expiry', () => {
    const { db, credential } = teamWithExpiringHuman(Date.now() + HOUR);
    expect(authMember(db, 'acme', credential).member.name).toBe('guest');
  });

  it('refuses an expired human on an OAuth msat_ bearer (ADR 446 remote MCP)', () => {
    const { db, team, row } = teamWithExpiringHuman(Date.now() - HOUR);
    const { client_id } = registerClient(db, {
      teamId: team.id,
      clientName: 'phone',
      redirectUris: ['https://claude.ai/api/mcp/auth_callback'],
    });
    // Minted before expiry is irrelevant: the token outlives nothing — auth reads the clock.
    const { access_token } = mintTokenPair(db, {
      teamId: team.id,
      memberId: row.id,
      clientId: client_id,
    });
    expect(() => authMember(db, 'acme', access_token)).toThrowError(/membership expired/);
  });

  it('refuses an expired agent on its msac_ credential too', () => {
    const db = openDb(':memory:');
    const team = createTeam(db, { slug: 'acme' });
    const { row } = addMember(db, team, {
      name: 'helper',
      kind: 'agent',
      lifecycle: 'until',
      lifecycleUntil: Date.now() - HOUR,
    });
    const { seat_credential } = mintAgentSeatCredential(db, row.id);
    expect(() =>
      authMember(db, 'acme', seat_credential, undefined, undefined, { leaseless: true }),
    ).toThrowError(/membership expired/);
  });

  it('leaves lifecycle "forever" members untouched (revive-shaped teams)', () => {
    const db = openDb(':memory:');
    const team = createTeam(db, { slug: 'rev' });
    const { row } = addMember(db, team, { name: 'stanley', kind: 'human' });
    const { credential } = mintCredential(db, row.id);
    expect(authMember(db, 'rev', credential).member.name).toBe('stanley');
  });
});

describe('sponsorship + cascading revocation (ADR 449 §3)', () => {
  it('addMember records sponsored_by', () => {
    const db = openDb(':memory:');
    const team = createTeam(db, { slug: 'acme' });
    const { row: human } = addMember(db, team, { name: 'guest', kind: 'human' });
    const { row: agent } = addMember(db, team, {
      name: 'guest-scout',
      kind: 'agent',
      sponsoredBy: human.id,
    });
    expect(agent.sponsored_by).toBe(human.id);
  });

  it('revoking a sponsor disables their sponsored members, transitively, and reports each one', () => {
    const db = openDb(':memory:');
    const team = createTeam(db, { slug: 'acme' });
    const { row: human } = addMember(db, team, { name: 'guest', kind: 'human' });
    const { row: a1 } = addMember(db, team, {
      name: 'scout',
      kind: 'agent',
      sponsoredBy: human.id,
    });
    const { row: a2 } = addMember(db, team, { name: 'digger', kind: 'agent', sponsoredBy: a1.id });
    const { row: other } = addMember(db, team, { name: 'bystander', kind: 'agent' });

    const affected = cascadeSponsoredRevocation(db, team.id, human.id);
    expect(affected.map((m) => m.name).sort()).toEqual(['digger', 'scout']);
    for (const id of [a1.id, a2.id]) {
      const row = db
        .prepare<
          [string],
          { account_status: string | null }
        >('SELECT account_status FROM members WHERE id = ?')
        .get(id)!;
      expect(row.account_status).toBe('disabled');
    }
    const untouched = db
      .prepare<
        [string],
        { account_status: string | null }
      >('SELECT account_status FROM members WHERE id = ?')
      .get(other.id)!;
    expect(untouched.account_status).toBeNull();
  });

  it('a disabled sponsored member is refused at auth', () => {
    const db = openDb(':memory:');
    const team = createTeam(db, { slug: 'acme' });
    const { row: human } = addMember(db, team, { name: 'guest', kind: 'human' });
    const { row: agent } = addMember(db, team, {
      name: 'scout',
      kind: 'agent',
      sponsoredBy: human.id,
    });
    const { seat_credential } = mintAgentSeatCredential(db, agent.id);
    cascadeSponsoredRevocation(db, team.id, human.id);
    expect(
      resolveAccountStatus(db.prepare('SELECT * FROM members WHERE id = ?').get(agent.id) as never),
    ).toBe('disabled');
    expect(() =>
      authMember(db, 'acme', seat_credential, undefined, undefined, { leaseless: true }),
    ).toThrowError(/disabled/);
  });
});
