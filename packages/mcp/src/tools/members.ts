import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { MusterdClient } from '../client.js';
import { textResult } from './format.js';

const DESCRIPTION =
  'Get detail on one member (or all): kind, role, lifecycle, current presences/surfaces. ' +
  'Use to decide who to hand off to or ask for help.';

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
        const lines = selected.map((m) => {
          // A residency-enrolled seat (ADR 131) is absent but wakeable — a directed act reaches it.
          const presences = m.presences.length
            ? m.presences.map((p) => `${p.surface}:${p.status}`).join(', ')
            : m.wakeable
              ? 'not present · wakeable'
              : 'not present';
          const lifecycle =
            m.lifecycle === 'until' && m.lifecycle_until
              ? `until ${new Date(m.lifecycle_until).toISOString()}`
              : m.lifecycle;
          return `${m.name} — kind=${m.kind} role=${m.role || '—'} lifecycle=${lifecycle} presence=[${presences}]`;
        });
        return textResult(lines.join('\n'));
      } catch (err) {
        return textResult(`error: ${(err as Error).message}`);
      }
    },
  );
}
