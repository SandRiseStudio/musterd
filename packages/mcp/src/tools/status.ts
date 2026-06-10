import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { MusterdClient } from '../client.js';
import { textResult } from './format.js';

const DESCRIPTION =
  'List the team roster: who is a member, their role, kind (agent/human), and whether ' +
  'they are currently online and on what surface.';

export function registerStatus(server: McpServer, client: MusterdClient): void {
  server.registerTool('team_status', { description: DESCRIPTION, inputSchema: {} }, async () => {
    try {
      const { members } = await client.roster();
      const lines = members.map((m) => {
        const surface = m.presences[0]?.surface;
        const presence = m.presence === 'offline' ? 'offline' : `${m.presence}${surface ? ` via ${surface}` : ''}`;
        return `${m.name} (${m.kind}${m.role ? `, ${m.role}` : ''}) — ${presence}`;
      });
      return textResult(lines.join('\n') || 'no members');
    } catch (err) {
      return textResult(`error: ${(err as Error).message}`);
    }
  });
}
