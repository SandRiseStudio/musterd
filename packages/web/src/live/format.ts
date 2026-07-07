import type { AccountStatus, Capabilities, Envelope, MemberSummary } from '@musterd/protocol';

export type ActTone =
  | 'accent'
  | 'success'
  | 'danger'
  | 'info'
  | 'handoff'
  | 'status'
  | 'neutral';

/** Map an act to its colour role — mirrors brand.md / the act-badge variants (ADR 061 view). */
export function actTone(act: string): ActTone {
  switch (act) {
    case 'request_help':
      return 'accent';
    case 'accept':
    case 'resolve':
    case 'lane_resolve':
      return 'success';
    case 'decline':
      return 'danger';
    case 'wait':
    case 'lane_open':
      return 'info';
    case 'handoff':
    case 'lane_handoff':
      return 'handoff';
    case 'status_update':
      return 'status';
    default:
      return 'neutral';
  }
}

/**
 * A short, human label per act — what reads in the badge. Distinct from the raw act token so the
 * stream stays legible (`status_update` → `status`, `request_help` → `help`) without losing meaning.
 */
export function actLabel(act: string): string {
  switch (act) {
    case 'status_update':
      return 'status';
    case 'request_help':
      return 'help';
    case 'lane_open':
      return 'lane open';
    case 'lane_resolve':
      return 'lane done';
    case 'lane_handoff':
      return 'lane handoff';
    default:
      return act;
  }
}

/**
 * A lane lifecycle event (open/resolve/handoff) rides as an ordinary `message` envelope with
 * structured meta (ADR 083 §4: no new act token, no SPEC bump) — this recovers the intended
 * sub-type from `meta` so the stream badge, glyph, and office choreography can key on it distinctly
 * from a plain message instead of all three collapsing into a generic "message".
 */
export type LaneEventKind = 'lane_open' | 'lane_resolve' | 'lane_handoff';
export function laneEvent(env: Pick<Envelope, 'act' | 'meta'>): LaneEventKind | null {
  if (env.act !== 'message' || !env.meta) return null;
  if (env.meta['lane_open']) return 'lane_open';
  if (env.meta['lane_resolve']) return 'lane_resolve';
  if (env.meta['lane_handoff']) return 'lane_handoff';
  return null;
}

/** Where a message went, distilled to the three audiences a reader cares about (ADR 061 firehose). */
export type ActScope = 'direct' | 'team' | 'all';
export function recipientScope(to: Envelope['to']): ActScope {
  if (to.kind === 'member') return 'direct';
  if (to.kind === 'team') return 'team';
  return 'all';
}
/** The named recipient of a direct (1:1) message; null for team/broadcast. */
export function recipientName(to: Envelope['to']): string | null {
  return to.kind === 'member' ? to.name : null;
}

export function initial(name: string): string {
  return (name.trim()[0] ?? '?').toUpperCase();
}

/** 12-hour clock (e.g. `9:48 PM`) in the viewer's locale, from a ms-epoch ts. */
export function clock(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', hour12: true });
}

/** Local day bucket (ms at local midnight) — for grouping the stream into days. */
export function dayKey(ts: number): number {
  const d = new Date(ts);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** A day divider label: `Today`, `Yesterday`, or a dated weekday (`Mon, Jun 26`). */
export function dayLabel(ts: number): string {
  const diff = Math.round((dayKey(Date.now()) - dayKey(ts)) / 86_400_000);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  const d = new Date(ts);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString([], {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    ...(sameYear ? {} : { year: 'numeric' }),
  });
}

export type Kind = 'agent' | 'human';

/** Index the roster by name for O(1) kind/role lookups while rendering. */
export function rosterIndex(roster: MemberSummary[]): Map<string, MemberSummary> {
  return new Map(roster.map((m) => [m.name, m]));
}

export function kindOf(name: string, idx: Map<string, MemberSummary>): Kind {
  return idx.get(name)?.kind === 'human' ? 'human' : 'agent';
}

/**
 * A deterministic, per-member colour so every agent (and human) is individually distinguishable —
 * stable across sessions (hashed from the name, not assigned by index). Agents sit in a cool jewel
 * band, humans in a warm band, so kind still reads at a glance while individuals stay unique. The
 * golden-ratio hash spreads similar names apart. Returns an `hsl()` string usable in CSS and three.js.
 */
export function memberColor(name: string, kind: Kind): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  const t = (h * 0.618033988749895) % 1;
  // agents: 150°→280° (green · teal · cyan · blue · indigo); humans: 320°→70° (magenta · rose · coral · amber)
  const hue = kind === 'human' ? Math.round((320 + t * 110) % 360) : Math.round(150 + t * 130);
  return `hsl(${hue}, 68%, 62%)`;
}

/* ─── governance projection (ADR 070 capability/account-status surface) ───────────────────────────
 * The web read-only view of the v0.3 seat model: it renders whatever the daemon *projects* (role
 * defaults ⊕ per-seat narrowing → effective capabilities, plus the derived account_status). Nothing is
 * enforced here — this is the observable surface. P2 (server) is the enforcement half. */

/** How an account_status reads in the rail: a tone + whether it's the healthy norm (shown quiet). */
export interface StatusMeta {
  label: string;
  tone: 'ok' | 'pending' | 'danger' | 'muted';
  /** `active` is the steady state — rendered subdued so the rail only *shouts* the exceptions. */
  quiet: boolean;
}
export function accountStatusMeta(status: AccountStatus | undefined): StatusMeta {
  switch (status) {
    case 'active':
      return { label: 'active', tone: 'ok', quiet: true };
    case 'provisioned':
      return { label: 'provisioned', tone: 'pending', quiet: false };
    case 'disabled':
      return { label: 'disabled', tone: 'muted', quiet: false };
    case 'banned':
      return { label: 'banned', tone: 'danger', quiet: false };
    case 'archived':
      return { label: 'archived', tone: 'muted', quiet: false };
    default:
      // Pre-v0.3 daemon (no account_status projected) — say so rather than inventing 'active'.
      return { label: 'unknown', tone: 'muted', quiet: true };
  }
}

export type BadgeTone = 'admin' | 'restrict' | 'muted';
export interface CapBadge {
  key: string;
  label: string;
  tone: BadgeTone;
  /** The long-form tooltip explaining the capability behind the badge. */
  title: string;
}

/**
 * The capability badges worth showing for a seat — only **deviations from the generalist default**
 * (everyone-can-do-everything) plus the positive `admin` marker. A fully-generalist seat shows no
 * badges, so the rail stays calm today and lights up exactly as governance is configured. Mirrors the
 * Universe-1 fields the protocol enforces (ADR 070); Universe-2 (tool/resource scopes) is declared-only
 * and intentionally not surfaced as a badge.
 */
export function capabilityBadges(caps: Capabilities | undefined): CapBadge[] {
  if (!caps) return [];
  const out: CapBadge[] = [];
  if (caps.is_admin)
    out.push({ key: 'admin', label: 'admin', tone: 'admin', title: 'Team admin — full governance authority' });
  if (caps.visibility_level === 'admin')
    out.push({
      key: 'view',
      label: 'admin view',
      tone: 'admin',
      title: 'Sees everything: credentials, grants, audit, and all charters',
    });
  if (caps.can_message === 'none')
    out.push({ key: 'muted', label: 'muted', tone: 'muted', title: 'May not send messages to the team' });
  if (!caps.can_flag_urgent)
    out.push({
      key: 'urgent',
      label: 'no urgent',
      tone: 'restrict',
      title: 'May not flag messages as urgent',
    });
  if (!caps.can_observe)
    out.push({
      key: 'observe',
      label: 'no observe',
      tone: 'restrict',
      title: 'May not observe the team firehose',
    });
  return out;
}

/**
 * Pretty-print an audit `action` (ADR 071). Known v0.3 actions get a short human label + a tone;
 * unknown actions (P3 adds `grant.*`, `claim.*`, …) fall back to the raw token so the view never
 * hides a record it doesn't recognise. The dot-namespace (`urgent.denied`) reads fine verbatim.
 */
export function auditActionMeta(action: string): { label: string; tone: ActTone } {
  switch (action) {
    case 'urgent.flagged':
      return { label: 'urgent flagged', tone: 'status' };
    case 'urgent.denied':
      return { label: 'urgent denied', tone: 'danger' };
    case 'send.denied':
      return { label: 'send denied', tone: 'danger' };
    case 'observe.denied':
      return { label: 'observe denied', tone: 'danger' };
    case 'member.reclaim':
      return { label: 'seat reclaimed', tone: 'handoff' };
    case 'member.remove':
      return { label: 'member removed', tone: 'handoff' };
    default:
      return { label: action, tone: 'neutral' };
  }
}

/** Compact one-line render of an audit entry's free-form `detail` object (`k: v · k: v`). */
export function formatAuditDetail(detail: Record<string, unknown> | null): string {
  if (!detail) return '';
  return Object.entries(detail)
    .map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`)
    .join(' · ');
}

/** A precise audit timestamp — date + 24h time to the second (records can cluster within a second). */
export function auditTime(ts: number): string {
  return new Date(ts).toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}

/** Roster sort for the rail: online before offline, then humans before agents, then by name. */
export function rosterOrder(a: MemberSummary, b: MemberSummary): number {
  const onA = a.presence !== 'offline' ? 0 : 1;
  const onB = b.presence !== 'offline' ? 0 : 1;
  if (onA !== onB) return onA - onB;
  const kA = a.kind === 'human' ? 0 : 1;
  const kB = b.kind === 'human' ? 0 : 1;
  if (kA !== kB) return kA - kB;
  return a.name.localeCompare(b.name);
}
