import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Envelope } from '@musterd/protocol';
import { z } from 'zod';
import type { MusterdClient } from '../client.js';
import { linkReceived } from '../otel.js';
import { buildSkewWarning, formatMessage, notReadyMessage, textResult } from './format.js';

const DESCRIPTION =
  'Check for new messages addressed to you or the team since you last checked. ' +
  'Returns unread messages and marks them read. Call this to see if teammates have responded or need you. ' +
  'Best practice: call it at the start and end of each task and whenever you finish a reply — teammates may ' +
  'be waiting on you, and messages that arrived while you were heads-down only surface when you check.';

export function registerInboxCheck(server: McpServer, client: MusterdClient): void {
  server.registerTool(
    'team_inbox_check',
    {
      description: DESCRIPTION,
      inputSchema: {
        unread_only: z.boolean().default(true),
        limit: z.number().default(50),
      },
    },
    async (args) => {
      if (!client.joined) {
        return textResult(notReadyMessage(client, 'check your inbox'));
      }
      try {
        // Combine buffered live deliveries with the authoritative inbox fetch, dedup by id.
        const buffered = client.drainBuffer();
        const fetched = await client.fetchInbox(args.unread_only ?? true);
        const byId = new Map<string, Envelope>();
        for (const e of [...buffered, ...fetched.messages]) byId.set(e.id, e);
        // Keep the NEWEST `limit` (an inbox is read most-recent-first), then present ascending — not
        // the OLDEST N a bare `.sort().slice(0, limit)` would keep once the inbox exceeds the cap.
        const ordered = [...byId.values()].sort((a, b) => a.ts - b.ts);
        const messages = ordered.slice(Math.max(0, ordered.length - (args.limit ?? 50)));

        if (messages.length === 0) {
          // ADR 135: inbox-check is every agent's minute-0 call (the SessionStart hook routes here),
          // so a stale adapter learns about itself immediately — even on an empty inbox.
          return textResult('no new messages' + (await buildSkewWarning(client)));
        }
        // Link any sender trace context (meta.otel) to our trace as causality (ADR 011 receiver).
        linkReceived(messages);
        // Advance the cursor to the newest message read.
        const newest = messages[messages.length - 1]!;
        await client.markRead(newest.id).catch(() => undefined);

        const text = messages.map(formatMessage).join('\n') + (await buildSkewWarning(client));
        return {
          content: [{ type: 'text' as const, text }],
          structuredContent: {
            messages: messages.map((m) => ({
              id: m.id,
              from: m.from,
              act: m.act,
              body: m.body,
              ts: m.ts,
              thread: m.thread ?? null,
              meta: m.meta ?? null,
            })),
          },
        };
      } catch (err) {
        return textResult(`error: ${(err as Error).message}`);
      }
    },
  );
}
