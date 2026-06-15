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
