import type { McpServer } from '@modelcontextprotocol/server';
import { makeEnvelope } from '@musterd/protocol';
import { ulid } from 'ulid';
import { z } from 'zod';
import type { MusterdClient } from '../client.js';
import type { McpConfig } from '../config.js';
import { errorResult, notReadyMessage, textResult } from './format.js';

/**
 * Team memory (ADR 327): findings saved so the whole team can find them. `team_insight_save`
 * writes an `insight` act — team-visible by intent, the opposite of seat memory's privacy (ADR
 * 093); `team_insight_search` is the pull-only read over a derived FTS fold of the log (a rebuildable
 * cache, never a source of truth — ADR 259). (The `team_memory_search` alias from the 2026-08-27 rename was
 * removed 2026-09-03 after its one-epoch retention — ADR 296 one-meaning-per-word.) Durable findings still belong
 * in docs/wiki/ eventually: saving an insight is the fast tier, promoting one into the wiki is
 * the governed act.
 */

const SAVE_DESCRIPTION =
  'Save a reusable finding for the WHOLE team (team_memory_save is seat-private): a trap fixed, a ' +
  'measured number, how something works. Findable via team_insight_search; promote durable ones into docs/wiki/.';

const SEARCH_DESCRIPTION =
  "Search the team's saved insights by keyword — before re-deriving what a teammate may have recorded.";

export function registerTeamMemory(
  server: McpServer,
  client: MusterdClient,
  config: McpConfig,
): void {
  server.registerTool(
    'team_insight_save',
    {
      description: SAVE_DESCRIPTION,
      inputSchema: {
        headline: z.string().min(1).max(120).describe('one-line subject (≤120 chars)'),
        body: z.string().max(2048).describe('the finding (≤2048 bytes)'),
        tags: z.array(z.string()).max(8).optional().describe('up to 8 short tags'),
        repo: z.string().optional().describe('repo slug, when bound to one'),
      },
    },
    async (args) => {
      if (!client.holdsSeat || !config.member) {
        return textResult(notReadyMessage(client, 'save an insight'));
      }
      try {
        const envelope = makeEnvelope({
          id: ulid(),
          team: config.team,
          from: config.member,
          to: { kind: 'team' },
          act: 'insight',
          body: args.body,
          meta: {
            headline: args.headline,
            ...(args.tags ? { tags: args.tags } : {}),
            ...(args.repo ? { repo: args.repo } : {}),
          },
        });
        await client.sendEnvelope(envelope);
        client.markSeen(envelope.id);
        return textResult(
          `insight saved to team memory: "${args.headline}" — findable via team_insight_search`,
        );
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  const searchInputSchema = {
    query: z.string().min(1).describe('keywords — every word must appear in the finding'),
    limit: z.number().int().positive().max(100).optional().describe('max hits (default 20)'),
  } as const;
  const searchHandler = async (args: { query: string; limit?: number | undefined }) => {
    if (!client.holdsSeat) return textResult(notReadyMessage(client, 'search team memory'));
    try {
      const params = new URLSearchParams({ q: args.query });
      if (args.limit) params.set('limit', String(args.limit));
      const body = await client.teamMemorySearch(params.toString());
      const results = body.results ?? [];
      if (results.length === 0) {
        return textResult(
          'no matching insights — nothing saved under those words yet; if you go on to learn it, team_insight_save records it for the next seat',
        );
      }
      const rendered = results
        .map(
          (r) =>
            `[${r.id}] ${r.headline}\n  by ${r.from} · ${new Date(r.ts).toISOString()}\n  ${r.body}`,
        )
        .join('\n\n');
      return textResult(`${results.length} insight(s):\n\n${rendered}`);
    } catch (err) {
      return errorResult(err);
    }
  };

  server.registerTool(
    'team_insight_search',
    {
      description: SEARCH_DESCRIPTION,
      inputSchema: searchInputSchema,
    },
    searchHandler,
  );
}
