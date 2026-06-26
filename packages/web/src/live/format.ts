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

/** `HH:MM` in the viewer's locale, from a ms-epoch ts. */
export function clock(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
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
