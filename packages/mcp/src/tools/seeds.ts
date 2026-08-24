import type { McpServer } from '@modelcontextprotocol/server';
import {
  AnswerSeedClarificationSchema,
  AskSeedClarificationSchema,
  ClaimSeedSchema,
  PromoteSeedSchema,
  SubmitSeedBriefSchema,
  seedInActiveTray,
  type Seed,
} from '@musterd/protocol';
import { z } from 'zod';
import type { MusterdClient } from '../client.js';
import { errorResult } from './format.js';

const IdSchema = z.string().min(1).describe('Seed id');
// MCP SDK consumes Zod v4 fields; protocol currently ships Zod v3 schemas. This describes the same
// wire shape for tool discovery, while every handler still parses through the protocol schema.
const McpSeedBriefSchema = z.object({
  problem: z.string().trim().min(1),
  context: z.string().trim().min(1),
  external_evidence: z.array(z.string().trim().min(1)),
  approaches: z
    .array(
      z.object({
        approach: z.string().trim().min(1),
        tradeoffs: z.string().trim().min(1),
      }),
    )
    .min(1),
  constraints: z.array(z.string().trim().min(1)),
  risks: z.array(z.string().trim().min(1)),
  unknowns: z.array(z.string().trim().min(1)),
  recommendation: z.string().trim().min(1),
  proposed_lane: z.object({
    title: z.string().trim().min(1),
    detail: z.string().trim().min(1),
  }),
});

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
        const seed = await client.seed(IdSchema.parse(args.id));
        return seedResult(fmtSeed(seed), seed);
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'team_seed_claim',
    {
      description: 'Claim an open Seed as its one active explorer before researching it.',
      inputSchema: { id: IdSchema },
    },
    async (args) => {
      try {
        ClaimSeedSchema.parse({});
        const seed = await client.claimSeed(IdSchema.parse(args.id));
        return seedResult(`Seed ${seed.id} — exploring as ${seed.explorer}`, seed);
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'team_seed_ask',
    {
      description:
        'Ask the submitting human Member the one clarification needed to continue exploring.',
      inputSchema: { id: IdSchema, body: z.string().trim().min(1) },
    },
    async (args) => {
      try {
        const input = AskSeedClarificationSchema.parse({ body: args.body });
        const seed = await client.askSeed(IdSchema.parse(args.id), input.body);
        return seedResult(`Seed ${seed.id} — waiting for ${seed.submitted_by}`, seed);
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'team_seed_answer',
    {
      description: 'Answer the active explorer as the human Member who submitted this Seed.',
      inputSchema: { id: IdSchema, body: z.string().trim().min(1) },
    },
    async (args) => {
      try {
        const input = AnswerSeedClarificationSchema.parse({ body: args.body });
        const seed = await client.answerSeed(IdSchema.parse(args.id), input.body);
        return seedResult(`Seed ${seed.id} — clarified`, seed);
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'team_seed_submit',
    {
      description:
        'Submit the exhaustive exploration result. result:promote opens the proposed Lane; result:complete records why no Lane should open.',
      inputSchema: {
        id: IdSchema,
        result: z.enum(['promote', 'complete']),
        brief: McpSeedBriefSchema,
        conclusion: z.string().trim().min(1).optional(),
      },
    },
    async (args) => {
      try {
        const id = IdSchema.parse(args.id);
        const body = SubmitSeedBriefSchema.parse(args);
        const seed = await client.submitSeed(id, body);
        return seedResult(
          seed.state === 'promoted'
            ? `Seed ${seed.id} — promoted to Lane ${seed.linked_lane_id}`
            : `Seed ${seed.id} — completed`,
          seed,
        );
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'team_seed_promote',
    {
      description: 'Explicitly skip research and promote a Seed directly to a Lane.',
      inputSchema: {
        id: IdSchema,
        title: z.string().trim().min(1).optional(),
        detail: z.string().trim().min(1).optional(),
      },
    },
    async (args) => {
      try {
        const body = PromoteSeedSchema.parse({ title: args.title, detail: args.detail });
        const seed = await client.promoteSeed(IdSchema.parse(args.id), body);
        return seedResult(`Seed ${seed.id} — promoted to Lane ${seed.linked_lane_id}`, seed);
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
