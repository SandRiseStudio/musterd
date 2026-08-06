import type { McpServer } from '@modelcontextprotocol/server';
import {
  type Act,
  ACTS,
  type AskTier,
  AskTierSchema,
  askContract,
  askContractText,
  type Envelope,
  makeEnvelope,
  type Recipient,
} from '@musterd/protocol';
import { ulid } from 'ulid';
import { z } from 'zod';
import type { MusterdClient } from '../client.js';
import type { McpConfig } from '../config.js';
import { withTraceContext } from '../otel.js';
import { errorResult, notReadyMessage, textResult } from './format.js';

// Rewritten for concision + retrievability (ADR 144 inc 2): the act vocabulary is the API and
// stays complete, one terse clause each; the plan-epoch/interrupt mechanics live in the skill.
//
// The trailing example is inc 4's `input_examples` lever, and it is spent HERE and nowhere else on
// purpose. Examples cost surface bytes on every connect, so they only earn their place where the
// coercion layer cannot forgive the mistake: `to`/`body` drift is now repaired silently, but
// `ask`'s conditionally-required `meta.species`/`meta.tier` cannot be — nothing in a bare `ask`
// says which species the caller meant, and guessing would misroute a human's attention. So the one
// shape that must be shown is the one shape that can only be taught.
const DESCRIPTION =
  "Send an act to a teammate, '@team', or '@broadcast'. Acts: status_update = report progress; " +
  'request_help = you are blocked; handoff = pass work; accept/decline = answer the latest open ' +
  'ask (set reply_to to override); wait = paused; resolve = close a thread (set thread to its ' +
  'root id); steer = redirect a teammate (interrupts; newest steer wins; meta.goal_id scopes it ' +
  'to a Goal); challenge = demand justification (answered by an accept with evidence); defer = ' +
  "re-sequence a Goal (meta.goal_id, meta.wave: a number reorders, 'later' defers); ask = a " +
  'directed-to-human ask (meta.species: consult|escalate|approve, meta.tier: advisory|standard|' +
  'blocking) — the reply tells you how long to wait and what to do if no answer comes. Goal-scoped ' +
  'steer/defer re-sequence the plan and flag lanes building against the old one. ' +
  'e.g. {act:"status_update",body:"…"}; an ask needs meta: ' +
  '{act:"ask",to:"nick",body:"…",meta:{species:"consult",tier:"standard"}}.';

function recipient(to: string): Recipient {
  if (to === '@team') return { kind: 'team' };
  if (to === '@broadcast') return { kind: 'broadcast' };
  return { kind: 'member', name: to };
}

/** Acts an `accept`/`decline` can answer: a call for help, a handoff, a `challenge` (ADR 103), or a
 *  to-human `ask` (ADR 147 — an admin accepts/declines the latest open ask without naming it). */
const ANSWERABLE = new Set<Act>(['request_help', 'handoff', 'challenge', 'ask']);

/** Does this envelope carry a lane acceptance ask (ADR 192)? Those are verdicts about a NAMED
 * artifact, which is why they are never auto-targeted (§ {@link openAnswerable}). */
function isLaneReviewAsk(m: Envelope): boolean {
  const meta = m.meta as { lane_review?: { lane?: string } } | null | undefined;
  return typeof meta?.lane_review?.lane === 'string';
}

/**
 * Still-open request_help/handoff/challenge/ask waiting for `me` — the acts an `accept`/`decline`
 * answers when the caller didn't name one (ADR 067, parity with the CLI's `send`). A `request_help`
 * (anyone can answer) or an act directed at `me`, whose thread carries no `resolve`, newest first.
 * Best-effort: a read failure → empty.
 */
async function openAnswerable(client: MusterdClient, me: string): Promise<Envelope[]> {
  try {
    const { messages, answered } = await client.fetchInbox(false);
    const resolved = new Set<string>();
    for (const m of messages) if (m.act === 'resolve' && m.thread) resolved.add(m.thread);
    // An act I already replied to is not open, and only the server can tell me so: the inbox
    // excludes my own sends, so the reply that answers it never appears in `messages`. Reading
    // closure from `resolve` alone left every answered ask open forever — 199 accepts against 9
    // resolves on the live ledger — which silted up the lane-acceptance candidate list with dead
    // asks and could push the live one out of the six it shows. Absent on an older daemon ⇒ empty ⇒
    // exactly the previous behaviour.
    const alreadyAnswered = new Set(answered ?? []);
    const open = messages.filter((m) => {
      if (!ANSWERABLE.has(m.act)) return false;
      const directed =
        m.act === 'request_help' || m.act === 'ask' || (m.to.kind === 'member' && m.to.name === me);
      return directed && !resolved.has(m.thread ?? m.id) && !alreadyAnswered.has(m.id);
    });
    return open.sort((a, b) => b.ts - a.ts);
  } catch {
    return [];
  }
}

/** Narrow an unknown meta.tier to a valid `AskTier` (validation already enforced it on `ask`). */
function isAskTier(tier: unknown): tier is AskTier {
  return AskTierSchema.safeParse(tier).success;
}

export function registerSend(server: McpServer, client: MusterdClient, config: McpConfig): void {
  server.registerTool(
    'team_send',
    {
      description: DESCRIPTION,
      inputSchema: {
        to: z.string().default('@team').describe("member name, or '@team', or '@broadcast'"),
        // Derived from ACTS (the protocol's single source of truth) so the MCP surface can never drift
        // from the enum — a new act lands here the moment it's appended (ADR 103). Rebuilt with this
        // package's zod (4) rather than importing ActSchema: the protocol package is still on zod 3,
        // and a zod-3 schema object is not a zod-4 type at the registerTool boundary.
        act: z.enum(ACTS),
        body: z.string(),
        thread: z.string().optional().describe('thread id to reply within'),
        reply_to: z
          .string()
          .optional()
          .describe('message id this accepts/declines; omit to answer the latest open ask'),
        meta: z
          .record(z.string(), z.unknown())
          .optional()
          .describe('act-specific fields, e.g. {progress:0.5}'),
      },
    },
    async (args) => {
      if (!client.holdsSeat || !config.member) {
        return textResult(notReadyMessage(client, 'send'));
      }
      const meta: Record<string, unknown> = { ...(args.meta ?? {}) };
      if (args.reply_to) meta['in_reply_to'] = args.reply_to;

      // accept/decline auto-targeting (ADR 067, parity with the CLI): when answering without an explicit
      // reply target, point at the latest open request_help/handoff for this member and inherit its
      // thread, so closing the loop is one tool call. An explicit reply_to / meta.in_reply_to wins.
      let thread = args.thread;
      if (
        (args.act === 'accept' || args.act === 'decline') &&
        !args.reply_to &&
        !meta['in_reply_to']
      ) {
        const open = await openAnswerable(client, config.member);
        const target = open[0];
        if (!target) {
          return textResult(
            `no open request to ${args.act} — pass reply_to with the message id (see team_inbox_check)`,
          );
        }
        // A lane acceptance is a verdict about a NAMED artifact, so "newest open ask" is never a safe
        // guess: writing a considered verdict takes minutes, and any ask arriving meanwhile silently
        // steals it. Observed live 2026-07-31 — an accept whose body read "Lane A accepted" bound to
        // lane B's ask 90s newer, so the thread record says B was accepted by a review of A. Refuse to
        // guess rather than mis-attribute; plain request_help/handoff keep the ADR 067 convenience,
        // because answering the wrong one of those is recoverable and answering the wrong lane is not.
        if (isLaneReviewAsk(target) && open.length > 1) {
          const lines = open
            .slice(0, 6)
            .map((m) => {
              const lane = (m.meta as { lane_review?: { lane?: string } } | null)?.lane_review
                ?.lane;
              return `  reply_to:${m.id}  ${m.act} from ${m.from}${lane ? ` — lane ${lane}` : ''}`;
            })
            .join('\n');
          return textResult(
            `${open.length} open asks and the newest is a lane acceptance — name the one you are ` +
              `answering with reply_to, so the verdict lands on the lane you actually reviewed:\n${lines}`,
          );
        }
        meta['in_reply_to'] = target.id;
        thread ??= target.thread ?? target.id;
      }

      // Ride the adapter's active trace context along as meta.otel (ADR 011) so a handoff links the
      // sender's and receiver's traces across runtimes. Inert when there's no active context.
      const metaToSend = withTraceContext(Object.keys(meta).length ? meta : null);
      try {
        const envelope = makeEnvelope({
          id: ulid(),
          team: config.team,
          from: config.member,
          to: recipient(args.to),
          act: args.act as Act,
          body: args.body,
          thread: thread ?? null,
          meta: metaToSend,
        });
        const ackBody = await client.sendEnvelope(envelope);
        client.markSeen(envelope.id); // don't echo our own send back via inbox
        // The ask's tier contract (ADR 147 §2): the agent owns the clock, so the send response hands it
        // back its marching orders — how long to wait, and the no-answer policy to invoke on silence. The
        // top tier HOLDS (never proceed); below-top PROCEEDS with a recorded risk-acceptance
        // (status_update, meta.ask_ref + meta.ask_outcome:'risk_accepted' + meta.risk + meta.chosen_approach).
        // The daemon's ack may carry the derived contract with `unblocker_reachable` (ADR 153) — prefer
        // it: when provably unreachable, the top-tier orders become STRAND, not hold. Older daemons omit
        // it and the pure local contract stands.
        const serverContract = ackBody?.ask_contract;
        const askGuidance =
          args.act === 'ask' && isAskTier(meta['tier'])
            ? askContractText(envelope.id, meta['tier'], serverContract?.unblocker_reachable)
            : null;
        // The delivery hint (ADR 167): the daemon says the recipient is live on this machine, and the
        // relay is the SENDER's to make (only live desktop sessions hold the harness's session-send
        // tool). Quoted verbatim so the model can relay it unmodified — the fingerprint check on the
        // other end verifies exactly that. Absent hint (older daemon, offline recipient, damped) ⇒
        // this response is byte-identical to before the ADR.
        const hint = ackBody?.delivery_hint;
        const hintGuidance = hint
          ? ` Recipient is live: if you have the ccd session tools, find their session via ` +
            `list_sessions (seat-name label) and send_message this line VERBATIM: "${hint.nudge_text}"`
          : '';
        // The handoff's lane (ADR 231): a `handoff` that named no lane either got one attached —
        // because the sender held exactly one live lane, so there was nothing to choose between —
        // or gets told it holds several and the orientation `why` cannot tell which. Surfaced
        // rather than silent: work was linked to the message on the sender's behalf, and they are
        // the one who can correct it.
        const handoffLane = ackBody?.handoff_lane;
        const handoffGuidance = !handoffLane
          ? ''
          : 'warning' in handoffLane
            ? ` NOTE: ${handoffLane.warning}`
            : ` Lane ${handoffLane.lane} attached (your only live lane` +
              `${handoffLane.branch ? `, branch ${handoffLane.branch}` : ''}) — ` +
              `re-send with meta.lane_handoff.lane if this handoff was about something else.`;
        // Structured-first (ADR 144 inc 3): the id/thread a programmatic caller needs to keep the
        // exchange threaded (reply_to / thread on the next send), without parsing the prose.
        const text =
          (askGuidance
            ? `sent ask to ${args.to} (id=${envelope.id}). ${askGuidance}`
            : `sent ${args.act} to ${args.to} (id=${envelope.id})`) +
          hintGuidance +
          handoffGuidance;
        return {
          content: [{ type: 'text' as const, text }],
          structuredContent: {
            id: envelope.id,
            act: args.act,
            to: args.to,
            thread: envelope.thread,
            ...(args.act === 'ask' && isAskTier(meta['tier'])
              ? { ask_contract: serverContract ?? askContract(meta['tier']) }
              : {}),
            ...(hint ? { delivery_hint: hint } : {}),
            ...(handoffLane ? { handoff_lane: handoffLane } : {}),
          },
        };
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
