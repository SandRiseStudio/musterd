/*
 * The roadmap — single source of truth.
 *
 * This typed module is canonical: the web roadmap map imports it directly, and ROADMAP.md's
 * item region is GENERATED from it (`pnpm roadmap:gen`, via scripts/gen-roadmap.ts). Edit here;
 * never hand-edit the generated region of ROADMAP.md. Copy stays plain and declarative, and
 * honest about status, per brand.md §4.
 */

export type Status = 'shipped' | 'near-term' | 'reserved' | 'out-of-scope';

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

  // ── near-term ─────────────────────────────────────────────────────────────
  {
    id: 'notification-tiers',
    title: 'Notification tiers',
    status: 'near-term',
    category: 'human-loop',
    blurb: 'The full reachability set: route an agent’s request for help to a human by salience and availability, not only when they are watching.',
    detail:
      'Co-Gym’s ablation: removing the notification protocol more than halves the collaboration win rate (30% → 70%). This is where the measured value is.',
    refs: [doc('docs/design/research-foundation.md', 'research-foundation.md')],
    dependsOn: ['notify-nudge'],
  },

  // ── reserved ──────────────────────────────────────────────────────────────
  {
    id: 'telemetry-l2',
    title: 'Telemetry — Layer 2 + SDK',
    status: 'reserved',
    category: 'observability',
    blurb: 'A full CLI/MCP telemetry SDK, then MAST-aware views over the act-typed log that agent-observability tools cannot see.',
    detail: 'The seed of a standalone coordination-observability product.',
    refs: [doc('docs/design/observability.md', 'observability.md')],
    dependsOn: ['telemetry-l1'],
  },
  {
    id: 'schedule-enforcement',
    title: 'Schedule & lifecycle enforcement',
    status: 'reserved',
    category: 'platform',
    blurb: 'availability and lifecycle: until are stored today but not enforced. Later: honor windows for routing and auto-expire members.',
  },
  {
    id: 'step-streaming',
    title: 'Step-level streaming transport',
    status: 'reserved',
    category: 'transport',
    blurb: 'v0.1 sends whole Envelopes. A v2 transport adds step-level streaming, which beats wait-for-complete for collaborating agents.',
    detail: 'The broadcast recipient kind is already distinct on the wire to anticipate richer delivery semantics.',
  },
  {
    id: 'federation',
    title: 'Team-to-team federation',
    status: 'reserved',
    category: 'transport',
    blurb: 'A Member belongs to one Team today. Teams that address one another, and identities recognized across Teams, come later.',
    dependsOn: ['cross-network'],
  },
  {
    id: 'web-dashboard',
    title: 'Web dashboard',
    status: 'reserved',
    category: 'surfaces',
    blurb: 'A web surface for the same Members — designed now, built later. This page is the first foundation of it.',
    detail: 'The Surface enum already includes web, ios, slack. Same Member, more Presences.',
  },
  {
    id: 'more-surfaces',
    title: 'iOS & Slack surfaces',
    status: 'reserved',
    category: 'surfaces',
    blurb: 'An iOS app and a Slack surface, so a Member is reachable wherever its human or agent already lives.',
    dependsOn: ['web-dashboard'],
  },
  {
    id: 'board-insights',
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
    id: 'own-harness',
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
    title: 'Sandboxed runtime',
    status: 'reserved',
    category: 'platform',
    blurb: 'musterd connects agents; it does not run them. A later, optional sandbox could host members with nowhere else to live.',
  },
  {
    id: 'python-sdk',
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
