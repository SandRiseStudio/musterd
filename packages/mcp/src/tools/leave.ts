import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { MusterdClient } from '../client.js';
import type { McpConfig } from '../config.js';
import { textResult } from './format.js';

const DESCRIPTION =
  'Go offline and release your seat — call when you finish working or step away. The seat is ' +
  'held ~45s for a quick rejoin; team_join brings you back.';

export function registerLeave(server: McpServer, client: MusterdClient, config: McpConfig): void {
  server.registerTool('team_leave', { description: DESCRIPTION, inputSchema: {} }, async () => {
    if (!client.joined) {
      return textResult(
        `Not joined to ${config.team} — nothing to leave. team_join brings you online.`,
      );
    }
    client.leave();
    return textResult(
      `Left ${config.team}. Your seat is free (held ~45s in case you rejoin). Call team_join to come back online.`,
    );
  });
}
