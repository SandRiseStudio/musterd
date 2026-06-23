/*
 * Structured projection of ROADMAP.md.
 *
 * ROADMAP.md is the source of truth; this file is a hand-maintained, typed view of it
 * for the web surface. When the roadmap changes, update ROADMAP.md first, then mirror the
 * change here. Copy stays plain and declarative, and honest about status, per brand.md §4.
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

export const CATEGORY_META: Record<Category, { label: string }> = {
  'human-loop': { label: 'Human ↔ agent loop' },
  observability: { label: 'Telemetry & observability' },
  transport: { label: 'Transport & topology' },
  surfaces: { label: 'Surfaces' },
  insights: { label: 'Work items & insight' },
  harness: { label: 'Harness environment' },
  platform: { label: 'Platform' },
};

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
    id: 'cross-network',
    title: 'Cross-network teams',
    status: 'reserved',
    category: 'transport',
    blurb: 'Members on different machines are conceptually a valid team today; the networking substrate is not designed yet.',
    detail:
      'Near-term answer is docs-only — stand on a Tailscale/WireGuard-style overlay. Then a secured off-loopback bind (wss://, TLS), then a hosted relay. Still one team = one daemon.',
    refs: [doc('docs/design/deployment-topology.md', 'deployment-topology.md')],
  },
  {
    id: 'federation',
    title: 'Team-to-team federation',
    status: 'reserved',
    category: 'transport',
    blurb: 'A Member belongs to one Team today. Teams that address one another, and identities recognized across Teams, come later.',
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
  },
  {
    id: 'own-harness',
    title: 'Role templates & mixed-harness teams',
    status: 'reserved',
    category: 'harness',
    blurb: 'A Role becomes a harness-agnostic provisioning template, rendered per-harness — then musterd’s own harness, then mixed-harness teams.',
    detail: 'Provisioning is a starting point, not a security boundary. It stays additive, reversible, and non-obligating.',
    refs: [adr(26, 'ADRs 026–030')],
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
