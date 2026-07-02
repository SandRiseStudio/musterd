import type { Lane } from '@musterd/protocol';
import type { Parsed } from '../args.js';
import { CliError } from '../errors.js';
import { theme } from '../render/theme.js';
import { resolve } from './helpers.js';

/**
 * `musterd done [<lane-id>]` — close the unit of work (ADR 049 as amended by 084). Marks the lane
 * `done` (the reliable terminal that drives derived Goal status — not the near-dead thread `resolve`).
 * Auto-targets your single live lane when no id is given; the toil-killer half of the next/done pair.
 */

const LIVE: ReadonlySet<string> = new Set(['claimed', 'active', 'blocked']);

function laneLine(l: Lane): string {
  const goal = l.goal_id ? theme.meta(` ◆ ${l.goal_id}`) : '';
  return `  ${theme.meta(l.id)} ${l.state} "${l.title}"${goal}`;
}

export async function doneCommand(parsed: Parsed): Promise<number> {
  const { team, identity, http } = resolve(parsed.flags);

  let id = parsed.positionals[0];
  if (!id) {
    // Auto-target: the caller's single live lane. Zero → nothing to close; many → ask which.
    const board = await http.laneBoard(team, { mine: true });
    const live = board.lanes.filter((l) => LIVE.has(l.state));
    if (live.length === 0) {
      throw new CliError(
        `no live lane to close for ${identity.name} — open one with \`musterd lane open "<title>" --claim\``,
        1,
      );
    }
    if (live.length > 1) {
      const lines = live.map(laneLine).join('\n');
      throw new CliError(
        `you own ${live.length} live lanes — name one: \`musterd done <lane-id>\`\n${lines}`,
        2,
      );
    }
    id = live[0]!.id;
  }

  const res = await http.updateLane(team, id, { state: 'done' });
  process.stdout.write(`${theme.ok('✓')} done\n${laneLine(res.lane)}\n`);

  // Chain into orientation: what's next now that this landed (the pair's whole point).
  const brief = await http.next(team);
  if (brief.up_next.length > 0) {
    process.stdout.write(`\n${theme.accent('up next')} — \`musterd next\` for the full brief:\n`);
    for (const l of brief.up_next.slice(0, 3)) process.stdout.write(laneLine(l) + '\n');
  }
  return 0;
}
