import type { Envelope } from '@musterd/protocol';
import { eligibleOf } from '@musterd/protocol/wire';
import { actLabel, actTone, laneEvent } from '../format';
import { speechAddressee, speechMark } from './speech';
import type { OfficeEvent } from './types';

/**
 * Project a live act to office choreography (memory: act → choreography, travel-intensity == tier).
 * Pure — the scene decides how to *render* each event (lightweight cue in M1, real motion in M2). A
 * `null` return is an act we don't animate. `meta.urgent` promotes a help walk to the urgent tier.
 */
export function actToEvent(env: Envelope): OfficeEvent | null {
  const from = env.from;
  const to = env.to;
  const lane = laneEvent(env);
  const tone = actTone(lane ?? env.act);
  const urgent = env.meta?.['urgent'] === true;
  /**
   * Who the act is for, as a list. A `member` act is a one-name list; an ADR 254 eligible set
   * (message / request_help / challenge) is 2-4 names carried in `meta.eligible` while `to` stays
   * `{kind:'team'}`, because routing still fans out to the team.
   *
   * Every name is treated identically — the sender walks to each desk in turn, the same trip it
   * makes for a single recipient (nick, 2026-09-02). Anything less would make "either of you" a
   * second-class act in the room while the ledger treats all of them as equally on the hook.
   */
  const recipients: string[] =
    to.kind === 'member' ? [to.name] : (eligibleOf(env.meta)?.filter((n) => n !== from) ?? []);

  // Lane open/resolve/handoff (ADR 083 §4: an ordinary `message` + meta, no new act) get their own
  // choreography instead of collapsing into the generic team megaphone or 1:1 note.
  if (lane === 'lane_open') return { kind: 'screen-pulse', who: from, tone };
  if (lane === 'lane_resolve') return { kind: 'resolve', who: from };
  if (lane === 'lane_handoff') {
    return to.kind === 'member'
      ? { kind: 'walk-handoff', from, to: to.name, label: env.body.slice(0, 24) }
      : { kind: 'megaphone', from };
  }

  switch (env.act) {
    case 'status_update':
      return { kind: 'screen-pulse', who: from, tone };
    case 'message':
      return recipients.length > 0
        ? { kind: 'note', from, to: recipients, tone }
        : { kind: 'megaphone', from };
    case 'request_help':
      return recipients.length > 0
        ? { kind: 'walk-help', from, to: recipients, tier: urgent ? 'urgent' : 'needs-attn' }
        : { kind: 'megaphone', from };
    case 'handoff':
      return to.kind === 'member'
        ? { kind: 'walk-handoff', from, to: to.name, label: env.body.slice(0, 24) }
        : { kind: 'megaphone', from };
    case 'accept':
      // Directed accepts carry the celebrant: the RECIPIENT is whose work was just accepted, and
      // the celebration (confetti, neighbor glances) belongs over their desk, not the acceptor's.
      return { kind: 'accept', who: from, of: to.kind === 'member' ? to.name : null };
    case 'decline':
      return { kind: 'decline', who: from };
    case 'wait':
      return { kind: 'wait', who: from };
    case 'resolve':
      return { kind: 'resolve', who: from };
    // Steering acts (ADR 103) — a redirect is directed at a member (or the team); `defer` is a plan
    // mutation and always sender-anchored (its target is a Goal, not a member).
    case 'steer':
      return { kind: 'steer', from, to: to.kind === 'member' ? to.name : null, urgent };
    case 'challenge':
      return { kind: 'challenge', from, to: recipients, urgent };
    case 'defer':
      return { kind: 'defer', who: from };
    default:
      return null;
  }
}

/**
 * The bubble EVERY act speaks (typed out over the sender's head) — the office's legible counterpart
 * to the stream. Body-less acts (accept/decline/wait/resolve…) speak their act label so nothing on
 * the team passes invisibly; the envelope id makes the bubble a click-through to the same act in
 * the stream panel; a directed act carries its recipient so "You were right, I'll take the
 * handoff…" can't float with no way to know who "you" is.
 *
 * Pure and constructed HERE, not at the component's emit site: the addressee passthrough was
 * originally assembled inline in OfficeScene.tsx, where reverting it to `addressee: null` left
 * every suite green (ryder's 01M0GVNBHA acceptance addendum — only the rule was pinned, not the
 * construction calling it).
 */
export function speechEventFor(env: Envelope): Extract<OfficeEvent, { kind: 'speech' }> {
  return {
    kind: 'speech',
    who: env.from,
    text: env.body && env.body.trim() ? stripSenderPrefix(env.from, env.body) : actLabel(env.act),
    tone: actTone(env.act),
    id: env.id,
    act: env.act,
    // `eligibleOf` is the protocol's single reader of the shape, deliberately shared so no package
    // can interpret an eligible set differently from the schema that validated it.
    addressee: speechAddressee(env.to, env.from, eligibleOf(env.meta)),
    /* The act's mark (speech.ts `speechMark`) — computed HERE, at the one place a bubble event is
       built from an envelope, for the reason this function exists at all: assembled inline in the
       scene it would be a projection no test holds. A lane transition arrives as a plain `message`
       + meta, so the recovered lane kind has to be passed in — the act alone cannot see it. */
    marking: speechMark(env.act, env.meta, laneEvent(env)),
  };
}

/**
 * A bubble does not name its own speaker. Seats open most of what they say with their own name —
 * `miley: #1258 merged …` — because in the stream and the inbox the line stands apart from its
 * author. Over the sender's head the name is the person under the bubble, so the prefix is the
 * one thing on the floor that says twice what the room says once (nick, 2026-09-03). Only the
 * SENDER's name is stripped, and only at the very start: `nick: ` on a bubble ada speaks is
 * quoted text and stays. The recipient line above the text on a directed act is a different
 * fact and is untouched — that one says who "you" is.
 */
export function stripSenderPrefix(from: string, body: string): string {
  const n = from.length + 1;
  if (body.slice(0, n).toLowerCase() !== `${from.toLowerCase()}:`) return body;
  return body.slice(n).trimStart() || body;
}

/**
 * The walk requests a `walk-help` turns into — one per seat, in the order the sender named them.
 *
 * Pure and here rather than inline in the scene's event switch, for the reason ryder's 01M0GVNBHA
 * acceptance established and dolly's #1158 review repeated: a fan-out written inline is a fan-out
 * no test holds. Mutating the scene's loop to `ev.to.slice(0, 1)` — walk only the first of an
 * eligible set — left all 890 web tests green before this existed.
 *
 * `actors.walk` queues per call (one trip in flight, up to three pending), so a set at the
 * `MAX_ELIGIBLE` cap of four drains without the backlog guard dropping a leg.
 */
export function helpWalks(ev: Extract<OfficeEvent, { kind: 'walk-help' }>): WalkReq[] {
  return ev.to.map((to) => ({ kind: 'help' as const, to, urgent: ev.tier === 'urgent' }));
}

/** One trip the scene hands to `actors.walk`. */
export interface WalkReq {
  kind: 'help';
  to: string;
  urgent: boolean;
}
