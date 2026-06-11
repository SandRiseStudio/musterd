import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { MusterdClient } from '../client.js';
import type { McpConfig } from '../config.js';
import { textResult } from './format.js';

const DESCRIPTION =
  'Leave the team and go offline (release your seat). Call this when you finish working or step ' +
  'away for a while. The seat is held briefly (~45s) so you can rejoin without losing it; the ' +
  'musterd tools stay available, and team_join brings you back online.';

export function registerLeave(server: McpServer, client: MusterdClient, config: McpConfig): void {
  server.registerTool('team_leave', { description: DESCRIPTION, inputSchema: {} }, async () => {
    if (!client.joined) {
      return textResult(`Not joined to ${config.team} — nothing to leave.`);
    }
    client.leave();
    return textResult(
      `Left ${config.team}. Your seat is free (held ~45s in case you rejoin). Call team_join to come back online.`,
    );
  });
}
