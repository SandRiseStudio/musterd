import type { Envelope, MemberSummary } from '@musterd/protocol';
import { ringTargets } from '@musterd/protocol/wire';

/**
 * The doorbell's `live` sink, browser half (ADR 443 §3): an open `/live` tab raises a browser
 * `Notification` when an act rings the connected seat. `live` is always on, and the page already
 * holds every envelope (the firehose), so this is a pure fold plus one browser call.
 *
 * The notification is built from structured fields only, never the body — the same record the
 * other sinks carry. It fires once per act, never for what was already there when the page loaded
 * (a backfill is not news), never for an act already answered, and never for an observer: only a
 * connected roster member can be rung.
 */

export interface RingNotice {
  id: string;
  title: string;
  body: string;
}

const SPECIES_PHRASE: Record<string, string> = {
  escalate: 'escalated to you',
  approve: 'needs your approval',
  consult: 'asks what you think',
};

/** The notice for one act: who and what, never the body. */
export function ringNotice(env: Envelope): RingNotice {
  const meta = (env.meta ?? {}) as Record<string, unknown>;
  const title = `musterd [${env.team}]`;
  if (env.act === 'ask') {
    const species = typeof meta['species'] === 'string' ? meta['species'] : 'consult';
    const tier = typeof meta['tier'] === 'string' ? ` (${meta['tier']})` : '';
    const phrase = SPECIES_PHRASE[species] ?? SPECIES_PHRASE['consult']!;
    return { id: env.id, title, body: `${env.from} ${phrase}${tier}` };
  }
  if (env.act === 'handoff') return { id: env.id, title, body: `${env.from} handed you work` };
  if (env.act === 'request_help') return { id: env.id, title, body: `${env.from} needs your help` };
  return { id: env.id, title, body: `${env.from} sent you a ${env.act}` };
}

/** Acts answered in this timeline: an accept/decline naming them, or a resolve of their thread. */
function answered(envelopes: Envelope[]): { replied: Set<string>; resolved: Set<string> } {
  const replied = new Set<string>();
  const resolved = new Set<string>();
  for (const e of envelopes) {
    const ref = (e.meta as { in_reply_to?: unknown } | null | undefined)?.in_reply_to;
    if ((e.act === 'accept' || e.act === 'decline') && typeof ref === 'string') replied.add(ref);
    if (e.act === 'resolve' && e.thread) resolved.add(e.thread);
  }
  return { replied, resolved };
}

/**
 * The acts in this timeline that ring `seat` and are still open. `seat` is null for a viewer who
 * cannot be rung (an observer, a watch link, a signed-out tab).
 */
export function openRingsFor(
  envelopes: Envelope[],
  roster: MemberSummary[],
  seat: string | null,
): Envelope[] {
  if (seat === null) return [];
  const humans = new Set(roster.filter((m) => m.kind === 'human').map((m) => m.name));
  if (!humans.has(seat)) return [];
  const admins = new Set(
    roster.filter((m) => m.kind === 'human' && m.capabilities?.is_admin).map((m) => m.name),
  );
  const { replied, resolved } = answered(envelopes);
  return envelopes.filter((env) => {
    if (replied.has(env.id) || resolved.has(env.thread ?? env.id)) return false;
    const to = env.to.kind === 'member' ? env.to.name : null;
    const meta = env.meta as Record<string, unknown> | null | undefined;
    return ringTargets({ act: env.act, to, meta, humans, admins }).includes(seat);
  });
}

/** How far before page load an act may be and still count as news — the daemon's clock and the
 *  browser's are different clocks. */
export const BACKFILL_SLACK_MS = 2_000;

/**
 * Which rings are news: open rings not yet seen, and not older than the page. The caller adds each
 * id it notifies to `seen`, so nothing fires twice; the `loadedAt` bar is what keeps a backfill —
 * which may arrive before or after the roster — from firing on load.
 */
export function newRings(
  open: Envelope[],
  seen: ReadonlySet<string>,
  loadedAt: number,
): Envelope[] {
  return open.filter((env) => !seen.has(env.id) && env.ts >= loadedAt - BACKFILL_SLACK_MS);
}

/** Raise one browser notification, if this tab may. Clicking it brings the tab forward. */
export function notifyBrowser(notice: RingNotice, onClick: (id: string) => void): void {
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
  const n = new Notification(notice.title, { body: notice.body, tag: notice.id });
  n.onclick = () => {
    window.focus();
    onClick(notice.id);
    n.close();
  };
}
