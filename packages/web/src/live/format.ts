import type { Envelope, MemberSummary } from '@musterd/protocol';

export type ActTone = 'accent' | 'success' | 'danger' | 'info' | 'neutral';

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
    default:
      return 'neutral';
  }
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

export function recipientLabel(to: Envelope['to']): string | null {
  if (to.kind === 'member') return `→ ${to.name}`;
  if (to.kind === 'team') return '→ team';
  return '→ all';
}

export type Kind = 'agent' | 'human';

/** Index the roster by name for O(1) kind/role lookups while rendering. */
export function rosterIndex(roster: MemberSummary[]): Map<string, MemberSummary> {
  return new Map(roster.map((m) => [m.name, m]));
}

export function kindOf(name: string, idx: Map<string, MemberSummary>): Kind {
  return idx.get(name)?.kind === 'human' ? 'human' : 'agent';
}
