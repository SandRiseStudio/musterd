import type { Envelope, MemberSummary } from '@musterd/protocol';

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
      return 'success';
    case 'decline':
      return 'danger';
    case 'wait':
      return 'info';
    case 'handoff':
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
    default:
      return act;
  }
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
