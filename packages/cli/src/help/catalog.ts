/**
 * The structured command catalog — the single source of truth for `musterd`'s command surface.
 *
 * One catalog, three consumers: the grouped `musterd help` and per-command `musterd help <cmd>`
 * (render/help.ts), the machine-readable `musterd help --json` (agents/agentic workflows), and the
 * plain `HELP` string the guidance drift check imports (help/plain.ts → help.ts). Keeping every
 * command described in exactly one place is the ADR 085 doctrine: names are the only thing allowed to
 * be duplicated across the guidance layers, and `scripts/check-guidance.ts` verifies that mechanically.
 *
 * This module is intentionally **pure data with zero runtime imports** so it stays hermetic — the
 * guidance check imports it on Node's native TypeScript with no build step and no color dependency.
 */

export type GroupId = 'setup' | 'team' | 'messaging' | 'work' | 'insight' | 'inbox' | 'admin';

export interface CommandGroup {
  id: GroupId;
  /** Section title, shown as a heading in grouped help. */
  title: string;
  /** One dim line under the heading — the room's purpose. */
  blurb: string;
}

export interface CommandEntry {
  /** The canonical command word — the anchor guidance:check looks for as `musterd <name>`. */
  name: string;
  /** Everything after the name: args and flags. */
  signature: string;
  /** One scannable line, shown in the grouped view. */
  summary: string;
  group: GroupId;
  /** Shown in the condensed grouped view; non-primary commands fold into a `… +N more` pointer. */
  primary?: boolean;
  /** A fuller paragraph for `musterd help <name>`. */
  detail?: string;
  /** Copy-paste examples for `musterd help <name>`. */
  examples?: string[];
}

/** The rooms of the floor, in display order. */
export const GROUPS: readonly CommandGroup[] = [
  { id: 'setup', title: 'Setup & daemon', blurb: 'get wired up and run the coordination daemon' },
  {
    id: 'team',
    title: 'Team & seats',
    blurb: 'create teams, add members, give agents a workspace',
  },
  { id: 'messaging', title: 'Messaging', blurb: 'send acts, nudge a teammate, get notified' },
  {
    id: 'work',
    title: 'Work & lanes',
    blurb: 'own a unit of work, orient, hand off, close it out',
  },
  { id: 'insight', title: 'Insight', blurb: 'the roster, flow metrics, and the governance trail' },
  {
    id: 'inbox',
    title: 'Inbox & presence',
    blurb: 'read what is waiting; set who you are and when',
  },
  {
    id: 'admin',
    title: 'Seats & admin',
    blurb: 'claim a seat, approve requests, release and recover',
  },
];

/** The four commands a fresh session reaches for first — surfaced above the groups. */
export const START_HERE: readonly string[] = ['init', 'claim', 'status', 'next'];

/** Global flags every command accepts (rendered in the help footer and in `help <cmd>`). */
export const GLOBAL_FLAGS: readonly { flag: string; summary: string }[] = [
  { flag: '--team <slug>', summary: 'act on a specific team (else the folder / config default)' },
  { flag: '--server <url>', summary: 'point at a specific daemon' },
  { flag: '--json', summary: 'machine-readable output (no color, no chrome)' },
  { flag: '--no-color', summary: 'disable ANSI color' },
  { flag: '--quiet', summary: 'suppress the reachability nudge' },
];

/** The act vocabulary, for the help footer and `send` detail. */
export const ACTS: readonly string[] = [
  'message',
  'status_update',
  'request_help',
  'handoff',
  'accept',
  'decline',
  'wait',
  'resolve',
  'steer',
  'challenge',
  'defer',
];

export const CATALOG: readonly CommandEntry[] = [
  // ── Setup & daemon ─────────────────────────────────────────────────────────────────────────
  {
    name: 'init',
    signature: '[--check [--fix]]',
    summary: 'interactive first-run setup — wire this folder to musterd',
    group: 'setup',
    primary: true,
    detail:
      'Interactive first-run setup (recommended). Registers the MCP server, writes the primer, and ' +
      'gets this folder onto a team. `--check` reports provisioning drift without writing; add `--fix` ' +
      'to repair it by re-running init.',
    examples: ['musterd init', 'musterd init --check', 'musterd init --check --fix'],
  },
  {
    name: 'wire',
    signature: '[--autojoin] [--key mskey_…]',
    summary: 'headless self-wire from a committed .musterd/workspace.json',
    group: 'setup',
    detail:
      'Headless setup for a fresh clone: register the MCP server from this folder’s committed ' +
      '.musterd/workspace.json with no prompts and no seat claim (pass `--autojoin` to also claim).',
    examples: ['musterd wire', 'musterd wire --autojoin'],
  },
  {
    name: 'serve',
    signature:
      '[--port 4849] [--host 127.0.0.1] [--tls-cert <pem> --tls-key <pem> | --insecure-trust-proxy]',
    summary: 'run the coordination daemon in the foreground',
    group: 'setup',
    primary: true,
    detail:
      'Run the daemon in the foreground. For a background service that survives logout, use ' +
      '`musterd service install` instead.',
  },
  {
    name: 'service',
    signature:
      '<install|uninstall|start|stop|restart|refresh|status|logs> [--live] [--port <n>] [--host <h>] [--follow] [--force]',
    summary: 'run the daemon (or the /live viewer) as a background service (macOS LaunchAgent)',
    group: 'setup',
    primary: true,
    detail:
      'Manage the daemon as a LaunchAgent (ADR 045). `refresh` is the one-command "run latest main" ' +
      '(ADR 118): sync the daemon’s checkout to origin/main → `pnpm build` → restart, so merged work ' +
      'goes live without the manual pull+build+restart dance (refuses on uncommitted changes; a failed ' +
      'build aborts before the bounce). `restart`/`stop`/`refresh` refuse while teammates hold live ' +
      'sessions unless `--force`. Add `--live` to target the /live viewer instead of the daemon ' +
      '(ADR 132): `install --live` stands up a self-updating build-publisher (a dedicated ' +
      'detached-on-main worktree + an interval agent that rebuilds the web app and publishes it into ' +
      'the daemon’s web-root whenever main moves), so the daemon serves /live from its own origin — ' +
      'always the latest main, no dev server, no daemon restart; `refresh --live` forces a rebuild now.',
    examples: [
      'musterd service install',
      'musterd service refresh',
      'musterd service status',
      'musterd service install --live',
      'musterd service status --live',
    ],
  },
  {
    name: 'fmt',
    signature: '[--check]',
    summary: 'canonicalize this folder’s .musterd/ roster files',
    group: 'setup',
    detail:
      'Canonicalize the git-tracked .musterd/ roster files (ADR 058). `--check` verifies without writing.',
  },
  {
    name: 'reload',
    signature: '',
    summary: 'tell the running daemon to re-read the roster files',
    group: 'setup',
    detail:
      'Send the daemon a SIGHUP so it re-reads the .musterd/ roster files — run after `team export`.',
  },
  {
    name: 'reset',
    signature: '[--force] [--no-backup]',
    summary: 'wipe the local db + identities back to a clean slate',
    group: 'setup',
    detail:
      'Wipe the local database and identities back to a clean slate. The daemon must be stopped first.',
  },
  {
    name: 'uninstall',
    signature: '[--force]',
    summary: 'remove what musterd added to this folder’s harness',
    group: 'setup',
    detail: 'Remove the servers, permissions, and primer musterd wrote into this folder’s harness.',
  },

  // ── Team & seats ───────────────────────────────────────────────────────────────────────────
  {
    name: 'team',
    signature: '<create|add|remove|export> …',
    summary: 'create a team, add/remove members, export the roster to git',
    group: 'team',
    primary: true,
    detail:
      'Manage the standing roster:\n' +
      '  create <slug> [--as <you>] [--role <role>] [--display <name>]\n' +
      '  add <name> --kind <agent|human> [--role <role>] [--lifecycle forever|session|until --until <iso>]\n' +
      '  remove <name>                soft-remove a member (history is kept)\n' +
      '  export <slug>                move the roster onto git-tracked .musterd/ files (ADR 058)',
    examples: [
      'musterd team create acme --as nick',
      'musterd team add lin --kind human --role reviewer',
    ],
  },
  {
    name: 'agent',
    signature:
      '<name> [--role <role>] [--harness <claude-code|cursor|codex>] [--here | --path <dir>]',
    summary: 'add an agent AND give it its own isolated workspace (worktree)',
    group: 'team',
    primary: true,
    detail:
      'Add an agent and give it its own isolated git-worktree workspace, wired to run (ADR 065). One ' +
      'command instead of team add + worktree + wire + claim. `--harness` picks which harness to wire ' +
      '(default claude-code; also cursor, codex) — the same adapters `musterd init` uses. Do not run ' +
      '`--here` inside a live seat’s folder.',
    examples: ['musterd agent scout --role researcher', 'musterd agent ryder --harness cursor'],
  },
  {
    name: 'join',
    signature: '<slug> --as <name> [--token <tok>] [--surface cli]',
    summary: 'join a team as a named member from this surface',
    group: 'team',
    primary: true,
    examples: ['musterd join acme --as nick'],
  },
  {
    name: 'role',
    signature: 'list | show <name> | create <name> [--from <builtin>] [--force]',
    summary: 'manage role provisioning templates (.musterd/roles/)',
    group: 'team',
  },

  // ── Messaging ──────────────────────────────────────────────────────────────────────────────
  {
    name: 'send',
    signature:
      '--to <name|@team|@broadcast> --act <act> [--thread <id>] [--reply-to <id>] [--meta k=v] [--urgent --urgent-reason <why>] <body…>',
    summary: 'send a typed act to a teammate, the team, or everyone',
    group: 'messaging',
    primary: true,
    detail:
      'Send a typed message. Acts: message · status_update · request_help · handoff · accept · decline · ' +
      'wait · resolve, plus the steering acts (ADR 103): steer (change direction, always interrupts, ' +
      'supersedes prior), challenge (justify-or-reconsider), defer (--meta goal_id=<id> [--meta ' +
      'wave=<n|later>] to reorder/defer a Goal). accept/decline auto-target the latest open request ' +
      'unless you pass --reply-to.',
    examples: [
      "musterd send --to lin --act request_help 'stuck on the auth redirect'",
      "musterd send --to @team --act status_update 'shipping the lane board'",
      'musterd send --act accept',
    ],
  },
  {
    name: 'nudge',
    signature: '',
    summary: 'print directed acts waiting for this seat (read-only)',
    group: 'messaging',
    primary: true,
    detail:
      'Print the directed acts waiting for this seat. Read-only — the approval-prompt hook target.',
  },
  {
    name: 'notify',
    signature: '[--interval <seconds>] [--once]',
    summary: 'background OS notification when a directed act lands while away',
    group: 'messaging',
  },

  // ── Work & lanes ───────────────────────────────────────────────────────────────────────────
  {
    name: 'lane',
    signature:
      'open "<title>" [--surface <glob>,…] [--depends <id>,…] [--goal <id>] [--branch b] [--claim]  |  <claim|handoff|update|resolve> <id> [--to <seat>] [--branch <ref>] [--state <s>]',
    summary: 'declare a unit of work; own it, hand it off, close it',
    group: 'work',
    primary: true,
    detail:
      'A lane is a declared unit of work with warn-only contention checks (ADR 083).\n' +
      '  open "<title>" [--surface …] [--depends …] [--goal <id>] [--branch b] [--claim]   declare it\n' +
      '  claim <id>                    take ownership\n' +
      '  handoff <id> --to <seat> [--branch <ref>]   transfer it, with its branch\n' +
      '  update <id> [--state <s>] [--branch <ref>]  edit it\n' +
      '  resolve <id>                  close it\n' +
      '--goal links a lane to a Goal (ADR 084).',
    examples: [
      'musterd lane open "wire the help catalog" --claim',
      'musterd lane handoff L3 --to scout --branch feat/help',
    ],
  },
  {
    name: 'lanes',
    signature: '[--project p] [--mine] [--open] [--json]',
    summary: 'the lane board — who owns what, with live warnings',
    group: 'work',
    primary: true,
    examples: ['musterd lanes', 'musterd lanes --mine --open'],
  },
  {
    name: 'next',
    signature: '[--json]',
    summary: 'the orientation brief — what you carry, what to pick up next',
    group: 'work',
    primary: true,
    detail:
      'The orientation brief (ADR 049/084): what you’re carrying, what just shipped, open lanes you ' +
      'could pick up, the next Goal, and the latest handoff *why* — so a fresh session self-orients.',
  },
  {
    name: 'done',
    signature: '[<lane-id>] [--json]',
    summary: 'close your work — mark the lane done, then show what’s next',
    group: 'work',
    primary: true,
    detail:
      'Mark the lane done (the terminal that drives derived Goal status) and chain into orientation. ' +
      'Auto-targets your single live lane when no id is given.',
  },
  {
    name: 'goal',
    signature:
      'declare "<title>" --goal-id <id> [--wave <n|later>] [--depends <id>,…]  |  list [--json]',
    summary: 'declare a team Goal; lanes join it and status is derived',
    group: 'work',
    primary: true,
    detail:
      'Declare a team Goal (ADR 048/084); lanes join it via `--goal` and its status (planned / in-flight ' +
      '/ shipped) is derived. `goal list` shows the board.',
    examples: ['musterd goal declare "ship v0.3" --goal-id v03', 'musterd goal list'],
  },

  // ── Insight ────────────────────────────────────────────────────────────────────────────────
  {
    name: 'report',
    signature: '[--altitude ic|team|exec] [--json]  |  delivery [<id>]  |  coordination',
    summary: 'the insight report — flow metrics, waiting-on, the Goal board',
    group: 'insight',
    primary: true,
    detail:
      'One derived projection (ADR 050/084) at three altitudes (ic / team / exec).\n' +
      '  report delivery [<id>]   the delivery ledger — open directed acts and who has seen/answered them\n' +
      '  report coordination      coordination health — density, time-to-unblock, ignored help, stalls',
  },
  {
    name: 'archaeology',
    signature: '--start <sha> [--delivered <ref>] [--repo <path>] [--exclude <glob>,…] [--json]',
    summary: 'wasted-work % from git alone — the cookoff reference collector',
    group: 'insight',
    primary: false,
    detail:
      'Classifies every authored line after the kickoff commit per wasted-work predicate set v1 ' +
      '(ADR 123): W3 duplicated → W1 abandoned → W2 clobbered → W4 conflict churn. Needs only git — ' +
      'no daemon; actor identity comes from git attribution (ADR 109 seat identities / Co-authored-by ' +
      'trailers). Runs on any repo.',
    examples: ['musterd archaeology --start a1b2c3d --delivered main --json'],
  },
  {
    name: 'status',
    signature: '',
    summary: 'the roster — who’s on the team, present, and working',
    group: 'insight',
    primary: true,
    detail:
      'The team roster: members, presence, and what each is working on — plus, up top, anything waiting ' +
      'for you and which daemon/db is being read (so a wrong-db “everyone offline” is obvious).',
  },
  {
    name: 'audit',
    signature: '[--limit <n>] [--before <ms-epoch>] [--authorized-by <seat>] [--json]',
    summary: 'read the governance audit log (admin-only)',
    group: 'insight',
  },

  // ── Inbox & presence ───────────────────────────────────────────────────────────────────────
  {
    name: 'inbox',
    signature:
      '[--watch] [--all] [--unread] [--peek] [--limit <n>] [--from <name>] [--act <act>]  |  --wait [--timeout <s>]  |  --interrupt-check',
    summary: 'read what’s waiting for you; watch or block for the next act',
    group: 'inbox',
    primary: true,
    detail:
      'Your durable mailbox. By default it shows a bounded RECENT window (newest last), grouped under ' +
      'day headers (Today / Yesterday / Monday · Jul 7), and always includes every unread — reading ' +
      'advances the cursor only past what it showed. `--limit <n>` resizes the window; `--limit 0` ' +
      'shows the full history; `--peek` reads without marking anything read; `--unread` shows only new. ' +
      '`--watch` streams live; `--wait` blocks until the next directed act then exits (pairs with /loop); ' +
      '`--interrupt-check` is silent unless an urgent act waits (the ADR 088 PostToolUse interrupt hook).',
    examples: [
      'musterd inbox',
      'musterd inbox --unread',
      'musterd inbox --limit 40',
      'musterd inbox --wait --timeout 300',
    ],
  },
  {
    name: 'whoami',
    signature: '',
    summary: 'the seat this folder resolves to (member, team, surface, source)',
    group: 'inbox',
    primary: true,
    detail:
      'Show the seat this folder resolves to right now and where it came from (env > binding > --as > ' +
      'config). An unbound folder is a valid answer — it tells you how to claim a seat.',
  },
  {
    name: 'memory',
    signature: '[show] | save --headline "<subject>" [body…] | clear',
    summary: 'this seat’s private continuity note (save before you hand off)',
    group: 'inbox',
    primary: true,
    detail:
      'This seat’s private continuity note (ADR 093): save before handing off or wrapping up; claim/status ' +
      'show the one-line pointer. No cross-seat read.',
  },
  {
    name: 'availability',
    signature: '<available|away|dnd> [--until <iso>]',
    summary: 'set your availability (away holds notifications; dnd passes urgent)',
    group: 'inbox',
    primary: true,
  },

  // ── Seats & admin ──────────────────────────────────────────────────────────────────────────
  {
    name: 'claim',
    signature: '[<name>] [--token <code>] | --role <role> [--for <code>] [--surface <s>] [--force]',
    summary: 'get onto the team from this folder — occupy or adopt a seat',
    group: 'admin',
    primary: true,
    detail:
      'Get onto the team from this folder: bare `claim` occupies your bound seat (or confirms it if ' +
      'already live here); a name/role claims that seat; `--token` adopts a teammate’s seat; `--force` ' +
      'repoints a folder bound to a live member. A held seat opens a request and blocks until an admin ' +
      'approves, then occupies (ADR 087).',
    examples: ['musterd claim', 'musterd claim scout', 'musterd claim --role reviewer'],
  },
  {
    name: 'requests',
    signature:
      '[--pending] [--json]  |  decide <id> --approve [--once | --standing | --ttl-hours <n>] | --deny',
    summary: 'list and decide claim/teammate requests (admin-only)',
    group: 'admin',
    primary: true,
    detail:
      'List claim/teammate requests and decide them (admin-only, ADR 077). Approve grant lifetimes: ' +
      'ttl (default resume token / 24h), once (single-use), standing (until revoked).',
    examples: ['musterd requests --pending', 'musterd requests decide r7 --approve --standing'],
  },
  {
    name: 'residency',
    signature: 'on [--harness <class>] [--host <name>] | off | status  [--seat <name>] [--json]',
    summary: 'enroll this seat for wake-on-message while offline (ADR 131)',
    group: 'admin',
    detail:
      'Harness residency (ADR 131): an enrolled seat that goes offline stays reachable — the daemon ' +
      'derives wake-due directed acts and `musterd host` resurrects the harness session. ' +
      '`on` (admin-authorized) enrolls a seat, lands a standing resume grant in .musterd/binding.json, ' +
      'and registers the workspace in the machine-local host registry; `off` is the kill switch ' +
      '(reverses all three); `status` cross-checks the stores and names drift. Two different flags: ' +
      '--seat = WHAT gets enrolled (an agent seat; defaults to this workspace’s binding), --as = WHO ' +
      'authorizes (an admin). The roster shows enrolled offline seats as `offline · wakeable`.',
    examples: [
      'musterd residency on --as nick',
      'musterd residency on --seat scout --as nick',
      'musterd residency status',
      'musterd residency off',
    ],
  },
  {
    name: 'session',
    signature: 'show [--json]  |  start --stdin | end --stdin',
    summary: 'this workspace’s captured harness session — what a wake would resume (ADR 131)',
    group: 'admin',
    detail:
      'Session capture (ADR 131 inc 4): the SessionStart/SessionEnd hooks (`musterd init` wires ' +
      'them) pipe the harness hook JSON into `start`/`end`, which record the session in the ' +
      'gitignored .musterd/binding.json — the id and transcript path never leave this machine; the ' +
      'daemon gets a harness-class-only attestation (presence-neutral, never claims). A wake then ' +
      'upgrades from fresh to `--resume`, and a live local session defers the wake entirely. ' +
      '`show` is the human view: what is captured here, is it live, would a wake resume or defer.',
    examples: ['musterd session show', 'musterd session show --json'],
  },
  {
    name: 'host',
    signature: '[--once] [--interval <s>] [--timeout <s>] [--host <label>]',
    summary: 'the wake actuator — resurrect enrolled offline seats on this machine (ADR 131)',
    group: 'admin',
    detail:
      'The per-machine wake actuator (ADR 131 inc 3): polls the daemon for wake leases ' +
      '(agent-key, presence-neutral), spawns the harness fresh in the seat’s registered workspace ' +
      'with the daemon-composed one-line prompt (never message bodies), verifies occupancy from ' +
      'the roster (never stdout), kills on the mandatory watchdog (--timeout, default 300s), and ' +
      'reports the outcome. Reply-only by default: the spawned run gets musterd MCP tools under ' +
      'the workspace’s own permission mode — never a skip-permissions flag. Seats register via ' +
      '`musterd residency on` in their workspace; `--once` polls a single time (for cron/testing).',
    examples: ['musterd host', 'musterd host --once', 'musterd host --interval 5 --timeout 120'],
  },
  {
    name: 'unbind',
    signature: '',
    summary: 'release this folder’s seat — keeps it on the team, free to re-claim',
    group: 'admin',
  },
  {
    name: 'reclaim',
    signature: '<member>',
    summary: 'drop a member’s stuck/stale live session so it can rejoin',
    group: 'admin',
  },
];
