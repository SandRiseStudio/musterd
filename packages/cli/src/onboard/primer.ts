import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The agent primer (ADR 012 / docs/design/agent-primer.md). `musterd init` seeds the binding
 * folder's AGENTS.md — the cross-tool agent-context file both Claude Code and Cursor read every
 * session — with a marker-delimited block giving a fresh agent standing context: who it is and
 * the team working-loop (join → inbox at task boundaries → status/request_help/handoff/accept).
 * Without it, a fresh agent doesn't know it's on a team or how to coordinate (2026-06-12 dogfood).
 */

const START = '<!-- musterd:start (managed by `musterd init` — edit outside these markers) -->';
const END = '<!-- musterd:end -->';
// Stable prefixes used for matching, so a hand-edited start line still re-anchors on re-run.
const START_PREFIX = '<!-- musterd:start';
const END_MARKER = '<!-- musterd:end -->';

/** Render the managed primer block (including the start/end markers) for a member on a team. */
export function renderPrimer(opts: { member: string; team: string; role?: string }): string {
  const role = opts.role?.trim();
  const who = role ? `**${opts.member}**, the ${role},` : `**${opts.member}**`;
  return [
    START,
    '## Your musterd team',
    '',
    `You are ${who} on the **${opts.team}** team. musterd is your coordination layer: your`,
    'teammates — other agents *and* humans — are reachable through the `team_*` tools in this',
    'session. Humans on the team are peers, not approvers.',
    '',
    'Work as a teammate, not in isolation:',
    '',
    '- **Join when you start.** Call `team_join` at the start of a working session so teammates',
    '  can see you and reach you. (If this agent was set up with auto-join, you’re already on.)',
    '- **Check your inbox at every task boundary.** Call `team_inbox_check` when you start, when',
    '  you finish a unit of work, and after you’ve been heads-down — messages addressed to you',
    '  wait there and teammates expect a reply.',
    "- **Say what you’re doing.** Post `team_send {act:'status_update'}` when you pick up or finish",
    '  work, so the team (and the human watching) can see progress.',
    "- **Ask when you’re blocked** with `team_send {act:'request_help'}` instead of guessing — it’s",
    '  visible to the whole team.',
    "- **Hand off cleanly.** `team_send {act:'handoff'}` passes a unit of work (name the artifact);",
    '  answer a `request_help` or `handoff` with `accept` / `decline` (set `reply_to`).',
    '- **See who’s around** with `team_status` / `team_members` before you ask or hand off.',
    '',
    'Keep messages short and purposeful. The acts are how the team coordinates — use them instead',
    'of narrating in free text.',
    END,
  ].join('\n');
}

/**
 * Write or update the primer block in `<dir>/AGENTS.md`, idempotently and without clobbering the
 * user's own content: create the file if absent, replace the managed block in place if markers are
 * present, otherwise append the block below existing prose.
 */
export function upsertPrimer(
  dir: string,
  block: string,
): { path: string; action: 'created' | 'appended' | 'updated' } {
  const path = join(dir, 'AGENTS.md');
  if (!existsSync(path)) {
    writeFileSync(path, block + '\n', 'utf8');
    return { path, action: 'created' };
  }
  const content = readFileSync(path, 'utf8');
  const startIdx = content.indexOf(START_PREFIX);
  const endIdx = content.indexOf(END_MARKER);
  if (startIdx >= 0 && endIdx > startIdx) {
    const next = content.slice(0, startIdx) + block + content.slice(endIdx + END_MARKER.length);
    writeFileSync(path, next, 'utf8');
    return { path, action: 'updated' };
  }
  const sep = content.endsWith('\n') ? '\n' : '\n\n';
  writeFileSync(path, content + sep + block + '\n', 'utf8');
  return { path, action: 'appended' };
}
