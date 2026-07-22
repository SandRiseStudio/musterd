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
 * The curated gradation for an item that has **not yet shipped** — a "how imminent/designed" judgment
 * that no signal can derive. Declared by hand. (`shipped` is the fourth Status value, but it is never
 * declared — it is *derived* from a {@link ShippedAnchor}; see the declared/derived split below.)
 */
export type PlanStatus = 'near-term' | 'reserved' | 'out-of-scope';

/**
 * The proof an item **shipped** — the roadmap dogfooding musterd's own ADR 048/084/111 posture: a
 * declared skeleton with a *derived* status. An item is `shipped` iff it carries this anchor, and
 * `scripts/check-roadmap-truth.ts` verifies it against reality so the data can't silently overclaim:
 * `{ prs }` names the merged PR number(s) that landed it (each checked against git history), and
 * `{ legacy: true }` grandfathers items that shipped before this convention (recorded, not verified).
 * Marking an item shipped is thus a one-field, machine-checkable act — never a hand-set status.
 */
export type ShippedAnchor = { prs: number[] } | { legacy: true };

/**
 * Build-order lane — priority/sequence, orthogonal to {@link Status}. Status is the coarse
 * "how imminent/designed" grouping; `wave` is the linear order we actually build in. Every unshipped,
 * in-scope item carries one; out-of-scope items omit it. A shipped item may keep the wave it was
 * built in as history (the map badge), but the generated Build sequence lists only unshipped work.
 */
export type Wave = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 'later';

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
  /** Derived, never authored — computed by {@link resolveItem} from `shipped` (present ⟹ 'shipped') or `plan`. */
  status: Status;
  category: Category;
  blurb: string;
  detail?: string;
  refs?: Ref[];
  /** ids of items this one builds on — drawn as dependency edges on the map. */
  dependsOn?: string[];
  /** Build-order lane (priority/sequence). Unset on shipped + out-of-scope items. */
  wave?: Wave;
  /** The shipped anchor (carried through for the truth check); present ⟺ status === 'shipped'. */
  shipped?: ShippedAnchor;
  /** The ADR that *is* this item — the reverse anchor for the truth check (see {@link RawItem}). */
  frozenBy?: number;
}

/**
 * The **authored** shape (declared skeleton). An item declares exactly one of `shipped` / `plan`;
 * {@link resolveItem} derives the `status` the rest of the app reads. This is the ADR 084 Goal-status
 * pattern applied to the roadmap itself: order, wave, prose, and grouping stay curated; whether it has
 * *shipped* is anchored to reality, not a hand-set flag.
 */
export interface RawItem {
  id: string;
  title: string;
  category: Category;
  blurb: string;
  detail?: string;
  refs?: Ref[];
  dependsOn?: string[];
  wave?: Wave;
  /** Present ⟺ shipped — the proof it landed. Mutually exclusive with `plan`. */
  shipped?: ShippedAnchor;
  /** Present ⟺ not yet shipped — the curated gradation. Mutually exclusive with `shipped`. */
  plan?: PlanStatus;
  /**
   * The ADR that *is* this item — its own freezing ADR, distinct from the `refs` it merely builds on.
   * The truth check reads that ADR's `Status:` line as a second, bidirectional anchor: a shipped item's
   * frozenBy ADR must be accepted, and — the drift that motivated this — an *unshipped* item whose
   * frozenBy ADR is already accepted is flagged as a stale roadmap. Optional: only items with a
   * dedicated freezing ADR set it.
   */
  frozenBy?: number;
}

/** Derive the read-model item (with its `status`) from an authored declaration; enforce shipped-xor-plan. */
function resolveItem(r: RawItem): RoadmapItem {
  const isShipped = r.shipped !== undefined;
  const isPlanned = r.plan !== undefined;
  if (isShipped === isPlanned) {
    throw new Error(
      `roadmap item "${r.id}" must declare exactly one of \`shipped\` or \`plan\` (found ${
        isShipped ? 'both' : 'neither'
      })`,
    );
  }
  const { plan: _plan, ...rest } = r;
  return { ...rest, status: r.shipped ? 'shipped' : r.plan! };
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

export const WAVE_ORDER: Wave[] = [1, 2, 3, 4, 5, 6, 7, 8, 'later'];

export const WAVE_META: Record<Wave, { label: string; tone: string }> = {
  1: { label: 'Wave 1', tone: 'Harden the coordination loop — small, additive, evidence-backed.' },
  2: { label: 'Wave 2', tone: 'The v0.3 governance rock, then the full governed tiers it unlocks.' },
  3: { label: 'Wave 3', tone: 'Reach + the second-product seed.' },
  4: {
    label: 'Wave 4',
    tone: 'The steerable team — mid-loop reachability + anti-staleness, so steering reaches a busy agent before it builds on a stale assumption.',
  },
  5: {
    label: 'Wave 5',
    tone: 'Depth — turn the telemetry we already emit into a real observability layer, then per-seat memory, model as a variable, observed-surface contention, and the insight board; closing with the presence-gap fix.',
  },
  6: {
    label: 'Wave 6',
    tone: 'Prove it — run the cookoff ladder (smoke → pilot → flagship) and ship the coordination-traces dataset it produces; the sellable number decides how everything after is weighed.',
  },
  7: {
    label: 'Wave 7',
    tone: 'Humans as peers, re-founded — reevaluate the human role and human↔agent coordination as a whole, then build what it names (starting with the presence gap and the human-facing board).',
  },
  8: {
    label: 'Wave 8',
    tone: 'Any harness, always on — residency (resume the offline) plus the reevaluated role-template/mixed-harness layer; the top of the reachability ladder.',
  },
  later: { label: 'Later', tone: 'No near-term pull; opportunistic.' },
};

/** The launch gate that precedes all new dev — not a roadmap item (a one-shot op), but part of the sequence. */
export const SEQUENCE_GATE =
  'v0.2 is published on npm (the @musterd/* packages) — the gate that unblocked the waves below. The launch post is the only remaining launch-tail item, and it is human-authored; new dev proceeds on the sequence below.';

/** Rank an item for priority sorting within a status (unwaved items sort last, by category). */
export function waveRank(item: RoadmapItem): number {
  return item.wave === undefined ? Number.POSITIVE_INFINITY : WAVE_ORDER.indexOf(item.wave);
}

const RAW: RawItem[] = [
  // ── shipped ───────────────────────────────────────────────────────────────
  {
    id: 'driver-co-presence',
    title: 'Driver co-presence',
    shipped: { legacy: true },
    category: 'human-loop',
    blurb: 'When a human steers an agent inside its session, the roster shows the human present — not offline.',
    detail:
      'The founding dogfood wound: a human driving an agent used to read as absent. Pulled pre-launch because the headline is humans and agents as peers.',
    refs: [adr(21, 'ADR 021')],
  },
  {
    id: 'resolve-act',
    title: 'The resolve act',
    shipped: { legacy: true },
    category: 'human-loop',
    blurb: 'A terminal "done" signal for a thread. accept is not finished; resolve closes the loop.',
    detail: 'A new collaboration act and a SPEC bump — it serves both progress-awareness and the future board layer.',
    refs: [adr(25, 'ADR 025')],
  },
  {
    id: 'notify-nudge',
    title: 'Reachability nudge',
    shipped: { legacy: true },
    category: 'human-loop',
    blurb: 'musterd notify pushes a localhost OS notification so an away human learns an agent needs them.',
    detail:
      'The minimal down-payment on the notification protocol Co-Gym shows more than doubles collaboration win rate. Full notification tiers come with v0.3 governance.',
    refs: [adr(35, 'ADR 035'), adr(24, 'ADR 024')],
  },
  {
    id: 'telemetry-l1',
    title: 'Telemetry — Layer 1',
    shipped: { legacy: true },
    category: 'observability',
    blurb: 'One OTLP span per Envelope on the validate → persist → route path, plus act and team metrics. Off by default, no phone-home.',
    detail:
      'meta.otel carries W3C trace context so a handoff links the sender and receiver traces across runtimes and vendors. @musterd/mcp emits and honors it.',
    refs: [adr(15, 'ADR 015'), adr(11, 'ADR 011'), doc('docs/design/observability.md', 'observability.md')],
  },
  {
    id: 'harness-adapters',
    title: 'Harness adapters',
    shipped: { legacy: true },
    category: 'harness',
    blurb: 'Claude Code, Cursor, and Codex each get a rendered role MCP server. Codex writes a project-local .codex/config.toml.',
    detail:
      'Plus the role-template format and built-in library, musterd role, an uninstall manifest, charter injection, and musterd uninstall.',
    refs: [adr(29, 'ADRs 029–031'), doc('docs/design/provisioning-recipe.md', 'provisioning-recipe.md')],
  },
  {
    id: 'workspace-scoped-presence',
    title: 'Seat stops flapping on health-check probes',
    shipped: { legacy: true },
    category: 'platform',
    blurb: 'Agent single-active displacement is scoped by workspace: a same-seat reconnect (a reload, or Claude Code’s periodic MCP health-check spawn) no longer supersedes the live session — only a genuinely different session does.',
    detail:
      'A dogfood finding: an autojoined agent kept getting superseded “between posts”. Cause — Claude Code transiently spawns the stdio MCP server (health checks ~90s, claude mcp get), and with autojoin each spawn joined and, under newest-wins (ADR 017), displaced the real session, then disconnected. Fix: only displace connections from a different workspace; a same-workspace hello is the same seat reconnecting and is kept. Cross-workspace newest-wins (real reload / second machine) is unchanged.',
    refs: [adr(68, 'ADR 068'), adr(17, 'ADR 017'), adr(57, 'ADR 057')],
  },
  {
    id: 'agent-workspace',
    title: 'One-command agent workspaces',
    shipped: { legacy: true },
    category: 'harness',
    blurb: 'musterd agent <name> adds an agent AND gives it its own isolated git worktree, binding, and MCP registration — so two actors never fight over one folder’s seat.',
    detail:
      'Closes the identity-thrash dogfood: in Claude Code one folder = one MCP registration = one identity, so each agent needs its own workspace. The command provisions a worktree on an agent/<name> branch (sibling folder outside git), writes the binding there, and registers the server with autojoin. It also auto-issues a standing grant for the seat so the workspace occupies on launch without an admin-approval round-trip, and writes the committed launch spec (see committed-launch-spec). Re-adding a soft-removed name now revives it instead of dead-ending on a UNIQUE constraint.',
    refs: [adr(65, 'ADR 065'), adr(59, 'ADR 059')],
  },
  {
    id: 'verify-provisioning',
    title: 'Verify provisioning, don’t assume',
    shipped: { legacy: true },
    category: 'harness',
    blurb: 'The SessionStart hook checks the musterd server is actually registered before telling an agent it’s auto-joined; if not, it prints the fix instead of a false reassurance.',
    detail:
      'Closes the gap between the committed AGENTS.md primer marker (travels with the repo) and the machine-local `claude mcp add -s local` registration. `musterd init`/`agent` now auto-install the verify hook globally + self-gating (it fires only in folders carrying the `musterd:start` primer, and absorbs a hand-pasted recipe so it never double-fires). `musterd init --check` is the on-demand drift detector for the same "primer present, server unregistered" state — read-only, like the arch-tree / fmt --check guards. The "server registration is never committable" limitation this once described is now lifted by the committed launch spec (see committed-launch-spec).',
    refs: [adr(60, 'ADR 060'), doc('docs/harness-hooks.md', 'harness-hooks.md')],
  },
  {
    id: 'layered-guidance-surface',
    title: 'Layered guidance surface — primer, skill, help, hooks',
    shipped: { legacy: true },
    category: 'harness',
    blurb: 'musterd init writes an on-demand skill (seat claiming, handoff-with-branch, recovery) and slash commands alongside the primer, slimming the always-loaded primer to a loop kernel — with drift checks so the generated guidance can’t silently rot as the platform evolves.',
    detail:
      'One doctrine: each fact lives in one layer — primer = the always-loaded loop kernel, skill = on-demand playbooks, `musterd help` = flag-level reference, hooks = enforcement, MCP = capability. No fact is duplicated across layers except command/tool *names*, which is exactly what CI verifies. Templates are pure renderers in @musterd/protocol (single-sourced with the primer), stamped with a monotonic content version; init writes one canonical body into thin per-harness shells (.claude/skills/musterd/SKILL.md, .cursor/rules/musterd.mdc, and the harness-neutral .musterd/skill/SKILL.md the primer points at — covering Codex). `musterd init --check` flags a stale/edited skill (stamp version + body hash); `pnpm guidance:check` breaks the build if the skill names a command/tool that no longer exists (asserted against the CLI HELP and the live MCP tool registry); a snapshot test forces a version bump on any prose change. Uninstall removes exactly the stamped files it wrote.',
    refs: [adr(85, 'ADR 085'), doc('docs/design/agent-primer.md', 'agent-primer.md'), doc('docs/harness-hooks.md', 'harness-hooks.md')],
    dependsOn: ['verify-provisioning'],
  },
  {
    id: 'committed-launch-spec',
    title: 'Committed launch spec — a clone self-wires',
    shipped: { legacy: true },
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
    shipped: { legacy: true },
    category: 'harness',
    blurb: 'A folder claim policy and live claim bring a running pending session online — no relaunch, no wire change.',
    detail:
      'musterd claim --for <code> drops an ephemeral resolved sidecar the adapter adopts. The binding stays the durable channel; the sidecar is the live overlay.',
    refs: [adr(32, 'ADRs 032–034')],
  },
  {
    id: 'cross-network',
    title: 'Cross-network teams',
    shipped: { legacy: true },
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
    shipped: { legacy: true },
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
    shipped: { legacy: true },
    category: 'platform',
    blurb: 'musterd service runs the daemon as a background service that survives a closed terminal, restarts on crash, and starts at login — without raw launchctl.',
    detail:
      'A per-user macOS LaunchAgent today; systemd (--user) and Windows are the named seam. The CLI manages musterd’s own daemon’s lifecycle — not member agents — so the clean-core principle stays intact.',
    refs: [adr(45, 'ADR 045')],
  },
  {
    id: 'agent-reachability',
    title: 'Agent-side reachability',
    shipped: { legacy: true },
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
    shipped: { legacy: true },
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
    shipped: { legacy: true },
    category: 'harness',
    blurb: 'A teammate issues a ready seat to another agent in one command, the receiver adopts it in one command, and a claim conflict no longer dead-ends — it names the runnable next command.',
    detail:
      'Elevated after a 2026-06-25 dogfood disaster: a fresh agent handed a pre-created named seat could not claim it (team add mints a join --token; claim <name> refused it; join/reclaim fought a shared cached identity), burned its whole session on acquisition, and escalated to hand-editing the live SQLite DB. The fix shipped: claim <name> --token adopts a teammate-created seat into the folder binding with no global-identity clobber; claim --for <code> binds a pending session; the claim conflict path names the next command instead of dead-ending; per-folder binding is the identity channel; and team add + the primer teach seat acquisition. Validated by a follow-up onboarding run (a fresh agent adopted its seat end-to-end, no DB surgery). The multi-identity vault (ADR 059) hardened it further — a second agent on the same machine can no longer clobber the first’s cached token.',
    refs: [adr(55, 'ADR 055'), adr(59, 'ADR 059'), adr(32, 'ADRs 032–034'), adr(36, 'ADR 036')],
  },
  {
    id: 'agent-presence-touch',
    title: 'Ambient agent presence',
    shipped: { legacy: true },
    category: 'human-loop',
    blurb: 'An agent doing bursty one-shot CLI work shows present on the roster instead of offline — liveness from real actions, not just a resident watch socket.',
    detail:
      'Presence used to need a resident WS session; a sequence of one-shots read as offline. Now a short-TTL ambient presence touch on each authenticated command keeps a bursty agent present for the timeout window — while working: <x> still comes solely from a self-reported status_update (the two-clocks rule). No-ops under a resident session, upserts one row per member, and never displaces — so it composes with newest-session-wins and human fan-out. Unblocked the wake-on-message and blocked-agent work, which assume the roster reflects who is actually doing things.',
    refs: [adr(57, 'ADR 057'), adr(10, 'ADR 010'), adr(17, 'ADR 017')],
  },
  {
    id: 'durable-roster',
    title: 'Durable seat roster on git',
    shipped: { legacy: true },
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
    shipped: { legacy: true },
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
    shipped: { legacy: true },
    category: 'observability',
    blurb: 'Every agent-facing feature ships with its traces and an eval, the way it ships with tests — an ADR-template section and a format:check guard enforce it. Cheap and compounding, so later features inherit it.',
    detail:
      'The cheap, compounding half of the trace → eval → experiment flywheel: an "Observability & Evaluation" section in the ADR template (traces, eval metric + dataset + baseline, experiment) plus an obs-evals:check step in format:check, modeled on the arch-tree checker (presence and shape, not content). ADRs from 060 on must carry the section (earlier ones grandfathered); features built through later waves now carry telemetry by default and batond never retrofits.',
    refs: [adr(52, 'ADR 052'), adr(51, 'ADR 051'), doc('docs/design/observability.md', 'observability.md')],
  },
  {
    id: 'inbox-reaches-blocked-agent',
    title: 'Inbox reaches a blocked agent',
    shipped: { legacy: true },
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
    shipped: { legacy: true },
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
    shipped: { legacy: true },
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
    shipped: { legacy: true },
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
    shipped: { legacy: true },
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
    shipped: { legacy: true },
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
    shipped: { legacy: true },
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
    plan: 'reserved',
    category: 'transport',
    blurb: 'Plug the agent key + grant + human credential into the already-built secured off-loopback bind, so a teammate on another machine joins over wss with a real credential, not a locally-minted token.',
    detail:
      'The credential layer ADR 039/040 named but did not build. The secured transport (TLS/wss refuse-plaintext bind, Origin/Host gate) is done and waiting; P4 is mostly integration — the cross-network claim flow over that channel + docs. Now unblocked: P3’s agent-key + grant + human-credential model shipped (2026-06-30), so P4 is the remaining cross-network claim flow over the secured channel. Deferred at the 2026-07-01 reprioritization: the wedge is local coordination + human partnership and there is no near-term pull for cross-network, so remote join waits behind the telemetry + lanes work. Cross-org reach also wants a bilateral cross-boundary *consent* flow (who may add whom across an org line): band.ai has productized exactly this as "contacts" (request → approval → mutual access) — a reference design worth borrowing when this lands (landscape.md §5).',
    refs: [adr(69, 'ADR 069'), adr(39, 'ADR 039'), adr(40, 'ADR 040'), doc('docs/design/landscape.md', 'landscape.md')],
    dependsOn: ['v03-p3-credentials', 'cross-network'],
  },
  {
    id: 'notification-tiers',
    title: 'Notification tiers',
    shipped: { legacy: true },
    category: 'human-loop',
    blurb: 'The full reachability set: route an agent’s request for help to a human by salience and availability, not only when they are watching.',
    detail:
      'Co-Gym’s ablation: removing the notification protocol more than halves the collaboration win rate (30% → 70%). This is where the measured value is. The localhost availability + urgent down-payment shipped, then the governed superset (can_flag_urgent gating, audit, wasnt_urgent feedback) shipped inside v0.3 P2 enforcement (ADR 071). Only off_hours/schedule enforcement remains, tracked separately (Wave 3).',
    refs: [adr(71, 'ADR 071'), doc('docs/design/research-foundation.md', 'research-foundation.md')],
    dependsOn: ['notify-nudge', 'availability-urgent', 'v03-p2-enforcement'],
  },
  {
    id: 'coordination-lanes',
    title: 'Coordination lanes (Phase 1) — own the work, never dup a diff',
    shipped: { legacy: true },
    category: 'platform',
    blurb:
      'A first-class lane = { work-item × owner × surface } so musterd advises before two agents (or humans) redo the same work — the anti-swarm primitive.',
    detail:
      'From the P3 dogfood post-mortem: coordination messages cost ~1% of tokens, but ~37% of the code produced never reached main (53% of that a single dependency-revert). Phase 1 (ADR 083) shipped the intent + dependency layer — git-optional, warn-only: the lanes table (migration v11), the two contention checks (unmet-dependency + surface-overlap, scoped per project), warning delivery inline to the actor + one directed wake to the affected owner (meta.lane_warning — no new act, no SPEC bump), handoff that carries the branch instead of a prose description (the redone-lane fix), lane_* MCP tools + musterd lane/lanes CLI, and a primer habit. Sequenced after telemetry-gaps at the 2026-07-01 reprioritization so its wasted-work win is measurable; live-verified on bravo (the dependency-revert replay caught both warnings). Phase 2 (deferred): observed surface (fs/git-diff), the symbol-level merge-funnel, lane_ack, role-pool assignment, auto-done on branch-merge.',
    refs: [
      adr(83, 'ADR 083'),
      doc('docs/design/lane-phase1-mvp-spec.md', 'Phase-1 MVP spec'),
      doc('docs/design/lanes-and-the-multi-agent-tax.md', 'lanes / multi-agent-tax'),
    ],
    dependsOn: ['v03-p1-seats'],
  },
  {
    id: 'telemetry-gaps',
    title: 'Close the dogfood telemetry gaps (instrument-by-default)',
    shipped: { legacy: true },
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
    id: 'eval-experiment-engine',
    wave: 'later',
    title: 'Eval & experiment engine (batond)',
    plan: 'reserved',
    category: 'observability',
    blurb: 'The batond half of the flywheel: team-outcome evals and side-by-side experiments over model × prompt × harness × team topology — built on a bought, Langfuse-shaped backend, never a from-scratch store.',
    detail:
      'Emit in musterd, engine in batond (ADR 051). OTel wire + Langfuse semantics for scores/datasets/experiments, plus the coordination-native additions no single-agent vendor can do: evals scored against a Goal’s definition-of-done (ADR 048/050), experiments that vary the team itself, judge calibration as meta-evals, and the harness-decay measurement that says when to delete complexity models have absorbed.',
    refs: [adr(51, 'ADR 051'), doc('docs/design/observability.md', 'observability.md')],
    dependsOn: ['telemetry-l2', 'insight-engine'],
  },
  {
    id: 'research-intake',
    wave: 'later',
    title: 'Research radar (ingest)',
    plan: 'reserved',
    category: 'observability',
    blurb: 'A standing scan/triage of new multi-agent-coordination research, funneled into research-foundation.md — findings that change a decision graduate to an ADR.',
    detail:
      'The ingest half of the research practice (ADR 056): keep musterd shaped by the field. A recurring agent emits a triaged digest of arXiv / HF Papers / venue work; a human decides what graduates to an ADR + roadmap item. No auto-merge of findings into the thesis.',
    refs: [adr(56, 'ADR 056'), doc('docs/design/research-foundation.md', 'research-foundation.md')],
  },
  {
    id: 'schedule-enforcement',
    wave: 'later',
    title: 'Schedule & lifecycle enforcement',
    plan: 'reserved',
    category: 'platform',
    blurb: 'availability and lifecycle: until are stored today but not enforced. Later: honor windows for routing and auto-expire members.',
    detail:
      'The one governance-completion piece that did not ship with the Wave 2 rock (v0.3 P2): availability windows and lifecycle: until are stored but not yet enforced for routing/expiry. Moved out of the now-complete Wave 2 to later — a follow-on to the shipped P2 enforcement with no near-term pull.',
    dependsOn: ['v03-p2-enforcement'],
  },
  {
    id: 'step-streaming',
    wave: 'later',
    title: 'Step-level streaming transport',
    plan: 'reserved',
    category: 'transport',
    blurb: 'v0.1 sends whole Envelopes. A v2 transport adds step-level streaming, which beats wait-for-complete for collaborating agents.',
    detail: 'The broadcast recipient kind is already distinct on the wire to anticipate richer delivery semantics.',
  },
  {
    id: 'federation',
    wave: 'later',
    title: 'Team-to-team federation',
    plan: 'reserved',
    category: 'transport',
    blurb: 'A Member belongs to one Team today. Teams that address one another, and identities recognized across Teams, come later.',
    dependsOn: ['cross-network'],
  },
  {
    id: 'web-dashboard',
    wave: 3,
    title: 'Web dashboard — live team console',
    shipped: { legacy: true },
    category: 'surfaces',
    blurb: 'A browser console for the team: the firehose observer stream, the live roster, and the governance/approval web views — a read-only window onto the same Members.',
    detail:
      'Built: the team firehose (ADR 061, subscribe scope team-all + GET /teams/:slug/messages), the daemon static-serve (ADR 062), the read-only observer seat (ADR 063/064), the approval card (ADR 072), and the governance web views (ADR 073) all landed; the /live dashboard has had polish passes and the office render on top. The web observer connects via the v0.3 P3.2 claim handshake (ADR 077) and the shared read-only watch link (ADR 063) shipped — the console works end-to-end against a live P3 daemon. Marked shipped at the 2026-07-10 reprioritization: the console does its job today; the once-vague "general hardening" remainder is now tracked concretely elsewhere — observer scoping under shared/remote-team security hardening, and the board/insight rail under the web insight layer. The Surface enum already includes web/ios/slack — same Member, more Presences.',
    refs: [adr(61, 'ADR 061'), adr(63, 'ADR 063'), adr(72, 'ADR 072'), adr(73, 'ADR 073'), adr(77, 'ADR 077')],
  },
  {
    id: 'live-office',
    title: 'Live isometric office',
    shipped: { legacy: true },
    category: 'surfaces',
    blurb: 'Replace the /live constellation with a 2D isometric animated co-work office — presence→placement, act→choreography, travel-intensity == notification tier.',
    detail:
      'A living, human-vs-agent-neutral office view of the team (ADR 079). ADR 079 shipped M1–M3: M1 (code-drawn isometric floor + act cues + panel modes), M2 (per-member characters plus acts as walking choreography — walk-over, carry-box handoff, megaphone broadcast), M3 (presence changes walk in/out, door-open staging, urgent walks at faster cadence, reduced-motion parity). Then ADR 086 (ambient office life) added the calm-at-rest layer: Phase 1 GPU-composited ambient overlay + afterglow (idle-park invariant intact, rAF 0/sec at rest), Phase 2 idle micro-choreography (coffee strolls + idle-FPS cap + real-act preemption), Phase 3 render optimisation, and the ambient in-place gesture poses. ADR 133 then replaced the Rive rig — which was flat and ungrouped, so members glided with unmoving limbs and never actually sat down — with a procedural jointed skeleton (office-scene/skeleton.ts): a distance-driven walk cycle with IK legs and counter-swinging arms, a real seated pose with the hands typing on the desk, eased sit/stride blends, and a desk/chair geometry fix so a seated member is visible from the chest up instead of buried to the neck. The skeleton emits joint transforms, so a future 3D renderer can bind the same curves to a glTF rig. Remaining: overflow/nook polish and perf passes. Shares the firehose/observer substrate with the web dashboard. The office/stream act vocabulary has since grown to cover the full act set: lane lifecycle events render as a distinct work-moving class (ADR 102), the steering acts get their own choreography (ADR 107 — steer sweep + redirect, challenge question, defer board pulse), and a reclaimable seat shows a "reconnecting" hint on the roster (ADR 105). The act→tone/label/glyph/choreography/sound seam is documented in docs/architecture/08-web.md.',
    refs: [adr(79, 'ADR 079'), adr(86, 'ADR 086'), adr(102, 'ADR 102'), adr(107, 'ADR 107'), adr(133, 'ADR 133'), doc('docs/architecture/08-web.md', '08-web.md')],
    dependsOn: ['web-dashboard'],
  },
  {
    id: 'more-surfaces',
    wave: 'later',
    title: 'Slack surface (iOS deferred)',
    plan: 'reserved',
    category: 'surfaces',
    blurb: 'A Slack surface, so a Member is reachable where its human already lives; a native iOS app is explicitly deferred behind it.',
    detail:
      'Re-scoped at the 2026-07-10 reprioritization: no evidence pull for iOS anywhere in the record, while Slack is where the reachability loop (notify → availability → urgent) most plausibly meets a human day-to-day. Slack-first when a surface wave opens; iOS only on real demand.',
    dependsOn: ['web-dashboard'],
  },
  {
    id: 'orientation-spine',
    title: 'Plan/Goal model + `musterd next`/`done`',
    shipped: { legacy: true },
    category: 'insights',
    blurb: 'The orientation + handoff spine that kills the copy-paste toil: a declared Plan→Goal skeleton — the backlog noun — with derived status, and one-command next/done.',
    detail:
      'From planning-and-insights-brainstorm.md (ADRs 048/049 as amended by ADR 084). Shipped in two increments: the goal_id lane join + deriveGoalStatus + `musterd next`/`done` + team_next (PR #79), then the declared-Goal seam — `musterd goal declare/list` + next_goal (PR #81). The declared skeleton (Goal existence, intent, wave, dependsOn) owns the backlog noun; below a Goal the work items are lanes (ownership/contention, joined by an optional goal_id on the lane) and threads (the conversational fabric + zero-compliance fallback). Goal status is *derived* — lanes-first, threads-fallback — never stored; handoff carries a goal_id; SessionStart auto-injects orientation. The toil-killing spine the brainstorm sequenced first; the insight engine projects over it.',
    refs: [adr(48, 'ADR 048'), adr(49, 'ADR 049'), adr(84, 'ADR 084'), doc('docs/design/planning-and-insights-brainstorm.md', 'planning & insights')],
  },
  {
    id: 'insight-engine',
    title: 'Insight engine — server-side projections',
    shipped: { legacy: true },
    category: 'insights',
    blurb: 'One projection engine in the daemon — Goal status, the board view, flow metrics, waiting-on — computed over Goals × lanes × threads, never stored, exposed as an HTTP API.',
    detail:
      'The single engine every insight surface renders (ADR 050 as amended by ADR 084), shipped as the report engine — flow metrics + waiting-on + GET /report (PR #82), then the coordination-density warning (PR #84): derived Goal status (lanes-first, threads-fallback), the board projection (the IC altitude — every work item, its latest-state column), flow metrics from lane timestamps (cycle time, WIP, age, throughput), the waiting-on view (openActionNeeded aggregated by recipient), and the broadcast-journal versus directed/threaded-exchange signal. Distinct from the shipped lanes contention board (ADR 083), which warns about overlap/dependency — this layer derives meaning from the same substrate. Goodhart guard: outcomes and queues, never message volume; v0.3 need-to-know governs derived human metrics.',
    refs: [adr(50, 'ADR 050'), adr(84, 'ADR 084'), doc('docs/design/human-agent-dynamics.md', 'human-agent-dynamics.md')],
    dependsOn: ['orientation-spine', 'resolve-act', 'coordination-lanes'],
  },
  {
    id: 'insight-cli-mcp',
    title: 'Reporting altitudes + waiting-on view (CLI + MCP)',
    shipped: { legacy: true },
    category: 'insights',
    blurb: '`musterd report` at IC/team/exec altitudes and the "N threads waiting on <human>" bottleneck view — the first surfaces of the insight engine, with MCP parity.',
    detail:
      'From planning-and-insights-brainstorm.md Parts 4–6 (ADR 050 as amended by ADR 084): the CLI report with altitude flags (ic|team|exec) and the waiting-on-human view (oldest-first), plus the matching team_* MCP tools — agents use one channel only, so a CLI-only report would be invisible to MCP-wired teammates. Thin renderers over the insight engine, which owns the metric definitions; cost-per-shipped-work-item stays deferred to the batond cost-ingestion seam.',
    refs: [adr(50, 'ADR 050'), adr(84, 'ADR 084'), doc('docs/design/planning-and-insights-brainstorm.md', 'planning & insights')],
    dependsOn: ['insight-engine'],
  },
  {
    id: 'coordination-density',
    title: 'Coordination-density insight',
    shipped: { prs: [84] },
    category: 'insights',
    blurb: 'An insight that flags when a team’s traffic is all broadcast-journal and no directed or threaded exchange — coordination that only looks collaborative.',
    detail:
      'Shipped in PR #84 under ADR 050: the report engine computes a seven-day broadcast-status-update share versus directed/threaded-exchange ratio from the act-typed log and warns only when a non-trivial sample is journal-heavy. `musterd report` and `team_report` surface the diagnostic; it is a candidate metric for the standalone coordination-observability product.',
    refs: [adr(50, 'ADR 050'), doc('docs/design/human-agent-dynamics.md', 'human-agent-dynamics.md')],
    frozenBy: 50,
    dependsOn: ['insight-engine'],
  },

  // ── Wave 4 — the steerable team: mid-loop reachability (2026-07-03 brainstorm) ──
  // The reachability ladder (046 heads-down / 053 blocked / 054 idle) has one rung left: a loop
  // busy on its own work. ADR 088 + the agent-ontology + interrupt-line design docs freeze the arc.
  // Increments 1–3 SHIPPED: the interrupt line (ADR 088, 2026-07-05), steer/challenge/defer acts
  // (ADR 103, 2026-07-06), and plan epochs + stale-plan detection (ADR 111, 2026-07-08). The last
  // Interrupt-line arc (design §8): increments 1–4 all shipped (088 → 103 → 111 → 125).
  {
    id: 'interrupt-line',
    title: 'The interrupt line — reach a busy agent mid-loop',
    shipped: { prs: [109] },
    frozenBy: 88,
    category: 'human-loop',
    blurb:
      'A directed steer reaches an agent busy mid-task at its next tool-call boundary — the missing reachability rung for a loop that is neither idle nor blocked, but heads-down on its own work.',
    detail:
      'The frontier the Qoder demo failure named and our own P3 dogfood measured (~37% wasted work, the largest item a steer that arrived too late). ADR 088 increment 1 SHIPPED 2026-07-05 (PR #109): `musterd inbox --interrupt-check` — a one-shot, local, sub-50ms query that exits silent when nothing waits and prints one daemon-composed line when an interrupt-class directed act does, provisioned by `musterd init` as a PostToolUse hook (verified by `init --check`, degrading to the ADR 046 per-command nudge where hooks are thin). The daemon owns the predicate (a short-lived CLI can\'t flush telemetry, and the composed line is a security requirement): `pendingInterrupts` in the server store gates on action-needed + urgent tier + unresolved thread, a new `GET /inbox/interrupt-check` route composes the line from structured fields, and a `musterd.interrupt.check` counter + `interrupt.raised` audit verb (DB-deduped per recipient+act) make every raised line auditable. Interrupt-class is scarce by construction (urgent tier gated by can_flag_urgent, ADR 044/071). Injection-surface mitigations shipped as launch requirements: the line is daemon-composed (never the raw body), sender always shown, capability-gated. Its headline eval is *steering latency* (steer sent → recipient acknowledges) — the number the launch demo (hook on vs off) is built around. Increments 2–3 (steer/challenge acts, plan epochs) carry the arc forward as their own items. Resident harnesses (OpenClaw/Hermes) need the same policy at their gateway; the ladder is indexed by harness residency class (agent-ontology.md §4).',
    refs: [
      adr(88, 'ADR 088'),
      doc('docs/design/interrupt-line-mid-loop-reachability.md', 'interrupt line'),
      doc('docs/design/agent-ontology.md', 'agent-ontology.md'),
    ],
    dependsOn: ['agent-reachability', 'wake-on-message'],
  },
  {
    id: 'steer-challenge-acts',
    wave: 4,
    title: 'Steer & challenge acts (+ plan-mutation verbs)',
    shipped: { prs: [138, 143, 158] },
    frozenBy: 103,
    category: 'human-loop',
    blurb:
      'Give steering first-class semantics: a directive `steer` that supersedes prior direction, an epistemic `challenge` that forces revalidation, and a `defer` verb that reorders/defers a Goal on the plan.',
    detail:
      'Increment 2 of the interrupt-line arc (design §4.2–4.3) — SHIPPED 2026-07-06 (ADR 103). A change of direction was free-text `message`; this appends three acts to the protocol vocabulary and rides the increment-1 interrupt line for delivery, with **no new delivery machinery** (three additive enum entries, no wire-version bump). **`steer`** (directive) is interrupt-class by definition — it raises the ⚡ line whether or not it is flagged urgent — and the newest steer **supersedes** prior direction (ADR 017 newest-wins applied to *direction*, as a pure read-side collapse inside `pendingInterrupts`) so a late-waking agent sees one current direction, never a contradictory stack. **`challenge`** (epistemic: "justify this assumption or reconsider it") is warn-never-block — tier-configurable, interrupting only when its sender flags it — and is answered with evidence: an `accept` now auto-targets an open challenge. **`defer`** is the plan-mutation act (the design\'s reorder/defer): it names `meta.goal_id` and an optional `meta.wave` target (a number reorders, "later" defers), mirroring the Goal `wave` field `nextGoal` reads — the verb ships here; automatic re-sequencing + goal epochs are increment 3. The interrupt-check line and audit now name the raise class (`steer` vs `urgent`), and the MCP `team_send` enum is derived from `ACTS` so the surface can never drift from the protocol again. Headline eval unchanged: *steering latency* on the first-class `steer`, plus a supersession-correctness check (zero acts taken against a superseded steer). The `/live` web render followed (ADR 107, PR #158): the office and stream now key on the three acts distinctly — `steer` as interrupt-class (a room-wide sweep + an urgent redirect run to the target), `challenge` as a "justify?" question cue, `defer` as a lane-family board pulse — with their own tones, badge glyphs, and opt-in sound cues; verified end-to-end against a live daemon.',
    refs: [adr(103, 'ADR 103'), adr(107, 'ADR 107'), adr(88, 'ADR 088'), adr(17, 'ADR 017'), doc('docs/design/interrupt-line-mid-loop-reachability.md', 'interrupt line')],
    dependsOn: ['interrupt-line', 'orientation-spine'],
  },
  {
    id: 'stale-plan-detection',
    wave: 4,
    title: 'Plan epochs & dependency-targeted invalidation',
    shipped: { prs: [169, 171] },
    frozenBy: 111,
    category: 'insights',
    blurb:
      'Catch stale work even when an interrupt misses: a goal carries a plan epoch, `defer` re-sequences it and bumps it, and only the lanes actually building against the moved plan get a targeted warning.',
    detail:
      'Increment 3 of the arc (design §5) — SHIPPED 2026-07-08 (ADR 111), the semantic backstop for the deaf window the interrupt line cannot close (mid-generation, long single commands, approval-parked). It also gives `defer` the teeth ADR 103 withheld ("a signal, not yet an actuator"). Everything is **derived, nothing stored** — faithful to the ADR 048 maxim and the mirror of steer-supersession\'s read-side collapse: no migration, no wire-version bump. **Plan epochs** = bounded staleness from async distributed training (workers on stale weights ≙ agents on superseded plans): a Goal\'s epoch is the count of direction-changing acts naming it (every `defer`, plus a `steer` carrying `meta.goal_id`), projected out of the log beside the Goal\'s derived status. **`defer` actuates** by folding into that derivation — the newest wave assertion (declaration or `defer`) wins, so `nextGoal` actually re-sequences. **Targeted invalidation** = directory-based cache coherence (not broadcast/snooping): two owner-directed, warn-never-block lane signals — `stale_plan` (a lane whose own Goal moved epoch since it was claimed) and `stale_dependency` (a lane building on another whose Goal moved) — routed by the goal_id join + depends_on edges to exactly the affected owners, pushed on the defer/steer send path and annotated live on the board. The P3 dependency-revert (53% of that session\'s waste) is exactly the miss this closes. Watcher-not-gatekeeper.',
    refs: [adr(111, 'ADR 111'), adr(103, 'ADR 103'), adr(88, 'ADR 088'), adr(84, 'ADR 084'), adr(83, 'ADR 083')],
    dependsOn: ['interrupt-line', 'orientation-spine', 'coordination-lanes'],
  },
  {
    id: 'steering-latency-metric',
    wave: 4,
    title: 'Steering-latency & stale-work-caught metrics',
    shipped: { prs: [216, 218] },
    frozenBy: 125,
    category: 'insights',
    blurb:
      'The number the launch demo is built around: measure how fast steering reaches a busy agent, and how much stale work the anti-staleness layer actually catches.',
    detail:
      'Increment 4 — the last rung of the interrupt-line arc (design §8 item 4) — SHIPPED 2026-07-10 (ADR 125, PRs #216/#218): the measurement layer that turns the whole arc from a claim into a before/after against the P3 37%-waste baseline. Three numbers derived purely from the message + lane log (no new capture, on the report engine): **steering latency** (a `steer` sent → the recipient\'s next act acknowledging it), **supersession-correctness** (acts taken against a *superseded* steer — should be zero, ADR 103; same-ts tie-break via message id matching `pendingInterrupts`), and **stale-work-caught** (the `stale_plan`/`stale_dependency` wakes that precede a lane owner changing course, ADR 111). Surfaced via `musterd report` + `team_report`, and doubling as the launch-demo A/B instrument (hook-on vs hook-off, ADR 056 benchmark scenario).',
    refs: [adr(125, 'ADR 125'), adr(88, 'ADR 088'), adr(103, 'ADR 103'), adr(111, 'ADR 111'), adr(50, 'ADR 050'), doc('docs/design/interrupt-line-mid-loop-reachability.md', 'interrupt line')],
    dependsOn: ['stale-plan-detection', 'insight-engine'],
  },
  {
    id: 'record-honesty',
    title: 'Keep the declared record honest — truth check + the steward seat',
    shipped: { prs: [174, 175, 176] },
    frozenBy: 112,
    category: 'insights',
    blurb:
      'The roadmap can’t silently lie: its shipped-status is derived from a verifiable anchor and checked against git + ADR statuses, and a standing steward seat hunts the drift a static check can’t see.',
    detail:
      'Grew out of a live gap — `roadmap:check` only proved ROADMAP.md matched its source, not that the source was true, so a shipped item sat mismarked. Two halves. **Static (PR #174):** the roadmap now dogfoods its own ADR 084 pattern — `status` is *derived* from a `shipped: { prs }` anchor, and `roadmap-truth:check` verifies every shipped item against a merged-PR commit and its freezing ADR’s own Status line, so the data can’t overclaim or drift from its ADR. **Agentic (ADR 112):** a standing **steward seat** — a teammate, not a cron — runs a deterministic drift scan weekly for the discovery a linter is blind to (unmarked features, stale prose, shipped-but-unmarked items). With no secrets it posts one self-updating tracking issue; with the model + PAT secrets a CI-launched Claude Code CLI session drafts each fix and opens a **draft PR**, gated by `roadmap-truth:check` as the seatbelt — validated end-to-end (the steward opened PR #184 correcting a planted fixture, checks green). Per-task autonomy (`propose` vs `auto-merge`) is a reusable knob. This very item was declared *because the steward flagged its own runtime as undeclared work* — the loop closing on itself. Ahead: `auto-merge` tasks (once a statically-guarded mechanical fix exists) and the reachability chase via daemon residency.',
    refs: [adr(112, 'ADR 112'), adr(84, 'ADR 084'), adr(111, 'ADR 111')],
    dependsOn: ['insight-engine'],
  },
  {
    id: 'harness-residency',
    wave: 8,
    title: 'musterd gives any harness residency (resume the offline)',
    plan: 'near-term',
    category: 'harness',
    blurb:
      'The offline rung: a seat binding holds the harness session id, so the daemon can resurrect an exited session on a directed act — turning a turn-scoped harness into an always-on one.',
    detail:
      'From agent-ontology.md §4 (residency classes). Turn-scoped harnesses (Claude Code, Cursor) die between turns; the strategic claim is that musterd, holding the session id, can resurrect them on a directed act (`claude --resume <id> -p …`). Nobody has built the multi-agent, multi-human, one-team residency layer — the always-on gateways (OpenClaw, Hermes) are single-agent, single-human. **Increments 1–5 landed**: the frozen contract (#236, ADR 131); the wake ledger (#240 — stored leases, derived rate policy); `musterd host` + the claude fresh-first backend (#244 — first measured wake: roster occupancy in 22.4s, answered +46s); session capture + the local-session guard (#255/#257 — resume wake 4.1s); and increment 5 whole (#269/#271 + the service/steward PR): policy knobs (team defaults ⊕ per-seat overrides), the ping-pong demotion implemented (send-time provenance, v21), provenance newest-wins, wake latency/answer-rate/cost in the report engine (`musterd report residency`), the resumable roster badge, the wake actuator as a LaunchAgent (`service --wake`), and the pre-registered steward cron→wake experiment wired (run owner-gated). Remaining: increment 6 — the native backend (owner-gated), musterd\'s own agent loop as the contract\'s reference row.',
    refs: [adr(131, 'ADR 131'), doc('docs/design/harness-residency.md', 'residency contract'), doc('docs/design/agent-ontology.md', 'agent-ontology.md'), doc('docs/design/interrupt-line-mid-loop-reachability.md', 'interrupt line')],
    dependsOn: ['wake-on-message'],
  },

  // ── Wave 5 — depth (priority order set 2026-07-04) ──
  // Interrupt line inc1 (Wave 4) shipped; steer/challenge acts lead Wave 4. This is the ordered batch
  // after it. Telemetry L2 leads because
  // L1 is verified emitting (finding 002) — the data is already useful, L2 makes it first-class.
  {
    id: 'telemetry-l2',
    wave: 5,
    title: 'Telemetry — Layer 2 + SDK',
    shipped: { legacy: true },
    category: 'observability',
    blurb: 'A full CLI/MCP telemetry SDK, then MAST-aware views over the act-typed log that agent-observability tools cannot see.',
    detail:
      'The seed of a standalone coordination-observability product, and the head of the depth wave. Pulled up 2026-07-04: Layer 1 is verified emitting live (finding 002 mined ~53 h from the local sink and caught the broadcast-journal anti-pattern by hand) — so the data is already useful; L2 is what turns "grep a text log" into first-class MAST-aware views (ignored request_help, circular handoffs, stalled threads, broadcast-only journaling) + the report surfaces. Frozen as a three-increment arc (ADR 089). Increment 1 SHIPPED 2026-07-05: the shared @musterd/telemetry bootstrap boots in the MCP adapter (a musterd.tool.call span around every tool) and the CLI (musterd.cli.command; serve + interrupt-check carved out), so the ADR 011 meta.otel plumbing fires in production and a handoff is one cross-agent distributed trace — identity attribution fixed first (issue #107: normalized seat id as the key, raw name a label). Increment 2 SHIPPED 2026-07-06 (ADR 090): per-recipient delivery status derived from the log + cursors + audit — never a delivery table (logged / seen / answered per recipient, attempt history as telemetry span events, the seen_latency metric completing the ADR 088 raised→read pair, and the open directed ledger on report / team_report / musterd report delivery) — the band.ai borrow (landscape.md §5) recast for seats; countOpenLoops gained resolve-exclusion so gauge and ledger reconcile. Increment 3 SHIPPED 2026-07-06 (ADR 091): the MAST-aware views — time-to-unblock, ignored request_help (the inc2 ledger filtered), stalled threads, circular handoffs — derived on the ADR 050 projection seam and served as report.mast + musterd report coordination + a health block on team_report; the finding-002 grep session is now one command. Arc complete.',
    refs: [
      adr(89, 'ADR 089'),
      doc('docs/design/observability.md', 'observability.md'),
      doc('docs/research/002-telemetry-caught-broadcast-journal.md', 'finding 002'),
      doc('docs/design/landscape.md', 'landscape.md'),
    ],
    dependsOn: ['telemetry-l1'],
  },
  {
    id: 'seat-memory',
    wave: 5,
    title: 'Persistent seat memory',
    shipped: { legacy: true },
    category: 'platform',
    blurb: 'A persistent identity wants persistent memory — the seat carries a continuity note across the session gap, headline-first.',
    detail:
      'The membership-model reserved seam, designed (ADR 093, 2026-07-06) and SHIPPED the same day (PRs #129/#130). The v1 job is **cross-session continuity only**: one small occupant-written note per seat (headline ≤120 chars + body ≤8KB, last-write-wins, `saved_at` stamped, no server expiry), saved explicitly at natural boundaries — before a handoff, at wrap-up, when told to wind down. Delivery is **envelope-on-occupy / body-on-demand**: `OccupiedFrame.memory` un-stubbed into `{ headline, saved_at, size_bytes }` (SPEC A.3 minor), the join/claim result renders one ~30-token pointer line, and the body travels only over an explicit read. Daemon-private `seat_memory` table, seat-scoped with **no cross-seat read path** (team admins included — deliberately narrowing ADR 071); banned = inert applies; audit records sizes only, never content. Surfaces: `team_memory_save`/`team_memory_read` + the `team_join` one-liner (MCP), `musterd memory save|show|clear` + the claim/status pointer (CLI), and the skill\'s save-before-handoff playbook (guidance v2). Memory belongs to the seat, not the occupant — a successor inherits the note (agent=seat). Named follow-up seam: harness-hook auto-save (SessionEnd/PreCompact) if dogfood shows agents forget to save; eval = read-after-occupy rate.',
    refs: [adr(93, 'ADR 093'), doc('docs/design/membership-model.md', 'membership-model.md'), doc('docs/design/agent-ontology.md', 'agent-ontology.md')],
    dependsOn: ['durable-roster'],
  },
  {
    id: 'model-experimentation',
    wave: 5,
    title: 'Model experimentation — frontier cadence + own models',
    shipped: { legacy: true },
    category: 'observability',
    blurb: 'Treat the model itself as a first-class experimental variable: be early to each frontier model, and own models end-to-end.',
    detail:
      'From model-experimentation.md; design frozen 2026-07-06 in the "model as a variable" session with model-diversity (ADR 101 — the two share one kernel: `model` as a first-class attribute musterd captures). ADR 101 increment 1 SHIPPED 2026-07-07 (PR #144): the foundation Track A rides — per-occupancy harness-attested model (re-attestable via claim + heartbeat, `unknown` legal, never blocks — the durable seat stays model-agnostic per ADR 087; carried across the grant-less approval gap on the request), the per-act model stamp as the dataset (server-controlled + un-spoofable — `meta.model` stamped from the sender\'s attested occupancy, `musterd.model`/`musterd.model.family` on the envelope span), and the issue #107 stable-seat-id fix closed on the same seam. Track A (bleeding edge) is now a live process, not a platform: run the reproducible coordination experiment manifest (docs/research/frontier-cadence-manifest.md) as each new frontier model lands, diffing the emitted coordination metrics (loop_latency, dup-rate, wasted-work) vs the prior baseline → a per-model coordination leaderboard that accretes from research findings. Track B (own models) stays the reserved research tail in the separate lab repo: the tiny-model dogfood fixture (Stage 1 local instruct agent probing the guardrail floor → Stage 2 train-from-scratch with MLX), culminating in a fine-tuned coordination-judge model over the traces dataset.',
    refs: [adr(101, 'ADR 101'), doc('docs/design/model-experimentation.md', 'model-experimentation'), adr(51, 'ADR 051'), adr(56, 'ADR 056')],
    dependsOn: ['telemetry-l2'],
  },
  {
    id: 'model-diversity',
    wave: 5,
    title: 'Model diversity as a team-composition feature',
    shipped: { legacy: true },
    category: 'observability',
    blurb:
      'Same-model agents agree in correlated ways, so their consensus is weak evidence. Record the model per occupancy and flag same-family review/approval chains — making model diversity a first-class team property.',
    detail:
      'From agent-ontology.md §5 (the monoculture problem); design frozen 2026-07-06 in the "model as a variable" session (ADR 101). SHIPPED 2026-07-07 (PR #144, ADR 101 increment 1): musterd is the model-agnostic layer, so heterogeneity is ours to make first-class — the model attaches per-occupancy (harness-attested — attested, never verified; `unknown` legal and honestly poisons conclusions as "unverifiable", never "diverse"), and the insight/report layer flags a review/approval/challenge chain (request_help/handoff/challenge answered by accept/decline from a different seat) that was single-model-FAMILY end-to-end ("treat agreement as weak evidence") — family (`claude-*` vs `gpt-*`) is the decorrelation boundary, review/approval scope keeps the flag scarce, warn-never-block keeps it a watcher. Surfaced in `musterd report coordination`, the `team_report` MAST health block, and `report.mast.diversity`; measured by the `musterd.insight.diversity_flags` observable gauge (derived state, not a counter). Still feeds the research track (ADR 056): agreement correlation between same-family vs cross-family reviewer pairs on real coordination traces is the evidence that upgrades or confirms the family boundary.',
    refs: [adr(101, 'ADR 101'), doc('docs/design/agent-ontology.md', 'agent-ontology.md'), adr(56, 'ADR 056'), doc('docs/design/model-experimentation.md', 'model-experimentation')],
    dependsOn: ['model-experimentation'],
  },
  {
    id: 'cookoff-value-experiment',
    wave: 6,
    title: 'cookoff — the controlled experiment that proves musterd’s value',
    plan: 'near-term',
    category: 'observability',
    blurb:
      'The commercial crux: a sellable, defensible number for coordinated-vs-siloed agents on the same task — one reusable instrument (the cookoff scenario) that also answers the model and harness questions by varying a different term.',
    detail:
      'Design frozen 2026-07-10 (ADR 122 / ADR 123): a five-cell matrix (A single agent · B one musterd agent · C2 human-dispatch · C3 markdown-board DIY-musterd · D N musterd agents) over one bespoke fixture, holding everything fixed except the coordination medium and N. Headline = wasted-work %, supports = interventions- and tokens-to-done, guardrail = hidden acceptance-test pass rate (no LLM judge on the headline). The apparatus is BUILT: prep froze the measurement protocol (PR #210 — predicate set v1 W3→W1→W2→W4 + I1–I6 interventions), `musterd archaeology` is the git-only wasted-work reference collector (PR #212), the "Skiff" scenario repo carries 8 trap tickets + hidden suites + scoring harness in its own repo (PR #214, kickoff `ea5c6d4`), and the run manifest pins the ladder (PR #217 — Sonnet 5 / Claude Code / N=3, smoke-only spend authorized). Next is the run ladder itself: smoke (1×D) → pilot (A+D) → flagship (5 cells × 3–5), each rung gating the next. Every flagship run is a labeled coordination transcript — the experiment produces the coordination-traces dataset as a byproduct (ADR 122 flywheel). The smoke rung already corrected one design assumption: finding 001’s ≈37% is a forensic proxy, not a reproducible calibration gate (single-actor history) — the reproducible anchor is the fixture’s multi-seat reference-solution (12.2%).',
    refs: [
      adr(122, 'ADR 122'),
      adr(123, 'ADR 123'),
      adr(51, 'ADR 051'),
      doc('docs/design/cookoff-experiment.md', 'cookoff-experiment'),
      doc('docs/design/cookoff-run-manifest.md', 'run-manifest'),
    ],
    dependsOn: ['model-experimentation', 'coordination-lanes'],
  },
  {
    id: 'coordination-dataset',
    wave: 6,
    title: 'Coordination-traces dataset & MAST-in-the-wild',
    plan: 'near-term',
    category: 'observability',
    blurb: 'The first research artifact: an open, redacted dataset of real human+agent coordination traces on HuggingFace, plus MAST failure detectors over the act-typed log — the data no single-agent vendor can produce.',
    detail:
      'Dataset-first on the HF ladder (dataset → benchmark + leaderboard → paper → judge model), MAST-in-the-wild as the first thesis (ADR 056). Substrate is telemetry-l2 + coordination-density; reproducibility rides on the flywheel’s pinned experiment manifests (ADR 051) and baselines (ADR 052). Pulled up 2026-07-10 into the cookoff wave: ADR 122 makes every flagship cookoff run a labeled coordination transcript, so the dataset is now a *byproduct* of the experiment, not an independent build — sequenced directly behind the run ladder. Release stays gated on the opt-in + redaction posture (ADR 051) — no dataset ships before consent/redaction is enforced.',
    refs: [adr(56, 'ADR 056'), doc('docs/research/README.md', 'docs/research/')],
    dependsOn: ['telemetry-l2', 'coordination-density', 'cookoff-value-experiment'],
  },
  {
    id: 'lanes-phase2',
    wave: 'later',
    title: 'Coordination lanes — Phase 2 (observed surface + merge-funnel)',
    plan: 'reserved',
    category: 'platform',
    blurb: 'The observed-surface + merge-funnel layer on top of the Phase-1 lane primitive — tighter contention signal, less reliance on declarations.',
    detail:
      'Phase-1 (ADR 083) shipped the declared intent+dependency layer. Phase 2: observed surface (fs-watch / git-diff sampling instead of only declared globs), the symbol/hunk-level merge-funnel, lane_ack to silence a warning, role-pool auto-assignment of open lanes, and auto-done when a lane\'s branch merges. Watcher, never gatekeeper. Deliberately parked behind the cookoff (2026-07-10): cell D measures how much contention the *declared* Phase-1 layer already catches — if declared lanes cover most of it, Phase 2\'s priority drops; if wasted-work stays high with lanes on, this is the next lever.',
    refs: [adr(83, 'ADR 083'), doc('docs/design/lanes-and-the-multi-agent-tax.md', 'lanes / multi-agent-tax')],
    dependsOn: ['coordination-lanes'],
  },
  {
    id: 'human-role-reevaluation',
    wave: 7,
    title: 'Re-found the human role — human↔agent coordination, reevaluated whole',
    plan: 'near-term',
    category: 'human-loop',
    blurb:
      'The dedicated design pass that reevaluated the human’s role in musterd end-to-end — presence, steering, notification, approval, and thread-close — against the humans-as-peers thesis and what the dogfood record actually shows. Complete: it re-sequenced the human-loop backlog into the items below.',
    detail:
      'Declared at the 2026-07-10 reprioritization; run 2026-07-16/17 as a founder interview (evidence mined first, stated ideals challenged against the record). Findings, from the daemon’s own store: in-band the human is an approver, not a peer (637 agent vs 6 nick acts on the dogfood team, half of the six test fixtures; 44 authorization events); agents never once sent request_help to nick; the seat-claim wall expired unanswered 7× at its 1h TTL and taught the founder to approve gated agents "--as nick"; and the human is invisible exactly while most present (MUSTERD_DRIVER absent from 903 provenance rows, 0 of ~84 lanes human-owned, the npm-publish work parked and unseeable). Diagnosis: musterd gates what the human doesn’t value and can’t see what he controls. Conclusion (ADR 145): membership is the default, authority a human-only admin overlay; a three-species to-human ask stream (consultative / escalation / approval) with per-tier timeout + no-answer policy (top tier holds, below-top proceeds with a recorded risk-acceptance, nothing below top wedges); delivery on lived-in surfaces (Slack + a loud /live panel); a human presence ladder where steering marks you working; human work identity (create/claim lanes from the web UI); and a two-stage close (ready-for-review + counterpart confirm) that absorbs the parked resolve-as-state-gate question. Deliverable landed: docs/design/human-role-reevaluation.md (with the verbatim interview as Appendix A) + ADR 145, which re-sequences the backlog into dogfood-approval-grant → human-ask-stream → ask-surfaces → human-presence-ladder → human-work-identity → two-stage-close → web-steering-console → multi-human-admin.',
    refs: [
      doc('docs/design/human-role-reevaluation.md', 'human-role-reevaluation.md'),
      doc('docs/design/human-agent-dynamics.md', 'human-agent-dynamics.md'),
      doc('docs/design/research-foundation.md', 'research-foundation.md'),
      adr(145, 'ADR 145'),
      adr(25, 'ADR 025'),
    ],
    dependsOn: ['resolve-act', 'steering-latency-metric'],
  },
  {
    id: 'dogfood-approval-grant',
    wave: 7,
    title: 'Dogfood-mode approval — a standing grant for re-seating known agents',
    shipped: { prs: [309] },
    frozenBy: 146,
    category: 'human-loop',
    blurb:
      'Stop the bleeding: re-occupying a seat you already held becomes a notification, not an admin decision. Brand-new member admission stays gated. First policy of the configurable approval surface.',
    detail:
      'The seat-claim wall exists because a gate meant for strangers fires on teammates: 27 claim requests in the record, 7 expired unanswered at the 1h TTL, 7 approvals of the *same* seat in four days, and a `team_join` that averages 76s because it waits on a human who isn’t looking — which taught the founder to tell the gated agent to approve itself `--as nick`, minting audit rows that read authorized_by:nick for decisions he never saw. A standing grant for re-seating a *known* agent (ADR 069/070 substrate) turns the routine case into a notification; new-member admission stays a real decision. Since the agent key is team-scoped (no per-agent identity), "known" is read as an already-bound named agent seat: an authorized harness re-claiming a seat the team already held occupies immediately (a `claim.reseated` audit row, not a `claim.pending` request); never-bound seats, role-pool claims, and human seats stay gated. The authorization is derived from `policy + bound_at` (a per-team `standing_reseat_known_agents` flag, default off; `musterd team policy --reseat-known-agents on`), not a stored grant row — the ADR 145 §6 "derived, never a second stored flag" posture. Retiring the routine gate is what lets the remaining admin decisions insist on a real human surface (closing the --as-nick impersonation hole). Smallest correct change, shipped first because it’s the live wound.',
    refs: [adr(146, 'ADR 146'), adr(145, 'ADR 145'), adr(70, 'ADRs 069–070')],
    dependsOn: ['human-role-reevaluation', 'v03-p2-enforcement'],
  },
  {
    id: 'human-ask-stream',
    wave: 7,
    title: 'The to-human ask stream — tiered asks, timeouts, no-answer policy',
    shipped: { prs: [312] },
    frozenBy: 147,
    category: 'human-loop',
    blurb:
      'One directed-to-human stream, three species (consultative ask / escalation / approval), each carrying a tier that sets a timeout and a no-answer policy. Top tier holds; below-top proceeds with a recorded risk-acceptance. Nothing below top wedges. Harness permission prompts explicitly excluded.',
    detail:
      'The spine of the re-founded human role (ADR 145). Directed-to-human traffic is exactly three species — consultative asks ("what do you think", wanted even in full-auto), escalations (true blockers/disputes), approvals (the admin gate). Each carries a tier; each tier sets a timeout (wait before invoking the no-answer policy) and that policy: top tier (~15m, extremely costly/destructive) *holds* — pause, keep re-notifying, never proceed; below-top (~3m scaling by importance) *proceeds with a recorded risk-acceptance* — the act records the risk, that the human was unreachable, and the chosen approach. Invariants: escalations always technically reach the human (delivery unconditional, response not); nothing below top can wedge. Routing is to admins by default, with a configurable (never automatic) fallback to non-admin humans on admin silence, on the same timeout/risk machinery. A human may answer any ask with "deciding — check back in ⟨duration/indefinitely⟩" — the human symmetric of the agent `wait` act. Excludes harness permission prompts (those stay with the harness). Supersedes the notification ladder (ADR 024/035/044) as the human-reachability path — the record shows 0 request_help ever reached nick.',
    refs: [adr(147, 'ADR 147'), adr(145, 'ADR 145'), adr(103, 'ADR 103'), adr(44, 'ADR 044')],
    dependsOn: ['human-role-reevaluation', 'steer-challenge-acts'],
  },
  {
    id: 'ask-surfaces',
    wave: 7,
    title: 'Ask surfaces — Slack delivery + a loud /live asks & approvals panel',
    shipped: { prs: [317] },
    frozenBy: 149,
    category: 'human-loop',
    blurb:
      'Deliver the ask stream where the human already lives: a Slack message naming what needs a decision, and a prominent asks/approvals element on /live. The CLI inbox demotes to a power tool.',
    detail:
      'The record’s clearest lesson: a channel the human doesn’t inhabit is a dead letter box, however good its acts — nick never once opened the CLI inbox, and the whole notification ladder carries no traffic to him. So the ask stream (`human-ask-stream`) ships *with* its surfaces, not after. Two surfaces the founder named: a Slack message telling him what to approve/decide, and a loud, prominent asks/approvals component on the /live office screen (its own panel, or on the messages/office panels). Sequenced deliberately before more acts are added — acts without a lived-in surface reproduce the dead inbox with more machinery.',
    refs: [adr(149, 'ADR 149'), adr(145, 'ADR 145'), adr(35, 'ADR 035')],
    dependsOn: ['human-ask-stream'],
  },
  {
    id: 'human-presence-ladder',
    wave: 7,
    title: 'The human presence ladder — steering marks you working',
    shipped: { prs: [353, 354, 355] },
    frozenBy: 155,
    category: 'human-loop',
    blurb:
      'Humans get agent-equivalent presence from signals humans already emit: steering marks you working, an authenticated /live tab marks you online, and a stale status decays to idle. Presence informs the ask-stream escalation-eagerness; absolute time still drives every timeout. This resolved the driver co-presence gap rather than patching it.',
    detail:
      'Shipped as ADR 155 in three increments over primitives that already existed — no new presence state, table, or wire field, the ladder is derived composition. Increment 1 (#353): `musterd agent --driver` provisions the opt-in driver link, and a human named as `driver` on a live agent seat composes as working + online at roster read time — derived from the link, no synthetic presence row ("I steer, therefore I’m online", the exact question driver-copresence-gap was blocked on). Increment 2 (#354): presence informs the ask clock, never the ceiling — a present admin (live presence or live driver link, not self-set away/dnd/off_hours) is waited on quietly with loud Slack held for the re-notify, an away one gets Slack at raise; the ADR 153 absolute hold window is byte-identical either way, mechanized as a test. Increment 3 (#355): an authenticated /live tab (advanced sign-in claiming the member seat, surface web) reads online on the roster, and a human’s working label decays to idle once their last status_update ages past the presence timeout (the approved default — no human-specific window) while agents keep the ADR 010 never-silently-revert read. Surveillance-asymmetry held throughout: zero new human-activity audit rows; presence is ops input, not monitoring output.',
    refs: [adr(155, 'ADR 155'), adr(145, 'ADR 145'), adr(21, 'ADR 021'), adr(57, 'ADR 057')],
    dependsOn: ['human-role-reevaluation'],
  },
  {
    id: 'human-work-identity',
    wave: 8,
    title: 'Human work identity — create & claim lanes from the web UI',
    plan: 'reserved',
    category: 'human-loop',
    blurb:
      'Humans create and claim lanes/Goals from the web UI, just like agents — so blockers, human-only work (publish to npm), and self-defined human work are captured, measured, and auditable. No new work-item nouns; the writable board is the missing affordance.',
    detail:
      'The record: nick created 5 lanes and owns 0 of ~84 ownerships; the one work item only he can do (publish the packages to npm) has sat parked and invisible for weeks — musterd literally cannot say "the team is blocked on nick’s lane." Nothing in the schema stops it (`owner_seat: nick` is already legal; lanes already have a backlog state); the only human claim surface is the CLI he never opens. So the board becomes writable from the web UI: a human creates a work item any time and picks it up, and all such work is captured/measured/auditable like agent work. No new hierarchy nouns — ADR 098 holds (Goal → Lane). First dogfood: a real publish-to-npm lane owned by nick, aging and nudgeable. Builds on the read-only board (insight-dashboard increment 1) by adding write.',
    refs: [adr(145, 'ADR 145'), adr(98, 'ADR 098')],
    dependsOn: ['human-role-reevaluation', 'insight-dashboard'],
  },
  {
    id: 'two-stage-close',
    wave: 8,
    title: 'Two-stage close — ready-for-review + counterpart confirm',
    plan: 'reserved',
    category: 'human-loop',
    blurb:
      'Split "done" into the worker’s claim (a `ready for review` lane state) and the owner’s claim (a different seat confirms before `done`; a failed review marks `unverified`). The review request rides the ask stream, so a missing reviewer degrades to self-closed-unverified — never a wedge. Absorbs the parked resolve-as-state-gate question.',
    detail:
      '`resolve` (ADR 025) conflates two claims — the worker’s "technically complete" and the owner’s "this is what I wanted". The founder: agent work can be technically done but not what he wanted when he reviews it with his own eyes (the agile sprint-demo acceptance moment). So the worker asserts only `ready for review`; a *different* seat (agent reviewer, or the requesting human for owner-acceptance) confirms before `done`, and a failed review marks `unverified`. The review request is an ordinary ask-stream item with a timeout, so a missing reviewer degrades to self-close-flagged-unverified rather than wedging. Keeps every settled constraint of the resolve-as-state-gate brainstorm: musterd runs no verifiers, threads can’t wedge, verified-ness is derived from a counterpart act, never a stored second flag. Rides on human-ask-stream.',
    refs: [
      adr(145, 'ADR 145'),
      adr(25, 'ADR 025'),
      doc('docs/design/resolve-as-state-gate-brainstorm.md', 'resolve-as-state-gate-brainstorm.md'),
    ],
    dependsOn: ['human-ask-stream', 'resolve-act'],
  },
  {
    id: 'web-steering-console',
    wave: 8,
    title: 'Web steering console — answer consultative asks from /live',
    plan: 'reserved',
    category: 'human-loop',
    blurb:
      'Pull the steering the founder does inside each harness (approve/deny/redirect, plan feedback, "what do you think") into musterd, answerable from /live — unifying consultative asks, escalations, and approvals into one addressed-to-human stream. Harness permission prompts stay in the harness, permanently.',
    detail:
      'The session’s biggest idea and its biggest lift. Today the founder’s most valuable steering — the approve/deny/redirect stream, plan-mode feedback, the consultative "what do you think" — lives inside each harness (Claude Code, Cursor, Codex) separately, and musterd can’t see, route, or record any of it. This routes the *consultative* asks through the team layer: an ask an agent would have shown in its own session becomes a musterd act, renderable and answerable on /live (or Slack), recorded like everything else, with the tiered proceed-on-timeout semantics attached. It also dissolves driver co-presence from the other side — steering flows through the team, not just annotates it. Explicitly *not* harness permission prompts — those stay with the harness (the boundary the founder drew). Reserved: needs the ask stream, surfaces, and presence ladder live first, and is the heaviest build in the arc.',
    refs: [adr(145, 'ADR 145'), adr(103, 'ADR 103')],
    dependsOn: ['human-ask-stream', 'ask-surfaces', 'human-presence-ladder'],
  },
  {
    id: 'multi-human-admin',
    wave: 'later',
    title: 'Multi-human admin model — the two-human dogfood',
    plan: 'reserved',
    category: 'human-loop',
    blurb:
      'The admin overlay for teams with more than one human: admins are human-only (≥1 always, creator default), a second human joins as non-admin, and a configurable fallback routes asks to non-admin humans on admin silence. Deliberately last — its open questions can’t be honestly designed with one human.',
    detail:
      'musterd has never had two real humans on a team — every human-kind row in the store is nick or his own browser observer, so the entire multi-human story (the "muster your agents *and humans*" pitch) is speculation with zero dogfood. ADR 145 freezes the *defaults*: admins are human-only, at least one always exists (team creator), a second human joins as non-admin (all acts + lanes, sends into the ask stream like agents, but doesn’t receive approvals/escalations by default), and a configurable — never automatic — policy may fall back to non-admin humans on admin silence, on the same timeout/risk machinery. Non-admin humans direct the same three species at admins that agents do, and wield the steering vocab (challenge/stop/wake/rescope/redirect). Deliberately deferred are the questions that need a real second human: the multi-admin race (a decision-maker designation vs a single-admin cap), the exact non-admin steering scope, and whether two humans coordinate through musterd or around it in Slack. Gated on a second-human dogfood.',
    refs: [adr(145, 'ADR 145'), adr(42, 'ADR 042'), adr(70, 'ADRs 069–070')],
    dependsOn: ['human-role-reevaluation', 'v03-p1-seats'],
  },
  {
    id: 'insight-dashboard',
    wave: 7,
    title: 'Work items, board & insight layer (web)',
    plan: 'near-term',
    category: 'insights',
    blurb: 'The kanban-style board and team analytics rendered in the web dashboard — a thin surface over the insight engine, never a second store.',
    detail:
      'The web surface for the already-shipped insight engine (server projections + GET /report + the report CLI/MCP all landed; this is the browser board they never got). ADR 104 frames it as three increments over the two existing endpoints — no board CRUD, no stored columns, the dashboard renders what the engine derives. Increment 1 shipped (PR #151): a read-only /board kanban over GET /lanes — one column per lane state (backlog/claimed/in-progress/blocked/done), cards carrying owner, Goal, branch, age, and the advisory lane-warning flag, auto-provisioning the same hidden observer seat /live uses. Remaining: increment 2 — the insight rail (throughput, cycle time, WIP, waiting-on, MAST exceptions) + Goal swimlanes over GET /report; increment 3 — live-tail so the board moves cards on the ADR 102 lane events instead of on refresh.',
    refs: [adr(104, 'ADR 104'), doc('docs/design/human-agent-dynamics.md', 'human-agent-dynamics.md')],
    dependsOn: ['insight-engine', 'web-dashboard'],
  },
  {
    id: 'driver-copresence-gap',
    wave: 7,
    title: 'Driver co-presence gap — make steering light up the human',
    shipped: { prs: [353] },
    category: 'human-loop',
    blurb: 'Closed by ADR 155 Increment 1: `musterd agent --driver` provisions the once-dormant MUSTERD_DRIVER link, and a human steering a live agent seat now composes as working + online on the roster — derived from the driver link at read time, no presence row of their own.',
    detail:
      'Diagnosed 2026-07-04 from the live roster (nick showed offline while actively steering) + the code: (1) `musterd agent` never wrote MUSTERD_DRIVER (unlike `init`), so the ADR 021 "driven by" annotation never fired for agent-provisioned seats — the link was absent from all 903 provenance rows; (2) even when set, ADR 021 annotated the *agent* row only, giving the human no presence of their own. Both parts closed by ADR 155 Increment 1 (#353), exactly as the human-role reevaluation answered the "should steering mean present" question: `musterd agent --driver <you>` bakes the link opt-in per workspace, and the roster derives the steering human as working + online from any live agent presence carrying their name as `driver` — computed at read time (surveillance-asymmetry: no synthetic row, no new audit trail).',
    refs: [adr(155, 'ADR 155'), adr(21, 'ADR 021'), adr(57, 'ADR 057'), adr(42, 'ADR 042'), adr(145, 'ADR 145')],
    dependsOn: ['agent-presence-touch', 'human-presence-ladder'],
  },


  {
    id: 'own-harness',
    wave: 8,
    title: 'musterd as its own harness & mixed-harness teams',
    plan: 'reserved',
    category: 'harness',
    blurb: 'musterd grows a standalone harness/chat of its own — a seat that runs on musterd directly, like Claude Code or Codex, instead of only sitting on top of them — then mixed-harness teams as a first-class shape.',
    detail:
      'Today every seat runs on someone else’s harness (Claude Code, Cursor, Codex) with musterd as the coordination layer on top; the residency work (ADR 131) already names musterd’s own native harness as its reference actuator row. This item is that ambition whole: a musterd-native runtime a seat can live on directly, plus mixed-harness teams as the deliberately-supported composition (Track B finding 003: non-Claude harnesses coordinate through musterd today; ADR 101 makes model family a team-composition property). Role creation/assignment is deliberately NOT this item — roles are harness-independent (see roles-and-stewardship) and must work identically whether a seat runs on Claude Code, Codex, or musterd’s own harness. (Split 2026-07-13: this item previously also carried the role-template reevaluation.)',
    refs: [adr(26, 'ADRs 026–030'), adr(131, 'ADR 131')],
    dependsOn: ['harness-adapters'],
  },
  {
    id: 'roles-and-stewardship',
    wave: 8,
    title: 'Roles & stewardship — a role library with an infra-touch guardrail',
    plan: 'reserved',
    category: 'platform',
    blurb: 'Create and assign named roles (steward, platform guardian, product manager, UX designer, facilitator/brainstorm, experimenter, researcher, support, database guru…) with charters + capabilities — including "only designated platform agents touch running infrastructure".',
    detail:
      'Captured 2026-07-13 (owner intent; full brainstorm/design session pending — docs/design/roles-and-stewardship.md is the seed). The prompting problem: any agent can restart/rebuild shared infrastructure or modify platform code while teammates are online and depending on it; the desired end state is that only designated platform agent(s) may, and everyone else routes infra requests + troubleshooting to them (request_help by role). Explicitly lenient while the team is still building musterd itself — warn-first, watcher-never-gatekeeper, hardening later. Concrete first target (captured 2026-07-20): the **platform / infra guardian** as an on-call, self-healing-prod agent — a local cheap-probe-wakes-a-session watcher that supervises the daemon and the ADR 152 auto-refresher, auto-remediates safe classes, and escalates the rest, with the per-incident autonomy tier set by an admin via `musterd team policy` (ADR 150). Runtime/recency/probe/autonomy-as-policy all captured in the seed doc; the daemon auto-refresh mechanism it supervises shipped as ADR 152. Builds on what exists rather than re-inventing: the ADR 069/070 capability substrate (roles/<name>.toml already carries defaults + charter, per-seat narrowing, in-band enforcement + audit), the ADR 026–030 provisioning templates (the per-harness rendering half), the steward (ADR 112) as the first worked example of a role-agent (charter + autonomy knobs + guardrails; today an Action, wants to be a resident seat via ADR 131), and the no-orchestrator stance (a role is charter + capabilities on an ordinary seat, never a new protocol power). Roles are harness-independent by design — the same role assignable on Claude Code, Codex, Cursor, or musterd’s own future harness. Seed library also includes a Facilitator/brainstorm archetype (tldraw for diverge, harness visual companion for converge; portable intent, per-harness surfaces) — see the seed doc.',
    refs: [
      adr(70, 'ADRs 069–070'),
      adr(112, 'ADR 112'),
      doc('docs/design/roles-and-stewardship.md', 'roles-and-stewardship.md'),
    ],
    dependsOn: ['v03-p1-seats'],
  },
  {
    id: 'sandboxed-runtime',
    wave: 'later',
    title: 'Sandboxed runtime',
    plan: 'reserved',
    category: 'platform',
    blurb: 'musterd connects agents; it does not run them. A later, optional sandbox could host members with nowhere else to live.',
  },
  {
    id: 'python-sdk',
    wave: 'later',
    title: 'Python client SDK',
    plan: 'reserved',
    category: 'platform',
    blurb: 'A fast follow after launch. The protocol is language-neutral; the TypeScript client is the reference, not the only one.',
  },

  // ── captured from design docs / ADRs (roadmap-completeness pass, 2026-07-01) ──
  {
    id: 'team-hardening',
    wave: 'later',
    title: 'Shared/remote-team security hardening',
    plan: 'reserved',
    category: 'platform',
    blurb: 'The security cluster that follows the v0.3 governance work once teams span machines: recipient-scoped message reads, multi-admin delegation, rotating/per-seat keys, a signed audit log, and abuse limits.',
    detail:
      'Named as "roadmap" in security.md + membership-model.md: **recipient-scoped message reads SHIPPED** (ADR 128 — `GET /messages` + the `team-all` firehose no longer leak others\' DMs to a regular member; a party is sender/recipient/team-broadcast, admins + read-only observers see all under localhost-trust; the local-vs-shared observer scoping — a shared watch-link seeing only public traffic — is the tracked remainder here). Still reserved in this cluster: local-vs-shared observer scoping, multi-admin delegation & policy, per-seat / rotating agent keys, a tamper-evident (signed) audit log, claim rate-limiting / anomaly detection + per-sender urgent rate-limit, OS-keychain secret storage, and DB encryption-at-rest. Follows directly from the shipped v0.3 governance substrate.',
    refs: [doc('docs/design/security.md', 'security.md'), doc('docs/design/membership-model.md', 'membership-model.md')],
  },
  {
    id: 'authorization-provenance',
    wave: 'later',
    title: 'Authorization provenance (who approved it)',
    shipped: { prs: [167, 170, 227] },
    frozenBy: 127,
    category: 'platform',
    blurb: 'For audit: when a decision, escalation, or merge routes to a human for authorization, record which human authorized it — a first-class, attestable link from an approved action back to the approver.',
    detail:
      'The merge half shipped as ADR 109 (PRs #167/#170): `authorized_by` on `git.pr_merged`, surfaced via `lane resolve --authorized-by`. ADR 127 extends the same key to `request.decide` + `grant.issue` (server-derived from the authenticated admin), writes `grant.issue` when an approve mints a grant, and adds `musterd audit --authorized-by <seat>` / `?authorized_by=` so admins can filter the ledger by authorizer. Seeds: P2 audit log (ADR 071), request lane (ADR 077), human credentials (P3).',
    refs: [adr(127, 'ADR 127'), adr(109, 'ADR 109'), adr(71, 'ADR 071'), adr(77, 'ADR 077'), doc('docs/design/security.md', 'security.md')],
    dependsOn: ['v03-p2-enforcement'],
  },
  {
    id: 'hosted-relay',
    wave: 'later',
    title: 'Hosted rendezvous relay (Topology C)',
    plan: 'reserved',
    category: 'transport',
    blurb: 'A musterd-operated hosted relay members dial out to — the "just works" path for teams that won\'t run a Tailscale/WireGuard overlay.',
    detail:
      'From deployment-topology.md §Topology C: the largest transport build and the "just works" future — a hosted rendezvous relay so cross-network teams need no self-run overlay. Extends cross-network teams (the loopback + secured-bind + overlay topologies already shipped).',
    refs: [doc('docs/design/deployment-topology.md', 'deployment-topology'), adr(40, 'ADR 040')],
    dependsOn: ['cross-network'],
  },

  {
    id: 'tool-call-telemetry',
    wave: 'later',
    title: 'Tool-call telemetry — which tools get used, and what they cost',
    plan: 'reserved',
    category: 'observability',
    blurb:
      'musterd records coordination acts, never tool calls. Emit a per-tool-call event — tool name, latency, error, caller role, estimated schema weight — so we can see how the MCP surface is actually used and what it costs.',
    detail:
      'The gap, confirmed 2026-07-14: the audit ledger is coordination-level (claim.occupied, residency.*, git.pr_merged, memory.save — 769 rows over 12 days), and the messages table records acts (status_update 510, message 181, accept 101, steer/handoff/request_help/challenge/defer in single digits), but nothing records which `team_*`/`lane_*` tool was invoked, how long it took, or how many tokens its schema cost. The one exception is the inc-5 `residency.wake_cost` (~$1.21/wake) — proof the ledger can carry a real measured cost once someone instruments it. The PostHog taxonomy defines `$mcp_tool_call`/`$ai_generation` but the Sandrise project collects none of them. The work: emit one event/span per MCP tool call (name, wall-clock, error state, caller role) plus an estimated per-seat schema-token weight, land it in the audit ledger + report engine, honoring the ADR 051 opt-in/redaction posture. It serves two masters — it tells the MCP-surface redesign which tools and descriptions earn their bytes, and it feeds the broader observability product (cost accounting, coordination density, the MAST-in-the-wild dataset). Split out from the surface item on 2026-07-14 so it is not lost as a sub-bullet. Design frozen 2026-07-15 as increment 1 of the ADR 144 measure-then-craft arc (event fields + report-engine aggregates frozen; ledger-vs-aggregate storage is the increment’s call); still sequenced later. Builds on the telemetry emission path (ADRs 015, 089–091) and the wake-cost precedent (ADR 131).',
    refs: [
      adr(144, 'ADR 144'),
      doc('docs/design/mcp-tool-surface.md', 'mcp-tool-surface.md'),
      adr(89, 'ADRs 089–091'),
      adr(15, 'ADR 015'),
      adr(131, 'ADR 131'),
    ],
    dependsOn: ['telemetry-l2'],
  },
  {
    id: 'mcp-tool-surface',
    wave: 'later',
    title: 'musterd’s MCP server, examined — names, descriptions, schemas, results & discovery',
    plan: 'reserved',
    category: 'harness',
    blurb:
      'Treat musterd’s own MCP server as a designed product surface — both what an agent sends and what it reads back. Audit the 18 tools’ names, descriptions, and schemas for clarity and weight, fix the namespace drift, make every result (empty states included) informative and action-naming for an agent, and give a seat a lean surface it can discover instead of a wall of schema on every call.',
    detail:
      'The MCP adapter is the whole surface an agent reads — what it sends (tool names, descriptions, schemas) and what it reads back (every tool result, empty states included). The ecosystem is scrutinizing the input half: the field report that a single "hi" ships ~20K tokens of tool schema, the observation that tool *descriptions* (not parameter structure) are the biggest culprit, Alibaba SkillWeaver’s on-demand tool discovery (>99% context cut over a 2,209-tool library), the tool-selection literature’s gate→retrieve→route→scope stack where accuracy degrades past ~15–20 tools, and GPT-5.6’s programmatic tool calling. Our surface has grown to 18 tools (12 `team_*` + 6 `lane_*`) with real craft debt: a namespace inconsistency (`lane_*` sits outside the `team_*` prefix every other tool shares), heavy prose descriptions (lanes ~2.9K, send ~1.7K, insights ~1.3K chars) where `team_send` alone crams nine acts into one paragraph, no discovery affordance (every schema loads on every call), and — the output half — results whose helpfulness is uneven: `format.ts` already renders for an agent to read and some empty states name the next action ("no lanes — lane_open to declare your work"), but others are bare ("no members") and no standard holds them to it. The work: (1) audit and rewrite tool names + descriptions for consistency and concision (the cheapest, highest-leverage lever); (2) make every result — especially empty states and errors — informative, intuitive, and action-naming for an agent, as an audited standard rather than ad hoc; (3) tighten schemas and split/merge overloaded tools like `team_send`; (4) scope the rendered surface to the seat’s role so an observer never loads acting tools; (5) a discovery/`get_more_tools` affordance so the catalog can grow without taxing every call. What each tool actually costs and how it is used is tracked separately (tool-call-telemetry). A 2026-07-15 adjacent-systems sweep (in the seed brief) validated and sharpened the shape: Anthropic’s Tool Search Tool / `defer_loading` builds discovery into the harness (50+ tools ~72K→8.7K tokens, accuracy up — so retrievable names/descriptions are the durable server-side work), `input_examples` beats longer prose for `team_send`’s nine acts, MCP spec issue #2808 proposes namespacing + discovery-tier schemas (our drift and increment 5, as spec concerns), prompt-caching makes a stable per-seat surface the cacheable shape (scope at render, never mutate mid-session), OPA contributes the decouple-policy-from-render pattern without the dependency, and the server-side conforming-agent idea lands as deterministic lenient coercion + repair-hinting errors now, model-in-the-path as a researchable extension. Design frozen 2026-07-15 by ADR 144, which sequences the arc — measurement first (tool-call-telemetry as increment 1), then names/descriptions, results/empty states, schemas/tool shape, scope-by-role, and a conditional discovery increment — under frozen principles (measure-then-craft, deterministic forgiveness, stability over dynamism, coarse by default, retrievability as the durable work); still sequenced later. Substrate exists: the per-seat adapter render (ADRs 029–031), the agent-first result formatter (`format.ts`), roles/grants for scoping (ADR 069), and the model-as-a-variable role work (ADR 101).',
    refs: [
      adr(144, 'ADR 144'),
      doc('docs/design/mcp-tool-surface.md', 'mcp-tool-surface.md'),
      adr(29, 'ADRs 029–031'),
      adr(69, 'ADR 069'),
      { label: 'ML Mastery — tool selection in AI agents', href: 'https://machinelearningmastery.com/the-complete-guide-to-tool-selection-in-ai-agents/' },
      { label: 'Alibaba SkillWeaver (VentureBeat)', href: 'https://venturebeat.com/orchestration/new-alibaba-ai-framework-skips-loading-every-tool-cutting-agent-token-use-99' },
      { label: 'The New Stack — MCP context problem', href: 'https://thenewstack.io/mcp-enterprise-agent-governance/' },
    ],
    dependsOn: ['harness-adapters', 'own-harness', 'tool-call-telemetry'],
  },

  // ── out of scope ──────────────────────────────────────────────────────────
  {
    id: 'no-orchestrator',
    title: 'A planner / orchestrator role',
    plan: 'out-of-scope',
    category: 'platform',
    blurb: 'One member does the work; the team does the coordination. musterd never forces decomposition.',
    detail: 'A team of one agent, plus optionally a human, is a first-class — even default — configuration.',
  },
  {
    id: 'no-runtime',
    title: 'Running your agent',
    plan: 'out-of-scope',
    category: 'platform',
    blurb: 'Protocol over framework. We connect agents; we don’t own their execution loop.',
  },
];

/** The read-model: authored declarations with their `status` derived + shipped-xor-plan enforced. */
export const ROADMAP: RoadmapItem[] = RAW.map(resolveItem);

/** The authored declarations, unresolved — what `scripts/check-roadmap-truth.ts` verifies against reality. */
export const ROADMAP_RAW: RawItem[] = RAW;

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
