import { type Envelope, modelFamily } from '@musterd/protocol';
import type { Ctx } from '../context.js';
import { MusterdError } from '../errors.js';
import { log } from '../log.js';
import { appendAudit } from '../store/audit.js';
import { getMemberByName, getMemberById } from '../store/members.js';
import { getMessageTs, insertMessage, rowToEnvelope } from '../store/messages.js';
import { currentAttestedModel } from '../store/presence.js';
import type { MemberRow, MessageRow, TeamRow } from '../store/rows.js';
import { resolveAccountStatus, resolveCapabilities } from '../store/rows.js';
import {
  recordActModel,
  recordDeliveryOutcome,
  recordLoopClosure,
  recordTokenUsage,
  withEnvelopeSpan,
} from '../telemetry.js';

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
  /** The sending connection's presence/occupancy id (ADR 101) — so the per-act model stamp reads
   *  *this* session's attestation, not the member's newest presence. Omitted on the stateless HTTP
   *  message paths (no live occupancy), which fall back to the member's freshest attested presence. */
  senderPresenceId?: string,
): RouteResult {
  return withEnvelopeSpan(env, () => routeEnvelopeInner(ctx, team, sender, env, senderPresenceId));
}

function routeEnvelopeInner(
  ctx: Ctx,
  team: TeamRow,
  sender: MemberRow,
  env: Envelope,
  senderPresenceId?: string,
): RouteResult {
  if (env.from !== sender.name || env.team !== team.slug) {
    throw new MusterdError('forbidden', 'envelope from/team must match the authenticated member');
  }
  // Observer seats (ADR 063) are read-only — they watch the firehose but cannot speak.
  if (sender.observer) {
    throw new MusterdError('forbidden', 'observer seats are read-only and cannot send');
  }

  // v0.3 P2 send gates (ADR 071) on the existing token auth. The sender's effective capabilities +
  // resolved account status are projected onto the row by reconcile (ADR 070); the generalist default
  // (active, can_message:team, can_flag_urgent:true) passes everything, so an un-governed team is
  // unaffected.
  const caps = resolveCapabilities(sender);
  const status = resolveAccountStatus(sender);
  const target = env.to.kind === 'member' ? env.to.name : null;

  // account_status: a disabled/banned/archived seat cannot send (provisioned/active send normally).
  if (status === 'disabled' || status === 'banned' || status === 'archived') {
    appendAudit(ctx.db, team.id, {
      actor: sender.name,
      action: 'send.denied',
      target,
      result: 'deny',
      detail: { account_status: status },
    });
    throw new MusterdError('forbidden', `seat "${sender.name}" is ${status} and cannot send`);
  }

  // can_message: a muted seat (`none`) cannot address the team.
  if (caps.can_message === 'none') {
    appendAudit(ctx.db, team.id, {
      actor: sender.name,
      action: 'send.denied',
      target,
      result: 'deny',
      detail: { can_message: 'none' },
    });
    throw new MusterdError('forbidden', `seat "${sender.name}" is muted (can_message: none)`);
  }

  // can_flag_urgent: the urgency breakthrough (ADR 044) is the scarce, auditable flag. A seat without
  // the capability is **downgraded, not rejected** (the message still lands, just not as a breakthrough):
  // strip `urgent`, mark `wasnt_urgent` so the recipient + firehose see the denied attempt, keep the
  // reason for context. An allowed urgent is audited too (the flag is meant to be legible).
  let outgoingEnv = env;
  if (env.meta?.['urgent'] === true) {
    const rawReason = env.meta['urgent_reason'];
    const detail = typeof rawReason === 'string' ? { reason: rawReason } : {};
    if (caps.can_flag_urgent) {
      appendAudit(ctx.db, team.id, {
        actor: sender.name,
        action: 'urgent.flagged',
        target,
        result: 'allow',
        detail,
      });
    } else {
      const { urgent: _urgent, ...restMeta } = env.meta;
      outgoingEnv = { ...env, meta: { ...restMeta, wasnt_urgent: true } };
      appendAudit(ctx.db, team.id, {
        actor: sender.name,
        action: 'urgent.denied',
        target,
        result: 'deny',
        detail,
      });
    }
  }

  // Per-act model stamp (ADR 101): the occupancy attestation is the *source*, the stamp on each act
  // is the *dataset*. Model is **entirely server-controlled** — any client-supplied `meta.model` is
  // stripped first (a session can't stamp an act with a model its occupancy didn't attest — the
  // integrity claim the diversity flag rests on), then the sender's current attested occupancy value
  // is stamped when present. Unattested → no stamp at all (reads as `unknown` downstream,
  // warn-never-block). Keyed on the *sending* occupancy (senderPresenceId) so a fanned-out member's
  // two sessions on different models don't cross-attribute (ADR 042 human fan-out).
  const attestedModel = currentAttestedModel(ctx.db, sender.id, senderPresenceId);
  if (outgoingEnv.meta && 'model' in outgoingEnv.meta) {
    const { model: _clientModel, ...restMeta } = outgoingEnv.meta;
    outgoingEnv = { ...outgoingEnv, meta: restMeta };
  }
  if (attestedModel) {
    outgoingEnv = { ...outgoingEnv, meta: { ...outgoingEnv.meta, model: attestedModel } };
    recordActModel(attestedModel);
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
    // team or broadcast: every participant currently in the team except the sender. Observers (ADR
    // 063) aren't participants — they receive it via the firehose, not as addressed recipients.
    recipients = ctx.db
      .prepare<[string, string], { id: string }>(
        'SELECT id FROM members WHERE team_id = ? AND left_at IS NULL AND observer = 0 AND id != ?',
      )
      .all(team.id, sender.id)
      .map((r) => r.id);
  }

  // Persist (append-only log) — the urgent-downgraded envelope when applicable, so the stored meta and
  // every delivery (direct + firehose, all derived from the row) carry the corrected flags.
  const message = insertMessage(ctx.db, team.id, sender.id, toMemberId, outgoingEnv);

  // Coordination loop latency (ADR 082 slice 3): accept/decline close the directed act they answer
  // (meta.in_reply_to); resolve closes its thread root. Emitted first-party instead of reconstructed
  // (finding 001). Best-effort — an unknown reference just records nothing.
  // Dimension the loop by team + the closer's model family (#207): "how fast does model X close
  // loops" is the per-model leaderboard's headline metric. `attestedModel` is this closer's occupancy
  // model (resolved above); absent → no family label (never guessed).
  const loopDims = {
    team: env.team,
    ...(attestedModel ? { family: modelFamily(attestedModel) } : {}),
  };
  if (env.act === 'accept' || env.act === 'decline') {
    const ref = env.meta?.['in_reply_to'];
    const refTs = typeof ref === 'string' ? getMessageTs(ctx.db, team.id, ref) : null;
    if (refTs !== null && env.ts >= refTs) recordLoopClosure(env.act, env.ts - refTs, loopDims);
  } else if (env.act === 'resolve' && env.thread) {
    const rootTs = getMessageTs(ctx.db, team.id, env.thread);
    if (rootTs !== null && env.ts >= rootTs)
      recordLoopClosure('resolve', env.ts - rootTs, loopDims);
  }
  // Self-reported token usage (meta.usage — ADR 082 slice 4): opt-in, harness-agnostic.
  recordTokenUsage(outgoingEnv);

  // Deliver live to whoever is present. Durability is the log; this is the push — its outcome per
  // recipient (live vs inboxed) is attempt history, recorded as span events (ADR 090), never rows.
  let delivered = 0;
  for (const recipientId of recipients) {
    const recipient = getMemberById(ctx.db, recipientId);
    const toName = env.to.kind === 'member' && recipient ? recipient.name : null;
    const outgoing = rowToEnvelope(message, team.slug, sender.name, toName);
    const pushed = ctx.hub.deliver(recipientId, { type: 'deliver', envelope: outgoing });
    delivered += pushed;
    if (recipient) recordDeliveryOutcome(recipient.name, pushed > 0);
  }

  // Fan out to firehose observers (ADR 061): every envelope on the team, for read-only watchers like
  // the dashboard. Skip recipients (already delivered) and the sender (got an ack) so no double-send.
  const firehoseEnv = rowToEnvelope(
    message,
    team.slug,
    sender.name,
    env.to.kind === 'member' ? env.to.name : null,
  );
  const skip = new Set(recipients);
  skip.add(sender.id);
  // Directed (member-kind) envelopes reach only full-visibility connections on the firehose — admins
  // and read-only observers (ADR 063); team/broadcast acts stay public. Regular non-party members no
  // longer see others' DMs (recipient-scoping).
  const firehoseDelivered = ctx.hub.broadcastFirehose(
    team.id,
    { type: 'deliver', envelope: firehoseEnv },
    skip,
    message.to_kind === 'member',
  );

  log.info({
    msg: 'route',
    team: team.slug,
    member: sender.name,
    act: env.act,
    to: env.to.kind,
    recipients: recipients.length,
    delivered,
    firehose_delivered: firehoseDelivered,
  });

  return { message, recipients, delivered };
}
