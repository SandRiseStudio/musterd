import type { McpServer } from '@modelcontextprotocol/server';
import type { MusterdClient } from '../client.js';
import {
  buildSkewWarning,
  errorResult,
  evictionNotice,
  formatRoster,
  syncWedgeWarning,
  textResult,
} from './format.js';

const DESCRIPTION =
  'The team roster grouped by working / here / out: who is on the team, what each is working ' +
  'on, their model, and where. Check it before picking up work or choosing who to hand off to.';

export function registerStatus(server: McpServer, client: MusterdClient): void {
  server.registerTool('team_status', { description: DESCRIPTION, inputSchema: {} }, async () => {
    try {
      const roster = await client.roster();
      const { members } = roster;
      // ADR 237 decision 3: a session that knows it was evicted must not read the roster as its own
      // unqualified state — the banner leads, because "you are ryder" was the false positive evidence
      // that kept the incident's session working for twenty minutes.
      // ADR 135: a stale adapter warns about itself where the agent will actually read it.
      return textResult(
        evictionNotice(client.lastJoinError) +
          formatRoster(members, client.member) +
          syncWedgeWarning(roster) +
          (await buildSkewWarning(client)),
      );
    } catch (err) {
      return errorResult(err);
    }
  });
}
