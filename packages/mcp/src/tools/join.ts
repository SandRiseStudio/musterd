import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { MusterdClient } from '../client.js';
import type { McpConfig } from '../config.js';
import { textResult } from './format.js';

const DESCRIPTION =
  'Join your team and go online as your member — call this once when you start working so ' +
  'teammates can see you and reach you. Until you join you are dormant (you can look at the ' +
  'roster but cannot send or receive). After joining, check your inbox at task boundaries.';

export function registerJoin(server: McpServer, client: MusterdClient, config: McpConfig): void {
  server.registerTool('team_join', { description: DESCRIPTION, inputSchema: {} }, async () => {
    if (client.joined) {
      return textResult(`Already joined ${config.team} as ${config.member}.`);
    }
    try {
      await client.join();
      return textResult(
        `Joined ${config.team} as ${config.member} (${config.surface}). You are now the live occupant of this seat.\n\n` +
          `IMPORTANT — stay in sync: call team_inbox_check now, then again whenever you finish a task or a reply. ` +
          `Messages addressed to you while you weren't looking wait in your inbox; teammates expect a response. ` +
          `Report progress with team_send {act:'status_update'} and hand work off with {act:'handoff'}.`,
      );
    } catch (err) {
      const msg = (err as Error).message;
      if (/member_busy/i.test(msg) || /already active/i.test(msg)) {
        return textResult(
          `Can't join as ${config.member}: that member is already live in another session (single-active — one ` +
            `session per member at a time). Either close the other session, or ask an admin to add a separate ` +
            `member/seat for you. You remain dormant; the musterd tools are still available to inspect the team.`,
        );
      }
      return textResult(`Could not join ${config.team} as ${config.member}: ${msg}`);
    }
  });
}
