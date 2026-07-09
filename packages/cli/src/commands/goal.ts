import type { Goal } from '@musterd/protocol';
import { flagStr, type Parsed } from '../args.js';
import { CliError } from '../errors.js';
import { theme } from '../render/theme.js';
import { heading, success, sym } from '../render/ui.js';
import { resolve } from './helpers.js';

/**
 * `musterd goal <declare|list>` — the general-team declared-Goal seam (ADR 048, resolved by ADR 084):
 * a Goal is an ordinary `message` act to `@team` carrying `meta.goal`, no new act or table. musterd's
 * own dogfood uses `roadmap.data.ts` instead — this is what any other team gets for free. Status is
 * always derived (lanes joined by `goal_id`), never stored; re-declaring the same id amends it.
 */

const USAGE =
  'usage:\n' +
  '  musterd goal declare "<title>" --goal-id <id> [--wave <n|later>] [--depends <id>[,<id>…]]\n' +
  '  musterd goal list [--json]';

function renderGoal(g: Goal): string {
  const status =
    g.status === 'shipped'
      ? theme.ok(g.status)
      : g.status === 'in-flight'
        ? theme.warn(g.status)
        : g.status;
  const wave = g.wave !== null ? theme.meta(` wave:${g.wave}`) : '';
  const deps = g.depends_on.length ? theme.meta(` deps:${g.depends_on.length}`) : '';
  // The plan epoch (ADR 111) — shown only once direction has changed, so a steady Goal stays quiet.
  const epoch = g.epoch > 0 ? theme.warn(` epoch:${g.epoch}`) : '';
  return `${theme.meta(sym.goal)} ${theme.meta(g.id)} ${status} "${g.title}"${wave}${deps}${epoch} ${theme.meta(`— declared by ${g.declared_by}`)}`;
}

export async function goalCommand(parsed: Parsed): Promise<number> {
  const sub = parsed.positionals[0];
  const { team, http } = resolve(parsed.flags);

  if (sub === 'declare') {
    const title = parsed.positionals[1];
    const id = flagStr(parsed.flags, 'goal-id');
    if (!title || !id) throw new CliError(USAGE, 2);
    const waveRaw = flagStr(parsed.flags, 'wave');
    const wave =
      waveRaw === undefined ? undefined : waveRaw === 'later' ? 'later' : Number(waveRaw);
    const dependsRaw = flagStr(parsed.flags, 'depends');
    const depends_on = dependsRaw
      ? dependsRaw
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : undefined;
    const goal = await http.declareGoal(team, {
      id,
      title,
      ...(wave !== undefined ? { wave } : {}),
      ...(depends_on ? { depends_on } : {}),
    });
    process.stdout.write(
      success('goal declared', {
        next: `musterd lane open "…" --goal ${id} --claim`,
      }) +
        '\n' +
        renderGoal(goal) +
        '\n',
    );
    return 0;
  }

  if (sub === 'list') {
    const { goals } = await http.goals(team);
    if (parsed.flags['json']) {
      process.stdout.write(JSON.stringify(goals) + '\n');
      return 0;
    }
    if (goals.length === 0) {
      process.stdout.write(
        theme.meta(
          'no declared goals yet — the board is clear. `musterd goal declare "<title>" --goal-id <id>`',
        ) + '\n',
      );
      return 0;
    }
    process.stdout.write(heading('goals') + '\n');
    for (const g of goals) process.stdout.write(renderGoal(g) + '\n');
    return 0;
  }

  throw new CliError(USAGE, 2);
}
