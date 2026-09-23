import type { DoorbellRecord } from '@musterd/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { postDoorbellWebhook } from './webhook.js';

const record: DoorbellRecord = {
  team: 'revive',
  from: 'dolly',
  act: 'ask',
  species: 'approve',
  tier: 'blocking',
  act_id: '01X',
  answer_path: '/live?act=01X',
};

describe('postDoorbellWebhook (ADR 443)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('POSTs the record as-is, refusing redirects', async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      seen.push({ url, init });
      return new Response(null, { status: 204 });
    });
    expect(await postDoorbellWebhook('https://ntfy.sh/t', record)).toEqual({
      ok: true,
      status: 204,
    });
    expect(JSON.parse(String(seen[0]!.init.body))).toEqual(record);
    expect(seen[0]!.init.redirect).toBe('manual');
  });

  it('a non-2xx is ok:false with its status', async () => {
    vi.stubGlobal('fetch', async () => new Response(null, { status: 302 }));
    expect(await postDoorbellWebhook('https://ntfy.sh/t', record)).toEqual({
      ok: false,
      status: 302,
    });
  });

  it('never throws: a network failure resolves ok:false with no status', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new Error('ECONNREFUSED');
    });
    expect(await postDoorbellWebhook('https://ntfy.sh/t', record)).toEqual({ ok: false });
  });
});
