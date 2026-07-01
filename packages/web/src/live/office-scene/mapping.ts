import type { Envelope } from '@musterd/protocol';
import { actTone } from '../format';
import type { OfficeEvent } from './types';

/**
 * Project a live act to office choreography (memory: act → choreography, travel-intensity == tier).
 * Pure — the scene decides how to *render* each event (lightweight cue in M1, real motion in M2). A
 * `null` return is an act we don't animate. `meta.urgent` promotes a help walk to the urgent tier.
 */
export function actToEvent(env: Envelope): OfficeEvent | null {
  const from = env.from;
  const to = env.to;
  const tone = actTone(env.act);
  const urgent = env.meta?.['urgent'] === true;

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
      return { kind: 'accept', who: from };
    case 'decline':
      return { kind: 'decline', who: from };
    case 'wait':
      return { kind: 'wait', who: from };
    case 'resolve':
      return { kind: 'resolve', who: from };
    default:
      return null;
  }
}
