import type { McpServer } from '@modelcontextprotocol/server';
import { SeedMcpUpdateSchema, SeedSchema, seedInActiveTray, type Seed } from '@musterd/protocol';
import { z } from 'zod';
import type { MusterdClient } from '../client.js';
import { errorResult, notReadyMessage, textResult } from './format.js';

const IdSchema = z.string().min(1).describe('Seed id');

function fmtSeed(seed: Seed): string {
  const explorer = seed.explorer ? ` explorer=${seed.explorer}` : '';
  return `${seed.id} [${seed.state}] "${seed.body.replace(/\s+/g, ' ').trim()}" — submitted_by=${seed.submitted_by}${explorer}`;
}

function seedResult(text: string, seed: Seed) {
  return {
    content: [{ type: 'text' as const, text }],
    structuredContent: { seed: { ...seed } },
  };
}

export function registerSeeds(server: McpServer, client: MusterdClient): void {
  server.registerTool(
    'team_seed_list',
    {
      description:
        'List shared Team ideas waiting for exploration. The default active tray includes work in progress and recently completed Seeds; history:true includes every Seed.',
      inputSchema: {
        history: z.boolean().optional().describe('include completed and promoted history'),
      },
    },
    async (args) => {
      try {
        const seeds = (await client.seeds()).filter(
          (seed) => args.history || seedInActiveTray(seed),
        );
        if (seeds.length === 0) {
          return {
            content: [
              {
                type: 'text' as const,
                text: "no active Seeds — send an idea through the Team's Slack capture",
              },
            ],
            structuredContent: { seeds: [] },
          };
        }
        return {
          content: [{ type: 'text' as const, text: seeds.map(fmtSeed).join('\n') }],
          structuredContent: { seeds: seeds.map((seed) => ({ ...seed })) },
        };
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'team_seed_get',
    {
      description:
        'Read one shared Seed, including its immutable source and public exploration thread.',
      inputSchema: { id: IdSchema },
    },
    async (args) => {
      try {
        const seed = await client.seed(SeedSchema.shape.id.parse(args.id));
        return seedResult(fmtSeed(seed), seed);
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'team_seed_update',
    {
      description:
        'Advance a Seed: claim, ask, answer, submit, or promote. input is {body}, {result,brief,conclusion?}, or {title?,detail?}; omit it for claim.',
      inputSchema: {
        action: z.enum(['claim', 'ask', 'answer', 'submit', 'promote']),
        id: IdSchema,
        input: z.record(z.string(), z.unknown()).optional(),
      },
    },
    async (args) => {
      if (!client.holdsSeat) return textResult(notReadyMessage(client, 'update a Seed'));
      try {
        const update = SeedMcpUpdateSchema.parse(args);
        if (update.action === 'claim') {
          const seed = await client.claimSeed(update.id);
          return seedResult(`Seed ${seed.id} — exploring as ${seed.explorer}`, seed);
        }
        if (update.action === 'ask') {
          const seed = await client.askSeed(update.id, update.input.body);
          return seedResult(`Seed ${seed.id} — waiting for ${seed.submitted_by}`, seed);
        }
        if (update.action === 'answer') {
          const seed = await client.answerSeed(update.id, update.input.body);
          return seedResult(`Seed ${seed.id} — clarified`, seed);
        }
        if (update.action === 'submit') {
          const seed = await client.submitSeed(update.id, update.input);
          return seedResult(
            seed.state === 'promoted'
              ? `Seed ${seed.id} — promoted to Lane ${seed.linked_lane_id}`
              : `Seed ${seed.id} — completed`,
            seed,
          );
        }
        const seed = await client.promoteSeed(update.id, update.input ?? {});
        return seedResult(`Seed ${seed.id} — promoted to Lane ${seed.linked_lane_id}`, seed);
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
