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
export const GUIDANCE_CONTENT_VERSION = 13;

/** MCP tool names the skill references by name. CI (`guidance:check`) asserts each is a registered tool
 * in `@musterd/mcp`, so renaming a tool without updating the skill breaks the build. */
export const SKILL_MCP_TOOLS = [
  'team_join',
  'team_inbox_check',
  'team_send',
  'team_status',
  'team_members',
  'team_memory_save',
  'team_memory_read',
  'team_next',
  'lane_open',
  'lane_claim',
  'lane_release',
  'lane_handoff',
  'lane_submit',
  'lane_resolve',
  'lane_board',
] as const;

/** CLI command names the skill references by name. CI (`guidance:check`) asserts each appears in the CLI
 * `HELP` text, so renaming a command without updating the skill breaks the build. */
export const SKILL_CLI_COMMANDS = [
  'init',
  // The workspace pair the skill now teaches (ADR 176): agents stand in worktrees, the human stands
  // in the team home. Named here so renaming either verb breaks the build instead of rotting the skill.
  'agent',
  'human',
  'board',
  'claim',
  'whoami',
  'status',
  'inbox',
  'send',
  'lane',
  'lanes',
  'next',
  'done',
  'memory',
  'requests',
  'availability',
  'notify',
  'unbind',
  'reclaim',
  'session',
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
    '**Where each kind of teammate stands.** `musterd agent <name>` mints an agent seat and stands it in',
    'an isolated git worktree, because an agent writes code. `musterd human <name>` stands a person in the',
    '**team home** (`~/musterd/<team>`), because what a human needs is somewhere their identity resolves —',
    '`musterd board`, `musterd inbox --watch` and `musterd send` are simply them there, with no `--as` and',
    'nothing pasted. The pair is one model, not two commands: **agents stand in worktrees, the human stands',
    'in the team home.** If a human on your team has no floor to act from, `musterd human` is the fix.',
    '',
    '## Owning work in a lane — claim before you build',
    '',
    '**Claim a lane before you touch the work, not after.** On a team, an open lane is an *invitation to',
    'claim*, not a menu to read past — a seeded board that nobody claims produces three agents all building',
    'the same thing and throwing two-thirds of it away. So: `lane_board` / `musterd lanes` to see what is',
    'open and who owns what, then `lane_claim` / `musterd lane claim` **the one lane you will do** before you',
    'start editing. Open a new one with `lane_open {title, surface_globs, claim:true}` / `musterd lane open',
    '"<title>" --surface <globs> --claim` if your work is not on the board yet.',
    '',
    '- **Never build in a lane a teammate already owns.** If the lane you need is claimed, coordinate —',
    "  `team_send` the owner, take a *different* open lane, or ask them to hand off — don't duplicate it.",
    '- **Park work you stop carrying.** If you claimed a lane and are not doing it, `lane_release` /',
    '  `musterd lane release <id>` hands it back to the board — a claimed lane sitting idle reserves work',
    '  nobody is doing. Releasing is not failing; it is the honest board state.',
    '- Link a lane to a Goal with `--goal <id>` so status derives up the plan. `musterd next` gives your',
    '  orientation brief (what you carry, what to pick up); `musterd done` closes your live lane and shows',
    '  what is next. Overlap is warned, never blocked — the warning is a coordination prompt, act on it.',
    '',
    '## Handing off cleanly',
    '',
    'A handoff carries the *work*, and the branch is part of the work. `lane_handoff` / `musterd lane',
    'handoff <id> --to <seat> --branch <ref>` transfers the lane **with its branch** so the next owner does',
    "not re-derive it. Pair it with `team_send {act:'handoff'}` / `musterd send --act handoff` naming the",
    'artifact. The receiver answers with `accept`/`decline` (set `reply_to`), and — importantly — accepting',
    'is not finishing: close the thread with `resolve` when the work actually lands.',
    '',
    '## Closing a lane — outcome acceptance (ADR 192)',
    '',
    'This is **not** a GitHub/code review. CI + auto-merge land the PR; then an acceptor judges the',
    '**landed outcome** (intent / principles / usable / feel) — not the hunk list.',
    '',
    '1. After merge: `lane_submit` / `musterd lane submit` with the merge attestation (`pr`, `sha`,',
    '   `authorized_by`). Moves the lane to `awaiting_acceptance` and asks an acceptor.',
    '2. Acceptor: accept (→ done) or reject (→ active with a concrete note). Not style nits.',
    '3. On silence / no candidate: `lane_resolve` / `musterd lane resolve` yourself — recorded',
    '   **unconfirmed**, never a wedge. Prefer a live acceptor over self-close.',
    '',
    '(`lane_ready` / `musterd lane ready` remain as deprecated aliases for submit.)',
    '',
    '## Asking a human (the ask stream, ADR 147)',
    '',
    'Humans are peers you can reach, not a wall to route around. When you need one, **raise it as an act —',
    "do not stall silently and do not take a big action unasked.** `team_send {act:'ask'}` / `musterd send",
    '--act ask` carries directed-to-human traffic; every ask needs a **species** (what kind) and a **tier**',
    '(how hard it wedges). The tier owns the clock: **the `team_send` response hands you the contract** — the',
    'timeout and the policy on silence (CLI: the shipped spectrum is blocking 15m → hold, standard 5m /',
    'advisory 3m → proceed-with-risk) — so *you* decide when the wait is up, never a server timer.',
    '',
    '- **`species:approve` — before a costly / irreversible / out-of-scope action.** Pair with',
    '  **`tier:blocking`**: an unanswered blocking ask **HOLDS** — you wait, and if the timeout elapses you',
    "  do **not** proceed; record it with a `status_update` carrying `meta.ask_ref` + `meta.ask_outcome:'held'`.",
    '  This is the admin gate — never edit past it on your own. The contract may say **STRAND** instead: when',
    '  no unblocker is reachable (no admin human present or notifiable, no live teammate with a sanctioned',
    "  route), don't hold an empty room — record WIP on your lane's branch, `lane_release` / `musterd lane",
    '  release <id>` so it stops reading as yours, log',
    "  `meta.ask_outcome:'stranded'`, and close out. Stranding is still *not proceeding*.",
    '- **`species:escalate` — a true blocker or dispute only a human can settle.** Usually **`tier:standard`**.',
    '- **`species:consult` — "which direction / does this look right."** Wanted even in full-auto; usually',
    '  **`tier:advisory`**.',
    '- **Below the top tier, silence is not a stop.** An unanswered `advisory`/`standard` ask **proceeds with',
    '  a recorded risk**: pick your path and log a `status_update` with `meta.ask_ref`, `meta.ask_outcome:',
    "  'risk_accepted'`, `meta.risk`, and `meta.chosen_approach`. Proceeding-with-risk is auditable; a silent",
    '  stall is not.',
    '',
    'The human answering, deciding ("check back"), or approving rides back on the normal acts — read your',
    'inbox at task boundaries for the reply. Species and tier are independent: a genuinely small approval can',
    'be `standard`, but reserve `blocking` for things that truly must not proceed unattended.',
    '',
    '## Saving your memory (cross-session continuity, ADR 093)',
    '',
    'Your seat can carry one small continuity note across the session gap — what you were doing,',
    'decisions mid-flight, where you left off. **Save it before handing off or wrapping up** (and when',
    'told to wind down): `team_memory_save` / `musterd memory save --headline "<subject>" [body]` —',
    'headline first, like a commit subject; it is the one line the next occupy shows. Last-write-wins,',
    'private to the seat, never put secrets in it. On your next join the result carries the one-line',
    'pointer; load the note with `team_memory_read` / `musterd memory` when the headline looks relevant.',
    'Durable knowledge still belongs in docs and prior work in lanes/threads — the note is working',
    'state, not a second home for facts.',
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
    '## Shared blockers — report, park, converge (incident convergence)',
    '',
    "**A red on a check your diff can't touch is not yours to debug.** Attach a report to the",
    'status_update you already send — `meta.blocked_by: { gate, ref?, sig? }`, where `gate` is the',
    'exact check name (the cluster key), `ref` is what you parked behind it, and `sig` is the failure',
    'detail for the eventual owner — then park the work and move on. When a second seat reports the',
    'same gate, the daemon opens ONE unowned `kind:incident` lane seeded with every report; later',
    'reporters get an automatic "park behind it" pointer, and `team_next` leads with the banner. Any',
    'seat may claim the incident — context beats role. The report is cheaper than the debugging it',
    'replaces: the measured alternative was four seats independently diagnosing one defect.',
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
    '## Daemon refresh — the machine owns it, not you',
    '',
    'Where an auto-refresher LaunchAgent is installed it syncs the daemon checkout to `origin/main`,',
    'rebuilds, and bounces the daemon (and the wake actuator) on its own interval. **Your merge reaches',
    'the daemon without you.** Do not close a status update with "needs a `service refresh`" — that hands',
    'a human a chore the machine already owns, and it reads as though you never looked.',
    '',
    '- **To check whether the daemon has your commit:** read `~/.musterd/autorefresh/refresh.log` (the tick',
    '  logs every sync, build and bounce), and compare the `build` in `GET /health` against `origin/main`.',
    '  `musterd service status` names the same skew, and says who owns closing it.',
    '- **`service refresh` is still correct where nothing is watching** — a host with no auto-refresher, or',
    '  a tick you have just seen fail. It is an escape hatch, not the routine path.',
    '- **When a tick fails, the daemon is PINNED, not down.** The refresher refuses to bounce onto a broken',
    '  build — correct, but it then answers `/health` from the previous commit while the debounce parks the',
    '  tip, so nothing retries until a new commit lands. A failed tick now raises an OS notification and',
    '  `musterd service status` says so; the log line is "build failed — the daemon is still running the',
    '  previous code". If it was a dependency change, `pnpm install` in the daemon checkout is the repair',
    '  (the tick installs on its own when the lockfile moved, so this should be rare).',
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

/**
 * The **label-sessions** skill (ADR 160, surface 2) — a second, deliberately separate guidance unit.
 * It is NOT part of {@link renderSkillBody}: the canonical musterd skill is harness-neutral by
 * contract, and this one can only work where the hosting harness exposes session-list/rename tools
 * to the agent (Claude Code Desktop today, via `HarnessGuidance.sessionsSkillPath`). The decision
 * logic lives in `musterd session resolve-labels` — the skill's job is only: gather, pipe, apply.
 *
 * The harness tool names below (`list_sessions`, `set_session_title`) are the desktop app's own and
 * deliberately NOT in {@link SKILL_MCP_TOOLS} — that list is CI-checked against @musterd/mcp's
 * registered tools, which these are not.
 */
export function renderLabelSessionsSkill(): string {
  return [
    '# Label seat sessions in the sidebar',
    '',
    'Prefix other seat sessions’ sidebar titles with the musterd chip, their seat, and their',
    'start time — `\u{1F536} Miley (Fri 3p) - Daemon refresh` — so a human can tell which session',
    'belongs to which seat. Run this at session start in a seat worktree, or when asked to label',
    'or tidy session titles.',
    '',
    '**A session can never rename itself** — the rename tool refuses the current session. Sessions',
    'label *each other*: the one you are in stays bare until the next session’s sweep. That is',
    'expected — never report it as a problem.',
    '',
    '## The sweep',
    '',
    '1. List the user’s sessions with the harness session-list tool (in Claude Code Desktop:',
    '   `list_sessions` from the session-management server, limit 40).',
    '2. Write that JSON array to a temp file and pipe it through the decision engine:',
    '   `musterd session resolve-labels --stdin < sessions.json`.',
    '   It returns `{"apply": [{session_id, seat, title}], "skipped": {reason: count}}`. All',
    '   filtering and formatting live there — do not second-guess it or hand-craft titles.',
    '3. For each `apply` entry, call the harness rename tool (`set_session_title`) with exactly that',
    '   `session_id` and `title`. Independent calls — issue them in parallel.',
    '4. Report one line: `labeled 3 sessions (Miley ×2, Izzo ×1)`. If `apply` is empty and this ran',
    '   automatically, say nothing at all; if the user asked, say `nothing to label`.',
    '',
    'Step 2 also stamps the machine-wide last-sweep file, which is what silences the per-turn',
    '`label-nudge` hook line for every seat — so when that nudge sent you here, one sweep is the',
    'whole job; do not re-run it each turn.',
    '',
    '## What the engine guarantees (so you do not re-derive it)',
    '',
    '- Only sessions in musterd seat worktrees; other repos are never touched.',
    '- A title the user typed (`titleSource: "user"`) is never proposed — including seat-form',
    '  hand titles. Claude Code Desktop soft-refuses those renames with a success reply; proposing',
    '  them was the forever-nudge bug (ADR 186).',
    '- Idempotent: labeled rows skip; pre-chip *auto* labels get the chip without re-dating.',
    '- Brand-new sessions are skipped until their auto-title settles.',
    '- The nudge stays quiet once `apply` would be empty — it keys off evidence, not stamp age.',
    '',
  ].join('\n');
}

/**
 * The **self-label** skill (ADR 186) — Cursor (and any future harness with current-only rename).
 * Inverse of {@link renderLabelSessionsSkill}: Claude renames *peers* and cannot rename itself;
 * Cursor's `rename_chat` renames *only the current* chat and has no peer list. One shared grammar
 * (`renderSeatLabel`); two apply loops.
 */
export function renderSelfLabelSessionSkill(): string {
  return [
    '# Label this seat session (current chat only)',
    '',
    'Prefix **this** chat’s title with the musterd chip and seat so a human scanning the Cursor',
    'sidebar can tell which seat it is — `\u{1F536} Dolly (Fri 3p) - <subject>`. Cursor cannot list',
    'or rename *other* sessions (no peer sweep); Claude Code Desktop is the inverse. Terminal tabs',
    'are already labeled by the CLI OSC postamble whenever you shell out to `musterd`.',
    '',
    '## When to run',
    '',
    '- At session start in a musterd seat worktree, once, if the `rename_chat` tool is available',
    '  (Cursor built-in MCP `cursor-app-control`).',
    '- When the user asks to label or rename this chat.',
    '- Skip silently when `rename_chat` is not in your tool list — do not invent a SQLite write.',
    '',
    '## The self-label',
    '',
    '1. Resolve this folder’s seat (`musterd whoami` / binding claim name).',
    '2. Build the title with the shared grammar: chip + capitalized seat + compact start time +',
    '   short subject (current title stripped of any prior chip/seat prefix, or a 3–6 word summary',
    '   of the task). Prefer `musterd session resolve-labels` shape mentally: never re-date a title',
    '   that already carries `(Fri 3p)`; never invent a wrong seat.',
    '3. Call `rename_chat` with that exact title (current chat only — the tool has no session id).',
    '4. Report one line: `labeled this session as Dolly`. If the tool is missing, say nothing',
    '   when this ran automatically.',
    '',
    '## Hard rules',
    '',
    '- Never write Cursor’s `state.vscdb` / Codex SQLite from the CLI — the app owns those stores.',
    '- Do not try a Claude-style peer sweep here; there is no list API.',
    '- A human-owned title the user just typed wins — if they renamed this chat by hand this turn,',
    '  leave it.',
    '',
  ].join('\n');
}

/** Cursor-rule frontmatter for {@link renderSelfLabelSessionSkill}. */
export function renderSelfLabelSessionFrontmatter(): string {
  return [
    '---',
    'description: Label this Cursor chat with the musterd seat chip (e.g. "\u{1F536} Dolly (Fri 3p) - …"). ' +
      'Use at session start in a musterd seat worktree when rename_chat is available, and when the ' +
      'user asks to label or rename this chat.',
    'alwaysApply: false',
    '---',
  ].join('\n');
}

/** Frontmatter for {@link renderLabelSessionsSkill} on a harness that gates skills on a description. */
export function renderLabelSessionsFrontmatter(): string {
  return [
    '---',
    'name: musterd-label-sessions',
    'description: Label musterd seat sessions in the app sidebar with the musterd chip, seat name, ' +
      'and start time (e.g. "\u{1F536} Miley (Fri 3p) - Office overlay"). Use at the start of a session ' +
      'in a musterd seat worktree, and when the user asks to label, rename, or tidy session titles.',
    '---',
  ].join('\n');
}

/**
 * The **nudge-relay** skill (ADR 167, increment 2) — like {@link renderLabelSessionsSkill}, a separate
 * per-surface guidance unit, NOT part of the harness-neutral {@link renderSkillBody}: it only works
 * where the hosting harness lets sessions message each other through agent-side tools (Claude Code
 * Desktop today, via `HarnessGuidance.nudgeSkillPath`).
 *
 * The harness tool names below (`list_sessions`, `send_message`) are the desktop app's own and
 * deliberately NOT in {@link SKILL_MCP_TOOLS} — that list is CI-checked against @musterd/mcp's
 * registered tools, which these are not.
 */
export function renderNudgeRelaySkill(): string {
  return [
    '# Relay a musterd delivery nudge',
    '',
    'When `team_send` returns a `delivery_hint`, your recipient is live on this machine and the',
    'daemon is inviting YOU to ring their doorbell: relay the hinted line into their session over',
    'the harness’s session messaging, so they see the act in seconds instead of at their next tool',
    'call. Use this the moment a send result carries a hint; skip silently when it doesn’t, when',
    'this session lacks the session-messaging tools, or when you cannot find the recipient’s',
    'session — the inbox ladder underneath delivers regardless, just slower.',
    '',
    '## The relay',
    '',
    '1. List sessions with the harness session-list tool (in Claude Code Desktop: `list_sessions`',
    '   from the session-management server).',
    '2. Find the recipient’s session. Seat sessions are labeled with their seat name in the title',
    '   (`\u{1F536} Miley (Fri 3p) - …`); for a to-human ask, pick a session the human is actively',
    '   driving (their own work session — NOT another seat’s).',
    '3. Send `nudge_text` with the session-send tool (`send_message`), **VERBATIM — the exact string',
    '   from the hint**. Never edit it, never add the act body, never append your own words: the',
    '   daemon fingerprints the line, and only an exact relay is counted as delivered. The act’s',
    '   content travels through musterd with full attribution; the nudge is only a pointer.',
    '4. Say nothing about it in your own report beyond, at most, `nudged <seat>`.',
    '',
    '## Rules',
    '',
    '- One relay per hint. No hint, no relay — never nudge on your own initiative; unsanctioned',
    '  session messages are logged as side-channel use (ADR 167).',
    '- Cannot find the recipient’s session, or the send tool refuses? Drop it silently — never',
    '  retry, never route around, never report it as a failure.',
    '- Never reply to a nudge over session messaging: answer the ACT through musterd',
    '  (`team_inbox_check`, then the usual acts).',
    '',
  ].join('\n');
}

/** Frontmatter for {@link renderNudgeRelaySkill} on a harness that gates skills on a description. */
export function renderNudgeRelayFrontmatter(): string {
  return [
    '---',
    'name: musterd-nudge-relay',
    'description: Relay a musterd delivery nudge into a teammate’s live session when team_send ' +
      'returns a delivery_hint (recipient live on this machine). Use immediately after any ' +
      'team_send whose result carries a delivery_hint; sends the hinted one-liner verbatim over ' +
      'the harness session-messaging tools.',
    '---',
  ].join('\n');
}

/** Frontmatter shell for a harness that gates a skill/rule on a `description` (Claude Code skill, Cursor
 * `.mdc` rule). `canonical` is the harness-neutral `.musterd/skill/SKILL.md` — no frontmatter. */
export function renderSkillFrontmatter(harness: 'claude-code' | 'cursor' | 'canonical'): string {
  const description =
    'Using the musterd coordination layer: claiming or adopting a seat, claiming a lane before you build, ' +
    'handing off with a branch, raising a to-human ask (consult/escalate/approve with a tier contract), ' +
    'waiting on the inbox without polling, and recovering from claim/identity errors. Use when a musterd ' +
    'team interaction goes past the basic join/inbox/status loop.';
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
