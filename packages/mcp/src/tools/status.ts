import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { MusterdClient } from '../client.js';
import { formatRoster, textResult } from './format.js';

const DESCRIPTION =
  'The team roster, grouped by working / here / out: who is on the team, what each of them is ' +
  'currently working on, the model they run, and where. Use it to see what the team is doing before ' +
  'you pick up work, and to decide who to hand off to or ask for help.';

export function registerStatus(server: McpServer, client: MusterdClient): void {
  server.registerTool('team_status', { description: DESCRIPTION, inputSchema: {} }, async () => {
    try {
      const { members } = await client.roster();
      return textResult(formatRoster(members, client.member));
    } catch (err) {
      return textResult(`error: ${(err as Error).message}`);
    }
  });
}
