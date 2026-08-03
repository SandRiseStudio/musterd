import type { McpServer } from '@modelcontextprotocol/server';
import { WakeContextRequestSchema, type WakeContextPacket } from '@musterd/protocol';
import { z } from 'zod';
import type { MusterdClient } from '../client.js';
import { errorResult, notReadyMessage, textResult } from './format.js';

const DESCRIPTION =
  'Read a bounded, recipient-scoped wake context packet for one directed Act or owned Lane. ' +
  'It contains IDs, state, delivery intent, and named explicit reads only; it never loads message or memory bodies.';

function render(context: WakeContextPacket): string {
  const target = context.wake.act_id ?? context.wake.lane_id;
  const followUps = context.fetch.map((fetch) => {
    if (fetch === 'seat_memory') return 'team_memory_read';
    if (fetch === 'inbox_thread') return 'team_inbox_check';
    if (fetch === 'lane_detail') return 'lane_board';
    return 'git artifact on the declared branch';
  });
  return [
    `wake context: ${context.wake.kind} ${target}`,
    `next action: ${context.objective.action} · delivery: ${context.delivery.requirement}/${context.delivery.intended}`,
    `explicit reads: ${followUps.join(', ')}`,
  ].join('\n');
}

export function registerWakeContext(server: McpServer, client: MusterdClient): void {
  server.registerTool(
    'team_wake_context',
    {
      description: DESCRIPTION,
      inputSchema: {
        act_id: z.string().min(1).optional().describe('directed Act id'),
        lane_id: z.string().min(1).optional().describe('owned Lane id'),
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
