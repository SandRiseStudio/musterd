import type { Lane, NextBrief } from '@musterd/protocol';
import type { Parsed } from '../args.js';
import { theme } from '../render/theme.js';
import { resolve } from './helpers.js';

/**
 * `musterd next` — the orientation brief (ADR 049/084). A fresh session self-orients without a
 * human-authored copy-paste prompt: what you're carrying, what just shipped, what to pick up, and the
 * latest handoff *why*. The projection is computed server-side (`GET /next`); this only renders it.
 */

function laneLine(l: Lane): string {
  const goal = l.goal_id ? theme.meta(` ◆ ${l.goal_id}`) : '';
  const branch = l.branch ? theme.meta(` ⎇ ${l.branch}`) : '';
  return `  ${theme.meta(l.id)} ${l.state} "${l.title}"${goal}${branch}`;
}

function render(brief: NextBrief): void {
  const w = process.stdout.write.bind(process.stdout);
  w(`${theme.accent('next')} — as ${theme.memberName(brief.member, 'agent')}\n`);

  if (brief.in_flight.length > 0) {
    w(`\n${theme.accent('carrying')} (${brief.in_flight.length}):\n`);
    for (const l of brief.in_flight) w(laneLine(l) + '\n');
  }
  if (brief.up_next.length > 0) {
    w(`\n${theme.accent('up next')} — open lanes you could pick up:\n`);
    for (const l of brief.up_next) w(laneLine(l) + '\n');
  }
  if (brief.shipped.length > 0) {
    w(`\n${theme.meta('recently shipped:')}\n`);
    for (const l of brief.shipped)
      w(`  ${theme.ok('✓')} "${l.title}"${l.goal_id ? theme.meta(` ◆ ${l.goal_id}`) : ''}\n`);
  }
  if (brief.next_goal) {
    const g = brief.next_goal;
    const wave = g.wave !== null ? theme.meta(` wave:${g.wave}`) : '';
    w(`\n${theme.accent('next goal')} — ${theme.meta(g.id)} "${g.title}"${wave}\n`);
    w(theme.meta(`  claim a lane on it: \`musterd lane open "…" --goal ${g.id} --claim\``) + '\n');
  }
  if (brief.why) {
    const when = new Date(brief.why.ts).toISOString().slice(0, 10);
    const goal = brief.why.goal_id ? theme.meta(` ◆ ${brief.why.goal_id}`) : '';
    w(
      `\n${theme.accent('why')} — handoff from ${theme.memberName(brief.why.from, 'agent')}${goal} ${theme.meta(`(${when})`)}\n`,
    );
    w(`  ${brief.why.body}\n`);
  }

  if (
    brief.in_flight.length === 0 &&
    brief.up_next.length === 0 &&
    brief.shipped.length === 0 &&
    !brief.next_goal &&
    !brief.why
  ) {
    w(
      theme.meta('nothing in flight — `musterd lane open "<title>" --claim` to declare your work') +
        '\n',
    );
  }
}

export async function nextCommand(parsed: Parsed): Promise<number> {
  const { team, http } = resolve(parsed.flags);
  const brief = await http.next(team);
  if (parsed.flags['json']) {
    process.stdout.write(JSON.stringify(brief) + '\n');
    return 0;
  }
  render(brief);
  return 0;
}
