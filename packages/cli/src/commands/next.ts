import { incidentBannerLines, shortDuration, type Lane, type NextBrief } from '@musterd/protocol';
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

/** Coarse elapsed time — the reader needs "hours, not minutes", never a precise duration. */
function render(brief: NextBrief): void {
  const w = process.stdout.write.bind(process.stdout);
  w(`${theme.accent('next')} — as ${theme.memberName(brief.member, 'agent')}\n`);

  // Incident banner FIRST, above everything including owed reviews (spec 2026-08-14 §4). Most of
  // the measured waste in the motivating episode was seats STARTING SESSIONS into a shared red they
  // assumed was theirs — so this is the one line that has to land before a seat reads anything else
  // and decides what it is working on.
  //
  // This surface had it missing entirely through increments 1 and 2: the banner was written into the
  // MCP renderer and never here, so every CLI seat got none of it. Words now come from the protocol
  // package so a third surface cannot repeat that. `?? []` for the same daemon-skew reason as
  // owed_reviews below — the brief arrives cast, not parsed.
  for (const inc of brief.incidents ?? []) {
    for (const line of incidentBannerLines(inc)) w(`${theme.warn(line)}\n`);
  }

  // FIRST, above your own work, on purpose (ADR 233). This is the one item in the brief that
  // someone else is blocked on, and the one that loses when a seat is busy: half the unverified
  // closes had the named reviewer online for ~40 minutes and still never answering. Printing it
  // under `carrying` would reproduce the failure it exists to fix.
  // `?? []` is not defensive noise: the brief arrives cast, not parsed through NextBriefSchema, so
  // a daemon predating ADR 233 omits the key and this would throw on `.length`. Additive means the
  // OLD daemon can omit it, which makes tolerating that the new client's job.
  const owed = brief.owed_reviews ?? [];
  if (owed.length > 0) {
    const now = Date.now();
    w(`\n${theme.accent('owed by you')} — ${owed.length} lane(s) waiting on your verdict:\n`);
    for (const r of owed) {
      w(
        `  ${theme.meta(r.lane.id)} "${r.lane.title}" — ${theme.memberName(r.from, 'agent')} has waited ${shortDuration(now - r.ts)}\n`,
      );
      w(theme.meta(`    answer: \`musterd send --act accept --reply-to ${r.ask_id} "…"\``) + '\n');
    }
  }
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
      w(
        `  ${theme.ok('✓')} "${l.title}"${l.goal_id ? theme.meta(` ◆ ${l.goal_id}`) : ''}` +
          // ADR 192's copy, matching the web board's chip (ADR 169). Only on an explicit `false`:
          // an absent verdict is unknown, not unconfirmed.
          (l.verified === false ? theme.meta(' — unconfirmed') : '') +
          '\n',
      );
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
    owed.length === 0 &&
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
