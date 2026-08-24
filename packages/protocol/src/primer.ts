/**
 * The agent primer (ADR 012 / docs/design/agent-primer.md) — the standing context that teaches a
 * fresh agent it is on a Team and how to coordinate. The delivery-specific pure renderers live here
 * in `@musterd/protocol` so the repository and runtime identity boundaries stay explicit without a
 * package cycle. Both compose the same channel-aware working loop (ADR 307).
 */

export const PRIMER_START =
  '<!-- musterd:start (managed by `musterd init` — edit outside these markers) -->';
export const PRIMER_END = '<!-- musterd:end -->';
// Stable prefixes used for matching, so a hand-edited start line still re-anchors on re-run.
export const PRIMER_START_PREFIX = '<!-- musterd:start';
export const PRIMER_END_MARKER = '<!-- musterd:end -->';

/** Render the marker-delimited, identity-neutral loop shared by both delivery contexts. */
function renderPrimer(identity: string): string {
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
    '',
    '**Your channel.** If this session has the `team_*` tools (the musterd MCP server), they are your',
    'channel — use them; otherwise coordinate with the `musterd` CLI. Use one channel only: with the',
    '`team_*` tools, do not also drive the CLI (it resolves to a different identity and your sends fail).',
    '',
    'The loop — `team_*` tool form / `musterd` CLI form:',
    '',
    '- **Get on the team when you start.** Your seat auto-claims on your first `team_*` call, so',
    '  `team_inbox_check` / `musterd claim <name>` is enough; `team_join` only if a tool says otherwise.',
    '- **Check your inbox at every task boundary.** `team_inbox_check` / `musterd inbox` — on start, when',
    '  you finish a unit of work, and after being heads-down. Directed acts wait there for a reply.',
    "- **Report status as you work.** `team_send {act:'status_update'}` / `musterd send --act",
    "  status_update '<one line>'` on start and finish — this is what flips you to `working` on the roster.",
    '- **Claim a lane *before* you build — reading the board is not enough.** `lane_claim` / `musterd lane',
    '  claim` the ONE you will do (`lane_open` if new); **never build in a lane a teammate owns.** Hand off',
    "  with `team_send {act:'handoff'}`; after merge `lane_submit`, then accept or `lane_resolve`.",
    '- **Ask a human before you act big or stall.** For a costly / irreversible / out-of-scope action, or',
    "  when only a human can unblock you: `team_send {act:'ask'}` / `musterd send --act ask` (`meta.species`",
    '  + `meta.tier`). The `team_send` reply hands you the contract: blocking 15m HOLDS; standard 5m / advisory 3m PROCEED (risk logged).',
    '',
    'Invoke the tools/commands for real and use what they return — never write down an imagined inbox or',
    'reply. Keep messages short: use the acts, do not narrate in free text. **The daemon refreshes itself',
    '— never ask a human to:** your merge reaches it without you (`~/.musterd/autorefresh/refresh.log`).',
    '',
    '**Going past the basics?** Adopting a seat, handing off a branch, lane contention, waiting without',
    'polling, daemon refresh, or recovering from an error — read the **musterd skill**',
    '(`.claude/skills/musterd/SKILL.md`, `.cursor/rules/musterd.mdc`, or `.musterd/skill/SKILL.md`) or run',
    '`musterd help` for the full command reference.',
    PRIMER_END,
  ].join('\n');
}

/**
 * Render the primer safe to commit in `AGENTS.md`. A Team is repository intent; the Member target is
 * Workspace-local and must come from runtime instructions, authenticated occupancy, or `whoami`.
 */
export function renderRepositoryPrimer(opts: { team: string }): string {
  const identity = `This repository coordinates through musterd with the **${opts.team}** Team. Member identity is Workspace-local: with the \`team_*\` tools, trust the adapter instructions and authenticated occupancy; without them, run \`musterd whoami\`. If no local identity is active, repair the wiring or ask the human — never claim a named seat from repository prose.`;
  return renderPrimer(identity);
}

/**
 * Render process-local MCP instructions. A configured Member is an intended target until the
 * server's authenticated `occupied` response confirms it; unresolved policies keep claim-first help.
 */
export function renderRuntimePrimer(opts: { team: string; member?: string }): string {
  const identity = opts.member
    ? `You are **${opts.member}** on the **${opts.team}** Team.`
    : `You are a Member of the **${opts.team}** Team — **claim your seat first** (\`team_join\`, or \`musterd claim <name>\` then \`musterd status\`; a seat is claimed with the Team **agent key** — set \`MUSTERD_AGENT_KEY\` or pass \`--key mskey_…\`, and an admin approves if no grant was pre-issued) so teammates can see and reach you.`;
  return renderPrimer(identity);
}
