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

/**
 * Render the managed primer block (including the start/end markers). `member` is optional: when a seat
 * is already assigned (a provisioned agent), the primer names it; when it isn't (a fresh agent that must
 * onboard itself), the primer tells it to claim a seat first. The playbook is **channel-aware** — it
 * works whether the session has the `team_*` MCP tools or only the `musterd` CLI (the dev-repo /
 * unprovisioned case), instead of assuming the tools and banning the CLI.
 */
export function renderPrimer(opts: {
  member?: string;
  team: string;
  role?: string;
  charter?: string;
}): string {
  const role = opts.role?.trim();
  const identity = opts.member
    ? `You are ${role ? `**${opts.member}**, the ${role},` : `**${opts.member}**`} on the **${opts.team}** team.`
    : `You are a member of the **${opts.team}** team — **claim your seat first** (\`team_join\`, or \`musterd claim <name>\` then \`musterd status\`) so teammates can see and reach you.`;
  // A role template's charter (the *lens*, ADR 026 / human-agent-dynamics.md §3) is injected
  // additively inside the managed block, so a re-claim updates it in place without clobbering the
  // user's own prose outside the markers. Generalist (no charter) leaves the playbook unchanged.
  const charter = opts.charter?.trim();
  const charterBlock = charter
    ? ['', `## Your charter${role ? ` (${role})` : ''}`, '', charter, '']
    : [];
  return [
    START,
    '## Your musterd team',
    '',
    `${identity} musterd is your coordination layer: your teammates — other agents *and* humans — are`,
    'reachable through it, and humans on the team are peers, not approvers.',
    ...charterBlock,
    '',
    '**Your channel.** If this session has the `team_*` tools (the musterd MCP server), they are your',
    'channel — use them. If it does not, coordinate with the `musterd` CLI instead (`musterd help`): the',
    'same team and the same acts. Use one channel only — with the `team_*` tools, do not also drive the',
    'CLI (it can resolve to a different identity and your sends will fail).',
    '',
    'Work as a teammate, not in isolation — `team_*` tool form / `musterd` CLI form:',
    '',
    '- **Get on the team when you start.** `team_join` / `musterd claim <name>` then `musterd status` —',
    '  so teammates can see you and reach you.',
    '- **Check your inbox at every task boundary.** `team_inbox_check` / `musterd inbox` — when you',
    '  start, when you finish a unit of work, and after being heads-down. Messages addressed to you wait',
    '  there and teammates expect a reply.',
    "- **Report status as you work.** `team_send {act:'status_update'}` / `musterd send --act",
    "  status_update '<one line>'` — when you start a task and when you finish. This is what flips you to",
    '  `working` on the roster; without it teammates just see you as idle.',
    "- **Ask when you are blocked.** `team_send {act:'request_help'}` / `musterd send --act request_help",
    '  …` — instead of guessing; it is visible to the whole team.',
    "- **Hand off cleanly.** `team_send {act:'handoff'}` / `musterd send --act handoff …` passes a unit",
    '  of work (name the artifact); answer a `request_help`/`handoff` with `accept`/`decline` (set',
    '  `reply_to` / `--reply-to`).',
    "- **Close the loop when it is done.** `team_send {act:'resolve', thread:<id>}` / `musterd send --act",
    '  resolve --thread <id>` — accepting is not finishing; it clears the request from the team pending',
    '  view.',
    '- **See who is around.** `team_status` / `team_members` / `musterd status` — before you ask or hand',
    '  off.',
    '',
    'Invoke the tools/commands for real and use what they return — never write down an imagined inbox or',
    'reply; if you did not call it, you do not know what is there. Keep messages short and purposeful:',
    'the acts are how the team coordinates — use them instead of narrating in free text.',
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

/**
 * Remove the managed primer block from `<dir>/AGENTS.md` (ADR 027 reversibility — `musterd
 * uninstall`), keeping the user's own prose outside the markers. Tidies the seam left behind so the
 * file doesn't accumulate blank lines. Returns what happened: `removed`, `absent` (no markers), or
 * `missing` (no AGENTS.md). Never throws on a missing file.
 */
export function removePrimer(dir: string): {
  path: string;
  action: 'removed' | 'absent' | 'missing';
} {
  const path = join(dir, 'AGENTS.md');
  if (!existsSync(path)) return { path, action: 'missing' };
  const content = readFileSync(path, 'utf8');
  const startIdx = content.indexOf(START_PREFIX);
  const endIdx = content.indexOf(END_MARKER);
  if (startIdx < 0 || endIdx <= startIdx) return { path, action: 'absent' };
  const before = content.slice(0, startIdx).replace(/\n+$/, '');
  const after = content.slice(endIdx + END_MARKER.length).replace(/^\n+/, '');
  const joined = [before, after].filter((s) => s.length > 0).join('\n\n');
  writeFileSync(path, joined.length > 0 ? joined + '\n' : '', 'utf8');
  return { path, action: 'removed' };
}
