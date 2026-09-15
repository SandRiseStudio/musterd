import type { McpServer } from '@modelcontextprotocol/server';
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
  'SEAT-PRIVATE (the team_ prefix is the tool namespace, not the audience — for the whole team use ' +
  "team_insight_save). Saves this seat's working state for the next session or occupant: what you were doing, " +
  'decisions mid-flight, where you left off. Working state ONLY — durable knowledge (traps, ' +
  'technique, learned facts) goes in docs/wiki/ pages, not here (ADR 259). Use at wrap-up or ' +
  'handoff, not mid-task. One note per seat, last-write-wins. headline ≤120 chars (shown on ' +
  'the next occupy); body ≤8KB. Private to this seat; never store secrets.';

/**
 * The empty state (ADR 144 inc 4). The daemon answers "nothing saved yet" with a 404, which is the
 * right HTTP answer and the wrong MCP one: rendered through `errorResult` it became an `error:`
 * result, so a first-ever read counted as a tool failure — inflating the very error rate the
 * increment is measured against, and telling the agent something broke when nothing did. An absent
 * note is an empty state, and inc 3's standard says an empty state names the next action.
 */
const NO_MEMORY = /no memory saved/i;

const READ_DESCRIPTION =
  "Load this seat's saved memory (seat-private; team findings are team_insight_search) — the full note behind the headline team_join showed. Call " +
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
        // The 120-char cap is declared HERE, not only in the protocol (ADR 144 inc 4): it used to
        // live solely in `claim-handshake.ts`, so a 121-char headline passed validation and came
        // back as a late server error instead of a bounce with a repair hint. Every constraint the
        // caller can violate belongs on the surface the caller is validated against.
        headline: z.string().min(1).max(120).describe('one-line subject (≤120 chars)'),
        body: z.string().optional().describe('the full note (≤8KB); omit for headline-only'),
      },
    },
    async (args) => {
      if (!client.holdsSeat) return textResult(notReadyMessage(client, 'save memory'));
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
      if (!client.holdsSeat) return textResult(notReadyMessage(client, 'read memory'));
      try {
        const mem = await client.readMemory();
        const header = `memory (saved ${ago(Date.now() - mem.saved_at)} ago): ${mem.headline}`;
        return textResult(mem.body ? `${header}\n\n${mem.body}` : header);
      } catch (err) {
        if (NO_MEMORY.test(err instanceof Error ? err.message : String(err))) {
          return textResult(
            'no memory saved for this seat yet — team_memory_save {headline} at wrap-up writes the note the next occupant sees',
          );
        }
        return errorResult(err);
      }
    },
  );
}
