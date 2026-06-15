import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { makeEnvelope, type Act, type Recipient } from '@musterd/protocol';
import { ulid } from 'ulid';
import { z } from 'zod';
import type { MusterdClient } from '../client.js';
import type { McpConfig } from '../config.js';
import { textResult } from './format.js';

const DESCRIPTION =
  'Send a message to a teammate, the whole team, or broadcast. Use the right act: ' +
  'status_update to report progress, request_help when blocked, handoff to pass work, ' +
  'accept/decline to answer a request_help/handoff (set reply_to), wait to signal you are paused.';

function recipient(to: string): Recipient {
  if (to === '@team') return { kind: 'team' };
  if (to === '@broadcast') return { kind: 'broadcast' };
  return { kind: 'member', name: to };
}

export function registerSend(server: McpServer, client: MusterdClient, config: McpConfig): void {
  server.registerTool(
    'team_send',
    {
      description: DESCRIPTION,
      inputSchema: {
        to: z.string().default('@team').describe("member name, or '@team', or '@broadcast'"),
        act: z.enum([
          'message',
          'status_update',
          'request_help',
          'handoff',
          'accept',
          'decline',
          'wait',
        ]),
        body: z.string(),
        thread: z.string().optional().describe('thread id to reply within'),
        reply_to: z
          .string()
          .optional()
          .describe('message id this accepts/declines (required for accept/decline)'),
        meta: z.record(z.unknown()).optional().describe('act-specific fields, e.g. {progress:0.5}'),
      },
    },
    async (args) => {
      if (!client.joined) {
        return textResult("you haven't joined the team yet — call team_join first, then send");
      }
      const meta: Record<string, unknown> = { ...(args.meta ?? {}) };
      if (args.reply_to) meta['in_reply_to'] = args.reply_to;
      try {
        const envelope = makeEnvelope({
          id: ulid(),
          team: config.team,
          from: config.member,
          to: recipient(args.to),
          act: args.act as Act,
          body: args.body,
          thread: args.thread ?? null,
          meta: Object.keys(meta).length ? meta : null,
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
