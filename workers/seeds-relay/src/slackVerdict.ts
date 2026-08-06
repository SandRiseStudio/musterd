/**
 * Why a Slack delivery did or did not become a seed — as a value, so it can be asserted in a test
 * and written to a diagnostic record instead of being an invisible `return`.
 *
 * This exists because the first version of the filter was a single boolean expression inside the
 * handler. It was correct, and it was unobservable: an event that failed any clause got a 200 and
 * left no trace, so an empty buffer could not distinguish "Slack never delivered" from "delivered
 * and silently dropped". Those two have completely different fixes and identical symptoms.
 */

export interface SlackEvent {
  type?: string;
  subtype?: string;
  bot_id?: string;
  thread_ts?: string;
  text?: string;
  user?: string;
  channel?: string;
  ts?: string;
}

export interface SlackEnvelope {
  type?: string;
  challenge?: string;
  event?: SlackEvent;
}

export type SlackVerdict = { seed: true; reason: 'seed' } | { seed: false; reason: SlackRejection };

export type SlackRejection =
  | 'handshake'
  | 'not_event_callback'
  | 'not_a_message'
  | 'has_subtype'
  | 'bot_message'
  | 'threaded_reply'
  | 'empty_text'
  | 'other_channel';

/**
 * The ONE place that decides whether a delivery is a seed. Ordered most-structural first, so the
 * reason names the earliest thing that disqualified it rather than an incidental later clause.
 *
 * `bot_message` and `threaded_reply` are load-bearing, not defensive: skipping bot messages is what
 * stops the "🌱 saved" confirmation from re-entering as a new seed, and threads are conversation
 * about a seed rather than a new one.
 */
export function slackSeedVerdict(
  envelope: SlackEnvelope,
  pinnedChannel: string | undefined,
): SlackVerdict {
  if (envelope.type === 'url_verification') return { seed: false, reason: 'handshake' };
  if (envelope.type !== 'event_callback') return { seed: false, reason: 'not_event_callback' };

  const event = envelope.event;
  if (event?.type !== 'message') return { seed: false, reason: 'not_a_message' };
  if (event.subtype) return { seed: false, reason: 'has_subtype' };
  if (event.bot_id) return { seed: false, reason: 'bot_message' };
  if (event.thread_ts) return { seed: false, reason: 'threaded_reply' };
  if (typeof event.text !== 'string' || event.text.trim().length === 0) {
    return { seed: false, reason: 'empty_text' };
  }
  if (pinnedChannel && event.channel !== pinnedChannel) {
    return { seed: false, reason: 'other_channel' };
  }
  return { seed: true, reason: 'seed' };
}
