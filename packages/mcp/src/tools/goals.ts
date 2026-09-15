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
  // goal-retract design: a withdrawn Goal renders only under include_retracted, with provenance.
  const retracted = g.retracted ? ` retracted by ${g.retracted.by}` : '';
  return `${g.id} [${g.status}] "${g.title}"${story}${wave}${deps}${epoch}${retracted} — declared by ${g.declared_by}${outcome}`;
}

export function registerGoals(server: McpServer, client: MusterdClient): void {
  server.registerTool(
    'team_goals',
    {
      description:
        'List declared Goals with derived status (planned/in-flight/shipped, computed from their ' +
        'lanes) — the outcome layer above lanes; team_next picks the next one. Retracted goals ' +
        'hide unless include_retracted is set.',
      inputSchema: {
        include_retracted: z.boolean().optional().describe('also list retracted (withdrawn) goals'),
      },
    },
    async (args) => {
      try {
        const { goals: allGoals } = await client.goals();
        // goal-retract design: hidden by default, but counted — never silently gone (ADR 257 scar).
        const retractedCount = allGoals.filter((g) => g.retracted !== undefined).length;
        const goals = args.include_retracted
          ? allGoals
          : allGoals.filter((g) => g.retracted === undefined);
        if (goals.length === 0)
          return textResult(
            retractedCount > 0
              ? `no live goals (${retractedCount} retracted — include_retracted lists them)`
              : 'no declared goals — team_goal_declare to add one',
          );
        const footer =
          !args.include_retracted && retractedCount > 0
            ? `\n(${retractedCount} retracted — include_retracted lists them)`
            : '';
        return textResult(goals.map(fmtGoal).join('\n') + footer);
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
        'Record what a shipped goal changed for a user — one sentence of evidence, rendered ' +
        'beside the goal. Re-record to amend; latest wins.',
      inputSchema: {
        goal_id: z.string().describe('the goal this note is about'),
        outcome: z.string().max(280).describe('what changed for a user — evidence, not a slogan'),
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

  server.registerTool(
    'team_goal_retract',
    {
      description:
        'Retract (withdraw) a Goal from the board — a signal folded on read, never a deletion: ' +
        'the goal stays in the log and listable via include_retracted, and re-declaring the same ' +
        'id revives it. Use for goals that are obsolete, merged into another, or scratch.',
      inputSchema: {
        goal_id: z.string().describe('the goal to retract'),
      },
    },
    async (args) => {
      try {
        const { goal } = await client.goalRetract(args);
        return textResult(
          goal
            ? `goal retracted\n${fmtGoal(goal)}`
            : 'goal retracted (goal not yet declared — the signal is queued until it is)',
        );
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
