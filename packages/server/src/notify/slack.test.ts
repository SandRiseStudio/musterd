import { afterEach, describe, expect, it, vi } from 'vitest';
import { formatAskSlackText, postSlackWebhook } from './slack.js';

describe('formatAskSlackText (ADR 149)', () => {
  it('phrases each species at the human and spells the tier contract in words', () => {
    const esc = formatAskSlackText({
      team: 'revive',
      from: 'ada',
      species: 'escalate',
      tier: 'blocking',
      body: 'prod migration is destructive — need a call',
    });
    expect(esc).toContain('[revive] ada escalated to you');
    expect(esc).toContain('blocking — holds after 15m without an answer');
    expect(esc).toContain('> prod migration is destructive — need a call');
    expect(esc).toContain('Answer on /live');

    expect(
      formatAskSlackText({ team: 't', from: 'bo', species: 'approve', tier: 'standard', body: '' }),
    ).toContain('bo needs your approval (standard — proceeds with recorded risk after 5m)');
    expect(
      formatAskSlackText({ team: 't', from: 'cy', species: 'consult', tier: 'advisory', body: '' }),
    ).toContain('cy asks what you think (advisory — proceeds with recorded risk after 3m)');
  });

  it('degrades gracefully when species/tier are missing (defensive read)', () => {
    const text = formatAskSlackText({ team: 't', from: 'ada', body: 'hm' });
    expect(text).toContain('ada asks what you think');
    expect(text).not.toContain('undefined');
  });
});

describe('postSlackWebhook', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('resolves { ok, status } from the endpoint response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('ok', { status: 200 })),
    );
    await expect(postSlackWebhook('https://hooks.example.com/x', 'hi')).resolves.toEqual({
      ok: true,
      status: 200,
    });
  });

  it('never throws — a network failure resolves { ok: false }', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('ECONNREFUSED');
      }),
    );
    await expect(postSlackWebhook('https://hooks.example.com/x', 'hi')).resolves.toEqual({
      ok: false,
    });
  });
});
