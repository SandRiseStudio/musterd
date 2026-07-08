import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Goal } from '@musterd/protocol';
import { z } from 'zod';
import type { MusterdClient } from '../client.js';
import { textResult } from './format.js';

/**
 * Declared Goals (ADR 048's general-team seam, resolved by ADR 084) — the coarse "what this team is
 * for" layer above lanes. A Goal is an ordinary team message carrying goal metadata (no new act/table);
 * lanes join it via `goal_id`, and its status is *derived* from those lanes (planned/in-flight/shipped),
 * never stored. `team_next` surfaces the next Goal to pick up; these tools declare + list them.
 */

function fmtGoal(g: Goal): string {
  const wave = g.wave !== null ? ` wave=${g.wave}` : '';
  const deps = g.depends_on.length ? ` deps=[${g.depends_on.join(', ')}]` : '';
  // The plan epoch (ADR 109) — how many times this Goal has been steered/deferred; shown only when > 0.
  const epoch = g.epoch > 0 ? ` epoch=${g.epoch}` : '';
  return `${g.id} [${g.status}] "${g.title}"${wave}${deps}${epoch} — declared by ${g.declared_by}`;
}

export function registerGoals(server: McpServer, client: MusterdClient): void {
  server.registerTool(
    'team_goals',
    {
      description:
        "List the team's declared Goals with derived status (planned/in-flight/shipped, computed from " +
        'the lanes joined to each). The coarse outcome layer above lanes; team_next picks the next one.',
      inputSchema: {},
    },
    async () => {
      try {
        const { goals } = await client.goals();
        if (goals.length === 0)
          return textResult('no declared goals — team_goal_declare to add one');
        return textResult(goals.map(fmtGoal).join('\n'));
      } catch (err) {
        return textResult(`error: ${(err as Error).message}`);
      }
    },
  );

  server.registerTool(
    'team_goal_declare',
    {
      description:
        'Declare a team Goal (a declared outcome). Lanes link to it via goal_id; its status is derived ' +
        'from those lanes, never stored. Re-declaring the same id amends it. Optional wave (build order) ' +
        'and depends_on (goal ids that must ship first) drive what team_next suggests.',
      inputSchema: {
        id: z.string().describe('stable Goal id, e.g. "orientation-spine"'),
        title: z.string().describe('the outcome, short'),
        wave: z
          .union([z.number().int(), z.literal('later')])
          .optional()
          .describe('build-order rank (lower = sooner); "later" sorts last'),
        depends_on: z
          .array(z.string())
          .optional()
          .describe('goal ids that must ship before this one'),
      },
    },
    async (args) => {
      try {
        const { goal } = await client.declareGoal(args);
        return textResult(`goal declared\n${fmtGoal(goal)}`);
      } catch (err) {
        return textResult(`error: ${(err as Error).message}`);
      }
    },
  );
}
