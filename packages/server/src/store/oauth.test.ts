import { describe, expect, it } from 'vitest';
import { openDb } from '../db/open.js';
import { MusterdError } from '../errors.js';
import { addMember, authMember } from './members.js';
import {
  burnUnexchangedCodes,
  issueCode,
  mintTokenPair,
  pkceChallenge,
  redeemCode,
  registerClient,
  revokeAllForMember,
  revokeToken,
  rotateRefresh,
  verifyAccess,
} from './oauth.js';
import { createTeam } from './teams.js';

function freshHuman() {
  const db = openDb(':memory:');
  const team = createTeam(db, { slug: 'dawn' });
  const { row } = addMember(db, team, { name: 'Nick', kind: 'human', role: '' });
  const { client_id } = registerClient(db, {
    teamId: team.id,
    clientName: 'Claude',
    redirectUris: ['https://app.example/cb'],
  });
  return { db, team, member: row, client_id };
}

const VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
const CHALLENGE = pkceChallenge(VERIFIER);

function codeFor(db: ReturnType<typeof openDb>, f: ReturnType<typeof freshHuman>) {
  return issueCode(db, {
    teamId: f.team.id,
    memberId: f.member.id,
    clientId: f.client_id,
    redirectUri: 'https://app.example/cb',
    codeChallenge: CHALLENGE,
  });
}

describe('oauth store (ADR 446)', () => {
  it('code redeem → mint → bearer authenticates like mscr_, no lease', () => {
    const f = freshHuman();
    const { code } = codeFor(f.db, f);
    const { memberId } = redeemCode(f.db, {
      teamId: f.team.id,
      clientId: f.client_id,
      code,
      redirectUri: 'https://app.example/cb',
      verifier: VERIFIER,
    });
    expect(memberId).toBe(f.member.id);
    const pair = mintTokenPair(f.db, {
      teamId: f.team.id,
      memberId,
      clientId: f.client_id,
    });
    expect(pair.access_token.startsWith('msat_')).toBe(true);
    expect(pair.refresh_token.startsWith('msrt_')).toBe(true);
    // No lease presented — and none required.
    const auth = authMember(f.db, 'dawn', pair.access_token);
    expect(auth.member.name).toBe('Nick');
    expect(authMember(f.db, 'dawn', pair.access_token, 'Nick').member.name).toBe('Nick');
    expect(() => authMember(f.db, 'dawn', pair.access_token, 'Ada')).toThrow(MusterdError);
  });

  it('code is single-use — a replay is refused', () => {
    const f = freshHuman();
    const { code } = codeFor(f.db, f);
    const input = {
      teamId: f.team.id,
      clientId: f.client_id,
      code,
      redirectUri: 'https://app.example/cb',
      verifier: VERIFIER,
    };
    redeemCode(f.db, input);
    expect(() => redeemCode(f.db, input)).toThrow(/replayed/);
  });

  it('PKCE downgrade, redirect mismatch, and expiry all fail closed', () => {
    const f = freshHuman();
    const { code } = codeFor(f.db, f);
    const base = {
      teamId: f.team.id,
      clientId: f.client_id,
      code,
      redirectUri: 'https://app.example/cb' as string,
      verifier: VERIFIER,
    };
    expect(() => redeemCode(f.db, { ...base, verifier: 'wrong' })).toThrow(/PKCE/);
    expect(() => redeemCode(f.db, { ...base, redirectUri: 'https://evil.example/cb' })).toThrow(
      /redirect/,
    );
    expect(() => redeemCode(f.db, base, Date.now() + 91_000)).toThrow(/expired/);
    // Cross-team bearer is refused.
    const pair = mintTokenPair(f.db, {
      teamId: f.team.id,
      memberId: f.member.id,
      clientId: f.client_id,
    });
    expect(() => authMember(f.db, 'dawn2', pair.access_token)).toThrow();
  });

  it('refresh rotates on the same chain — reuse revokes the chain', () => {
    const f = freshHuman();
    const first = mintTokenPair(f.db, {
      teamId: f.team.id,
      memberId: f.member.id,
      clientId: f.client_id,
    });
    const second = rotateRefresh(f.db, {
      teamId: f.team.id,
      clientId: f.client_id,
      refreshToken: first.refresh_token,
    });
    expect(second.access_token).not.toBe(first.access_token);
    // Old access token still valid until its own hour; burned refresh re-presented = theft signal.
    expect(verifyAccess(f.db, f.team.id, first.access_token).name).toBe('Nick');
    expect(() =>
      rotateRefresh(f.db, {
        teamId: f.team.id,
        clientId: f.client_id,
        refreshToken: first.refresh_token,
      }),
    ).toThrow(/revoked/);
    // The whole chain is dead — including the just-minted pair.
    expect(() => verifyAccess(f.db, f.team.id, second.access_token)).toThrow();
    expect(() =>
      rotateRefresh(f.db, {
        teamId: f.team.id,
        clientId: f.client_id,
        refreshToken: second.refresh_token,
      }),
    ).toThrow(/revoked/);
  });

  it('revoke drops one token; revoke-all drops the seat', () => {
    const f = freshHuman();
    const pair = mintTokenPair(f.db, {
      teamId: f.team.id,
      memberId: f.member.id,
      clientId: f.client_id,
    });
    expect(revokeToken(f.db, f.team.id, pair.access_token)).toBe(true);
    expect(() => verifyAccess(f.db, f.team.id, pair.access_token)).toThrow();
    const pair2 = mintTokenPair(f.db, {
      teamId: f.team.id,
      memberId: f.member.id,
      clientId: f.client_id,
    });
    expect(revokeAllForMember(f.db, f.team.id, f.member.id)).toBeGreaterThan(0);
    expect(() => verifyAccess(f.db, f.team.id, pair2.access_token)).toThrow();
    expect(() =>
      rotateRefresh(f.db, {
        teamId: f.team.id,
        clientId: f.client_id,
        refreshToken: pair2.refresh_token,
      }),
    ).toThrow();
  });

  it('bearer for a departed seat is refused', () => {
    const f = freshHuman();
    const pair = mintTokenPair(f.db, {
      teamId: f.team.id,
      memberId: f.member.id,
      clientId: f.client_id,
    });
    f.db.prepare('UPDATE members SET left_at = ? WHERE id = ?').run(Date.now(), f.member.id);
    expect(() => verifyAccess(f.db, f.team.id, pair.access_token)).toThrow(/gone/);
  });
});

describe('agent chains and member standing at the token endpoint (ADR 452 §2–4)', () => {
  const HOUR = 3600_000;

  function mint(f: ReturnType<typeof freshHuman>, memberId = f.member.id) {
    return mintTokenPair(f.db, { teamId: f.team.id, memberId, clientId: f.client_id });
  }

  it('verifyAccess admits an agent-bound chain (§3)', () => {
    const f = freshHuman();
    const { row: agent } = addMember(f.db, f.team, { name: 'scout', kind: 'agent' });
    const pair = mint(f, agent.id);
    expect(verifyAccess(f.db, f.team.id, pair.access_token).name).toBe('scout');
  });

  it('burnUnexchangedCodes refuses a code issued before a supersede (§2.3)', () => {
    const f = freshHuman();
    const { code } = codeFor(f.db, f);
    expect(burnUnexchangedCodes(f.db, f.team.id, f.member.id)).toBe(1);
    expect(() =>
      redeemCode(f.db, {
        teamId: f.team.id,
        clientId: f.client_id,
        code,
        redirectUri: 'https://app.example/cb',
        verifier: VERIFIER,
      }),
    ).toThrow(/replayed/);
    expect(burnUnexchangedCodes(f.db, f.team.id, f.member.id)).toBe(0);
  });

  it("caps the pair at the member's lifecycle_until (§4 / ADR 449 §1)", () => {
    const f = freshHuman();
    const until = Date.now() + 10 * 60_000;
    f.db
      .prepare("UPDATE members SET lifecycle = 'until', lifecycle_until = ? WHERE id = ?")
      .run(until, f.member.id);
    const pair = mint(f);
    expect(pair.expires_in).toBeLessThanOrEqual(600);
    expect(pair.expires_in).toBeGreaterThan(590);
    const refresh = f.db
      .prepare("SELECT expires_at FROM oauth_tokens WHERE kind = 'refresh'")
      .get() as { expires_at: number };
    expect(refresh.expires_at).toBeLessThanOrEqual(until);
  });

  it('an unexpiring member keeps the full TTLs', () => {
    const f = freshHuman();
    expect(mint(f).expires_in).toBe(3600);
  });

  it('refresh for a member whose standing ended is refused AND revokes the chain', () => {
    for (const end of ['disabled', 'expired', 'left'] as const) {
      const f = freshHuman();
      const pair = mint(f);
      if (end === 'disabled')
        f.db
          .prepare("UPDATE members SET account_status = 'disabled' WHERE id = ?")
          .run(f.member.id);
      if (end === 'expired')
        f.db
          .prepare("UPDATE members SET lifecycle = 'until', lifecycle_until = ? WHERE id = ?")
          .run(Date.now() - HOUR, f.member.id);
      if (end === 'left')
        f.db.prepare('UPDATE members SET left_at = ? WHERE id = ?').run(Date.now(), f.member.id);
      expect(() =>
        rotateRefresh(f.db, {
          teamId: f.team.id,
          clientId: f.client_id,
          refreshToken: pair.refresh_token,
        }),
      ).toThrow(MusterdError);
      const live = f.db
        .prepare('SELECT COUNT(*) AS n FROM oauth_tokens WHERE revoked_at IS NULL')
        .get() as { n: number };
      expect(live.n, end).toBe(0);
    }
  });
});
