import type { Envelope } from '@musterd/protocol';
import { laneEvent } from './format';

/**
 * The caption rail (first-five-seconds spec §2): orientation through narration of REAL moments.
 * A stranger learns the vocabulary by watching it used — the caption and the choreography it names
 * are on screen together. Notable moments only; status chatter never captions. Pure module: the
 * DOM layer owns nothing but rendering `CaptionRail.current`.
 */

/** Plain-sentence caption for a notable act — `null` for everything that should stay quiet. */
export function captionFor(env: Envelope): string | null {
  const from = env.from;
  const to = env.to.kind === 'member' ? env.to.name : null;
  if (laneEvent(env) === 'lane_handoff' && to) return `${from} is handing work to ${to}`;
  switch (env.act) {
    case 'handoff':
      return to ? `${from} is handing work to ${to}` : null;
    case 'accept':
      // The recipient is whose work was accepted — same rule as the confetti (mapping.ts).
      return to ? `${from} accepted ${to}'s work — it's done` : null;
    case 'steer':
      return `${from} is redirecting ${to ?? 'the team'}`;
    case 'request_help':
      if (!to) return null;
      return env.meta?.['urgent'] === true
        ? `${from} urgently needs ${to}`
        : `${from} is asking ${to} for help`;
    case 'ask':
      if (!to) return null;
      return env.meta?.['species'] === 'approve'
        ? `${from} is asking ${to} to approve something`
        : `${from} is asking ${to} to weigh in`;
    default:
      return null;
  }
}

/** Arrival/departure narration from the online-name diff — at most one story per refresh. */
export function captionForPresence(prev: ReadonlySet<string>, next: ReadonlySet<string>): string | null {
  for (const n of next) if (!prev.has(n)) return `${n} just walked in`;
  for (const n of prev) if (!next.has(n)) return `${n} just stepped out`;
  return null;
}

/** One caption at a time, ~6s hold, at most 2 queued — past that, drop rather than narrate the past. */
export interface CaptionRail {
  current: string | null;
  shownAt: number;
  queue: string[];
}

export const CAPTION_HOLD_MS = 6_000;
const QUEUE_MAX = 2;

export function pushCaption(s: CaptionRail, text: string, now: number): CaptionRail {
  if (s.current === null) return { current: text, shownAt: now, queue: [] };
  if (s.queue.length >= QUEUE_MAX) return s; // dropped — a late caption is noise, not orientation
  return { ...s, queue: [...s.queue, text] };
}

export function tickCaption(s: CaptionRail, now: number): CaptionRail {
  if (s.current === null || now - s.shownAt < CAPTION_HOLD_MS) return s;
  const [head, ...rest] = s.queue;
  return { current: head ?? null, shownAt: now, queue: rest };
}
