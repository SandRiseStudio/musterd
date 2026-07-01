/**
 * The agent primer (ADR 012 / docs/design/agent-primer.md) — the standing context that teaches a
 * fresh agent it is on a team and how to coordinate. The **pure renderer** lives here in
 * `@musterd/protocol` so both surfaces share one source of truth without a package cycle: the CLI
 * (`onboard/primer.ts`) wraps it with the `AGENTS.md` file I/O, and the MCP server (`@musterd/mcp`)
 * feeds it as the server `instructions` returned on initialize. Channel-aware (`team_*` tools *or* the
 * `musterd` CLI) and self-claim-aware (named seat *or* "claim one first").
 */

export const PRIMER_START =
  '<!-- musterd:start (managed by `musterd init` — edit outside these markers) -->';
export const PRIMER_END = '<!-- musterd:end -->';
// Stable prefixes used for matching, so a hand-edited start line still re-anchors on re-run.
export const PRIMER_START_PREFIX = '<!-- musterd:start';
export const PRIMER_END_MARKER = '<!-- musterd:end -->';

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
    : `You are a member of the **${opts.team}** team — **claim your seat first** (\`team_join\`, or \`musterd claim <name>\` then \`musterd status\`; a seat is claimed with the team **agent key** — set \`MUSTERD_AGENT_KEY\` or pass \`--key mskey_…\`, and an admin approves if no grant was pre-issued) so teammates can see and reach you.`;
  // A role template's charter (the *lens*, ADR 026 / human-agent-dynamics.md §3) is injected
  // additively inside the managed block, so a re-claim updates it in place without clobbering the
  // user's own prose outside the markers. Generalist (no charter) leaves the playbook unchanged.
  const charter = opts.charter?.trim();
  const charterBlock = charter
    ? ['', `## Your charter${role ? ` (${role})` : ''}`, '', charter, '']
    : [];
  return [
    PRIMER_START,
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
    '  so teammates can see you and reach you. Claim with the team **agent key** (`MUSTERD_AGENT_KEY`',
    '  or `--key mskey_…`); it binds this folder with no global-identity clobber, and an admin approves',
    '  the claim if no grant was pre-issued.',
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
    '- **Wait for the next message without polling.** When you are idle and want to resume the moment a',
    '  teammate addresses you, run `musterd inbox --wait` — it blocks until the next directed act, then',
    '  exits. Under a harness re-invoker, pair it with `/loop`: `musterd inbox --wait && <do the work>` —',
    '  the cheap, no-poll wake loop (do not bolt inbox-polling onto a timer).',
    '',
    'Invoke the tools/commands for real and use what they return — never write down an imagined inbox or',
    'reply; if you did not call it, you do not know what is there. Keep messages short and purposeful:',
    'the acts are how the team coordinates — use them instead of narrating in free text.',
    PRIMER_END,
  ].join('\n');
}
