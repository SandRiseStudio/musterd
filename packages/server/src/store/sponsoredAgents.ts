import { randomBytes } from 'node:crypto';
import type { Database } from 'better-sqlite3';
import { MusterdError } from '../errors.js';
import { addMember, getMemberByName, hashToken } from './members.js';
import type { MemberRow, TeamRow } from './rows.js';
import { resolveAccountStatus } from './rows.js';

/**
 * Member-created agents (ADR 449 §3–4). A human member mints an agent seat the way `musterd agent`
 * does on the team side — a real agent-kind member with its own name, role and roster row — and
 * gets back a one-time connect nonce instead of a secret. The agent's device redeems that nonce at
 * OAuth authorize (increment 2b) for a token chain bound to the agent seat.
 *
 * Three invariants, all enforced here so no route can skip them:
 * - `sponsored_by` = the caller, so revoking them cascades (§2, `cascadeSponsoredRevocation`);
 * - the agent's `lifecycle_until` is the sponsor's, so it cannot outlive them (an unexpiring
 *   sponsor mints unexpiring agents);
 * - at most {@link SPONSORED_AGENT_CAP} live agents per sponsor.
 */

/** Live sponsored agents per sponsor. Per-team tuning is increment 3. */
export const SPONSORED_AGENT_CAP = 3;

/** How long a connect link lives: long enough to install a harness, short enough to be inert. */
export const CONNECT_NONCE_TTL_MS = 15 * 60 * 1000;

export interface AgentConnectNonce {
  nonce: string;
  expires_at: number;
}

/**
 * Issue a fresh connect nonce for `memberId`, burning any unused one it had — one live link per
 * agent, so a re-issue is also how a sponsor kills a link they sent to the wrong place.
 */
export function issueAgentConnectNonce(
  db: Database,
  teamId: string,
  memberId: string,
  sponsorId: string,
  now = Date.now(),
): AgentConnectNonce {
  const nonce = randomBytes(32).toString('base64url');
  const expires_at = now + CONNECT_NONCE_TTL_MS;
  db.transaction(() => {
    db.prepare(
      'UPDATE agent_connect_nonces SET used_at = ? WHERE member_id = ? AND used_at IS NULL',
    ).run(now, memberId);
    db.prepare(
      `INSERT INTO agent_connect_nonces
         (nonce_hash, team_id, member_id, sponsor_id, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(hashToken(nonce), teamId, memberId, sponsorId, now, expires_at);
  })();
  return { nonce, expires_at };
}

/** Live (not left, not disabled/banned/archived) agents this sponsor has minted. */
export function liveSponsoredAgents(db: Database, teamId: string, sponsorId: string): MemberRow[] {
  return db
    .prepare<[string, string], MemberRow>(
      'SELECT * FROM members WHERE team_id = ? AND sponsored_by = ? AND left_at IS NULL',
    )
    .all(teamId, sponsorId)
    .filter((m) => {
      const s = resolveAccountStatus(m);
      return s !== 'disabled' && s !== 'banned' && s !== 'archived';
    });
}

export function createSponsoredAgent(
  db: Database,
  team: TeamRow,
  sponsor: MemberRow,
  input: { name: string; role?: string | null | undefined },
  now = Date.now(),
): { member: MemberRow } & AgentConnectNonce {
  if (sponsor.kind !== 'human' || sponsor.observer === 1)
    throw new MusterdError('forbidden', 'only a human member can create agents (ADR 449 §3)');
  return db.transaction(() => {
    // `addMember` would *revive* a tombstoned name — row, history and all. A sponsored mint must
    // never inherit someone else's past, so a removed name is refused here, not revived.
    const existing = getMemberByName(db, team.id, input.name);
    if (existing && existing.left_at !== null)
      throw new MusterdError(
        'conflict',
        `"${input.name}" was used by a removed member of "${team.slug}" — pick another name`,
      );
    const live = liveSponsoredAgents(db, team.id, sponsor.id);
    if (live.length >= SPONSORED_AGENT_CAP)
      throw new MusterdError(
        'forbidden',
        `you already have ${live.length} live agents (the cap of ${SPONSORED_AGENT_CAP} per member) — ` +
          `remove one first: ${live.map((m) => m.name).join(', ')}`,
      );
    const expiring = sponsor.lifecycle === 'until' && sponsor.lifecycle_until !== null;
    const { row } = addMember(db, team, {
      name: input.name,
      kind: 'agent',
      role: input.role ?? '',
      sponsoredBy: sponsor.id,
      ...(expiring ? { lifecycle: 'until' as const, lifecycleUntil: sponsor.lifecycle_until } : {}),
    });
    return { member: row, ...issueAgentConnectNonce(db, team.id, row.id, sponsor.id, now) };
  })();
}

/**
 * Redeem a connect nonce exactly once, returning the agent it names — or null for anything a
 * stranger would also get null for: unknown, used, expired, wrong team, or an agent that has since
 * left or been disabled. A wrong-team attempt does not burn it.
 */
export function redeemAgentConnectNonce(
  db: Database,
  teamId: string,
  nonce: string,
  now = Date.now(),
): MemberRow | null {
  return db.transaction(() => {
    const row = db
      .prepare<
        [string],
        { team_id: string; member_id: string; expires_at: number; used_at: number | null }
      >('SELECT team_id, member_id, expires_at, used_at FROM agent_connect_nonces WHERE nonce_hash = ?')
      .get(hashToken(nonce));
    if (!row || row.team_id !== teamId || row.used_at !== null) return null;
    db.prepare('UPDATE agent_connect_nonces SET used_at = ? WHERE nonce_hash = ?').run(
      now,
      hashToken(nonce),
    );
    if (row.expires_at <= now) return null;
    const member = db
      .prepare<
        [string, string],
        MemberRow
      >("SELECT * FROM members WHERE team_id = ? AND id = ? AND left_at IS NULL AND kind = 'agent'")
      .get(teamId, row.member_id);
    if (!member) return null;
    const s = resolveAccountStatus(member);
    if (s === 'disabled' || s === 'banned' || s === 'archived') return null;
    return member;
  })();
}
