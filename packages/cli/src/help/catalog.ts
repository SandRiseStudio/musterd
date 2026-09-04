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

export type GroupId =
  | 'waiting'
  | 'messaging'
  | 'work'
  | 'remembering'
  | 'team'
  | 'insight'
  | 'setup'
  | 'ops';

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
  /**
   * This command's first positional is FREE TEXT, not a subcommand — so `musterd <name> help` is an
   * argument the user meant, never a help request. Set it and `wantsCommandHelp` stands down.
   *
   * `send` is the case that forced this: its positional is the message body, and on a
   * `request_help` act a one-word body of exactly "help" is the most plausible message anyone
   * would ever type. Reserving the word globally would have swallowed the very word that verb
   * exists to carry.
   */
  freeTextPositional?: boolean;
}

/**
 * The rooms of the floor, in display order — one room per QUESTION a reader brings, not per
 * implementation. Regrouped 2026-09-03 (surface survey, docs/wiki/command-and-tool-surface-map.md):
 * "what is waiting for me" used to be answered from three rooms, and `whoami`/`memory`/`insight` sat
 * under "Inbox" though none of them reads an inbox.
 */
export const GROUPS: readonly CommandGroup[] = [
  {
    id: 'waiting',
    title: 'Waiting & orientation',
    blurb: 'what is waiting for you, what to pick up next, who you are here',
  },
  {
    id: 'messaging',
    title: 'Talking',
    blurb: 'send a typed act to a teammate, a few, or everyone',
  },
  {
    id: 'work',
    title: 'Work & lanes',
    blurb: 'explore shared Seeds; own, hand off, and close Lanes; the board',
  },
  {
    id: 'remembering',
    title: 'Remembering',
    blurb: "this seat's private continuity note; findings for the whole team",
  },
  {
    id: 'team',
    title: 'Team & seats',
    blurb: 'who is on the team; create, claim, join, release, and recover seats',
  },
  {
    id: 'insight',
    title: 'Insight & audit',
    blurb: 'flow metrics, the wasted-work collector, and the governance trail',
  },
  { id: 'setup', title: 'Setup & daemon', blurb: 'get wired up and run the coordination daemon' },
  {
    id: 'ops',
    title: 'Residency & sessions',
    blurb: 'wake enrolled seats while offline; the captured harness session',
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
    signature:
      '[--check [--fix]] [--refresh-guidance] [--refresh-hooks] [--refresh-permissions] [--prune-bindings [--apply]]',
    summary: 'interactive first-run setup — wire this folder to musterd',
    group: 'setup',
    primary: true,
    detail:
      'Interactive first-run setup (recommended). Registers the MCP server, writes the primer, and ' +
      'gets this folder onto a team. `--check` reports provisioning drift without writing; add `--fix` ' +
      'to repair it by re-running init. `--refresh-guidance` rewrites only the stamped skill/command ' +
      'files — no prompts, no member mint, no binding rewrite — so it is safe in a live seat’s ' +
      'workspace, which the full flow is not (ADR 161). `--refresh-hooks` is its sibling for hooks ' +
      '(ADR 168): it rewrites only the hook entries, so a hook added after this seat was provisioned ' +
      'reaches it without re-provisioning, and it declines to overwrite a hook a newer musterd wrote. ' +
      '`--refresh-permissions` is the third sibling (ADR 261): it writes the standard permission ' +
      'floor into this folder’s harness settings, merging under whatever is already there. A seat ' +
      'with no permissions block fails closed on its first Write in a non-interactive session and ' +
      'presents as a broken tool, so this is the repair for any seat provisioned before that floor ' +
      'existed. In an already-bound folder the full flow ' +
      'defaults to that folder’s own team, never the last team this machine happened to use. ' +
      '`--prune-bindings` reports registry entries whose folder is gone (ADR 162) — add `--apply` to ' +
      'remove them; credentials are never touched.',
    examples: [
      'musterd init',
      'musterd init --check',
      'musterd init --check --fix',
      'musterd init --refresh-guidance',
      'musterd init --refresh-hooks',
      'musterd init --refresh-permissions',
      'musterd init --prune-bindings --apply',
    ],
  },
  {
    name: 'wire',
    signature: '[--autojoin] [--key mskey_…] [--migrate-bootstrap]',
    summary: 'headless self-wire from a committed .musterd/workspace.json',
    group: 'setup',
    detail:
      'Headless setup for a fresh clone: reconcile this workspace’s SAVED harness selection from the ' +
      'committed .musterd/workspace.json + provisioned.json with no prompts and no seat claim (pass ' +
      '`--autojoin` to also claim). Never edits the selection and never converts pre-ADR-281 state — ' +
      'a folder without a valid selection exits 6 and names `musterd harness configure` as the fix. ' +
      '`--migrate-bootstrap` replaces this Workspace’s legacy Team key with a seat-scoped credential; ' +
      'it requires the existing seat credential, preserves active Presence, and is safe to retry after ' +
      'a local write failure.',
    examples: ['musterd wire', 'musterd wire --autojoin', 'musterd wire --migrate-bootstrap'],
  },
  {
    name: 'harness',
    signature: 'configure [--select <ids> [--yes]] | status [--json]',
    summary: 'choose which harnesses launch this workspace — and inspect the wiring',
    group: 'setup',
    detail:
      'The multi-harness front door (ADR 281/282/286). `configure` is the ONE editor of this ' +
      'workspace’s desired harness set (Claude Code, Cursor, Codex, the native musterd host — any ' +
      'subset, chosen once per workspace and machine) and the ONE converter of pre-ADR-281 local ' +
      'state; after you confirm the complete set it saves strict v2 identity/manifest state and ' +
      'reconciles the managed fragments crash-safely. `status` is read-only: per harness it reports ' +
      'desired, availability, each managed fragment’s observed state and ownership, pending ' +
      'journal/lock state, and the repair to run; exit 0 only when every desired fragment is usable ' +
      'and every deselected contribution is released (a selected-but-uninstalled harness is ' +
      '`pending`, which is healthy). `configure --select <ids> --yes` is the headless form: naming the ' +
      'complete set on the command line is the confirmation, so scripts and service agents can ' +
      'convert a pre-ADR-281 workspace non-interactively.',
    examples: [
      'musterd harness configure',
      'musterd harness configure --select claude-code,musterd --yes',
      'musterd harness status',
      'musterd harness status --json',
    ],
  },
  {
    name: 'surface',
    signature: 'list | decline <name> | accept <name>',
    summary:
      'record a refusal — remove a provisioned surface and remember that you meant to (ADR 332)',
    group: 'setup',
    detail:
      'Provisioning used to know only installed and absent, and absence carries no intent. `list` shows what can be refused here and what has been; `decline <name>` removes the surface (a hook, a statusline chip) and records the refusal so `init --check` reports drift about it as a choice, not a gap; `accept <name>` clears the refusal (re-install with `init --refresh-hooks`).',
    examples: [
      'musterd surface list',
      'musterd surface decline statusline',
      'musterd surface accept statusline',
    ],
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
    name: 'broadcast',
    signature:
      '--team <slug> (--out <file.mp4> | --twitch | --rtmp <url>) [--server <url>] [--fps 30] [--bitrate 4500k] [--duration <s>] [--encoder videotoolbox|libx264] [--audio] | --status | --stop',
    summary: 'stream the animated office — headless capture of /broadcast, no OBS',
    group: 'setup',
    primary: false,
    detail:
      'ADR 157 Increment 2: capture the /broadcast render mode (always-animating office, fixed ' +
      '1920×1080) with headless Chrome and encode it with ffmpeg — to a local file (`--out`, the ' +
      'no-key proof mode), to Twitch (`--twitch`), or to any RTMP(S) ingest (`--rtmp`). The Twitch ' +
      'stream key is a secret: set MUSTERD_STREAM_KEY or a macOS Keychain item (service ' +
      '`musterd-stream-key`) — never a flag, never musterd config. Needs Chrome and ffmpeg on the ' +
      'machine. Foreground process, Ctrl-C to stop — or `--stop` from anywhere, which is what you ' +
      'want once a build restart has replaced it with a detached process. `--status` says whether ' +
      'anything is streaming and on which build. Waits for the page’s readiness probe before ' +
      'encoding, so a dead daemon fails fast instead of streaming a blank page. Restarts itself on ' +
      'the new code when the daemon is rebuilt under it (ADR 159), and ends the stream rather than ' +
      'buffering without limit if the encoder stops keeping up. `--audio` captures the page’s own ' +
      'sound from a PulseAudio sink instead of muxing silence — hosted Linux only; the sink must ' +
      'already exist, which the hosted entrypoint guarantees (ADR 228). This runs the capture on ' +
      'THIS machine — to run it on a rented one instead, see `musterd stream`.',
  },
  {
    name: 'stream',
    signature:
      '<doctor|build|start|stop|status> [--app <name>] [--team <slug>] [--args <flags>] [--json]',
    summary: 'run the broadcast on a rented machine — hosted capture, one verb',
    group: 'setup',
    primary: false,
    detail:
      'The hosted half of `musterd broadcast`: the same capture runs on a Fly Machine whose lifetime ' +
      'is the stream’s lifetime (`--rm` destroys it when the stream ends, so billing tracks streamed ' +
      'hours), reaching this machine’s loopback-bound daemon over a Tailscale overlay. `doctor` is ' +
      'the one to run first — it checks every precondition (tailscale up, `serve` forwarding the ' +
      'daemon’s port, the daemon accepting the tailnet `Host` on the ADR 040 upgrade gate, flyctl ' +
      'authed, app, both secrets, image built) and prints the exact repair for each, because all of ' +
      'them otherwise fail as the same unhelpful "the broadcast page never reported ready". `build` ' +
      'pushes the capture image on Fly’s remote builders and records the pushed DIGEST — `start` runs ' +
      'that digest, never the tag, because a rebuilt tag can resolve to the previous image. `start` ' +
      'discovers the tailnet address itself. Secrets stay the operator’s: musterd checks that ' +
      'TS_AUTHKEY and MUSTERD_STREAM_KEY are set and never reads, prints, or accepts their values.',
    examples: ['musterd stream doctor', 'musterd stream build', 'musterd stream start'],
  },
  {
    name: 'service',
    signature:
      '<install|uninstall|start|stop|restart|refresh|status|logs> [--live | --wake] [--port <n>] [--host <h>] [--otlp-endpoint <url>] [--interval <s>] [--timeout <s>] [--follow] [--force]',
    summary: 'run the daemon (or the /live viewer, or the wake actuator) as a background service',
    group: 'setup',
    primary: true,
    detail:
      'Manage the daemon as a LaunchAgent (ADR 045). `refresh` is the one-command "run latest main" ' +
      '(ADR 118): sync the daemon’s checkout to origin/main → `pnpm build` → restart, so merged work ' +
      'goes live without the manual pull+build+restart dance (refuses on uncommitted changes; a failed ' +
      'build aborts before the bounce). `restart`/`stop`/`refresh` refuse while teammates hold live ' +
      'sessions unless `--force`. Add `--live` to target the /live viewer instead of the daemon ' +
      '(ADR 132): `install --live` stands up a self-updating build-publisher (a dedicated ' +
      'detached-on-main workspace + an interval agent that rebuilds the web app and publishes it into ' +
      'the daemon’s web-root whenever main moves), so the daemon serves /live from its own origin — ' +
      'always the latest main, no dev server, no daemon restart; `refresh --live` forces a rebuild now. ' +
      'Add `--wake` to target the wake actuator (ADR 131 inc 5): `install --wake` runs `musterd host` ' +
      'as a LaunchAgent (RunAtLoad + KeepAlive) so enrolled seats stay wakeable across reboots — no ' +
      'terminal left open; `--interval`/`--timeout` (bare seconds) bake the loop’s cadence/watchdog ' +
      'into the plist. NOT `--host`: that flag is the daemon’s bind host. Bouncing `--wake`/`--live` ' +
      'drops no teammate session, so neither takes the live-session guard. ' +
      '`install --otlp-endpoint <url>` persists the standard OTLP endpoint in the daemon plist; ' +
      'it is daemon-install-only, preserved on reinstall, and an empty value clears it.',
    examples: [
      'musterd service install',
      'musterd service install --otlp-endpoint http://127.0.0.1:4318',
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
    signature: '<create|add|credential|agent-key|bootstrap|remove|archive|export> …',
    summary:
      'create a team, add/remove members, manage scoped bootstrap credentials, archive a team, export the roster to git',
    group: 'team',
    primary: true,
    detail:
      'Manage the standing roster:\n' +
      '  create <slug> [--as <you>] [--role <role>] [--display <name>] [--switch]\n' +
      '                               binds the creating folder; --switch also points every UNBOUND\n' +
      '                               folder on this machine at the new team (skip it for a probe)\n' +
      '  add <name> --kind <agent|human> [--role <role>] [--lifecycle forever|session|until --until <iso>]\n' +
      '  credential <name>            re-issue a human’s lost mscr_ credential, shown once (localhost, or admin off-host)\n' +
      '  agent-key [--key <mskey_…>] [--rotate --yes] [--show]\n' +
      '                               the team agent key `musterd agent` provisions with. With no flags it\n' +
      '                               RECOVERS it — reads it back off the seat bindings already on this\n' +
      '                               machine and re-records it, changing nothing on the team. --rotate mints\n' +
      '                               a new one and invalidates every seat’s (it counts them and needs --yes)\n' +
      '  bootstrap mint (--seat <name>|--role <name>|--host <label>) [--label <text>] [--expires-in <duration>]\n' +
      '                               mint one independently revocable bootstrap credential, shown once\n' +
      '  bootstrap list              show the redacted credential inventory (admin)\n' +
      '  bootstrap revoke <id>       revoke one scoped bootstrap credential (admin)\n' +
      '  bootstrap cutover [--force] [--yes]\n' +
      '                               disable the legacy Team key after every held seat and enrolled host\n' +
      '                               proves scoped use; --force bypasses readiness, --yes confirmation\n' +
      '  remove <name>                soft-remove a member (history is kept)\n' +
      '  archive <slug> [--as <admin>]  soft-archive a whole team — off status/rosters, history kept (admin)\n' +
      '  export <slug> [--to <dir>]   move the roster onto git-tracked .musterd/ files (ADR 058);\n' +
      '                               defaults into the team home when the team has one (ADR 176)',
    examples: [
      'musterd team create acme --as nick',
      'musterd team add lin --kind human --role reviewer',
      'musterd team bootstrap mint --seat ada --expires-in 24h',
      'musterd team bootstrap cutover',
      'musterd team agent-key            # `musterd agent` says no team agent key? start here',
    ],
  },
  {
    name: 'agent',
    signature:
      // The live flag is still `--profile` (rename is ADR 296 tier 3) — the signature must match it. <!-- vocab:ok -->
      '<name> [--role <label>] [--profile <profile>] [--harness <claude-code|cursor|codex|opencode|grok>] [--here | --path <dir>]', // <!-- vocab:ok -->
    summary: 'add an agent AND give it its own isolated workspace',
    group: 'team',
    primary: true,
    detail:
      'Add an agent and give it its own isolated workspace on its own branch, wired to run (ADR 065). ' +
      'One command instead of team add + workspace + wire + claim. `--harness` picks which harness to wire ' +
      '(default claude-code; also cursor, codex) — the same adapters `musterd init` uses. Do not run ' +
      '`--here` inside a live seat’s folder.',
    examples: ['musterd agent scout --role researcher', 'musterd agent ryder --harness cursor'],
  },
  {
    name: 'human',
    signature: '<name> [--team <slug>] [--home <dir>] [--role <role>] [--rotate]',
    summary: 'add a person AND give them the team home to stand in',
    group: 'team',
    primary: true,
    detail:
      'The mirror of `musterd agent`: agents stand in workspaces, the human stands in the **team ' +
      'home** — `~/musterd/<team>` by default, holding their 0600 binding, so `musterd board`, ' +
      '`musterd inbox --watch` and `musterd send` are simply them with no `--as` and nothing pasted. ' +
      'Mints the credential for a new person, reuses one this machine already holds, and offers a ' +
      're-issue (`--rotate`) when it holds none. Also sets the current team, and says so. Idempotent.',
    examples: ['musterd human nick --team acme', 'musterd human lin --home ~/work/acme'],
  },
  {
    name: 'role',
    signature:
      // `--from <template>` is the command's own usage string (role.ts) — the signature must match it. <!-- vocab:ok -->
      'list | show <name> | assign <seat> <role> [--remove] [--force] | create <name> [--from <template>] [--force]', // <!-- vocab:ok -->
    summary: "the team's role library — responsibility the team grants (ADR 227)",
    group: 'team',
    detail:
      'A role is a responsibility the team grants: charter plus ceiling, team-side and reviewed. ' +
      'list/show read the durable library (roles/<name>.toml) off the daemon roster; create ' +
      'authors one in the roster home; assign edits seats/<seat>.toml there. What a workspace is ' +
      'equipped with is a toolkit and lives in `musterd toolkit` — a role may name a default ' +
      'toolkit, but a toolkit can never assert a role (ADR 296).',
    examples: ['musterd role list', 'musterd role assign wanderer platform'],
  },
  {
    name: 'toolkit',
    signature: 'list | show <name> | create <name> [--from <built-in>] [--force]',
    summary: 'what a workspace is equipped with — MCP servers, tools, allow-entries (ADR 296)',
    group: 'team',
    detail:
      'A toolkit carries no authority: it is the "installed" layer of the three (installed by a ' +
      'toolkit, allowed by harness permissions, authorized by the team as a capability — they ' +
      // `.musterd/profiles/` is the literal legacy path on disk, not the concept. <!-- vocab:ok -->
      'compose as AND). create scaffolds one into .musterd/toolkits/; the older .musterd/profiles/ ' + // <!-- vocab:ok -->
      'and .musterd/roles/ homes are still read, never written; ' +
      '`musterd init` provisions it, and a user file overrides a built-in of the same name. ' +
      'Nothing here reads the roster.',
    examples: ['musterd toolkit list', 'musterd toolkit create writer --from docs'],
  },

  // ── Messaging ──────────────────────────────────────────────────────────────────────────────
  {
    name: 'send',
    freeTextPositional: true,
    signature:
      '--to <name|a,b|@team|@broadcast> --act <act> [--thread <id>] [--reply-to <id>] [--meta k=v] [--urgent --urgent-reason <why>] [--blocked-by <gate> [--ref <what>] [--sig <detail>]] <body…>',
    summary: 'send a typed act to a teammate, a few teammates, the team, or everyone',
    group: 'messaging',
    primary: true,
    detail:
      'Send a typed message. Acts: message · status_update · request_help · handoff · accept · decline · ' +
      'wait · resolve, plus the steering acts (ADR 103): steer (change direction, always interrupts, ' +
      'supersedes prior), challenge (justify-or-reconsider), defer (--meta goal_id=<id> to shelve a ' +
      'Goal). accept/decline auto-target the latest open request ' +
      'unless you pass --reply-to. Name 2-4 seats (--to a,b) when EITHER could answer: each owes a ' +
      'reply, the first accept/decline stands the rest down, and the team still sees it (message/request_help/challenge only). ' +
      "--blocked-by files a SHARED-BLOCKER report: a red on a check your diff can't touch is not yours to " +
      'debug — name the gate, park the work, move on. It rides status_update (so --act is implied), and ' +
      'when a second seat reports the same gate the daemon opens one owned incident lane instead of ' +
      'letting you each debug it alone.',
    examples: [
      "musterd send --to lin --act request_help 'stuck on the auth redirect'",
      "musterd send --to @team --act status_update 'shipping the lane board'",
      "musterd send --to stanley,izzo --act message 'either of you know why the daemon pinned?'",
      'musterd send --act accept',
      'musterd send --blocked-by "ci:gates/A11y contrast" --ref pr#840',
    ],
  },
  {
    name: 'reap',
    signature: '[--yes]',
    summary: 'reclaim orphaned MCP sidecar processes (list first; --yes applies)',
    group: 'setup',
    detail:
      "Read the daemon's latest footprint tick (ADR 242) and list MCP sidecar processes whose " +
      'sessions ended. With --yes, ask the daemon to reap them — every pid is re-verified against ' +
      'the live process table at kill time (allowlist match + still orphaned), refused otherwise, ' +
      'and the kill is audited as footprint.reaped.',
    examples: ['musterd reap', 'musterd reap --yes'],
  },
  {
    name: 'notify',
    signature: '[--interval <seconds>] [--once]',
    summary: 'background OS notification when a directed act lands while away',
    group: 'waiting',
  },

  // ── Work & lanes ───────────────────────────────────────────────────────────────────────────
  {
    name: 'seed',
    signature:
      'list [--history] [--json]  |  show <id>  |  claim <id>  |  ask|answer <id> "<text>"  |  brief|conclude <id> --file <path>  |  promote <id>  |  capture --ref <path#anchor> "<text>"',
    summary: 'explore a shared idea before it becomes a Lane',
    group: 'work',
    primary: true,
    detail:
      'A Seed is a Team idea captured before it becomes a Lane (ADR 291/319).\n' +
      '  list [--history]              show the active tray or its full history\n' +
      '  show <id>                     read the source and public exploration thread\n' +
      '  claim <id>                    become its explorer\n' +
      '  ask|answer <id> "<text>"      run one attributed clarification edge\n' +
      '  brief <id> --file <path>      submit an exhaustive brief and open its Lane\n' +
      '  conclude <id> --file <path> "<conclusion>"   finish without a Lane\n' +
      '  promote <id>                  deliberately skip research and open a Lane\n' +
      '  capture --ref <path#anchor> [--lane <id>] "<text>"   a document-recorded intention (ADR 373); --batch <file|-> for `pnpm intents:ingest`',
    examples: ['musterd seed list', 'musterd seed claim 01SEED…'],
  },
  {
    name: 'huddle',
    signature:
      'open --topic <goal|lane|design>:<id> --anchor <path|pr|lane> [--to a,b|@team] [--turns N] [--until <ms|ISO>] "<why>"  |  say <id> [--act <act>] [--to <seat>] "<turn>"  |  close <id> --anchor-ref <ref|none> "<what landed>"',
    summary:
      'a bounded burst of collaboration on one topic, leaving one artifact — a thread with a room',
    group: 'messaging',
    detail:
      'A huddle is a thread (ADR 378). `open` sends the root act with meta.huddle — the topic it is bound to, ' +
      'the whiteboard room (laid out as anchor + turns when the service is up; never spawned), where the ' +
      'output will land, and a declared budget readers display by counting the thread. `say` is a turn: an ' +
      'ordinary act in the thread (message, challenge, steer, insight, wait). `close` is the resolve, naming ' +
      'in --anchor-ref where the artifact landed, or "none" with the reason. A question to a human inside a ' +
      'huddle is `musterd send --act ask --thread <id>` with a tier, not a turn. The daemon stores no clock ' +
      'and enforces no budget; the participants own both.',
    examples: [
      'musterd huddle open --topic lane:01M1N7Q2K5 --anchor docs/design/asks-rail.md --to miley,sloane --turns 12 "the asks rail arc — ring or bar?"',
      'musterd huddle say 01M1… --act challenge "why a ring at all when the strip already has the tier?"',
      'musterd huddle close 01M1… --anchor-ref docs/design/asks-rail.md@9ab435f0 "ring, drawn from the stored hue"',
    ],
  },
  {
    name: 'lane',
    signature:
      'open "<title>" [--surface <glob>,…] [--depends <id>,…] [--goal <id>] [--branch b] [--claim]  |  <claim|release|handoff|update|resolve> <id> [--to <seat>] [--branch <ref>] [--state <s>]',
    summary: 'declare a unit of work; own it, hand it off, close it',
    group: 'work',
    primary: true,
    detail:
      'A lane is a declared unit of work with warn-only contention checks (ADR 083).\n' +
      '  open "<title>" [--surface …] [--depends …] [--goal <id>] [--branch b] [--claim]   declare it\n' +
      '  claim <id>                    take ownership\n' +
      '  release <id>                  let it go — open for anyone again\n' +
      '  handoff <id> --to <seat> [--branch <ref>]   transfer it, with its branch\n' +
      '  update <id> [--state <s>] [--branch <ref>] [--goal <id>]  edit it\n' +
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
    name: 'node',
    signature: '<invite|join|rotate|revoke|list>',
    summary: 'machine credentials — admit a second machine to this team',
    group: 'team',
    detail:
      'The machine credential (ADR 328). An admin runs `node invite` on the hub to mint a single-use, ' +
      '15-minute `msinv_` code; the joining machine runs `node join <hub-url> <code>`, which asks ITS ' +
      'OWN daemon to enroll — the daemon presents the node id it already holds and writes the durable ' +
      '`msnode_` to ~/.musterd/node.json at 0600. `rotate` re-keys a machine without changing its ' +
      'identity, so every event it has already stamped still names it. `revoke` cuts it off ' +
      'immediately and leaves its history alone.',
  },
  {
    name: 'next',
    signature: '[--json]',
    summary: 'the orientation brief — what you carry, what to pick up next',
    group: 'waiting',
    primary: true,
    detail:
      'The orientation brief (ADR 049/084): what you’re carrying, what just shipped, open lanes you ' +
      'could pick up, the next Goal, and the latest handoff *why* — so a fresh session self-orients.',
  },
  {
    name: 'done',
    signature: '[<lane-id>] [--pr <n>] [--sha <sha>] [--authorized-by <human>] [--json]',
    summary:
      'close your work — mark the lane done (or submit it, with a merge attestation), then show what’s next',
    group: 'work',
    primary: true,
    detail:
      'Mark the lane done (the terminal that drives derived Goal status) and chain into orientation. ' +
      'Auto-targets your single live lane when no id is given. It says what it records: with `--pr`/`--sha` ' +
      'it IS `lane submit` (awaiting_acceptance, acceptor routed, ADR 192); without, it is an unconfirmed ' +
      'self-close (ADR 169) and prints that — unless the lane is acceptance-exempt (ADR 234). A lane already ' +
      'awaiting acceptance is refused rather than overridden.',
  },
  {
    name: 'goal',
    signature:
      'declare "<title>" --goal-id <id> [--story "<line>"] [--wave later] [--depends <id>,…]  |  outcome <id> "<text>"  |  retract <id>  |  list [--json]',
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
    signature:
      '[--altitude ic|team|exec] [--json]  |  delivery [<id>]  |  coordination  |  tools  |  review',
    summary: 'the insight report — flow metrics, waiting-on, the Goal board',
    group: 'insight',
    primary: true,
    detail:
      'One derived projection (ADR 050/084) at three altitudes (ic / team / exec).\n' +
      '  report delivery [<id>]   the delivery ledger — open directed acts and who has seen/answered them\n' +
      '  report coordination      coordination health — density, time-to-unblock, ignored help, stalls\n' +
      '  report tools             the MCP tool surface — per-tool calls/bounces/latency + rendered weight\n' +
      '  report review            outcome acceptance (ADR 192) — asks routed, no-counterpart degradations, rejects',
  },
  {
    name: 'board',
    signature: '[--team <slug>] [--print] [--no-open]',
    summary: 'open the work board in your browser, signed in as yourself',
    group: 'work',
    primary: true,
    detail:
      'Opens /board signed in as the seat this folder resolves to, without you handling a secret ' +
      '(ADR 170). The CLI stages the credential it already holds with the daemon and carries only a ' +
      'one-shot nonce to the browser — dead after a single use or 60 seconds, and redeemable only on ' +
      'this machine. `--print` shows the link instead of opening it; `--no-open` stages without ' +
      'launching. Signing in also marks you present on the roster (ADR 155).',
    examples: ['musterd board', 'musterd board --team revive'],
  },
  {
    name: 'live',
    signature: '[--team <slug>] [--print] [--no-open]',
    summary: 'open the office in your browser, signed in as yourself',
    group: 'team',
    primary: false,
    detail:
      'Opens /live signed in as the seat this folder resolves to, so the asks waiting on you are ' +
      'answerable rather than merely readable (ADR 222). Same one-shot nonce as `musterd board` — ' +
      'dead after a single use or 60 seconds, redeemable only on this machine, and never a ' +
      'credential in a link. The everyday path is the sign-in button on the rail itself; this is ' +
      'the cold start, for when no browser is open yet. Signing in also marks you present on the ' +
      'roster (ADR 155), which is what lets the ask clock treat you as reachable.',
    examples: ['musterd live', 'musterd live --team revive'],
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
    summary: 'the roster — who’s on the team, present, and working; leads with what waits for you',
    group: 'team',
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
      '[--watch] [--all] [--unread] [--peek] [--deferred] [--limit <n>] [--from <name>] [--act <act>]  |  --waiting  |  defer <act_id> --until-lane <id> | --until-reply  |  --wait [--timeout <s>]  |  --interrupt-check',
    summary: 'read what’s waiting for you; watch or block for the next act',
    group: 'waiting',
    primary: true,
    detail:
      'Your durable mailbox. By default it shows a bounded RECENT window (newest last), grouped under ' +
      'day headers (Today / Yesterday / Monday · Jul 7), and always includes every unread — reading ' +
      'advances the cursor only past what it showed. `--limit <n>` resizes the window; `--limit 0` ' +
      'shows the full history; `--peek` reads without marking anything read; `--unread` shows only new. ' +
      '`--watch` streams live; `--wait` blocks until the next directed act then exits (pairs with /loop); ' +
      '`--waiting` prints the waiting-acts banner and the directed acts behind it, read-only and silent when nothing waits (the ADR 053 approval-prompt Notification hook target; `musterd nudge` until 2026-09-03). ' +
      '`--interrupt-check` is silent unless an urgent act waits (the ADR 088 PostToolUse interrupt hook). ' +
      '`defer <act_id>` postpones one act until a condition fires — `--until-lane <id>` (that lane moves) ' +
      'or `--until-reply` (someone answers on its thread); it comes back on its own then, even if the ' +
      'cursor has passed it. There is no time form: "later" is a state edge, never a clock (ADR 211). ' +
      '`--deferred` lists what you have postponed and which ones have since raised.',
    examples: [
      'musterd inbox',
      'musterd inbox --unread',
      'musterd inbox --waiting',
      'musterd inbox --limit 40',
      'musterd inbox --wait --timeout 300',
      'musterd inbox defer 01KZ4PAE1E --until-reply',
      'musterd inbox --deferred',
    ],
  },
  {
    name: 'whoami',
    signature: '',
    summary: 'the seat this folder resolves to (member, team, surface, source)',
    group: 'waiting',
    primary: true,
    detail:
      'Show the seat this folder resolves to right now and where it came from (env > binding > --as > ' +
      'config). An unbound folder is a valid answer — it tells you how to claim a seat.',
  },
  {
    name: 'memory',
    signature: '[show] | save --headline "<subject>" [body…] | clear',
    summary: 'this seat’s private continuity note (save before you hand off)',
    group: 'remembering',
    primary: true,
    detail:
      'This seat’s private continuity note (ADR 093): save before handing off or wrapping up; claim/status ' +
      'show the one-line pointer. No cross-seat read.',
  },
  {
    name: 'insight',
    signature:
      'save --headline "<subject>" [body…] [--tags a,b] [--repo slug] | search "<keywords>"',
    summary: 'save a finding for the whole team; search what teammates already saved',
    group: 'remembering',
    primary: false,
    detail:
      'Team memory (ADR 327): `save` writes an insight act — team-visible, attributed, dated — for traps, ' +
      'measured numbers, and how-things-actually-work; `search` retrieves them pull-only via a derived index. ' +
      'The fast tier under docs/wiki/: promote a durable finding there once it proves out.',
  },
  {
    name: 'wake-context',
    signature: '--act <id> | --lane <id>',
    summary: 'read a bounded, body-free wake orientation index',
    group: 'waiting',
    primary: false,
    detail:
      'Read ADR 209 portable wake context for a directed Act or owned Lane. It names only canonical IDs, state, delivery intent, and explicit follow-up reads; it never loads an Act or memory body.',
  },
  {
    name: 'availability',
    signature: '<available|away|dnd> [--until <iso>]',
    summary:
      'set your availability (away holds notifications; dnd passes urgent) — MCP: team_availability',
    group: 'waiting',
    primary: true,
  },

  // ── Seats & admin ──────────────────────────────────────────────────────────────────────────
  {
    name: 'claim',
    signature:
      '[<name>] [--team <slug>] [--key <mskey_|mscr_>] [--grant <msgr_>] [--token <code>] | --role <role> [--for <code>] [--surface <s>] [--detach] [--force]',
    summary: 'get onto the team from this folder — occupy or adopt a seat (MCP: team_join)',
    group: 'team',
    primary: true,
    detail:
      'Get onto the team from this folder: bare `claim` occupies your bound seat (or confirms it if ' +
      'already live here); a name/role claims that seat; `--token` adopts a teammate’s seat; `--force` ' +
      'repoints a folder bound to a live member. A held seat opens a request and blocks until an admin ' +
      'approves, then occupies (ADR 087). In a fresh folder name the team and present the key: ' +
      '`claim <name> --team <slug> --key <mskey_|mscr_>` (the former `musterd join`, folded in by ADR 377; ' +
      'a key this machine has held before is found in the vault). `--detach` claims one-shot over HTTP and ' +
      'exits with the seat still present (no session held; what `join` always did) — for fixtures and ' +
      'scripts that want the room to stay occupied. The MCP spelling is `team_join`.',
    examples: [
      'musterd claim',
      'musterd claim scout',
      'musterd claim --role reviewer',
      'musterd claim nick --team acme --key mscr_…',
    ],
  },
  {
    name: 'requests',
    signature:
      '[--pending] [--json]  |  decide <id> --approve [--once | --standing | --ttl-hours <n>] | --deny',
    summary: 'list and decide claim/teammate requests (admin-only)',
    group: 'team',
    primary: true,
    detail:
      'List claim/teammate requests and decide them (admin-only, ADR 077). Approve grant lifetimes: ' +
      'ttl (default resume token / 24h), once (single-use), standing (until revoked).',
    examples: ['musterd requests --pending', 'musterd requests decide r7 --approve --standing'],
  },
  {
    name: 'residency',
    signature:
      'on [--harness <class>] [--host <name>] [knobs] | off | status | policy [knobs]  [--seat <name>] [--json]',
    summary: 'enroll this seat for wake-on-message while offline (ADR 131)',
    group: 'ops',
    detail:
      'Harness residency (ADR 131): an enrolled seat that goes offline stays reachable — the daemon ' +
      'derives wake-due directed acts and `musterd host` resurrects the harness session. ' +
      '`on` (admin-authorized) enrolls a seat, lands a standing resume grant in .musterd/binding.json, ' +
      'and registers the workspace in the machine-local host registry; `off` is the kill switch ' +
      '(reverses all three); `status` cross-checks the stores, names drift, and renders the effective ' +
      'wake policy (seat overrides starred). Two different flags: --seat = WHAT gets enrolled (an ' +
      'agent seat; defaults to this workspace’s binding), --as = WHO authorizes (an admin). Knobs ' +
      '(inc 5) — on `on` they override THIS seat, on `policy` they set the TEAM defaults: ' +
      '--lane both|interrupt|batched, --cooldown 15m, --hourly-cap N, --attempt-cap N, ' +
      '--tool-policy reply-only|seat-policy, --timeout 5m, --max-turns N, --budget USD, ' +
      '--transcript-max MiB (fractions OK — the default bound is 0.25, i.e. 256 KiB); ' +
      '--reset-policy clears a seat back to team defaults. There is no ' +
      '`--lane off` — "stop waking this seat" is `residency off`. The roster shows enrolled offline ' +
      'seats as `offline · wakeable`.',
    examples: [
      'musterd residency on --as nick',
      'musterd residency on --seat scout --as nick --lane batched --budget 2',
      'musterd residency policy --cooldown 15m --hourly-cap 4 --as nick',
      'musterd residency status',
      'musterd residency off',
    ],
  },
  {
    name: 'session',
    signature:
      'show [--json]  |  start --stdin | end --stdin  |  bind --thread <id>  |  resolve-labels --stdin  |  label-nudge',
    summary: 'this workspace’s captured harness session — what a wake would resume (ADR 131)',
    group: 'ops',
    detail:
      'Session capture (ADR 131 inc 4): the SessionStart/SessionEnd hooks (`musterd init` wires ' +
      'them) pipe the harness hook JSON into `start`/`end`, which record the session in the ' +
      'gitignored .musterd/binding.json — the id and transcript path never leave this machine; the ' +
      'daemon gets a harness-class-only attestation (presence-neutral, never claims). A wake then ' +
      'upgrades from fresh to `--resume`, and a live local session defers the wake entirely. ' +
      '`show` is the human view: what is captured here, is it live, would a wake resume or defer. ' +
      '`resolve-labels` is the sidebar-sweep decision engine (ADR 160): session-list JSON in, ' +
      '`{apply, skipped}` out — the label-sessions skill pipes through it and applies the renames; ' +
      'it also stamps the machine-wide last-sweep file. `label-nudge` is the hook-driven other ' +
      'half: one imperative line while that stamp is missing/stale (>4h), silence otherwise. ' +
      '`observe --orient` (ADR 333) is the Cursor sessionStart injector: after observe, stdout is ' +
      'JSON `{ additional_context }` wrapping the orientation block. ' +
      '`bind --thread <id>` is ADR 210 repair: a threaded send binds this session to that thread ' +
      'automatically, and this re-binds when that never happened (capture arrived late, inherited ' +
      'session, dialogue moved). It binds the CURRENT capture only — a hand-named session is the ' +
      'unprovable claim exact-match continuity exists to refuse. No capture means nothing to bind ' +
      'and wakes on that thread stay fresh.',
    examples: [
      'musterd session show',
      'musterd session show --json',
      'musterd session bind --thread 01KZ4C4R8NDZ1F7N7NJET2MG9K',
    ],
  },
  {
    name: 'host',
    signature: '[--once] [--interval <s>] [--timeout <s>] [--host <label>]',
    summary: 'the wake actuator — resurrect enrolled offline seats on this machine (ADR 131)',
    group: 'ops',
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
    group: 'team',
  },
  {
    name: 'reclaim',
    signature: '<member>',
    summary: 'drop a member’s stuck/stale live session so it can rejoin',
    group: 'team',
  },
];
