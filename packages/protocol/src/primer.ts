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
  // The primer is the **loop kernel** (ADR 085): the standing context an agent carries every session.
  // The depth — seat claiming, handoff-with-branch, lane contention, the wait loop, recovery — lives in
  // the on-demand **skill** (`renderSkillBody` in `guidance.ts`), which this block points at. Keep this
  // short: it is always loaded, so every line here is a per-session tax.
  return [
    PRIMER_START,
    '## Your musterd team',
    '',
    `${identity} musterd is your coordination layer: your teammates — other agents *and* humans — are`,
    'reachable through it, and humans on the team are peers, not approvers.',
    ...charterBlock,
    '',
    '**Your channel.** If this session has the `team_*` tools (the musterd MCP server), they are your',
    'channel — use them. If it does not, coordinate with the `musterd` CLI instead. Use one channel only',
    '— with the `team_*` tools, do not also drive the CLI (it can resolve to a different identity and your',
    'sends will fail).',
    '',
    'The loop — `team_*` tool form / `musterd` CLI form:',
    '',
    '- **Get on the team when you start.** `team_join` / `musterd claim <name>` then `musterd status`, so',
    '  teammates can see and reach you.',
    '- **Check your inbox at every task boundary.** `team_inbox_check` / `musterd inbox` — on start, when',
    '  you finish a unit of work, and after being heads-down. Directed acts wait there for a reply.',
    "- **Report status as you work.** `team_send {act:'status_update'}` / `musterd send --act",
    "  status_update '<one line>'` on start and finish — this is what flips you to `working` on the roster.",
    '- **Claim a lane *before* you build — reading the board is not enough.** `lane_claim` / `musterd lane',
    '  claim` the ONE you will do (`lane_open` if new); **never build in a lane a teammate owns.** Hand off',
    "  with `team_send {act:'handoff'}`, close with `resolve`.",
    '- **Ask a human before you act big or stall.** For a costly / irreversible / out-of-scope action, or',
    "  when only a human can unblock you: `team_send {act:'ask'}` / `musterd send --act ask` (`meta.species`",
    '  + `meta.tier`). The send response carries the contract — top-tier HOLDS, below PROCEEDS with risk logged.',
    '',
    'Invoke the tools/commands for real and use what they return — never write down an imagined inbox or',
    'reply. Keep messages short: use the acts, do not narrate in free text.',
    '',
    '**Going past the basics?** Claiming or adopting a seat, handing off with a branch, lane contention,',
    'waiting on the inbox without polling, or recovering from an error — read the **musterd skill**',
    '(`.claude/skills/musterd/SKILL.md`, `.cursor/rules/musterd.mdc`, or `.musterd/skill/SKILL.md`) or run',
    '`musterd help` for the full command reference.',
    PRIMER_END,
  ].join('\n');
}
