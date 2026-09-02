import { eligibleOf, type Envelope } from '@musterd/protocol';
import { actLabel, actTone, laneEvent } from '../format';
import { speechAddressee } from './speech';
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
      return to.kind === 'member'
        ? { kind: 'note', from, to: to.name, tone }
        : { kind: 'megaphone', from };
    case 'request_help':
      return to.kind === 'member'
        ? { kind: 'walk-help', from, to: to.name, tier: urgent ? 'urgent' : 'needs-attn' }
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
      return { kind: 'challenge', from, to: to.kind === 'member' ? to.name : null, urgent };
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
    text: env.body && env.body.trim() ? env.body : actLabel(env.act),
    tone: actTone(env.act),
    id: env.id,
    act: env.act,
    // `eligibleOf` is the protocol's single reader of the shape, deliberately shared so no package
    // can interpret an eligible set differently from the schema that validated it.
    addressee: speechAddressee(env.to, env.from, eligibleOf(env.meta)),
  };
}
