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

/** True when `content` already carries a managed musterd primer block (both markers present). */
export function hasPrimerMarkers(content: string): boolean {
  return content.includes(START_PREFIX) && content.includes(END_MARKER);
}

/**
 * What writing the primer into `<dir>/AGENTS.md` will do — so the confirm prompt can be honest at
 * the decision point (the dogfood paper-cut: a "Write an AGENTS.md?" prompt next to an existing,
 * unmarked AGENTS.md reads like overwrite when it is actually an append). Maps 1:1 to
 * {@link upsertPrimer}'s action: `none`→`created`, `unmarked`→`appended`, `managed`→`updated`.
 */
export type PrimerTarget = 'none' | 'unmarked' | 'managed';

/** Classify the AGENTS.md in `dir`: absent, present-without-markers, or already-managed. */
export function classifyPrimerTarget(dir: string): PrimerTarget {
  const path = join(dir, 'AGENTS.md');
  if (!existsSync(path)) return 'none';
  try {
    return hasPrimerMarkers(readFileSync(path, 'utf8')) ? 'managed' : 'unmarked';
  } catch {
    // Unreadable AGENTS.md: treat as absent so init still offers to write (upsert handles the rest).
    return 'none';
  }
}

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
    "- **Report status as you work.** Post `team_send {act:'status_update'}` *when you start a task*",
    '  and when you finish — a single short line on what you’re doing now (one sentence, not an essay).',
    '  This is what flips you to `working` on the roster; without it teammates just see you as idle.',
    "- **Ask when you’re blocked** with `team_send {act:'request_help'}` instead of guessing — it’s",
    '  visible to the whole team.',
    "- **Hand off cleanly.** `team_send {act:'handoff'}` passes a unit of work (name the artifact);",
    '  answer a `request_help` or `handoff` with `accept` / `decline` (set `reply_to`).',
    '- **See who’s around** with `team_status` / `team_members` before you ask or hand off.',
    '',
    'The `team_*` calls are tools — invoke them directly and use what they return. Never write down',
    'an imagined inbox or reply: if you didn’t call the tool, you don’t know what’s there. Do **not**',
    'shell out to the `musterd` CLI to coordinate — it authenticates as a different identity and your',
    'sends will fail; the `team_*` tools are your only channel.',
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
