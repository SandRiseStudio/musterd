import type { McpServer } from '@modelcontextprotocol/server';
import { WakeContextRequestSchema, type WakeContextPacket } from '@musterd/protocol';
import { z } from 'zod';
import type { MusterdClient } from '../client.js';
import { errorResult, notReadyMessage, textResult } from './format.js';

const DESCRIPTION =
  'Read your wake context packet for one directed Act or owned Lane: the thread you were woken for, ' +
  'what else is open against you, your lane, and your memory — attributed and budgeted (ADR 430). ' +
  'Fetch more only for what it lists under fetch.';

const ago = (ms: number): string =>
  ms < 60_000
    ? `${Math.round(ms / 1000)}s`
    : ms < 3_600_000
      ? `${Math.round(ms / 60_000)}m`
      : `${Math.round(ms / 3_600_000)}h`;

export function render(context: WakeContextPacket): string {
  const target = context.wake.act_id ?? context.wake.lane_id;
  const lines = [
    `wake context: ${context.wake.kind} ${target}`,
    `next action: ${context.objective.action} · delivery: ${context.delivery.requirement}/${context.delivery.intended}`,
  ];
  // ADR 430: the v2 block — attributed bodies the seat would otherwise spend 2–4 reads on.
  const c = context.context;
  if (c) {
    if (c.thread) {
      const omitted = c.thread.omitted ? `, ${c.thread.omitted} older omitted` : '';
      lines.push(`thread (${c.thread.acts.length} shown${omitted}):`);
      for (const a of c.thread.acts)
        lines.push(`  ${a.from} · ${a.act} · ${a.id}: ${a.body}${a.truncated ? ' …' : ''}`);
    }
    if (c.lane) {
      lines.push(`lane: ${c.lane.detail}${c.lane.truncated ? ' …' : ''}`);
      if (c.lane.last_status_update) {
        const u = c.lane.last_status_update;
        lines.push(`your last word on it: ${u.body}${u.truncated ? ' …' : ''}`);
      }
    }
    for (const o of c.open)
      lines.push(
        `open: ${o.kind} ${o.id}${o.from ? ` from ${o.from}` : ''} — ${o.title} (${ago(o.age_ms)})`,
      );
    if (c.memory)
      lines.push(
        `memory:\n${c.memory.body}${c.memory.truncated ? '\n…(truncated — team_memory_read for the rest)' : ''}`,
      );
  }
  if (context.fetch.length > 0) {
    const followUps = context.fetch.map((fetch) => {
      if (fetch === 'seat_memory') return 'team_memory_read';
      if (fetch === 'inbox_thread') return 'team_inbox_check';
      if (fetch === 'lane_detail') return 'lane_board';
      if (fetch === 'open_items') return 'team_inbox_check (open items did not fit)';
      return 'git artifact on the declared branch';
    });
    lines.push(`explicit reads: ${followUps.join(', ')}`);
  }
  return lines.join('\n');
}

export function registerWakeContext(server: McpServer, client: MusterdClient): void {
  server.registerTool(
    'team_wake_context',
    {
      description: DESCRIPTION,
      inputSchema: {
        // The hint is short on purpose: the tools list has a byte budget (context:check) and the
        // wake line itself now spells the call — `team_wake_context {act_id: "…"}` (lane 01M2P698NJ).
        act_id: z.string().min(1).optional().describe('Act id from your wake line'),
        lane_id: z.string().min(1).optional().describe('Lane id from your wake line'),
      },
    },
    async (args) => {
      if (!client.holdsSeat) return textResult(notReadyMessage(client, 'read wake context'));
      const target = WakeContextRequestSchema.safeParse(args);
      if (!target.success) return textResult('provide exactly one of act_id or lane_id');
      try {
        const context = await client.wakeContext(target.data);
        return { ...textResult(render(context)), structuredContent: { context } };
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
