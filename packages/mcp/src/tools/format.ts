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
