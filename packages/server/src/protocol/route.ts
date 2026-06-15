import type { Envelope } from '@musterd/protocol';
import type { Ctx } from '../context.js';
import { MusterdError } from '../errors.js';
import { log } from '../log.js';
import { getMemberByName, getMemberById } from '../store/members.js';
import { insertMessage, rowToEnvelope } from '../store/messages.js';
import type { MemberRow, MessageRow, TeamRow } from '../store/rows.js';

export interface RouteResult {
  message: MessageRow;
  recipients: string[]; // member ids the message is addressed to
  delivered: number; // live deliveries pushed
}

/**
 * The single validate→persist→deliver path shared by WS `send` and HTTP POST messages.
 * The envelope must already be schema-valid; this enforces identity + resolves/persists/delivers.
 */
export function routeEnvelope(
  ctx: Ctx,
  team: TeamRow,
  sender: MemberRow,
  env: Envelope,
): RouteResult {
  if (env.from !== sender.name || env.team !== team.slug) {
    throw new MusterdError('forbidden', 'envelope from/team must match the authenticated member');
  }

  // Resolve recipients.
  let toMemberId: string | null = null;
  let recipients: string[];
  if (env.to.kind === 'member') {
    const target = getMemberByName(ctx.db, team.id, env.to.name);
    if (!target || target.left_at !== null) {
      throw new MusterdError('not_found', `no member "${env.to.name}" in ${team.slug}`);
    }
    toMemberId = target.id;
    recipients = [target.id];
  } else {
    // team or broadcast: everyone currently in the team except the sender.
    recipients = ctx.db
      .prepare<[string, string], { id: string }>(
        'SELECT id FROM members WHERE team_id = ? AND left_at IS NULL AND id != ?',
      )
      .all(team.id, sender.id)
      .map((r) => r.id);
  }

  // Persist (append-only log).
  const message = insertMessage(ctx.db, team.id, sender.id, toMemberId, env);

  // Deliver live to whoever is present. Durability is the log; this is the push.
  let delivered = 0;
  for (const recipientId of recipients) {
    const recipient = getMemberById(ctx.db, recipientId);
    const toName = env.to.kind === 'member' && recipient ? recipient.name : null;
    const outgoing = rowToEnvelope(message, team.slug, sender.name, toName);
    delivered += ctx.hub.deliver(recipientId, { type: 'deliver', envelope: outgoing });
  }

  log.info({
    msg: 'route',
    team: team.slug,
    member: sender.name,
    act: env.act,
    to: env.to.kind,
    recipients: recipients.length,
    delivered,
  });

  return { message, recipients, delivered };
}
