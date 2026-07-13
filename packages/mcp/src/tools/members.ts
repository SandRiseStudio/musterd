import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { MusterdClient } from '../client.js';
import { formatMember, textResult } from './format.js';

const DESCRIPTION =
  'Get detail on one member (or all): what they are working on, the model they run, their role, ' +
  'and where they are present. Use to decide who to hand off to or ask for help.';

export function registerMembers(server: McpServer, client: MusterdClient): void {
  server.registerTool(
    'team_members',
    {
      description: DESCRIPTION,
      inputSchema: { name: z.string().optional().describe('member name; omit for all') },
    },
    async (args) => {
      try {
        const { members } = await client.roster();
        const selected = args.name ? members.filter((m) => m.name === args.name) : members;
        if (selected.length === 0) {
          return textResult(args.name ? `no member "${args.name}"` : 'no members');
        }
        // The shared member line (what they're doing, model, where) — the substance an agent decides on.
        // A member with several presences is the one case this tool must say more than the roster does:
        // it is the "detail on one member" tool, so the extra surfaces are appended rather than dropped.
        const lines = selected.map((m) => {
          const line = formatMember(m);
          const extra = m.presences.slice(1);
          return extra.length
            ? `${line} (also ${extra.map((p) => `${p.surface}:${p.status}`).join(', ')})`
            : line;
        });
        return textResult(lines.join('\n'));
      } catch (err) {
        return textResult(`error: ${(err as Error).message}`);
      }
    },
  );
}
