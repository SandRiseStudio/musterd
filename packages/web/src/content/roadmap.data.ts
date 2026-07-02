/*
 * The roadmap — single source of truth.
 *
 * This typed module is canonical: the web roadmap map imports it directly, and ROADMAP.md's
 * item region is GENERATED from it (`pnpm roadmap:gen`, via scripts/gen-roadmap.ts). Edit here;
 * never hand-edit the generated region of ROADMAP.md. Copy stays plain and declarative, and
 * honest about status, per brand.md §4.
 */

export type Status = 'shipped' | 'near-term' | 'reserved' | 'out-of-scope';

/**
 * Build-order lane — priority/sequence, orthogonal to {@link Status}. Status is the coarse
 * "how imminent/designed" grouping; `wave` is the linear order we actually build in. Every unshipped,
 * in-scope item carries one; shipped/out-of-scope items omit it.
 */
export type Wave = 1 | 2 | 3 | 'later';

export type Category =
  | 'human-loop'
  | 'observability'
  | 'transport'
  | 'surfaces'
  | 'insights'
  | 'harness'
  | 'platform';

export interface Ref {
  label: string;
  href: string;
}

export interface RoadmapItem {
  id: string;
  title: string;
  status: Status;
  category: Category;
  blurb: string;
  detail?: string;
  refs?: Ref[];
  /** ids of items this one builds on — drawn as dependency edges on the map. */
  dependsOn?: string[];
  /** Build-order lane (priority/sequence). Unset on shipped + out-of-scope items. */
  wave?: Wave;
}

const REPO = 'https://github.com/SandRiseStudio/musterd/blob/main';

// ADRs link to the decisions folder; the number lives in the label.
const adr = (_n: number, label: string): Ref => ({
  label,
  href: `${REPO}/docs/decisions`,
});
const doc = (path: string, label: string): Ref => ({ label, href: `${REPO}/${path}` });

export const STATUS_META: Record<Status, { label: string; tone: string; cssVar: string }> = {
  shipped: { label: 'shipped', tone: 'Built and in the product today.', cssVar: '--status-shipped' },
  'near-term': {
    label: 'near-term',
    tone: 'Next up — designed, evidence-backed, not yet built.',
    cssVar: '--status-near-term',
  },
  reserved: {
    label: 'reserved',
    tone: 'The schema and wire format already make room; built later.',
    cssVar: '--status-reserved',
  },
  'out-of-scope': {
    label: 'out of scope',
    tone: 'Excluded by principle, not by timing.',
    cssVar: '--status-out',
  },
};

export const CATEGORY_META: Record<Category, { label: string; short: string; color: string }> = {
  'human-loop': { label: 'Human ↔ agent loop', short: 'human loop', color: '#f2b441' },
  observability: { label: 'Telemetry & observability', short: 'telemetry', color: '#54c8c2' },
  transport: { label: 'Transport & topology', short: 'transport', color: '#7aa2f7' },
  surfaces: { label: 'Surfaces', short: 'surfaces', color: '#c792ea' },
  insights: { label: 'Work items & insight', short: 'insight', color: '#ec7fa0' },
  harness: { label: 'Harness environment', short: 'harness', color: '#8fd694' },
  platform: { label: 'Platform', short: 'platform', color: '#b3aba3' },
};

export const CATEGORY_ORDER: Category[] = [
  'human-loop',
  'observability',
  'transport',
  'surfaces',
  'insights',
  'harness',
  'platform',
];

export const STATUS_ORDER: Status[] = ['shipped', 'near-term', 'reserved', 'out-of-scope'];

export const WAVE_ORDER: Wave[] = [1, 2, 3, 'later'];

export const WAVE_META: Record<Wave, { label: string; tone: string }> = {
  1: { label: 'Wave 1', tone: 'Harden the coordination loop — small, additive, evidence-backed.' },
  2: { label: 'Wave 2', tone: 'The v0.3 governance rock, then the full governed tiers it unlocks.' },
  3: { label: 'Wave 3', tone: 'Reach + the second-product seed.' },
  later: { label: 'Later', tone: 'No near-term pull; opportunistic.' },
};

/** The launch gate that precedes all new dev — not a roadmap item (a one-shot op), but part of the sequence. */
export const SEQUENCE_GATE =
  'v0.2 is published on npm (the @musterd/* packages) — the gate that unblocked the waves below. The launch post is the only remaining launch-tail item, and it is human-authored; new dev proceeds on the sequence below.';

/** Rank an item for priority sorting within a status (unwaved items sort last, by category). */
export function waveRank(item: RoadmapItem): number {
  return item.wave === undefined ? Number.POSITIVE_INFINITY : WAVE_ORDER.indexOf(item.wave);
}

export const ROADMAP: RoadmapItem[] = [
  // ── shipped ───────────────────────────────────────────────────────────────
  {
    id: 'driver-co-presence',
    title: 'Driver co-presence',
    status: 'shipped',
    category: 'human-loop',
    blurb: 'When a human steers an agent inside its session, the roster shows the human present — not offline.',
    detail:
      'The founding dogfood wound: a human driving an agent used to read as absent. Pulled pre-launch because the headline is humans and agents as peers.',
    refs: [adr(21, 'ADR 021')],
  },
  {
    id: 'resolve-act',
    title: 'The resolve act',
    status: 'shipped',
    category: 'human-loop',
    blurb: 'A terminal "done" signal for a thread. accept is not finished; resolve closes the loop.',
    detail: 'A new collaboration act and a SPEC bump — it serves both progress-awareness and the future board layer.',
    refs: [adr(25, 'ADR 025')],
  },
  {
    id: 'notify-nudge',
    title: 'Reachability nudge',
    status: 'shipped',
    category: 'human-loop',
    blurb: 'musterd notify pushes a localhost OS notification so an away human learns an agent needs them.',
    detail:
      'The minimal down-payment on the notification protocol Co-Gym shows more than doubles collaboration win rate. Full notification tiers come with v0.3 governance.',
    refs: [adr(35, 'ADR 035'), adr(24, 'ADR 024')],
  },
  {
    id: 'telemetry-l1',
    title: 'Telemetry — Layer 1',
    status: 'shipped',
    category: 'observability',
    blurb: 'One OTLP span per Envelope on the validate → persist → route path, plus act and team metrics. Off by default, no phone-home.',
    detail:
      'meta.otel carries W3C trace context so a handoff links the sender and receiver traces across runtimes and vendors. @musterd/mcp emits and honors it.',
    refs: [adr(15, 'ADR 015'), adr(11, 'ADR 011'), doc('docs/design/observability.md', 'observability.md')],
  },
  {
    id: 'harness-adapters',
    title: 'Harness adapters',
    status: 'shipped',
    category: 'harness',
    blurb: 'Claude Code, Cursor, and Codex each get a rendered role MCP server. Codex writes a project-local .codex/config.toml.',
    detail:
      'Plus the role-template format and built-in library, musterd role, an uninstall manifest, charter injection, and musterd uninstall.',
    refs: [adr(29, 'ADRs 029–031'), doc('docs/design/provisioning-recipe.md', 'provisioning-recipe.md')],
  },
  {
    id: 'workspace-scoped-presence',
    title: 'Seat stops flapping on health-check probes',
    status: 'shipped',
    category: 'platform',
    blurb: 'Agent single-active displacement is scoped by workspace: a same-seat reconnect (a reload, or Claude Code’s periodic MCP health-check spawn) no longer supersedes the live session — only a genuinely different session does.',
    detail:
      'A dogfood finding: an autojoined agent kept getting superseded “between posts”. Cause — Claude Code transiently spawns the stdio MCP server (health checks ~90s, claude mcp get), and with autojoin each spawn joined and, under newest-wins (ADR 017), displaced the real session, then disconnected. Fix: only displace connections from a different workspace; a same-workspace hello is the same seat reconnecting and is kept. Cross-workspace newest-wins (real reload / second machine) is unchanged.',
    refs: [adr(68, 'ADR 068'), adr(17, 'ADR 017'), adr(57, 'ADR 057')],
  },
  {
    id: 'agent-workspace',
    title: 'One-command agent workspaces',
    status: 'shipped',
    category: 'harness',
    blurb: 'musterd agent <name> adds an agent AND gives it its own isolated git worktree, binding, and MCP registration — so two actors never fight over one folder’s seat.',
    detail:
      'Closes the identity-thrash dogfood: in Claude Code one folder = one MCP registration = one identity, so each agent needs its own workspace. The command provisions a worktree on an agent/<name> branch (sibling folder outside git), writes the binding there, and registers the server with autojoin. It also auto-issues a standing grant for the seat so the workspace occupies on launch without an admin-approval round-trip, and writes the committed launch spec (see committed-launch-spec). Re-adding a soft-removed name now revives it instead of dead-ending on a UNIQUE constraint.',
    refs: [adr(65, 'ADR 065'), adr(59, 'ADR 059')],
  },
  {
    id: 'verify-provisioning',
    title: 'Verify provisioning, don’t assume',
    status: 'shipped',
    category: 'harness',
    blurb: 'The SessionStart hook checks the musterd server is actually registered before telling an agent it’s auto-joined; if not, it prints the fix instead of a false reassurance.',
    detail:
      'Closes the gap between the committed AGENTS.md primer marker (travels with the repo) and the machine-local `claude mcp add -s local` registration. `musterd init`/`agent` now auto-install the verify hook globally + self-gating (it fires only in folders carrying the `musterd:start` primer, and absorbs a hand-pasted recipe so it never double-fires). `musterd init --check` is the on-demand drift detector for the same "primer present, server unregistered" state — read-only, like the arch-tree / fmt --check guards. The "server registration is never committable" limitation this once described is now lifted by the committed launch spec (see committed-launch-spec).',
    refs: [adr(60, 'ADR 060'), doc('docs/harness-hooks.md', 'harness-hooks.md')],
  },
  {
    id: 'committed-launch-spec',
    title: 'Committed launch spec — a clone self-wires',
    status: 'shipped',
    category: 'harness',
    blurb: 'A secret-free .musterd/workspace.json rides the repo, so a fresh clone/worktree registers the musterd MCP server with one no-prompt `musterd wire` — no interactive init.',
    detail:
      'Resolves the ADR 060 non-goal ("auto-register the server from the committed marker needs a secret-free, env-referenced entry"). Splits the binding: WorkspaceSpecSchema (server/team/surface/claim) is committable (only binding.json is gitignored, ADR 058), while the secrets (agent_key/grant) stay local (env / the 0600 global config / the gitignored binding). `musterd wire` reads the committed spec, resolves the key locally, and registers the server idempotently — tools only by default (no seat claim unless --autojoin), so a repo cloned by many never has every clone grab one seat. init/agent write the spec; the adapter reads it as a base (env > binding > spec); the SessionStart hook points a fresh clone at `musterd wire`.',
    refs: [adr(80, 'ADR 080'), adr(60, 'ADR 060'), doc('docs/design/provisioning-recipe.md', 'provisioning-recipe.md')],
    dependsOn: ['verify-provisioning', 'agent-workspace'],
  },
  {
    id: 'claim-on-first-use',
    title: 'Claim on first use',
    status: 'shipped',
    category: 'harness',
    blurb: 'A folder claim policy and live claim bring a running pending session online — no relaunch, no wire change.',
    detail:
      'musterd claim --for <code> drops an ephemeral resolved sidecar the adapter adopts. The binding stays the durable channel; the sidecar is the live overlay.',
    refs: [adr(32, 'ADRs 032–034')],
  },
  {
    id: 'cross-network',
    title: 'Cross-network teams',
    status: 'shipped',
    category: 'transport',
    blurb: 'Two people on two machines can share a team today — run the daemon on a Tailscale/WireGuard overlay and point each member’s MUSTERD_SERVER at its overlay address.',
    detail:
      'The topology framework is decided (one team = one daemon, not federation): overlay now, secured bind next, hosted relay later. The secured off-loopback bind shipped — the daemon refuses a non-loopback plaintext bind without TLS (wss://) or a trusted proxy, gates the WS upgrade on Origin/Host, and makes WAN timeouts tunable. Still ahead: the v0.3 credentialed remote join it carries, and a hosted relay for those who won’t run an overlay.',
    refs: [
      adr(39, 'ADRs 039–040'),
      doc('docs/guides/cross-network-overlay.md', 'overlay guide'),
      doc('docs/design/deployment-topology.md', 'deployment-topology.md'),
    ],
  },

  {
    id: 'availability-urgent',
    title: 'Availability axis + urgent breakthrough',
    status: 'shipped',
    category: 'human-loop',
    blurb: 'A human sets their own availability (available/away/dnd, away_until); an urgent flag with a required reason breaks through an away/dnd hold, and the notify loop tiers delivery by it.',
    detail:
      'The localhost down-payment on the governed model: availability is stored and on the roster, urgent rides meta with no version bump, tiering runs client-side. can_flag_urgent gating, audit, and the wasnt_urgent feedback are the v0.3 superset.',
    refs: [adr(44, 'ADR 044'), doc('SPEC.md', 'SPEC A.6a')],
    dependsOn: ['notify-nudge'],
  },
  {
    id: 'service-lifecycle',
    title: 'Daemon service lifecycle',
    status: 'shipped',
    category: 'platform',
    blurb: 'musterd service runs the daemon as a background service that survives a closed terminal, restarts on crash, and starts at login — without raw launchctl.',
    detail:
      'A per-user macOS LaunchAgent today; systemd (--user) and Windows are the named seam. The CLI manages musterd’s own daemon’s lifecycle — not member agents — so the clean-core principle stays intact.',
    refs: [adr(45, 'ADR 045')],
  },
  {
    id: 'agent-reachability',
    title: 'Agent-side reachability',
    status: 'shipped',
    category: 'human-loop',
    blurb: 'The agent half of the reachability loop: a directed act waiting for an agent surfaces on every command it runs, so a heads-down agent can’t miss a request_help addressed to it.',
    detail:
      'The mirror of ADR 024’s human comeback summary, on the agent side. A dogfood finding — a seat-holding agent read its inbox once and left a directed request_help unanswered. A one-line stderr nudge appended to every acting command, built from the same pending-action predicate; client-side, no wire change.',
    refs: [adr(46, 'ADR 046'), doc('docs/design/research-foundation.md', 'research-foundation.md')],
    dependsOn: ['notify-nudge'],
  },
  {
    id: 'service-roster-guard',
    title: 'Service guardrails',
    status: 'shipped',
    category: 'platform',
    blurb: 'musterd service stop/restart refuses when other members hold live sessions, so bouncing a shared daemon doesn’t silently drop a teammate.',
    detail:
      'Ties the daemon lifecycle command to roster awareness. A dogfood finding — a shared daemon was restarted three times under a live teammate with no in-band heads-up. The CLI reads a derived connections count from /health and refuses by default; --force overrides, and it fails open when the daemon is unreachable. The daemon stays a clean core that only reports.',
    refs: [adr(47, 'ADR 047')],
    dependsOn: ['service-lifecycle'],
  },

  // ── near-term ─────────────────────────────────────────────────────────────
  // Order within a wave is priority order (within-wave = array order). v0.2 is published (the gate);
  // the obs-evals gate shipped (ADR 052), so Wave 1 now leads with the dogfood loop (blocked-agent +
  // wake-on-message), then cli-ergo, then Wave 2 (v0.3 governance → full tiers).

  // Wave 1 — harden the coordination loop (small, additive, no v0.3 dependency).
  {
    id: 'seat-binding-ergonomics',
    title: 'Hand off & claim a seat without leaving the tool',
    status: 'shipped',
    category: 'harness',
    blurb: 'A teammate issues a ready seat to another agent in one command, the receiver adopts it in one command, and a claim conflict no longer dead-ends — it names the runnable next command.',
    detail:
      'Elevated after a 2026-06-25 dogfood disaster: a fresh agent handed a pre-created named seat could not claim it (team add mints a join --token; claim <name> refused it; join/reclaim fought a shared cached identity), burned its whole session on acquisition, and escalated to hand-editing the live SQLite DB. The fix shipped: claim <name> --token adopts a teammate-created seat into the folder binding with no global-identity clobber; claim --for <code> binds a pending session; the claim conflict path names the next command instead of dead-ending; per-folder binding is the identity channel; and team add + the primer teach seat acquisition. Validated by a follow-up onboarding run (a fresh agent adopted its seat end-to-end, no DB surgery). The multi-identity vault (ADR 059) hardened it further — a second agent on the same machine can no longer clobber the first’s cached token.',
    refs: [adr(55, 'ADR 055'), adr(59, 'ADR 059'), adr(32, 'ADRs 032–034'), adr(36, 'ADR 036')],
  },
  {
    id: 'agent-presence-touch',
    title: 'Ambient agent presence',
    status: 'shipped',
    category: 'human-loop',
    blurb: 'An agent doing bursty one-shot CLI work shows present on the roster instead of offline — liveness from real actions, not just a resident watch socket.',
    detail:
      'Presence used to need a resident WS session; a sequence of one-shots read as offline. Now a short-TTL ambient presence touch on each authenticated command keeps a bursty agent present for the timeout window — while working: <x> still comes solely from a self-reported status_update (the two-clocks rule). No-ops under a resident session, upserts one row per member, and never displaces — so it composes with newest-session-wins and human fan-out. Unblocked the wake-on-message and blocked-agent work, which assume the roster reflects who is actually doing things.',
    refs: [adr(57, 'ADR 057'), adr(10, 'ADR 010'), adr(17, 'ADR 017')],
  },
  {
    id: 'durable-roster',
    title: 'Durable seat roster on git',
    status: 'shipped',
    category: 'platform',
    blurb: 'A team’s seat roster lives as committed .musterd/ files; the daemon is a projection of them, so the git history of seats/ is the membership audit log — while live state (presence, tokens) stays daemon-only.',
    detail:
      'From the Sierra/Max-Agency podcast (“materialize everything into files/git so coding agents can cook”). The durable/live line runs through the members row: seat identity (name/kind/role/lifecycle) → git-tracked seats/<name>.toml; token_hash + presence + the held/unheld bit stay daemon-private. The daemon reconciles the files (match-by-name, preserving id/token across reconciles), the file is the single writer (races are git merges), and a semantic round-trip guard keeps the projection faithful. Closes the seat-claim disaster by construction — the durable act an agent kept falling back to the filesystem to do IS a file act now. Shipped end to end: canonical TOML format + isomorphism guards, the projection/reconcile module, bound_at migration, file-backed team add/claim, musterd fmt/unbind/reload, and team export (the live db→file migration). The dogfood team alpha was migrated to a file-backed roster in production, token-preserving, with no teammate re-auth.',
    refs: [adr(58, 'ADR 058'), doc('docs/design/projection-reconcile.md', 'projection-reconcile.md'), doc('docs/design/seat-lifecycle-as-files.md', 'seat-lifecycle-as-files.md')],
    dependsOn: ['seat-binding-ergonomics', 'agent-presence-touch'],
  },
  {
    id: 'multi-identity-vault',
    title: 'Multi-identity vault',
    status: 'shipped',
    category: 'harness',
    blurb: 'A second agent joining a team on the same machine can no longer clobber the first’s cached token — every claimed identity is kept, keyed by (team, member).',
    detail:
      'The global config kept one identity slot per team, so a second member joining the same team on one machine overwrote the first’s token and --as <name> stopped resolving. Now a knownIdentities vault keeps every identity this machine has joined or claimed, keyed by (team, name), backfilled from the legacy single-slot config on load. The per-folder binding stays the active-identity channel; the vault is the durable superset behind --as.',
    refs: [adr(59, 'ADR 059')],
    dependsOn: ['claim-on-first-use'],
  },
  {
    // Shipped 2026-06-26 as the lead Wave 1 item: cheapest, and everything built after it carries
    // traces+evals by default — so the dogfood-loop + governance work below never needs retrofit.
    id: 'obs-evals-gate',
    title: 'Traces & evals first-class gate',
    status: 'shipped',
    category: 'observability',
    blurb: 'Every agent-facing feature ships with its traces and an eval, the way it ships with tests — an ADR-template section and a format:check guard enforce it. Cheap and compounding, so later features inherit it.',
    detail:
      'The cheap, compounding half of the trace → eval → experiment flywheel: an "Observability & Evaluation" section in the ADR template (traces, eval metric + dataset + baseline, experiment) plus an obs-evals:check step in format:check, modeled on the arch-tree checker (presence and shape, not content). ADRs from 060 on must carry the section (earlier ones grandfathered); features built through later waves now carry telemetry by default and batond never retrofits.',
    refs: [adr(52, 'ADR 052'), adr(51, 'ADR 051'), doc('docs/design/observability.md', 'observability.md')],
  },
  {
    id: 'inbox-reaches-blocked-agent',
    title: 'Inbox reaches a blocked agent',
    status: 'shipped',
    category: 'human-loop',
    blurb: 'A teammate’s message reaches an agent parked on an approval prompt — surfaced into the terminal the human is already at — instead of waiting until the human hand-relays it.',
    detail:
      'A dogfood finding: with per-tool approval on, an agent frozen on a permission prompt runs no command, so ADR 046’s per-command nudge can’t fire and the message waits until the human hand-relays it — the message-bus regression. Allowlisting musterd commands doesn’t help; the block is on the agent’s own gated work. The fix is push, not pull. Shipped: musterd nudge (a read-only print of the directed acts waiting for this seat) plus a Claude Code Notification hook that runs it at the approval-prompt moment, installed by configure (so init and agent both wire it), idempotent and marker-reversible by musterd uninstall. The hook’s authenticated read also keeps a blocked agent recently-present via ambient presence (ADR 057); the distinct blocked_on_approval label is deferred to the ambient-presence ADR (a closed presence enum, so a no-wire-change for now). Cursor/Codex degrade to ADR 046’s per-command nudge.',
    refs: [adr(53, 'ADR 053'), adr(46, 'ADR 046'), adr(57, 'ADR 057')],
    dependsOn: ['agent-reachability'],
  },
  {
    id: 'wake-on-message',
    title: 'Wake on message',
    status: 'shipped',
    category: 'human-loop',
    blurb: 'An idle agent blocks until its next directed act arrives and resumes immediately — instead of polling on a timer or missing the message in the gap.',
    detail:
      'A dogfood finding: asked to “wake when the other agent messages,” an agent bolted inbox-polling onto /loop — a workaround that burns turns and trades latency for cost. Shipped musterd inbox --wait, a blocking one-shot over the existing watch socket that exits on the first directed act (exit 0 on a message, 124 on timeout); it first drains the durable inbox so a message that landed just before the wait isn’t missed, wakes only on acts directed to the seat (not broadcast journal traffic, narrowable with --from/--act), and --timeout bounds the wait (--timeout 0 unbounded). The musterd inbox --wait + /loop idiom is now blessed in the AGENTS.md primer. The free-agent complement to ADR 053’s blocked-agent push; neither reaches a frozen loop, so they pair.',
    refs: [adr(54, 'ADR 054'), adr(12, 'ADR 012')],
    dependsOn: ['agent-presence-touch'],
  },
  {
    id: 'cli-ergonomics',
    title: 'CLI ergonomics',
    status: 'shipped',
    category: 'platform',
    blurb: 'The papercuts a fresh agent hits in its first five minutes — identity, version, inbox filters, one-command replies.',
    detail:
      'Dogfood papercuts, several from the 2026-06-25 onboarding retry. Earlier half landed first (inbox --unread/--peek/--limit). The rest shipped as ADR 067: musterd whoami (which seat does this folder resolve to, + source) and musterd --version (both the first things a fresh agent reaches for); inbox --from/--act filters (the --act flag was previously a no-op), a lens that never advances the read cursor; and accept/decline auto-targeting the latest open request_help/handoff (inheriting its thread) so closing a loop is one command instead of inbox --json | parse | --reply-to. No wire change — all client-side over existing read/send paths. One residual spins out to Later: edit/supersede a sent act (a correction shouldn’t leave overlapping copies in the recipient inbox) — that implies a new wire concept, not a papercut.',
    refs: [adr(67, 'ADR 067'), adr(24, 'ADR 024'), adr(36, 'ADR 036')],
  },

  // Wave 2 — the v0.3 governance rock, phased so the breaking auth swap is isolated (ADR 069 build plan).
  {
    id: 'v03-p0-plan',
    title: 'v0.3 governance — build plan & spec reconciliation',
    status: 'shipped',
    category: 'platform',
    blurb: 'The phased decomposition of the v0.3 governance rock, the four directional decisions, and the spec-gap resolutions — so the breaking auth change lands as one isolated, reviewed moment.',
    detail:
      'The governance model is fully designed (SPEC Appendix A + membership-model.md + security.md); ADR 069 turns it into a buildable plan. Decisions: one-shot schema reset (safe because ADR 058 made the daemon a projection of git seat-files); hard cutover to claim/grant everywhere (no dual-path); durable seat fields (account_status + capability narrowing) live in the git seat-files, credentials stay daemon-private; deliver the plan then start P1. Pins the open spec gaps: credential/grant token format, request expiry (1h), pending-claim push contract, decide→grant-lifetime binding, and the A.9↔ADR-058 reconciliation (members→seats is a seat-file extension, not a row migration).',
    refs: [adr(69, 'ADR 069'), doc('SPEC.md', 'SPEC Appendix A'), doc('docs/design/membership-model.md', 'membership-model.md')],
    dependsOn: ['cross-network'],
  },
  {
    id: 'v03-p1-seats',
    title: 'v0.3 P1 — seats data model',
    status: 'shipped',
    category: 'platform',
    blurb: 'The substrate: account_status + capabilities on a seat, roles carrying default capabilities + charter, per-seat narrowing (never widening). Permissive defaults, no enforcement yet.',
    detail:
      'Extends the ADR 058 git seat-file schema with account_status + capability narrowing, adds roles/<name>.toml for role defaults + charter, and projects both through reconcile into new daemon columns; lifts the CLI role-template’s already-shaped capacity/charter/capabilities into a shared @musterd/protocol type. A one-shot reset rebuilds the daemon DB from the extended files (no row-migration code). Pure substrate — token auth unchanged, nothing enforced — so it ships green with no flag day.',
    refs: [adr(69, 'ADR 069'), adr(58, 'ADR 058'), adr(26, 'ADR 026')],
    dependsOn: ['v03-p0-plan'],
  },
  {
    id: 'v03-p2-enforcement',
    title: 'v0.3 P2 — in-band enforcement & audit',
    status: 'shipped',
    category: 'platform',
    blurb: 'The first real governance value, on the existing token auth: gate urgent on can_flag_urgent, admin-only governance routes, viewer-scoped visibility, account-status enforcement, and an append-only audit log.',
    detail:
      'Turns the capabilities from P1 into enforcement at the routeEnvelope / roster-projection seams: can_flag_urgent gates the urgent meta flag — downgrade-and-deliver (strip urgent, set wasnt_urgent) + audit, never reject — completing the notification-tiers governed superset; is_admin gates the today-ungated reclaim/remove (creator-admin default + an empty-admin fallback so an un-migrated team keeps its escape hatch); visibility_level projects the roster per viewer (non-admins see their own caps, not other seats’ authority map); account_status (disabled/banned/archived) + can_message:none block sending; can_observe gates the ADR 063 firehose. Every governed op writes an append-only audit record (admin-only GET /audit). Ships on the existing occupant==seat token auth — no flag day.',
    refs: [adr(71, 'ADR 071'), adr(69, 'ADR 069'), adr(44, 'ADR 044'), adr(63, 'ADR 063')],
    dependsOn: ['v03-p1-seats'],
  },
  {
    id: 'v03-p3-credentials',
    title: 'v0.3 P3 — credentials & the claim handshake',
    status: 'shipped',
    category: 'platform',
    blurb: 'The breaking auth rework: team agent key + admin-issued grants + human credentials, the WS claim frame replacing hello, and the no-grant request/approval lane — cut over across every surface at once.',
    detail:
      'Replaces token==member with agent key (authenticates a harness) + grant (authorizes a seat). The claim frame replaces hello (occupied/refused/pending); grants carry lifetime once|ttl|standing picked at live approval; the request lane routes a no-grant claim to admins (local-admin fast path + one-keystroke approval card); team policy allow_pre_issued_grants is the opt-in. Surface migration in one coordinated set: team add provisions a seat (no token), MUSTERD_TOKEN→MUSTERD_AGENT_KEY (+ optional MUSTERD_GRANT) with the seat resolved from binding.json (MUSTERD_CLAIM only a manual override, PR #58), init/join move to the claim flow. The single isolated breaking moment (ADR 069 decision 2). The CLI surface for the request lane (ADR 077): `musterd claim <name>` on a held/declared seat now opens an admin-approval request and waits over the WS instead of dead-ending; `musterd requests [--pending]` + `musterd requests decide <id> --approve [--once|--standing|--ttl-hours <n>] | --deny` are the admin decide surface; and `musterd init`’s "activate an existing member" branch drives that same flow (no longer a v0.3 stub).',
    refs: [adr(69, 'ADR 069'), adr(77, 'ADR 077'), doc('SPEC.md', 'SPEC A.2/A.3/A.5'), doc('docs/design/security.md', 'security.md')],
    dependsOn: ['v03-p1-seats'],
  },
  {
    id: 'v03-p4-remote-join',
    wave: 'later',
    title: 'v0.3 P4 — credentialed remote join',
    status: 'near-term',
    category: 'transport',
    blurb: 'Plug the agent key + grant + human credential into the already-built secured off-loopback bind, so a teammate on another machine joins over wss with a real credential, not a locally-minted token.',
    detail:
      'The credential layer ADR 039/040 named but did not build. The secured transport (TLS/wss refuse-plaintext bind, Origin/Host gate) is done and waiting; P4 is mostly integration — the cross-network claim flow over that channel + docs. Now unblocked: P3’s agent-key + grant + human-credential model shipped (2026-06-30), so P4 is the remaining cross-network claim flow over the secured channel. Deferred at the 2026-07-01 reprioritization: the wedge is local coordination + human partnership and there is no near-term pull for cross-network, so remote join waits behind the telemetry + lanes work.',
    refs: [adr(69, 'ADR 069'), adr(39, 'ADR 039'), adr(40, 'ADR 040')],
    dependsOn: ['v03-p3-credentials', 'cross-network'],
  },
  {
    id: 'notification-tiers',
    title: 'Notification tiers',
    status: 'shipped',
    category: 'human-loop',
    blurb: 'The full reachability set: route an agent’s request for help to a human by salience and availability, not only when they are watching.',
    detail:
      'Co-Gym’s ablation: removing the notification protocol more than halves the collaboration win rate (30% → 70%). This is where the measured value is. The localhost availability + urgent down-payment shipped, then the governed superset (can_flag_urgent gating, audit, wasnt_urgent feedback) shipped inside v0.3 P2 enforcement (ADR 071). Only off_hours/schedule enforcement remains, tracked separately (Wave 3).',
    refs: [adr(71, 'ADR 071'), doc('docs/design/research-foundation.md', 'research-foundation.md')],
    dependsOn: ['notify-nudge', 'availability-urgent', 'v03-p2-enforcement'],
  },
  {
    id: 'coordination-lanes',
    wave: 3,
    title: 'Coordination lanes — own the work, never dup a diff',
    status: 'near-term',
    category: 'platform',
    blurb:
      'A first-class lane = { work-item × owner × surface } so musterd advises before two agents (or humans) redo the same work — the anti-swarm primitive.',
    detail:
      'From the P3 dogfood post-mortem: coordination messages cost ~1% of tokens, but ~37% of the code produced never reached main (53% of that a single dependency-revert). A lane makes work-ownership contention-aware — unmet-dependency + surface-overlap warnings (advisory, never block; git-optional), a done-state that fixes the dead resolve act, and handoffs that carry the branch instead of a prose description. Phase 1 = the intent + dependency layer (catches the biggest waste, git-optional); Phase 2 = lightweight piggybacked observation (watcher, never gatekeeper). Design + spec live in docs/design/lanes-and-the-multi-agent-tax.md + lane-phase1-mvp-spec.md; no ADR yet. Sequenced after the telemetry-gaps work at the 2026-07-01 reprioritization, so its wasted-work win is measurable when it lands.',
    refs: [
      doc('docs/design/lanes-and-the-multi-agent-tax.md', 'lanes / multi-agent-tax'),
      doc('docs/design/lane-phase1-mvp-spec.md', 'Phase-1 MVP spec'),
    ],
    dependsOn: ['v03-p1-seats'],
  },
  {
    id: 'telemetry-gaps',
    title: 'Close the dogfood telemetry gaps (instrument-by-default)',
    status: 'shipped',
    category: 'observability',
    blurb:
      'Turned the built-but-inert telemetry on and wired the missing surfaces — so the next multi-agent session is measurable live, not reconstructed forensically.',
    detail:
      'From lab-notebook finding 001: the flagship P3 session was near-unobservable from musterd’s own telemetry (the message DB was the only live trace). Shipped as ADR 082 in four slices, each verified live on the dogfood daemon: (1) instrument-by-default — the daemon boots the built-but-inert OTel Layer 1 (ADR 015) to a local OTLP sink, emission staying pure-OTLP so batond replaces the endpoint not the instrumentation (the sink is an interim stand-in); (2) structured HTTP request logging on daemon.log (method/path/status/latency, warn 4xx / error 5xx); (3) first-party coordination metrics — musterd.coordination.loop_latency (accept/decline/resolve vs the act they close) + open_loops gauge, the directed-act latency we had been reconstructing; (4) opt-in per-agent token usage via meta.usage → musterd.agent.tokens (harness-agnostic in-band self-report, the only path that covers non-Claude agents). Deferred follow-ups: an automatic usage emitter (transcript hook), the git-side wasted-work/dup-rate metrics (lanes territory), and a cross-agent distributed trace over the ADR 011 traceparent.',
    refs: [
      adr(82, 'ADR 082'),
      doc('docs/dogfood-telemetry.md', 'dogfood-telemetry.md'),
      doc('docs/research/001-telemetry-gaps-p3-dogfood.md', 'finding 001'),
    ],
    dependsOn: ['telemetry-l1'],
  },

  // ── reserved ──────────────────────────────────────────────────────────────
  {
    id: 'telemetry-l2',
    wave: 3,
    title: 'Telemetry — Layer 2 + SDK',
    status: 'reserved',
    category: 'observability',
    blurb: 'A full CLI/MCP telemetry SDK, then MAST-aware views over the act-typed log that agent-observability tools cannot see.',
    detail: 'The seed of a standalone coordination-observability product.',
    refs: [doc('docs/design/observability.md', 'observability.md')],
    dependsOn: ['telemetry-l1'],
  },
  {
    id: 'eval-experiment-engine',
    wave: 'later',
    title: 'Eval & experiment engine (batond)',
    status: 'reserved',
    category: 'observability',
    blurb: 'The batond half of the flywheel: team-outcome evals and side-by-side experiments over model × prompt × harness × team topology — built on a bought, Langfuse-shaped backend, never a from-scratch store.',
    detail:
      'Emit in musterd, engine in batond (ADR 051). OTel wire + Langfuse semantics for scores/datasets/experiments, plus the coordination-native additions no single-agent vendor can do: evals scored against a Goal’s definition-of-done (ADR 048/050), experiments that vary the team itself, judge calibration as meta-evals, and the harness-decay measurement that says when to delete complexity models have absorbed.',
    refs: [adr(51, 'ADR 051'), doc('docs/design/observability.md', 'observability.md')],
    dependsOn: ['telemetry-l2', 'board-insights'],
  },
  {
    id: 'coordination-dataset',
    wave: 'later',
    title: 'Coordination-traces dataset & MAST-in-the-wild',
    status: 'reserved',
    category: 'observability',
    blurb: 'The first research artifact: an open, redacted dataset of real human+agent coordination traces on HuggingFace, plus MAST failure detectors over the act-typed log — the data no single-agent vendor can produce.',
    detail:
      'Dataset-first on the HF ladder (dataset → benchmark + leaderboard → paper → judge model), MAST-in-the-wild as the first thesis (ADR 056). Substrate is telemetry-l2 + coordination-density; reproducibility rides on the flywheel’s pinned experiment manifests (ADR 051) and baselines (ADR 052). Release is gated on the opt-in + redaction posture (ADR 051) — no dataset ships before consent/redaction is enforced.',
    refs: [adr(56, 'ADR 056'), doc('docs/research/README.md', 'docs/research/')],
    dependsOn: ['telemetry-l2', 'coordination-density'],
  },
  {
    id: 'research-intake',
    wave: 'later',
    title: 'Research radar (ingest)',
    status: 'reserved',
    category: 'observability',
    blurb: 'A standing scan/triage of new multi-agent-coordination research, funneled into research-foundation.md — findings that change a decision graduate to an ADR.',
    detail:
      'The ingest half of the research practice (ADR 056): keep musterd shaped by the field. A recurring agent emits a triaged digest of arXiv / HF Papers / venue work; a human decides what graduates to an ADR + roadmap item. No auto-merge of findings into the thesis.',
    refs: [adr(56, 'ADR 056'), doc('docs/design/research-foundation.md', 'research-foundation.md')],
  },
  {
    id: 'schedule-enforcement',
    wave: 2,
    title: 'Schedule & lifecycle enforcement',
    status: 'reserved',
    category: 'platform',
    blurb: 'availability and lifecycle: until are stored today but not enforced. Later: honor windows for routing and auto-expire members.',
    dependsOn: ['v03-p2-enforcement'],
  },
  {
    id: 'step-streaming',
    wave: 'later',
    title: 'Step-level streaming transport',
    status: 'reserved',
    category: 'transport',
    blurb: 'v0.1 sends whole Envelopes. A v2 transport adds step-level streaming, which beats wait-for-complete for collaborating agents.',
    detail: 'The broadcast recipient kind is already distinct on the wire to anticipate richer delivery semantics.',
  },
  {
    id: 'federation',
    wave: 'later',
    title: 'Team-to-team federation',
    status: 'reserved',
    category: 'transport',
    blurb: 'A Member belongs to one Team today. Teams that address one another, and identities recognized across Teams, come later.',
    dependsOn: ['cross-network'],
  },
  {
    id: 'web-dashboard',
    wave: 3,
    title: 'Web dashboard',
    status: 'reserved',
    category: 'surfaces',
    blurb: 'A web surface for the same Members — designed now, built later. This page is the first foundation of it.',
    detail: 'The Surface enum already includes web, ios, slack. Same Member, more Presences.',
  },
  {
    id: 'more-surfaces',
    wave: 3,
    title: 'iOS & Slack surfaces',
    status: 'reserved',
    category: 'surfaces',
    blurb: 'An iOS app and a Slack surface, so a Member is reachable wherever its human or agent already lives.',
    dependsOn: ['web-dashboard'],
  },
  {
    id: 'board-insights',
    wave: 3,
    title: 'Work items, board & insight layer',
    status: 'reserved',
    category: 'insights',
    blurb: 'A kanban-style board and team analytics — derived as views over the message log, never stored beside it.',
    detail:
      'Time-to-unblock, cycle time, load distribution, bottlenecks — plus a declared backlog noun for planned work. The natural home is the web dashboard.',
    refs: [doc('docs/design/human-agent-dynamics.md', 'human-agent-dynamics.md')],
    dependsOn: ['resolve-act', 'web-dashboard'],
  },
  {
    id: 'coordination-density',
    wave: 3,
    title: 'Coordination-density insight',
    status: 'reserved',
    category: 'insights',
    blurb: 'An insight that flags when a team’s traffic is all broadcast-journal and no directed or threaded exchange — coordination that only looks collaborative.',
    detail:
      'A dogfood finding: status_updates posted into a channel where no one shares the work degrade into a journal. A signal only musterd’s act-typed log can compute — a candidate metric for the standalone coordination-observability product.',
    refs: [doc('docs/design/human-agent-dynamics.md', 'human-agent-dynamics.md')],
    dependsOn: ['board-insights'],
  },
  {
    id: 'own-harness',
    wave: 'later',
    title: 'Role templates & mixed-harness teams',
    status: 'reserved',
    category: 'harness',
    blurb: 'A Role becomes a harness-agnostic provisioning template, rendered per-harness — then musterd’s own harness, then mixed-harness teams.',
    detail: 'Provisioning is a starting point, not a security boundary. It stays additive, reversible, and non-obligating.',
    refs: [adr(26, 'ADRs 026–030')],
    dependsOn: ['harness-adapters'],
  },
  {
    id: 'sandboxed-runtime',
    wave: 'later',
    title: 'Sandboxed runtime',
    status: 'reserved',
    category: 'platform',
    blurb: 'musterd connects agents; it does not run them. A later, optional sandbox could host members with nowhere else to live.',
  },
  {
    id: 'python-sdk',
    wave: 'later',
    title: 'Python client SDK',
    status: 'reserved',
    category: 'platform',
    blurb: 'A fast follow after launch. The protocol is language-neutral; the TypeScript client is the reference, not the only one.',
  },

  // ── out of scope ──────────────────────────────────────────────────────────
  {
    id: 'no-orchestrator',
    title: 'A planner / orchestrator role',
    status: 'out-of-scope',
    category: 'platform',
    blurb: 'One member does the work; the team does the coordination. musterd never forces decomposition.',
    detail: 'A team of one agent, plus optionally a human, is a first-class — even default — configuration.',
  },
  {
    id: 'no-runtime',
    title: 'Running your agent',
    status: 'out-of-scope',
    category: 'platform',
    blurb: 'Protocol over framework. We connect agents; we don’t own their execution loop.',
  },
];

export const WEDGE = {
  heading: 'How priorities are decided',
  body:
    'The wedge is persistent teams with identity, presence, and humans as peers — the coordination layer where about 79% of multi-agent failures actually happen. Work is weighed by whether it strengthens that layer, not by adding more agents or more orchestration. Human partnership ranks first, on evidence: collaborative agents beat fully autonomous ones on real-user preference, and removing the notification protocol more than halves the win rate.',
  refs: [
    doc('ROADMAP.md', 'ROADMAP.md'),
    doc('docs/design/research-foundation.md', 'research-foundation.md'),
    doc('docs/design/landscape.md', 'landscape.md'),
  ] as Ref[],
};

export const TAGLINE = 'Muster your agents and humans into persistent teams.';
