import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { MusterdClient } from '../client.js';
import { buildSkewWarning, errorResult, formatRoster, textResult } from './format.js';

const DESCRIPTION =
  'The team roster grouped by working / here / out: who is on the team, what each is working ' +
  'on, their model, and where. Check it before picking up work or choosing who to hand off to.';

export function registerStatus(server: McpServer, client: MusterdClient): void {
  server.registerTool('team_status', { description: DESCRIPTION, inputSchema: {} }, async () => {
    try {
      const { members } = await client.roster();
      // ADR 135: a stale adapter warns about itself where the agent will actually read it.
      return textResult(formatRoster(members, client.member) + (await buildSkewWarning(client)));
    } catch (err) {
      return errorResult(err);
    }
  });
}
