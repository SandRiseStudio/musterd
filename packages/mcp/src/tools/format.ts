import type { Envelope } from '@musterd/protocol';

/** Compact text rendering of a message for an agent to read. */
export function formatMessage(env: Envelope): string {
  const to =
    env.to.kind === 'member'
      ? `→ ${env.to.name}`
      : env.to.kind === 'team'
        ? '→ @team'
        : '→ @broadcast';
  const meta = env.meta && Object.keys(env.meta).length ? ` ${JSON.stringify(env.meta)}` : '';
  return `${env.from} [${env.act}] ${to}: ${env.body}${meta} (id=${env.id})`;
}

export function textResult(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

/**
 * The dormant-guard message for acting tools. If a prior (auto)join failed, include *why* —
 * otherwise a silent autojoin failure (e.g. a wrong-db token rejection) just reads as
 * "call team_join first" and the real cause (member offline everywhere) stays hidden.
 */
export function notJoinedMessage(action: string, lastJoinError: string | null): string {
  const base = `you haven't joined the team yet — call team_join first, then ${action}`;
  return lastJoinError ? `${base}.\nNote: the last join attempt failed: ${lastJoinError}` : base;
}

/**
 * Guard message for an acting tool when the session isn't ready (claim-on-first-use, ADR 032/033).
 * Two distinct states: **pending** (no seat claimed yet → name yourself), and **dormant** (claimed
 * but not joined → just join). Refusing cleanly here is what "pending presence … team_send /
 * team_inbox_check refuse while unclaimed" means.
 */
export function notReadyMessage(
  client: { claimed: boolean; lastJoinError: string | null; claimCode: string },
  action: string,
): string {
  if (!client.claimed) {
    return (
      `you're a pending presence (unclaimed, code ${client.claimCode}) — you hold no seat, so you ` +
      `can't ${action}. Claim one first: team_join {as:'Ada'} (named) or team_join {role:'backend'} ` +
      `(pool), or have a human run \`musterd claim <name>\` here.`
    );
  }
  return notJoinedMessage(action, client.lastJoinError);
}
