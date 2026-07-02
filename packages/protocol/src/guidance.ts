/**
 * The agent **skill** and **slash-command** templates (ADR 085 / docs/decisions/085-layered-guidance-surface.md)
 * — the on-demand playbook layer that sits below the always-loaded primer (`primer.ts`). The primer is
 * the loop *kernel* an agent carries every session; this is the depth it opens *when* a team interaction
 * goes past the basics (claiming a seat, handing off with a branch, recovering from a `conflict`).
 *
 * The pure renderers live here in `@musterd/protocol` so every surface shares one source of truth: the
 * CLI (`onboard/guidance.ts`) wraps them with per-harness file I/O and the content stamp.
 *
 * ## The layering rule (ADR 085) — do not break this
 * The primer = the loop kernel. This skill = playbooks. `musterd help` = flag-level reference. Hooks =
 * enforcement. **No fact is written in two layers except command/tool *names*** — and those are the only
 * duplication because they are the one thing CI can verify (`pnpm guidance:check` asserts every name in
 * `SKILL_CLI_COMMANDS` is in the CLI `HELP` and every name in `SKILL_MCP_TOOLS` is a registered MCP tool,
 * so a rename breaks the build instead of rotting the skill). So: name a command and give its one-line
 * intent, then say "run `musterd help`" for the flags. Do **not** inline flag lists into the prose here.
 */

/** Bumped whenever the rendered skill/command *content* changes (the stamp + doctor drift check key off
 * it). A snapshot test fails if the body changes without this moving, forcing the bump. */
export const GUIDANCE_CONTENT_VERSION = 1;

/** MCP tool names the skill references by name. CI (`guidance:check`) asserts each is a registered tool
 * in `@musterd/mcp`, so renaming a tool without updating the skill breaks the build. */
export const SKILL_MCP_TOOLS = [
  'team_join',
  'team_inbox_check',
  'team_send',
  'team_status',
  'team_members',
  'team_next',
  'lane_open',
  'lane_claim',
  'lane_handoff',
  'lane_resolve',
  'lane_board',
] as const;

/** CLI command names the skill references by name. CI (`guidance:check`) asserts each appears in the CLI
 * `HELP` text, so renaming a command without updating the skill breaks the build. */
export const SKILL_CLI_COMMANDS = [
  'init',
  'claim',
  'whoami',
  'status',
  'inbox',
  'send',
  'lane',
  'lanes',
  'next',
  'done',
  'requests',
  'availability',
  'notify',
  'unbind',
  'reclaim',
] as const;

/** The content-stamp prefix. A full stamp reads: `<!-- musterd:content v1 sha256:abcd1234 -->`. */
export const GUIDANCE_STAMP_PREFIX = '<!-- musterd:content';

/** Render the managed content stamp that musterd writes into every guidance file. `hash` is a short
 * (≥8-char) hex digest of the body the writer computed (`onboard/guidance.ts`, node:crypto). */
export function renderContentStamp(version: number, hash: string): string {
  return `${GUIDANCE_STAMP_PREFIX} v${version} sha256:${hash} -->`;
}

/** Parse a content stamp out of a written file. Returns null when no managed stamp is present (a
 * user-authored file musterd must not clobber). Matches anywhere in the text so the stamp can lead or
 * trail the body. */
export function parseContentStamp(text: string): { version: number; hash: string } | null {
  const m = text.match(/<!-- musterd:content v(\d+) sha256:([0-9a-f]{8,}) -->/);
  if (!m) return null;
  return { version: Number(m[1]), hash: m[2]! };
}

const CHANNEL_NOTE =
  'Use **one channel**: if this session has the `team_*` tools (the musterd MCP server), use them; ' +
  'otherwise use the `musterd` CLI. Do not drive both — the CLI can resolve to a different identity and ' +
  'your sends will fail. Names below are given tool-form / CLI-form.';

/**
 * The skill *body* — the harness-neutral playbook text (no frontmatter, no stamp; those are added per
 * surface by the caller). Keep it directive and scannable. Reference commands/tools **by name only**
 * (the arrays above); the flags live in `musterd help`, not here.
 */
export function renderSkillBody(opts: { team: string }): string {
  const team = opts.team;
  return [
    `# Using musterd — playbooks for the ${team} team`,
    '',
    'musterd is your coordination layer: teammates (agents *and* humans, who are peers not approvers) are',
    'reachable through it. This skill is the depth behind the primer — open it when a team interaction goes',
    'past the basic loop: claiming or adopting a seat, handing off work, opening a lane, or recovering from',
    'an error. For the everyday loop (join, inbox at task boundaries, status_update, resolve) the primer in',
    'AGENTS.md is enough; for exact flags on any command run `musterd help`.',
    '',
    `> ${CHANNEL_NOTE}`,
    '',
    '## Claiming your seat',
    '',
    'A session is dormant until it claims a seat. `team_join` / `musterd claim <name>` puts you on the',
    'roster so teammates can see and reach you; confirm with `musterd whoami` (the seat this folder',
    'resolves to) and `musterd status` (who else is around).',
    '',
    '- **Claim with the team agent key.** Set `MUSTERD_AGENT_KEY` or pass `--key mskey_…`. This binds the',
    '  folder with no global-identity clobber. If no grant was pre-issued the claim opens a request and',
    '  **waits for an admin to approve** — that is expected, not a failure.',
    "- **Adopt an existing seat** (take over a teammate's named seat) with `musterd claim <name> --token",
    "  <code>` — it adopts the seat into this folder's binding without clobbering your global identity.",
    '- **Recover from `conflict`.** A `conflict` means the seat/folder is already held. Do **not** hand-edit',
    "  state. Options: `musterd unbind` to release this folder's seat, `musterd reclaim <member>` to drop a",
    '  stuck/stale live session so it can rejoin, or claim a *different* open seat. Never run `musterd agent',
    "  --here` inside a live seat's folder (it clobbers the binding).",
    '- **Approve requests you own** (admin): `musterd requests` lists pending claims; decide with the',
    '  request-decide flow (see `musterd help`).',
    '',
    '## Owning work in a lane',
    '',
    'Declare what you are working on so the team sees it and musterd can warn on overlap (it warns, never',
    'blocks). `lane_open {title, surface_globs, claim:true}` / `musterd lane open "<title>" --surface',
    '<globs> --claim` when you start; `lane_claim` to take an open lane; `lane_board` / `musterd lanes` to',
    'see who owns what. Link a lane to a Goal with `--goal <id>` so status derives up the plan.',
    '`musterd next` gives your orientation brief (what you carry, what to pick up); `musterd done` closes',
    'your live lane and shows what is next.',
    '',
    '## Handing off cleanly',
    '',
    'A handoff carries the *work*, and the branch is part of the work. `lane_handoff` / `musterd lane',
    'handoff <id> --to <seat> --branch <ref>` transfers the lane **with its branch** so the next owner does',
    "not re-derive it. Pair it with `team_send {act:'handoff'}` / `musterd send --act handoff` naming the",
    'artifact. The receiver answers with `accept`/`decline` (set `reply_to`), and — importantly — accepting',
    'is not finishing: close the thread with `resolve` when the work actually lands.',
    '',
    '## Waiting without polling',
    '',
    'When you are idle and want to resume the moment a teammate addresses you, `musterd inbox --wait` blocks',
    'until the next directed act, then exits. Under a harness re-invoker pair it with `/loop`: `musterd inbox',
    '--wait && <do the work>` — the cheap, no-poll wake loop. Do not bolt inbox-polling onto a timer.',
    '',
    'Set how reachable you are with `musterd availability <available|away|dnd>` — `away` holds',
    'notifications, `dnd` still passes directed + urgent. `musterd notify` runs a background nudge that',
    'raises an OS notification when a directed act lands while you are away (the human-side loop).',
    '',
    '## When something looks wrong',
    '',
    '- **"You are auto-joined" but the `team_*` tools are absent** → the MCP server is not registered in',
    '  this checkout. Run `musterd init` (or `musterd init --check` to see the drift without writing).',
    '- **Sends fail / wrong identity** → run `musterd whoami`; you are likely driving the CLI alongside the',
    '  `team_*` tools (two identities). Pick one channel.',
    '- **You cannot tell what is real** → invoke the tool and use what it returns. Never write down an',
    '  imagined inbox or reply; if you did not call it, you do not know what is there.',
    '',
    '---',
    '',
    '### Command & tool reference (names — run `musterd help` for flags)',
    '',
    `- MCP tools: ${SKILL_MCP_TOOLS.map((n) => `\`${n}\``).join(', ')}`,
    `- CLI commands: ${SKILL_CLI_COMMANDS.map((n) => `\`musterd ${n}\``).join(', ')}`,
    '',
  ].join('\n');
}

/** Frontmatter shell for a harness that gates a skill/rule on a `description` (Claude Code skill, Cursor
 * `.mdc` rule). `canonical` is the harness-neutral `.musterd/skill/SKILL.md` — no frontmatter. */
export function renderSkillFrontmatter(harness: 'claude-code' | 'cursor' | 'canonical'): string {
  const description =
    'Using the musterd coordination layer: claiming or adopting a seat, owning work in a lane, ' +
    'handing off with a branch, waiting on the inbox without polling, and recovering from claim/identity ' +
    'errors. Use when a musterd team interaction goes past the basic join/inbox/status loop.';
  if (harness === 'claude-code') {
    return ['---', 'name: musterd', `description: ${description}`, '---'].join('\n');
  }
  if (harness === 'cursor') {
    return ['---', `description: ${description}`, 'alwaysApply: false', '---'].join('\n');
  }
  return '';
}

/** The three human-triggered slash-command prompts. Each drives real `musterd` commands and acts on
 * their output — thin, no flags baked in beyond what the workflow needs. */
export function renderSlashCommand(name: 'standup' | 'handoff' | 'claim'): string {
  switch (name) {
    case 'standup':
      return [
        '---',
        'description: musterd standup — digest the team state and propose the next move',
        '---',
        '',
        'Give me a musterd standup for this team. Run these and synthesize, do not just dump output:',
        '',
        '1. `musterd status` — who is around and their availability.',
        '2. `musterd lanes --open` — open lanes and any overlap/dependency warnings.',
        '3. `musterd inbox --unread` — directed acts waiting for me.',
        '4. `musterd next` — my orientation brief (what I carry, what to pick up).',
        '',
        'Then summarize in a few lines: what changed, what is blocked, and the single next action you',
        'recommend I take. Keep it tight.',
        '',
      ].join('\n');
    case 'handoff':
      return [
        '---',
        'description: musterd handoff — pass a lane (with its branch) to a teammate',
        '---',
        '',
        'Walk me through a clean musterd handoff:',
        '',
        '1. Confirm what I am handing off: run `musterd lanes --mine` and identify the lane id.',
        '2. Make sure the branch is committed and named — a handoff carries the branch.',
        '3. Transfer it: `musterd lane handoff <id> --to <seat> --branch <ref>`.',
        '4. Announce it: `musterd send --to <seat> --act handoff` naming the artifact and what is left.',
        '5. Watch for their `accept`/`decline`, and remind me that accepting is not finishing — the thread',
        '   is closed with `resolve` when the work lands.',
        '',
        'Ask me for the target seat and branch if I have not given them.',
        '',
      ].join('\n');
    case 'claim':
      return [
        '---',
        'description: musterd claim — get onto the team from this folder',
        '---',
        '',
        'Get me onto the musterd team from this folder:',
        '',
        '1. `musterd whoami` — check whether this folder already resolves to a seat.',
        '2. If unclaimed, claim it: `musterd claim <name>` with the team agent key (`MUSTERD_AGENT_KEY` or',
        '   `--key mskey_…`), or adopt an existing seat with `--token <code>`.',
        '3. If the claim opens a request and waits for admin approval, tell me — that is expected; poll with',
        '   `musterd whoami` / `musterd status` until it is granted.',
        '4. On `conflict`, do not hand-edit state — offer `musterd unbind`, `musterd reclaim <member>`, or a',
        '   different open seat.',
        '5. Confirm with `musterd status` once I am on.',
        '',
      ].join('\n');
  }
}
