import { describe, expect, it } from 'vitest';
import { slackSeedVerdict } from './slackVerdict.js';

const message = (over: Record<string, unknown> = {}) => ({
  type: 'event_callback',
  event: { type: 'message', text: 'an idea', user: 'U1', channel: 'C1', ts: '1.0', ...over },
});

describe('slackSeedVerdict', () => {
  it('accepts a plain human channel message', () => {
    expect(slackSeedVerdict(message(), undefined)).toEqual({ seed: true, reason: 'seed' });
  });

  it('names the handshake rather than calling it a rejection of a message', () => {
    expect(slackSeedVerdict({ type: 'url_verification', challenge: 'x' }, undefined).reason).toBe(
      'handshake',
    );
  });

  // The two that are load-bearing rather than defensive: bot messages are what would let the
  // "🌱 saved" confirmation re-enter as a seed, and a thread is talk ABOUT a seed.
  it('rejects bot messages, so the confirmation cannot loop', () => {
    expect(slackSeedVerdict(message({ bot_id: 'B1' }), undefined).reason).toBe('bot_message');
  });

  it('rejects threaded replies', () => {
    expect(slackSeedVerdict(message({ thread_ts: '1.0' }), undefined).reason).toBe(
      'threaded_reply',
    );
  });

  it('rejects edits/joins//other subtypes', () => {
    expect(slackSeedVerdict(message({ subtype: 'channel_join' }), undefined).reason).toBe(
      'has_subtype',
    );
  });

  it('rejects whitespace-only text', () => {
    expect(slackSeedVerdict(message({ text: '   ' }), undefined).reason).toBe('empty_text');
  });

  it('honours a pinned channel, and is permissive when none is pinned', () => {
    expect(slackSeedVerdict(message({ channel: 'C_OTHER' }), 'C1').reason).toBe('other_channel');
    expect(slackSeedVerdict(message({ channel: 'C1' }), 'C1').seed).toBe(true);
    expect(slackSeedVerdict(message({ channel: 'C_ANY' }), undefined).seed).toBe(true);
  });

  it('reports the EARLIEST disqualifier, so the reason is the structural one', () => {
    // A bot message that is also threaded and empty: the reason must not be whichever clause
    // happened to be last, or the diagnostic sends the reader after the wrong thing.
    const verdict = slackSeedVerdict(
      message({ bot_id: 'B1', thread_ts: '1.0', text: '' }),
      undefined,
    );
    expect(verdict.reason).toBe('bot_message');
  });
});
