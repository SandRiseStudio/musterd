import { resolveRosterRoots } from '../config.js';
import type { Ctx } from '../context.js';
import { MusterdError } from '../errors.js';
import { teamSpecForSlug } from '../projection/reconcile.js';
import { appendAudit } from '../store/audit.js';
import type { MemberRow, TeamRow } from '../store/rows.js';
import { createSponsoredAgent } from '../store/sponsoredAgents.js';

/**
 * The one mint path for member-created agents (ADR 449 §3), shared by `POST …/members/agents` and
 * the remote `team_agent_create` tool so the two surfaces cannot drift: the file-backed refusal,
 * the store's invariants (human-only, inherited expiry, cap, no revived names), the audit row, and
 * the connect link.
 */
export function mintSponsoredAgent(
  ctx: Ctx,
  team: TeamRow,
  sponsor: MemberRow,
  input: { name: string; role?: string | null | undefined },
  origin: string,
): { member: MemberRow; connect_url: string; connect_expires_at: number } {
  // A file-backed team's seat files are the single writer (ADR 058): a db-originated seat would be
  // double-sourced there. Member-created agents need a team whose roster lives in the daemon.
  if (teamSpecForSlug([...new Set([...ctx.rosterRoots, ...resolveRosterRoots()])], team.slug))
    throw new MusterdError(
      'forbidden',
      `"${team.slug}" keeps its roster in seat files — add an agent there (\`musterd agent\`); ` +
        'member-created agents need a team whose roster lives in the daemon',
    );
  const { member, nonce, expires_at } = createSponsoredAgent(ctx.db, team, sponsor, input);
  appendAudit(ctx.db, team.id, {
    actor: sponsor.name,
    action: 'member.sponsored_agent_created',
    target: member.name,
    result: 'allow',
    detail: { lifecycle_until: member.lifecycle_until },
  });
  return {
    member,
    connect_url: agentConnectUrl(origin, team.slug, nonce),
    connect_expires_at: expires_at,
  };
}

/** ADR 449 §4 / ADR 170: the nonce rides the fragment — never sent to a server, never logged. */
export function agentConnectUrl(origin: string, slug: string, nonce: string): string {
  return `${origin}/join/${encodeURIComponent(slug)}/agent#${nonce}`;
}

/** The public origin as the client saw it — the tunnel's `x-forwarded-proto` and the Host header. */
export function originFrom(
  host: string | null | undefined,
  proto: string | null | undefined,
): string {
  const first = proto?.split(',')[0]?.trim().toLowerCase();
  return `${first === 'https' ? 'https' : 'http'}://${host ?? 'localhost'}`;
}
