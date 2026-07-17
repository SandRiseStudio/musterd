import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { MemoryEnvelope } from '@musterd/protocol';
import { z } from 'zod';
import type { MusterdClient } from '../client.js';
import { errorResult, notReadyMessage, textResult } from './format.js';

/**
 * Seat memory (ADR 093): the seat's private cross-session continuity blob — the working state a
 * returning occupant needs (what it was doing, decisions mid-flight, where it left off). One small
 * note, last-write-wins, seat-scoped (readable by this seat only — no cross-seat path, admins
 * included). Delivery is envelope-on-occupy / body-on-demand: team_join renders {@link memoryLine}
 * (headline + age, ~30 tokens); the body travels only over team_memory_read.
 */

const SAVE_DESCRIPTION =
  "Save this seat's memory for the next session or occupant: what you were doing, decisions " +
  'mid-flight, where you left off. Call before a handoff, at wrap-up, or when winding down. ' +
  'One note per seat, last-write-wins. headline ≤120 chars (shown on the next occupy); body ' +
  '≤8KB. Private to this seat; never store secrets.';

const READ_DESCRIPTION =
  "Load this seat's saved memory — the full note behind the headline team_join showed. Call " +
  'when the headline looks relevant; judge staleness from its age.';

function ago(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s >= 86400) return `${Math.floor(s / 86400)}d`;
  if (s >= 3600) return `${Math.floor(s / 3600)}h`;
  if (s >= 60) return `${Math.floor(s / 60)}m`;
  return `${s}s`;
}

/**
 * The one-line pointer the join result carries (ADR 093 §3) — headline + age, never the body, so a
 * fresh session pays ~30 tokens and makes an informed fetch decision.
 */
export function memoryLine(env: MemoryEnvelope, now = Date.now()): string {
  return (
    `Saved memory from ${ago(now - env.saved_at)} ago: "${env.headline}" — ` +
    `team_memory_read to load it (${env.size_bytes} bytes).`
  );
}

export function registerMemory(server: McpServer, client: MusterdClient): void {
  server.registerTool(
    'team_memory_save',
    {
      description: SAVE_DESCRIPTION,
      inputSchema: {
        headline: z.string().describe('one-line subject (≤120 chars)'),
        body: z.string().optional().describe('the full note (≤8KB); omit for headline-only'),
      },
    },
    async (args) => {
      if (!client.joined) return textResult(notReadyMessage(client, 'save memory'));
      try {
        await client.saveMemory({
          headline: args.headline,
          ...(args.body ? { body: args.body } : {}),
        });
        return textResult(
          `memory saved — your next occupy of this seat will show: "${args.headline}"`,
        );
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'team_memory_read',
    { description: READ_DESCRIPTION, inputSchema: {} },
    async () => {
      if (!client.joined) return textResult(notReadyMessage(client, 'read memory'));
      try {
        const mem = await client.readMemory();
        const header = `memory (saved ${ago(Date.now() - mem.saved_at)} ago): ${mem.headline}`;
        return textResult(mem.body ? `${header}\n\n${mem.body}` : header);
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
