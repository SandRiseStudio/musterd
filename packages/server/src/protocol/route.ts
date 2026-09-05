import {
  type AskSpecies,
  type AskTier,
  blockedByOf,
  DeferUntilSchema,
  eligibleOf,
  type Envelope,
  isAwaitingAcceptance,
  type Lane,
  makeEnvelope,
  modelFamily,
} from '@musterd/protocol';
import { ulid } from 'ulid';
import type { Ctx } from '../context.js';
import { MusterdError } from '../errors.js';
import { log } from '../log.js';
import { formatAskSlackText, postSlackWebhook } from '../notify/slack.js';
import { appendAudit } from '../store/audit.js';
import { incidentReporters, recordBlockedReport } from '../store/incidents.js';
import { recordLaneClose } from '../store/laneClose.js';
import { deriveHandoffLane, getLane, type HandoffLaneBasis, updateLane } from '../store/lanes.js';
import { getMemberByName, getMemberById } from '../store/members.js';
import { getMessageTs, insertMessage, rowToEnvelope } from '../store/messages.js';
import { currentAttestation } from '../store/presence.js';
import { adminHumanPresent } from '../store/reachability.js';
import { pickHumanReviewer, supersededAcceptanceAsks } from '../store/review.js';
import type { MemberRow, MessageRow, TeamRow } from '../store/rows.js';
import { resolveAccountStatus, resolveCapabilities } from '../store/rows.js';
import { getPolicy, getTeamBySlug } from '../store/teams.js';
import { joinerEnrollment } from '../sync/claim.js';
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
  /** ADR 231 — what happened to a lane-less `handoff`'s lane: the one the daemon attached, or the
   *  warning that the sender holds several and the daemon would not guess. Absent for every other
   *  act, and for a handoff whose sender holds no live lane (the legal lane-less case). */
  handoff_lane?: { lane: string; branch: string | null; source: 'derived' } | { warning: string };
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
  /** ADR 225: the envelope was composed by the daemon, not received from a client, so its
   *  server-controlled meta (`lane_review`) is authentic and survives. **Defaults to false so the
   *  strip fails closed** — a new client-facing route that forgets this cannot mint interrupts, and a
   *  daemon route that forgets it merely loses the interrupt (visible in tests, not exploitable). */
  daemonComposed = false,
): RouteResult {
  return withEnvelopeSpan(env, () =>
    routeEnvelopeInner(ctx, team, sender, env, senderPresenceId, daemonComposed),
  );
}

function routeEnvelopeInner(
  ctx: Ctx,
  team: TeamRow,
  sender: MemberRow,
  env: Envelope,
  senderPresenceId?: string,
  daemonComposed = false,
): RouteResult {
  // ADR 231: a `handoff` that names no lane. Only `lane_handoff` ever wrote
  // `meta.lane_handoff.lane`, so a plain `team_send {act:'handoff'}` hands over work without saying
  // WHICH work — and the orientation `why`, which reads a handoff as a live instruction, then has
  // nothing to check it against and serves stale ones forever (24 of the first 30 handoffs on the
  // dogfood team named no lane). Derived HERE, on the one validate→persist→deliver path, so WS and
  // HTTP and every client above them get it from one implementation. Explicit meta always wins.
  let handoffLane: RouteResult['handoff_lane'];
  /** ADR 243: which evidence answered — audited, never on the wire. */
  let handoffBasis: HandoffLaneBasis | undefined;
  if (env.act === 'handoff' && !(env.meta as { lane_handoff?: unknown } | null)?.lane_handoff) {
    // ADR 243: the recipient is evidence. A handoff act directed at a seat, moments after a lane
    // was transferred to that seat, has a referent that "a lane the sender holds" cannot see — and
    // the held set is exactly where the intended lane is NOT, because lane_handoff already moved it.
    const derived = deriveHandoffLane(
      ctx.db,
      team.id,
      team.slug,
      sender.name,
      env.to.kind === 'member' ? env.to.name : undefined,
    );
    if (derived.kind === 'attach') {
      handoffLane = { lane: derived.lane.id, branch: derived.lane.branch, source: 'derived' };
      env = {
        ...env,
        meta: {
          ...(env.meta ?? {}),
          lane_handoff: { lane: derived.lane.id, branch: derived.lane.branch },
        },
      };
    } else if (derived.kind === 'ambiguous') {
      // Warn, never refuse. The un-threaded `accept` (mcp/tools/send.ts) DOES refuse to guess,
      // because guessing there writes a verdict onto the wrong lane and cannot be recovered. Here,
      // declining to attach leaves the message exactly as it is today — unjudgeable, but never
      // wrong. A message is worth more than a derived field.
      // ADR 243: say which set was ambiguous. "you hold N" is false when the candidates are lanes
      // the sender GAVE AWAY — a warning that misdescribes its own evidence sends the reader
      // looking at the wrong lanes.
      const situation =
        derived.basis === 'handed_to_recipient'
          ? `you handed ${derived.candidates.length} lanes to this seat`
          : `you hold ${derived.candidates.length}`;
      handoffLane = {
        warning:
          `handoff names no lane and ${situation} — the orientation ` +
          '`why` cannot tell the recipient which work this is. Use lane_handoff (its `note` ' +
          'carries the why on the same act), or pass meta.lane_handoff.lane: ' +
          derived.candidates.map((l) => `${l.id} "${l.title}"`).join(', '),
      };
    }
    handoffBasis = derived.kind === 'none' ? undefined : derived.basis;
  }

  if (env.from !== sender.name || env.team !== team.slug) {
    throw new MusterdError('forbidden', 'envelope from/team must match the authenticated member');
  }
  // ADR 327: an insight's finding text is capped at 2048 bytes — server-enforced here on the one
  // validate→persist→deliver path, like seat memory's blob cap (ADR 093), because actMetaRules
  // sees only {act, thread, meta}, never the body.
  if (env.act === 'insight' && Buffer.byteLength(env.body, 'utf8') > 2048) {
    throw new MusterdError('validation', 'act "insight" body is limited to 2048 bytes');
  }
  // Observer seats (ADR 063) are read-only — they watch the firehose but cannot speak.
  if (sender.observer) {
    throw new MusterdError('forbidden', 'observer seats are read-only and cannot send');
  }

  // ADR 211 §1: only the RECIPIENT of an act may defer it. The fold already ignores other people's
  // waits, so a stray deferral could never suppress anyone else's inbox — but "only the recipient"
  // is a stated boundary, and a boundary that is merely inert is not enforced. An unauthorized
  // target is indistinguishable from a missing one (ADR 209 §4): same error either way, so the
  // response never discloses that some other seat's act exists.
  if (env.act === 'wait') {
    const deferRef = (env.meta as { defer_ref?: unknown } | null | undefined)?.defer_ref;
    if (typeof deferRef === 'string' && deferRef.length > 0) {
      const target = ctx.db
        .prepare<
          [string, string],
          { to_kind: string; to_member: string | null }
        >('SELECT to_kind, to_member FROM messages WHERE team_id = ? AND id = ?')
        .get(team.id, deferRef);
      const deliveredToSender =
        target &&
        (target.to_member === sender.id ||
          target.to_kind === 'team' ||
          target.to_kind === 'broadcast');
      if (!deliveredToSender) {
        throw new MusterdError('forbidden', 'cannot defer an act that was not delivered to you');
      }
    }
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

  // ADR 225: `lane_review` is **server-controlled**, on the same grounds as `meta.model` below. The
  // daemon sets it on the review route, and ADR 225 makes it obligation-class in `pendingInterrupts`
  // — so a client-supplied copy would be a free interrupt, routing around the scarce, audited
  // `can_flag_urgent` gate (ADR 071) that every other non-`steer` raise must pass. Stripped silently
  // rather than rejected: the act still lands, it just cannot promote itself to the interrupt line.
  if (!daemonComposed && outgoingEnv.meta && 'lane_review' in outgoingEnv.meta) {
    const { lane_review: _clientLaneReview, ...restMeta } = outgoingEnv.meta;
    outgoingEnv = { ...outgoingEnv, meta: restMeta };
  }

  // Per-act model stamp (ADR 101): the occupancy attestation is the *source*, the stamp on each act
  // is the *dataset*. Model is **entirely server-controlled** — any client-supplied `meta.model` is
  // stripped first (a session can't stamp an act with a model its occupancy didn't attest — the
  // integrity claim the diversity flag rests on), then the sender's current attested occupancy value
  // is stamped when present. Unattested → no stamp at all (reads as `unknown` downstream,
  // warn-never-block). Keyed on the *sending* occupancy (senderPresenceId) so a fanned-out member's
  // two sessions on different models don't cross-attribute (ADR 042 human fan-out).
  // Read as a pair from ONE row: `model_source` says which tier produced `model` — `observed` (a
  // harness probe saw it) vs a declaration. Without it a stamp cannot say whether it is a
  // measurement or an assumption, and an aggregate over both reports a number it cannot support.
  const { model: attestedModel, source: attestedSource } = currentAttestation(
    ctx.db,
    sender.id,
    senderPresenceId,
  );
  // Both keys are server-controlled and stripped from any client-supplied meta, on the same grounds:
  // a session that could stamp its own tier could launder a declaration into an observation, which
  // is the one substitution this field exists to make impossible.
  if (outgoingEnv.meta && ('model' in outgoingEnv.meta || 'model_source' in outgoingEnv.meta)) {
    const { model: _clientModel, model_source: _clientSource, ...restMeta } = outgoingEnv.meta;
    outgoingEnv = { ...outgoingEnv, meta: restMeta };
  }
  if (attestedModel) {
    outgoingEnv = {
      ...outgoingEnv,
      meta: {
        ...outgoingEnv.meta,
        model: attestedModel,
        // Omitted, never defaulted, when the occupancy does not know its own tier (pre-migration-42
        // row, or a client too old to send one). Absence is not an assertion (ADR 236).
        ...(attestedSource ? { model_source: attestedSource } : {}),
      },
    };
    recordActModel(attestedModel);
  }

  // ADR 254: the roster half of eligible-set validation. `actMetaRules` proved the shape; only the
  // daemon can prove the *names*, and it REJECTS rather than dropping — a question addressed to a
  // seat that cannot answer it is worse than a rejected send, because the sender goes on believing
  // someone owes them a reply. Read off `outgoingEnv` so a meta rewrite above can never desync the
  // set that gets validated from the set that gets persisted.
  const eligible = eligibleOf(outgoingEnv.meta);
  if (eligible) {
    for (const name of eligible) {
      const seat = getMemberByName(ctx.db, team.id, name);
      if (!seat || seat.left_at !== null) {
        throw new MusterdError('not_found', `no member "${name}" in ${team.slug}`);
      }
      // An observer isn't a participant (ADR 063) — it receives the act via the firehose and can't
      // send, so it could never discharge one. Naming it would strand the act by construction.
      if (seat.observer === 1) {
        throw new MusterdError(
          'validation',
          `seat "${name}" is an observer and cannot owe an answer`,
        );
      }
      if (seat.id === sender.id) {
        throw new MusterdError('validation', `meta.eligible cannot name the sender ("${name}")`);
      }
    }
  }

  // Resolve recipients. Deliberately UNCHANGED by the eligible set: an eligible-set act is
  // team-addressed, so every seat still receives the push and sees it in their inbox. Only the
  // ledger (`recipientsOf`) and the obligation predicate (`pendingInterrupts`) narrow — visibility
  // and accountability are separate axes, and only the latter was ever meant to shrink.
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
    // ADR 188 stage two: a peer's accept on a risky lane's review ask fires the HUMAN ask, with
    // the peer's findings in the body — the human reviews an already-screened change. Best-effort
    // like every lane delivery: a failure here must never fail the accept itself.
    let escalatedToHuman = false;
    if (env.act === 'accept' && typeof ref === 'string') {
      try {
        escalatedToHuman = fireGatedHumanAsk(ctx, team, sender, ref, env.body);
      } catch (err) {
        log.warn({ msg: 'gated_human_ask_failed', err: String(err) });
      }
    }
    // ADR 202: the verdict MOVES the lane it judges. Before this, an accept wrote telemetry and
    // nothing else — the acceptor had to remember a second, separate call to close the lane, and
    // when they didn't (measured: three lanes in one evening) the owner eventually self-closed and
    // the audit recorded `self_close`/unverified for work that had in fact been reviewed. The
    // acceptance record understated itself, silently and in the safe-looking direction.
    // Skipped when the accept just escalated: a risky lane's peer review hands off to the human it
    // demanded, and that human's verdict is the one that closes.
    if ((env.act === 'accept' || env.act === 'decline') && typeof ref === 'string') {
      try {
        if (!escalatedToHuman) applyAcceptanceVerdict(ctx, team, sender, ref, env.act, env.body);
      } catch (err) {
        log.warn({ msg: 'acceptance_verdict_failed', err: String(err) });
      }
    }
  } else if (env.act === 'resolve' && env.thread) {
    const rootTs = getMessageTs(ctx.db, team.id, env.thread);
    if (rootTs !== null && env.ts >= rootTs)
      recordLoopClosure('resolve', env.ts - rootTs, loopDims);
  }
  // The to-human ask stream lifecycle (ADR 147). Append-only audit rows are the whole stream's trace;
  // the daemon runs no timer — the agent owns the clock (ADR 147 §2). Shapes only, never bodies (ADR 051).
  recordAskLifecycle(ctx, team, sender.name, outgoingEnv);

  // Incident convergence inc 1 (spec 2026-08-14): a `blocked_by` report on a status_update pools,
  // opens, or appends to an incident lane. Best-effort like every daemon-side hook here — a failure
  // must never fail the status_update that carried the report. `!daemonComposed` is the recursion
  // belt; the composed replies being `act:'message'` (which this hook ignores) is the suspenders.
  //
  // On an enrolled JOINER the hook does not run at all (ADR 371 §2): the pool is the hub's. The
  // report crosses on this very status_update, and the hub pools it when the message folds there
  // (`handleFoldedMessages`, called from the hub's pull). Counting here too would be one pool per
  // machine — one incident lane per machine past the threshold, the exact thing §2 refuses.
  if (
    !daemonComposed &&
    env.act === 'status_update' &&
    !joinerEnrollment(ctx.db, team.id, team.slug)
  ) {
    try {
      handleBlockedReport(ctx, team, sender, outgoingEnv);
    } catch (err) {
      log.warn({ msg: 'incident_hook_failed', err: String(err) });
    }
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

  // The to-human ask stream's guaranteed reach (ADR 147 §3): an `ask` routes to admin humans by default.
  // Live-push it to every admin connection on top of normal delivery — skipping admins already delivered
  // to as recipients (and the sender) so no one is double-sent. This is what makes "escalations always
  // technically reach the human" true even when the ask is directed at a non-admin: the durable message
  // row is the inbox reach, this push is the loud reach. (Its loud *surface* — Slack + /live — is item 3.)
  if (env.act === 'ask') {
    ctx.hub.deliverToAdmins(team.id, { type: 'deliver', envelope: firehoseEnv }, skip);
    dispatchAskToSlack(ctx, team, sender.name, outgoingEnv);
  }

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

  // Durable record of both branches (ADR 231 Observability): the derivation is otherwise invisible
  // to the sender's transcript, and the ambiguous count is the counter-signal that says the warning
  // is being ignored. The no-lane case is deliberately unlogged — it is the legal path, and logging
  // it would drown the two that matter.
  if (handoffLane) {
    appendAudit(ctx.db, team.id, {
      actor: sender.name,
      action: 'lane' in handoffLane ? 'handoff.lane_derived' : 'handoff.lane_ambiguous',
      target: message.id,
      result: 'allow',
      detail: {
        message: message.id,
        ...handoffLane,
        // ADR 243: which of the two candidate sets answered. Always written when a derivation
        // happened, so absence means "recorded before ADR 243" and never "the held set" — the
        // ADR 173 rule that a three-valued read needs an unambiguous write edge to mean anything.
        ...(handoffBasis ? { basis: handoffBasis } : {}),
      },
    });
  }
  return { message, recipients, delivered, ...(handoffLane ? { handoff_lane: handoffLane } : {}) };
}

/**
 * Incident convergence inc 1 (spec 2026-08-14 §1–§3, no wakes). Records the `blocked_by` report,
 * then closes the loop the store can't: a DUPLICATE reporter (report matched an open incident) gets
 * the park-behind-it pointer immediately, and the OPENING pair each get one announcement naming the
 * new lane — routed through the normal delivery path, so live sessions get the existing
 * delivery-hint nudge for free and out seats get inbox rows. Daemon-composed envelopes are
 * `act:'message'`, which the caller's status_update guard never matches (recursion bound).
 *
 * The composed messages are sent FROM the lane's owner when it has one, else from the lane's
 * creator (the seat whose report tripped the threshold) — same posture as `fireGatedHumanAsk`,
 * which routes as the lane owner: incident traffic reads as coming from whoever carries the lane.
 */
/**
 * The hub's half of ADR 371 §2: run the route-time hooks a FOLDED message still owes. A joiner's
 * `status_update` carrying a `blocked_by` report was never routed here — it folded — so the pool
 * never saw it. Called from the hub's pull with the ids the fold just inserted (never from a scan
 * of `messages`, which would re-fire on every tick). Only the incident hook lives here: every other
 * route-time hook is either residence-local by design or already replicated as its own kind.
 */
export function handleFoldedMessages(ctx: Ctx, teamSlug: string, messageIds: string[]): void {
  const team = getTeamBySlug(ctx.db, teamSlug);
  if (!team) return;
  for (const id of messageIds) {
    const row = ctx.db
      .prepare<[string, string], MessageRow>('SELECT * FROM messages WHERE team_id = ? AND id = ?')
      .get(team.id, id);
    if (!row || row.act !== 'status_update' || !row.meta) continue;
    const sender = getMemberById(ctx.db, row.from_member);
    if (!sender) continue;
    const to = row.to_member ? getMemberById(ctx.db, row.to_member) : null;
    const env = rowToEnvelope(row, team.slug, sender.name, to?.name ?? null);
    if (!blockedByOf(env.meta)) continue;
    try {
      handleBlockedReport(ctx, team, sender, env);
    } catch (err) {
      log.warn({ msg: 'incident_hook_failed', message: id, err: String(err) });
    }
  }
}

function handleBlockedReport(ctx: Ctx, team: TeamRow, sender: MemberRow, env: Envelope): void {
  const report = blockedByOf(env.meta);
  if (!report) return;
  const outcome = recordBlockedReport(ctx.db, team.id, team.slug, sender.name, report, env.id);
  // `disabled` (team opted out) and `recorded` (still pooling) both mean there is no lane to point
  // anyone at — and in the disabled case nothing was written down at all.
  if (outcome.kind === 'recorded' || outcome.kind === 'disabled') return;

  const lane = outcome.lane;
  const fromRow = laneVoice(ctx, team, lane);
  if (!fromRow) return; // nobody to speak as — the report itself is still durably recorded

  if (outcome.kind === 'appended') {
    // Don't answer the lane's own carrier: the owner re-reporting their own incident needs no pointer.
    if (sender.name === fromRow.name) return;
    const reply = makeEnvelope({
      id: ulid(),
      team: team.slug,
      from: fromRow.name,
      to: { kind: 'member', name: sender.name },
      act: 'message',
      body:
        `[incident] already ${lane.owner_seat ? `owned by ${lane.owner_seat}` : 'open (unclaimed)'}, ` +
        `lane ${lane.id} — park behind it.`,
      thread: env.id,
      meta: { incident: { lane: lane.id, gate: report.gate } },
    });
    routeEnvelope(ctx, team, fromRow, reply, undefined, true);
    appendAudit(ctx.db, team.id, {
      actor: sender.name,
      action: 'incident.duplicate_replied',
      target: lane.id,
      result: 'allow',
      detail: { gate: report.gate, lane: lane.id },
    });
    return;
  }

  // opened: announce to every distinct reporter (the threshold pair, typically). A self-send never
  // reaches an inbox, so when the recipient IS the lane's voice (the tripping reporter created it),
  // speak as another reporter instead — the threshold guarantees at least two exist.
  const reporters = incidentReporters(ctx.db, team.id, lane.id);
  for (const reporter of reporters) {
    const voice =
      reporter === fromRow.name
        ? (reporters
            .filter((r) => r !== reporter)
            .map((r) => getMemberByName(ctx.db, team.id, r))
            .find((m) => m != null) ?? null)
        : fromRow;
    const to = getMemberByName(ctx.db, team.id, reporter);
    if (!to || !voice) continue;
    const announce = makeEnvelope({
      id: ulid(),
      team: team.slug,
      from: voice.name,
      to: { kind: 'member', name: reporter },
      act: 'message',
      body:
        `[incident] opened: ${report.gate} — lane ${lane.id}, unclaimed. ` +
        `If your red matches, park behind it; any seat may claim.`,
      meta: { incident: { lane: lane.id, gate: report.gate } },
    });
    routeEnvelope(ctx, team, voice, announce, undefined, true);
  }
}

/**
 * Tell the seat an unclaimed incident was just handed to (ADR 271, spec §3), and tell the reporters
 * their red now has an owner.
 *
 * The voice cannot come from `laneVoice` here: assignment has ALREADY set `owner_seat`, so
 * `laneVoice` would return the new owner and every message would be a self-send — which never
 * reaches an inbox (the lesson increment 1 paid for on the open announcement). So the voice is
 * explicitly a reporter other than the recipient.
 *
 * Called from the reaper rather than a transport, on the `seeds/ingest.ts` precedent: a
 * daemon-composed act routed through normal delivery, so live sessions get the existing
 * delivery-hint nudge for free. `daemonComposed` is set, which is also the recursion belt — these
 * are `message` acts and would otherwise re-enter the blocked-report hook.
 */
export function announceIncidentRouted(
  ctx: Ctx,
  team: TeamRow,
  lane: Lane,
  owner: string,
  waitedMs: number,
): void {
  const reporters = incidentReporters(ctx.db, team.id, lane.id);
  const voiceFor = (recipient: string): MemberRow | null =>
    reporters
      .filter((r) => r !== recipient)
      .map((r) => getMemberByName(ctx.db, team.id, r))
      .find((m) => m != null) ??
    (lane.created_by !== recipient
      ? (getMemberByName(ctx.db, team.id, lane.created_by) ?? null)
      : null);

  const minutes = Math.round(waitedMs / 60_000);
  // The owner first, and they are told they can hand it back — an assignment nobody chose is a
  // routing default, not a verdict about who should fix it. Then the reporters, so the seats parked
  // behind the red learn it has an owner without anyone asking a human to relay it.
  const recipients: [string, string][] = [
    [
      owner,
      `[incident] routed to you: "${lane.title}" — lane ${lane.id}, unclaimed for ${minutes}m so it fell to your role. ` +
        `You did not choose it: hand it off or release it if someone with the context is closer.`,
    ],
    ...reporters
      .filter((r) => r !== owner)
      .map((r): [string, string] => [
        r,
        `[incident] "${lane.title}" now owned by ${owner} — lane ${lane.id}. Your report is on it; stay parked.`,
      ]),
  ];

  for (const [recipient, body] of recipients) {
    const to = getMemberByName(ctx.db, team.id, recipient);
    const voice = voiceFor(recipient);
    if (!to || !voice) continue;
    routeEnvelope(
      ctx,
      team,
      voice,
      makeEnvelope({
        id: ulid(),
        team: team.slug,
        from: voice.name,
        to: { kind: 'member', name: recipient },
        act: 'message',
        body,
        meta: { incident: { lane: lane.id, routed_to: owner } },
      }),
      undefined,
      true,
    );
  }
}

/**
 * Fan a resolved incident out to exactly the seats who reported it (ADR 271, spec §3).
 *
 * This is what every appended report was FOR. Increment 1 kept inserting a row per report even past
 * the threshold, on the stated bet that more refs make a better fan-out at resolve — this collects
 * it. A seat that parked a PR behind a shared red has no other way to learn it can move again short
 * of a human noticing and relaying, which is the exact job the spec set out to delete.
 *
 * Called from BOTH close paths — the board's PATCH and the ADR 202 acceptor `accept` — because
 * `recordLaneClose` deliberately cannot route envelopes (it is imported from the transport and the
 * protocol layer both, and routing from it would make that a cycle). Non-incident lanes return
 * immediately, so both call sites can call it unconditionally.
 */
export function announceIncidentResolved(
  ctx: Ctx,
  team: TeamRow,
  lane: Lane,
  closedBy: string,
): void {
  if (lane.kind !== 'incident') return;
  const reporters = incidentReporters(ctx.db, team.id, lane.id);
  const voice = getMemberByName(ctx.db, team.id, closedBy);
  if (!voice) return;

  for (const reporter of reporters) {
    // The closer already knows; a self-send reaches no inbox anyway.
    if (reporter === closedBy) continue;
    const to = getMemberByName(ctx.db, team.id, reporter);
    if (!to) continue;
    routeEnvelope(
      ctx,
      team,
      voice,
      makeEnvelope({
        id: ulid(),
        team: team.slug,
        from: voice.name,
        to: { kind: 'member', name: reporter },
        act: 'message',
        body:
          `[incident] resolved by ${closedBy}: ${lane.title.replace(/^incident: /, '')} — ` +
          `lane ${lane.id}. Whatever you parked behind it can move; re-run before you trust it.`,
        meta: { incident: { lane: lane.id, resolved_by: closedBy } },
      }),
      undefined,
      true,
    );
  }
}

/** The seat incident traffic speaks as: the lane's owner, else its creator. */
function laneVoice(ctx: Ctx, team: TeamRow, lane: Lane): MemberRow | null {
  return (
    (lane.owner_seat ? getMemberByName(ctx.db, team.id, lane.owner_seat) : null) ??
    getMemberByName(ctx.db, team.id, lane.created_by) ??
    null
  );
}

/**
 * ADR 188 stage two — the gated human ask. Fires when an ACCEPT lands whose replied-to message is a
 * lane-review ask (`meta.lane_review`) for a lane that is (a) risky and (b) still awaiting acceptance.
 * Composes the blocking-tier human ask FROM the lane's owner (the worker whose lane it is — same
 * sender as the stage-one ask) carrying the peer's findings, and audits `lane.review_peer_confirmed`
 * whether or not a human was live — `human_ask_fired: false` is the countable degradation
 * (ADR 173), and the close edge still derives `human_review_missed` when no human ever confirms.
 *
 * A peer accept on a NON-risky lane's review ask does nothing here: one review is that lane's whole
 * contract. Recursion is bounded — the composed act is an `ask`, which this hook never matches.
 *
 * Returns whether it ESCALATED — i.e. whether a human was asked and the lane is now waiting on them.
 * The caller needs that answer: since ADR 202 an accept also closes the lane it accepts, and a risky
 * lane whose peer review just escalated must stay open for the human whose verdict was demanded.
 */
function fireGatedHumanAsk(
  ctx: Ctx,
  team: TeamRow,
  peer: MemberRow,
  repliedToId: string,
  peerFindings: string,
): boolean {
  const replied = ctx.db
    .prepare<
      [string, string],
      { meta: string | null }
    >('SELECT meta FROM messages WHERE team_id = ? AND id = ?')
    .get(team.id, repliedToId);
  if (!replied?.meta) return false;
  let laneReview: { lane?: string; title?: string; grade?: string } | undefined;
  try {
    laneReview = (JSON.parse(replied.meta) as { lane_review?: typeof laneReview }).lane_review;
  } catch {
    return false;
  }
  if (!laneReview?.lane) return false;
  const lane = getLane(ctx.db, team.id, laneReview.lane, team.slug);
  if (!lane || lane.risk.length === 0 || !isAwaitingAcceptance(lane.state)) return false;
  const owner = lane.owner_seat ? getMemberByName(ctx.db, team.id, lane.owner_seat) : null;
  if (!owner) return false;

  const human = pickHumanReviewer(ctx.db, team.id, owner.name, ctx.config.presenceTimeoutMs);
  appendAudit(ctx.db, team.id, {
    actor: peer.name,
    action: 'lane.review_peer_confirmed',
    target: lane.id,
    result: 'allow',
    detail: {
      lane: lane.id,
      peer: peer.name,
      grade: laneReview.grade ?? null,
      human_ask_fired: human !== null,
    },
  });
  if (!human) return false;

  const findings = peerFindings.length > 500 ? `${peerFindings.slice(0, 500)}…` : peerFindings;
  const checklist =
    'Judge the LANDED OUTCOME (not a code review): ' +
    '(1) Intent — matches the lane brief? ' +
    '(2) Principles — project/musterd hard rules? ' +
    '(3) Usable — exercise the path enough to say it works? ' +
    '(4) Feel — only if UI/copy/brand is in surface, else N/A. ' +
    'Accept → move the lane to done; reject → send it back to active with a concrete note.';
  const ask = makeEnvelope({
    id: ulid(),
    team: team.slug,
    from: owner.name,
    to: { kind: 'member', name: human.reviewer },
    act: 'ask',
    body:
      `[lane] human acceptance required: "${lane.title}" — peer ${peer.name} accepted with: ` +
      `"${findings}". ${checklist}`,
    meta: {
      species: 'approve',
      tier: 'blocking',
      lane_review: {
        lane: lane.id,
        title: lane.title,
        branch: lane.branch,
        ...(lane.merged ? { merged: lane.merged } : {}),
        route: 'human_admin',
        grade: 'human',
        peer_confirmed_by: peer.name,
      },
    },
  });
  // daemonComposed: the daemon authored this ask, so its `lane_review` is authentic (ADR 225).
  routeEnvelope(ctx, team, owner, ask, undefined, true);
  return true;
}

/**
 * ADR 202 — an acceptance verdict moves the lane it judges.
 *
 * `accept` closes the lane the ask named; `decline` sends it back to `active`, which is exactly what
 * the board's two acceptor verbs do (`boardWrite.laneActions`). This is the same transition by the
 * other door: the acceptor who answers in chat and the acceptor who clicks on the board now leave
 * the same record, and neither has to know that the other surface exists.
 *
 * Deliberately narrow, because this mutates state from a message path:
 * · Only from a real `lane_review` ask — the ask carries the lane id, so nothing is inferred.
 * · Only while the lane is still awaiting acceptance. That makes it idempotent (a second accept on
 *   the same ask does nothing) and keeps a stale ask from reopening or re-closing settled work.
 * · The close audit goes through `recordLaneClose`, the same derivation the board's PATCH uses, so
 *   verified-ness cannot come out differently depending on which door the verdict came through.
 *   An owner who accepts their own lane records `verified: false` by that same derivation — the
 *   honesty is structural, not a check I have to remember to write here.
 */
function applyAcceptanceVerdict(
  ctx: Ctx,
  team: TeamRow,
  decider: MemberRow,
  repliedToId: string,
  act: 'accept' | 'decline',
  body: string,
): void {
  const replied = ctx.db
    .prepare<
      [string, string],
      { meta: string | null }
    >('SELECT meta FROM messages WHERE team_id = ? AND id = ?')
    .get(team.id, repliedToId);
  if (!replied?.meta) return;
  let laneId: string | undefined;
  try {
    laneId = (JSON.parse(replied.meta) as { lane_review?: { lane?: string } }).lane_review?.lane;
  } catch {
    return;
  }
  if (!laneId) return;
  const before = getLane(ctx.db, team.id, laneId, team.slug);
  if (!before || !isAwaitingAcceptance(before.state)) return;
  // A re-route (lane 01M1QYHJFY) told this seat the acceptance moved to someone else and closed
  // its ask. Its verdict still lands as a message — it is not refused as an act — but it binds to
  // nothing: the lane's acceptance is the NEW seat's to give, and honouring both would let two
  // seats close one lane.
  if (supersededAcceptanceAsks(ctx.db, team.id, laneId).has(repliedToId)) {
    log.info({
      msg: 'acceptance_verdict_on_superseded_ask',
      lane: laneId,
      ask: repliedToId,
      decider: decider.name,
    });
    return;
  }

  const lane = updateLane(
    ctx.db,
    team.id,
    laneId,
    team.slug,
    { state: act === 'accept' ? 'done' : 'active' },
    Date.now(),
    undefined,
    { actor: decider.name },
  );
  if (!lane) return;

  if (act === 'accept') {
    recordLaneClose(ctx.db, team.id, decider, before, lane);
    // ADR 271: the same fan-out the board's PATCH does. An incident closed by an acceptor's `accept`
    // owes its reporters exactly the same answer as one closed by a click — neither surface should
    // have to know the other exists. No-op for every ordinary lane.
    announceIncidentResolved(ctx, team, lane, decider.name);
  } else {
    // ADR 192: an acceptor moving an awaiting_acceptance lane back to a live state is the rejection
    // — the counterpart said "not what we wanted". Audit action stays `lane.review_sent_back`
    // (frozen), and the reason rides along so a sent-back lane can be told from a manual reopen.
    const note = body.trim();
    appendAudit(ctx.db, team.id, {
      actor: decider.name,
      action: 'lane.review_sent_back',
      target: lane.id,
      result: 'allow',
      // Keep the human's concrete rejection reason with the frozen audit action. Bound it like
      // peer findings: the message is already durable, but audit detail is used in reports and
      // must not become an unbounded copy of an arbitrary Act body.
      detail: {
        lane: lane.id,
        reviewer: decider.name,
        owner: before.owner_seat,
        ...(note ? { note: note.length > 500 ? `${note.slice(0, 500)}…` : note } : {}),
      },
    });
  }

  // The board-shape change the team sees, composed by the daemon (ADR 102) exactly as the PATCH
  // path composes it — same body, same meta, so a reader of the stream cannot tell which surface
  // the verdict arrived on, because it does not matter.
  const note =
    act === 'accept'
      ? {
          body: `[lane] resolved "${lane.title}"`,
          meta: { lane_resolve: { lane: lane.id, title: lane.title, state: lane.state } },
        }
      : {
          body: `[lane] "${lane.title}" → ${lane.state}`,
          meta: { lane_state: { lane: lane.id, title: lane.title, state: lane.state } },
        };
  routeEnvelope(
    ctx,
    team,
    decider,
    makeEnvelope({
      id: ulid(),
      team: team.slug,
      from: decider.name,
      to: { kind: 'team' },
      act: 'message',
      body: note.body,
      meta: note.meta,
    }),
  );
}

/**
 * Append the to-human ask stream's lifecycle rows (ADR 147). One row per event — the whole stream's
 * trace lives in the audit log, not in a new table, and the daemon fires no timeout (the agent owns the
 * clock, ADR 147 §2). The envelope is already schema-valid (`actMetaRules`), so the discriminating meta
 * is present when its act/field is; reads stay defensive anyway. Shapes only, never bodies (ADR 051).
 */
function recordAskLifecycle(ctx: Ctx, team: TeamRow, actor: string, env: Envelope): void {
  const meta = env.meta ?? {};
  // A new ask was raised — the species/tier that set its contract, and (if directed) whom it named.
  if (env.act === 'ask') {
    appendAudit(ctx.db, team.id, {
      actor,
      action: 'ask.raised',
      target: env.to.kind === 'member' ? env.to.name : null,
      result: 'allow',
      detail: { species: meta['species'], tier: meta['tier'] },
    });
    return;
  }
  // The agent's no-answer resolution (rides `status_update`, ADR 147 §4): the timeout elapsed unanswered.
  const outcome = meta['ask_outcome'];
  const askRef = typeof meta['ask_ref'] === 'string' ? meta['ask_ref'] : null;
  if (outcome === 'held') {
    appendAudit(ctx.db, team.id, {
      actor,
      action: 'ask.held',
      target: askRef,
      result: 'allow',
      detail: { ask_ref: askRef },
    });
    return;
  }
  // The strand terminal (ADR 153 §2): a top-tier ask with no reachable unblocker — the agent released
  // its lane (WIP recorded on the branch) and stopped, never proceeding. One append-only row makes the
  // dead-end queryable: "this seat legitimately could not proceed, and no unblocker existed."
  if (outcome === 'stranded') {
    appendAudit(ctx.db, team.id, {
      actor,
      action: 'ask.stranded',
      target: askRef,
      result: 'allow',
      detail: { ask_ref: askRef, reason: 'no_reachable_unblocker' },
    });
    return;
  }
  if (outcome === 'risk_accepted') {
    appendAudit(ctx.db, team.id, {
      actor,
      action: 'ask.risk_accepted',
      target: askRef,
      result: 'allow',
      // The record IS the risk-acceptance: what was risked, the approach taken, and that the human was
      // unreachable in the window — the auditable fact ADR 145 §3.1 promised, attributable to `actor`.
      detail: {
        ask_ref: askRef,
        risk: meta['risk'],
        chosen_approach: meta['chosen_approach'],
        human_unreachable: true,
      },
    });
    return;
  }
  // The human "deciding — check back in ⟨until⟩" reply (rides `wait`, ADR 147 §5).
  if (env.act === 'wait' && askRef) {
    appendAudit(ctx.db, team.id, {
      actor,
      action: 'ask.deferred',
      target: askRef,
      result: 'allow',
      detail: { ask_ref: askRef, until: meta['until'] },
    });
  }
  // The recipient's own postponement (rides `wait`, ADR 211 §1). Distinct from `ask.deferred` above
  // in both actor and meaning: that one is the SENDER saying "deciding, check back"; this is the
  // RECIPIENT saying "not now, raise it when ⟨cond⟩".
  //
  // Detail is the condition KIND only. Not the lane id, not the body (ADR 051) — the eval needs the
  // split between condition kinds and the deferral→raise interval, and neither needs content. There
  // is deliberately no `raised` counterpart: a raise is derived at read time and has no event, and
  // emitting one would invent a fact the system does not have (ADR 189).
  const deferRef = meta['defer_ref'];
  if (env.act === 'wait' && typeof deferRef === 'string' && deferRef.length > 0) {
    const until = DeferUntilSchema.safeParse(meta['until']);
    if (until.success) {
      appendAudit(ctx.db, team.id, {
        actor,
        action: 'inbox.deferred',
        target: deferRef,
        result: 'allow',
        detail: { until: 'reply' in until.data ? 'reply' : 'lane' },
      });
    }
  }
}

/**
 * The ask stream's Slack delivery (ADR 149) — the loud reach, fired beside the admin push. Opt-in via
 * the team-policy `ask_slack_webhook` (unset = no outbound call ever) and **detached from the send
 * path**: the POST runs fire-and-forget after persist + deliver, so a slow or dead endpoint can
 * neither delay nor fail the send. Each attempt audits `ask.surfaced` (attempt + outcome — never the
 * URL, never the body), so "did the loud reach fire, did the endpoint take it" is one audit query
 * beside `ask.raised`. Best-effort like `appendAudit` itself: any failure is a recorded fact, not an
 * error.
 *
 * Presence informs the clock, never the ceiling (ADR 155 Increment 2): when an admin human composes
 * *present* (`working`/`idle`), the raise stays quiet — the human already got the live admin push +
 * inbox row, and the loud surface waits for the agent's re-notify (an in-thread `ask`, which always
 * fires). When no admin is present (away/dnd/off_hours, or offline-but-notifiable), Slack fires at
 * raise — sitting a local timer for a demonstrably-away human wastes the window. This shifts only
 * *which surface fires when*: the tier's absolute timeout and the `held`/`stranded` terminals are
 * byte-for-byte the ADR 153 contract either way. Whether the loud surface fired at raise or on
 * re-notify is legible from the existing `ask.surfaced` timestamp beside `ask.raised` — no new trace.
 */
function dispatchAskToSlack(ctx: Ctx, team: TeamRow, actor: string, env: Envelope): void {
  const webhook = getPolicy(ctx.db, team.id).ask_slack_webhook;
  if (!webhook) return;
  const isRenotify = typeof env.thread === 'string' && env.thread.length > 0;
  if (!isRenotify && adminHumanPresent(ctx.db, team.id, ctx.config.presenceTimeoutMs)) return;
  const meta = env.meta ?? {};
  const text = formatAskSlackText({
    team: team.slug,
    from: actor,
    species: typeof meta['species'] === 'string' ? (meta['species'] as AskSpecies) : undefined,
    tier: typeof meta['tier'] === 'string' ? (meta['tier'] as AskTier) : undefined,
    body: env.body,
  });
  void postSlackWebhook(webhook, text).then(({ ok, status }) => {
    appendAudit(ctx.db, team.id, {
      actor,
      action: 'ask.surfaced',
      target: env.to.kind === 'member' ? env.to.name : null,
      result: 'allow',
      detail: { surface: 'slack', ok, ...(status !== undefined ? { status } : {}) },
    });
  });
}
