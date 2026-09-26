import { describe, expect, it } from 'vitest';
import { openDb } from '../db/open.js';
import { addMember, getMemberByName, leaveMember } from './members.js';
import {
  CONNECT_NONCE_TTL_MS,
  SPONSORED_AGENT_CAP,
  createSponsoredAgent,
  issueAgentConnectNonce,
  mintConnectNonce,
  redeemAgentConnectNonce,
} from './sponsoredAgents.js';
import { createTeam } from './teams.js';

/**
 * ADR 449 §3–4, increment 2a — the store half of member-created agents: a human mints an agent
 * seat that records them as sponsor, can never outlive them, is capped per sponsor, and is reached
 * through a one-time connect nonce (hashed at rest, single-use, 15 minutes). Redemption at OAuth
 * authorize is increment 2b; the store's redeem is exercised here so 2b wires a tested primitive.
 */

const HOUR = 60 * 60 * 1000;

function teamWithHuman(opts: { until?: number } = {}) {
  const db = openDb(':memory:');
  const team = createTeam(db, { slug: 'acme' });
  const { row: human } = addMember(db, team, {
    name: 'dana',
    kind: 'human',
    ...(opts.until !== undefined
      ? { lifecycle: 'until' as const, lifecycleUntil: opts.until }
      : {}),
  });
  return { db, team, human };
}

describe('createSponsoredAgent (ADR 449 §3)', () => {
  it('mints an agent-kind member sponsored by the caller, with a connect nonce', () => {
    const { db, team, human } = teamWithHuman();
    const { member, nonce, expires_at } = createSponsoredAgent(db, team, human, {
      name: 'dana-scout',
      role: 'research',
    });
    expect(member.kind).toBe('agent');
    expect(member.sponsored_by).toBe(human.id);
    expect(member.role).toBe('research');
    expect(nonce).toMatch(/^[A-Za-z0-9_-]{43}$/); // randomBytes(32), base64url
    expect(expires_at - Date.now()).toBeLessThanOrEqual(CONNECT_NONCE_TTL_MS);
  });

  it('stores only the nonce hash', () => {
    const { db, team, human } = teamWithHuman();
    const { nonce } = createSponsoredAgent(db, team, human, { name: 'dana-scout' });
    const rows = db.prepare('SELECT * FROM agent_connect_nonces').all() as Record<
      string,
      unknown
    >[];
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain(nonce);
  });

  it('an unexpiring sponsor mints an unexpiring agent', () => {
    const { db, team, human } = teamWithHuman();
    const { member } = createSponsoredAgent(db, team, human, { name: 'dana-scout' });
    expect(member.lifecycle).not.toBe('until');
    expect(member.lifecycle_until).toBeNull();
  });

  it("an expiring sponsor's agent inherits the sponsor's end — it cannot outlive them", () => {
    const until = Date.now() + 2 * HOUR;
    const { db, team, human } = teamWithHuman({ until });
    const { member } = createSponsoredAgent(db, team, human, { name: 'dana-scout' });
    expect(member.lifecycle).toBe('until');
    expect(member.lifecycle_until).toBe(until);
  });

  it('refuses an agent caller — only human members sponsor', () => {
    const { db, team } = teamWithHuman();
    const { row: agent } = addMember(db, team, { name: 'bot', kind: 'agent' });
    expect(() => createSponsoredAgent(db, team, agent, { name: 'bot-child' })).toThrowError(
      /only a human member/,
    );
  });

  it(`refuses the ${SPONSORED_AGENT_CAP + 1}th live agent, naming the cap`, () => {
    const { db, team, human } = teamWithHuman();
    for (let i = 0; i < SPONSORED_AGENT_CAP; i++)
      createSponsoredAgent(db, team, human, { name: `a${i}` });
    expect(() => createSponsoredAgent(db, team, human, { name: 'one-too-many' })).toThrowError(
      new RegExp(`cap of ${SPONSORED_AGENT_CAP}`),
    );
  });

  it('a removed agent frees its slot under the cap', () => {
    const { db, team, human } = teamWithHuman();
    const made = [];
    for (let i = 0; i < SPONSORED_AGENT_CAP; i++)
      made.push(createSponsoredAgent(db, team, human, { name: `a${i}` }).member);
    leaveMember(db, made[0]!.id);
    expect(createSponsoredAgent(db, team, human, { name: 'replacement' }).member.name).toBe(
      'replacement',
    );
  });

  it('refuses a live name', () => {
    const { db, team, human } = teamWithHuman();
    expect(() => createSponsoredAgent(db, team, human, { name: 'dana' })).toThrowError(
      /already exists/,
    );
  });

  it("refuses a removed member's name — a sponsored mint never revives someone else's history", () => {
    const { db, team, human } = teamWithHuman();
    const { row: old } = addMember(db, team, { name: 'ghost-of-old', kind: 'agent' });
    leaveMember(db, old.id);
    expect(() => createSponsoredAgent(db, team, human, { name: 'ghost-of-old' })).toThrowError(
      /was used by a removed member/,
    );
    expect(getMemberByName(db, team.id, 'ghost-of-old')!.left_at).not.toBeNull();
  });
});

describe('agent connect nonce (ADR 449 §4)', () => {
  it('redeems once, for the agent it was minted for, on its own team', () => {
    const { db, team, human } = teamWithHuman();
    const { member, nonce } = createSponsoredAgent(db, team, human, { name: 'dana-scout' });
    expect(redeemAgentConnectNonce(db, team.id, nonce)?.id).toBe(member.id);
    expect(redeemAgentConnectNonce(db, team.id, nonce)).toBeNull();
  });

  it('a wrong-team attempt neither redeems nor burns it', () => {
    const { db, team, human } = teamWithHuman();
    const other = createTeam(db, { slug: 'other' });
    const { member, nonce } = createSponsoredAgent(db, team, human, { name: 'dana-scout' });
    expect(redeemAgentConnectNonce(db, other.id, nonce)).toBeNull();
    expect(redeemAgentConnectNonce(db, team.id, nonce)?.id).toBe(member.id);
  });

  it('is void past its TTL', () => {
    const { db, team, human } = teamWithHuman();
    const { nonce } = createSponsoredAgent(db, team, human, { name: 'dana-scout' });
    expect(redeemAgentConnectNonce(db, team.id, nonce, Date.now() + CONNECT_NONCE_TTL_MS + 1)).toBe(
      null,
    );
  });

  it('re-issuing burns the previous nonce — one live link per agent', () => {
    const { db, team, human } = teamWithHuman();
    const { member, nonce: first } = createSponsoredAgent(db, team, human, { name: 'dana-scout' });
    const { nonce: second } = issueAgentConnectNonce(db, team.id, member.id, human.id);
    expect(redeemAgentConnectNonce(db, team.id, first)).toBeNull();
    expect(redeemAgentConnectNonce(db, team.id, second)?.id).toBe(member.id);
  });

  it('refuses to redeem for an agent that has since been removed or disabled', () => {
    const { db, team, human } = teamWithHuman();
    const { member, nonce } = createSponsoredAgent(db, team, human, { name: 'dana-scout' });
    leaveMember(db, member.id);
    expect(redeemAgentConnectNonce(db, team.id, nonce)).toBeNull();
  });
});

describe('mintConnectNonce', () => {
  it('redraws a nonce that would begin with a credential prefix', () => {
    const unlucky = Buffer.from('mscr_' + 'A'.repeat(38), 'base64url');
    const lucky = Buffer.alloc(32, 7);
    const draws = [unlucky, lucky];
    const nonce = mintConnectNonce(() => draws.shift()!);
    expect(nonce).toBe(lucky.toString('base64url'));
    expect(unlucky.toString('base64url').startsWith('mscr_')).toBe(true);
  });
});
