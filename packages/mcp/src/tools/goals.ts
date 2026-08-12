import type { McpServer } from '@modelcontextprotocol/server';
import type { Goal } from '@musterd/protocol';
import { z } from 'zod';
import type { MusterdClient } from '../client.js';
import { errorResult, textResult } from './format.js';

/**
 * Declared Goals (ADR 048's general-team seam, resolved by ADR 084) — the coarse "what this team is
 * for" layer above lanes. A Goal is an ordinary team message carrying goal metadata (no new act/table);
 * lanes join it via `goal_id`, and its status is *derived* from those lanes (planned/in-flight/shipped),
 * never stored. `team_next` surfaces the next Goal to pick up; these tools declare + list them.
 */

function fmtGoal(g: Goal): string {
  const wave = g.wave !== null ? ` wave=${g.wave}` : '';
  const deps = g.depends_on.length ? ` deps=[${g.depends_on.join(', ')}]` : '';
  // The plan epoch (ADR 111) — how many times this Goal has been steered/deferred; shown only when > 0.
  const epoch = g.epoch > 0 ? ` epoch=${g.epoch}` : '';
  const story = g.story ? ` — "${g.story}"` : '';
  // value-layer design: the outcome line — what shipping this changed for a user, with provenance.
  const outcome = g.outcome ? `\n    ⇒ ${g.outcome.text} — ${g.outcome.by}` : '';
  return `${g.id} [${g.status}] "${g.title}"${story}${wave}${deps}${epoch} — declared by ${g.declared_by}${outcome}`;
}

export function registerGoals(server: McpServer, client: MusterdClient): void {
  server.registerTool(
    'team_goals',
    {
      description:
        'List declared Goals with derived status (planned/in-flight/shipped, computed from their ' +
        'lanes) — the outcome layer above lanes; team_next picks the next one.',
      inputSchema: {},
    },
    async () => {
      try {
        const { goals } = await client.goals();
        if (goals.length === 0)
          return textResult('no declared goals — team_goal_declare to add one');
        return textResult(goals.map(fmtGoal).join('\n'));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'team_goal_declare',
    {
      description:
        'Declare a Goal (a named outcome). Lanes link to it via goal_id; status is derived from ' +
        'them, never stored. Re-declaring the same id amends it (wholesale — pass every field you ' +
        'want kept). depends_on names goals that must ship first; ordering is otherwise automatic ' +
        '(most recently declared first), so there is no rank to maintain.',
      inputSchema: {
        id: z.string().describe('stable Goal id, e.g. "orientation-spine"'),
        title: z.string().describe('the outcome, short'),
        story: z.string().max(140).optional().describe('plain-language line for outsiders'),
        wave: z
          .literal('later')
          .optional()
          .describe('"later" shelves the goal; omit otherwise (numeric ranks retired, ADR 257)'),
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
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'team_goal_outcome',
    {
      description:
        'Record what a shipped goal changed for a user — one plain sentence of evidence, shown ' +
        'beside the goal wherever it renders. Anyone may amend by recording a new note; the ' +
        'latest wins and provenance is kept.',
      inputSchema: {
        goal_id: z.string().describe('the goal this note is about'),
        outcome: z
          .string()
          .max(280)
          .describe('what changed for a user — evidence, not a slogan'),
      },
    },
    async (args) => {
      try {
        const { goal } = await client.goalOutcome(args);
        return textResult(
          goal
            ? `outcome recorded\n${fmtGoal(goal)}`
            : 'outcome recorded (goal not yet declared — queued until it is)',
        );
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
