import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  type Act,
  ActSchema,
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
const DESCRIPTION =
  "Send an act to a teammate, '@team', or '@broadcast'. Acts: status_update = report progress; " +
  'request_help = you are blocked; handoff = pass work; accept/decline = answer the latest open ' +
  'ask (set reply_to to override); wait = paused; resolve = close a thread (set thread to its ' +
  'root id); steer = redirect a teammate (interrupts; newest steer wins; meta.goal_id scopes it ' +
  'to a Goal); challenge = demand justification (answered by an accept with evidence); defer = ' +
  "re-sequence a Goal (meta.goal_id, meta.wave: a number reorders, 'later' defers); ask = a " +
  'directed-to-human ask (meta.species: consult|escalate|approve, meta.tier: advisory|standard|' +
  'blocking) — the reply tells you how long to wait and what to do if no answer comes. Goal-scoped ' +
  'steer/defer re-sequence the plan and flag lanes building against the old one.';

function recipient(to: string): Recipient {
  if (to === '@team') return { kind: 'team' };
  if (to === '@broadcast') return { kind: 'broadcast' };
  return { kind: 'member', name: to };
}

/** Acts an `accept`/`decline` can answer: a call for help, a handoff, a `challenge` (ADR 103), or a
 *  to-human `ask` (ADR 147 — an admin accepts/declines the latest open ask without naming it). */
const ANSWERABLE = new Set<Act>(['request_help', 'handoff', 'challenge', 'ask']);

/**
 * The latest still-open request_help/handoff/challenge waiting for `me` — the act an `accept`/`decline`
 * answers when the caller didn't name one (ADR 067, parity with the CLI's `send`). A `request_help`
 * (anyone can answer) or an act directed at `me`, whose thread carries no `resolve`, newest first.
 * Returns undefined if nothing is open. Best-effort: a read failure → undefined.
 */
async function latestOpenRequest(client: MusterdClient, me: string): Promise<Envelope | undefined> {
  try {
    const { messages } = await client.fetchInbox(false);
    const resolved = new Set<string>();
    for (const m of messages) if (m.act === 'resolve' && m.thread) resolved.add(m.thread);
    const open = messages.filter((m) => {
      if (!ANSWERABLE.has(m.act)) return false;
      const directed =
        m.act === 'request_help' || m.act === 'ask' || (m.to.kind === 'member' && m.to.name === me);
      return directed && !resolved.has(m.thread ?? m.id);
    });
    return open.sort((a, b) => b.ts - a.ts)[0];
  } catch {
    return undefined;
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
        // from the enum — a new act lands here the moment it's appended (ADR 103).
        act: ActSchema,
        body: z.string(),
        thread: z.string().optional().describe('thread id to reply within'),
        reply_to: z
          .string()
          .optional()
          .describe('message id this accepts/declines; omit to answer the latest open ask'),
        meta: z.record(z.unknown()).optional().describe('act-specific fields, e.g. {progress:0.5}'),
      },
    },
    async (args) => {
      if (!client.joined || !config.member) {
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
        const target = await latestOpenRequest(client, config.member);
        if (!target) {
          return textResult(
            `no open request to ${args.act} — pass reply_to with the message id (see team_inbox_check)`,
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
        // Structured-first (ADR 144 inc 3): the id/thread a programmatic caller needs to keep the
        // exchange threaded (reply_to / thread on the next send), without parsing the prose.
        const text = askGuidance
          ? `sent ask to ${args.to} (id=${envelope.id}). ${askGuidance}`
          : `sent ${args.act} to ${args.to} (id=${envelope.id})`;
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
          },
        };
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
