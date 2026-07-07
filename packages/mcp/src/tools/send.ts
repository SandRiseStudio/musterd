import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  type Act,
  ActSchema,
  type Envelope,
  makeEnvelope,
  type Recipient,
} from '@musterd/protocol';
import { ulid } from 'ulid';
import { z } from 'zod';
import type { MusterdClient } from '../client.js';
import type { McpConfig } from '../config.js';
import { withTraceContext } from '../otel.js';
import { notReadyMessage, textResult } from './format.js';

const DESCRIPTION =
  'Send a message to a teammate, the whole team, or broadcast. Use the right act: ' +
  'status_update to report progress, request_help when blocked, handoff to pass work, ' +
  'accept/decline to answer a request_help/handoff/challenge (auto-targets the latest open one — set reply_to to override), ' +
  'wait to signal you are paused, resolve to close a thread when the work is done (set thread to the thread/root id). ' +
  'Steering (ADR 102): steer to change direction (always interrupts; the newest steer supersedes prior direction), ' +
  'challenge to make a teammate justify a task/assumption or reconsider (answer it with an accept carrying evidence), ' +
  'defer to reorder/defer a Goal on the plan (set meta.goal_id, optional meta.wave — a number reorders, "later" defers).';

function recipient(to: string): Recipient {
  if (to === '@team') return { kind: 'team' };
  if (to === '@broadcast') return { kind: 'broadcast' };
  return { kind: 'member', name: to };
}

/** Acts an `accept`/`decline` can answer: a call for help, a handoff, or a `challenge` (ADR 102). */
const ANSWERABLE = new Set<Act>(['request_help', 'handoff', 'challenge']);

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
      const directed = m.act === 'request_help' || (m.to.kind === 'member' && m.to.name === me);
      return directed && !resolved.has(m.thread ?? m.id);
    });
    return open.sort((a, b) => b.ts - a.ts)[0];
  } catch {
    return undefined;
  }
}

export function registerSend(server: McpServer, client: MusterdClient, config: McpConfig): void {
  server.registerTool(
    'team_send',
    {
      description: DESCRIPTION,
      inputSchema: {
        to: z.string().default('@team').describe("member name, or '@team', or '@broadcast'"),
        // Derived from ACTS (the protocol's single source of truth) so the MCP surface can never drift
        // from the enum — a new act lands here the moment it's appended (ADR 102).
        act: ActSchema,
        body: z.string(),
        thread: z.string().optional().describe('thread id to reply within'),
        reply_to: z
          .string()
          .optional()
          .describe(
            'message id this accepts/declines (optional — accept/decline auto-target the latest open request_help/handoff)',
          ),
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
        await client.sendEnvelope(envelope);
        client.markSeen(envelope.id); // don't echo our own send back via inbox
        return textResult(`sent ${args.act} to ${args.to} (id=${envelope.id})`);
      } catch (err) {
        return textResult(`error: ${(err as Error).message}`);
      }
    },
  );
}
