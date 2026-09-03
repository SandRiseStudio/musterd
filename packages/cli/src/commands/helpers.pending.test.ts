import { PROTOCOL_VERSION, type Envelope } from '@musterd/protocol';
import { describe, expect, it, vi } from 'vitest';
import type { HttpClient } from '../client.js';
import { pendingActionSummary } from './helpers.js';

function env(partial: Partial<Envelope>): Envelope {
  return {
    id: 'm1',
    v: PROTOCOL_VERSION,
    team: 'dawn',
    from: 'Ada',
    to: { kind: 'member', name: 'nick' },
    act: 'request_help',
    body: 'review please',
    ts: Date.UTC(2026, 7, 19, 22, 18),
    ...partial,
  } as Envelope;
}

type InboxReply = Awaited<ReturnType<HttpClient['inbox']>>;

/**
 * The banner said "8 acts waiting" to a human whose inbox held 120: `pendingActionSummary` read ONE
 * unread page, the daemon caps a pageless read at 200 (a PREFIX, ADR 287), and nothing paged on.
 * The count was "acts in the oldest 200 unread", and `since` the oldest of that page — an artefact
 * of the bound, reported as the total. The summary must walk every page the way `inbox` does.
 */
describe('pendingActionSummary walks every unread page (the banner counts the total, not a prefix)', () => {
  it('pages on `truncated` with since = the last envelope position, and counts across pages', async () => {
    const page1: InboxReply = {
      messages: [
        env({ id: 'a', ts: 1_000, received_at: 1_000 }),
        env({ id: 'b', ts: 2_000, received_at: 2_000, act: 'status_update', to: { kind: 'team' } }),
      ],
      cursor: { last_read_ts: 0 },
      truncated: true,
      answered: ['zz'],
    };
    const page2: InboxReply = {
      messages: [env({ id: 'c', ts: 3_000, received_at: 3_000, act: 'ask' })],
      cursor: { last_read_ts: 0 },
      truncated: true,
      discharged: [{ id: 'd', by: 'Bob' }],
    };
    const page3: InboxReply = {
      messages: [
        env({ id: 'd', ts: 4_000, received_at: 4_000 }),
        env({ id: 'e', ts: 5_000, received_at: 5_000, act: 'handoff' }),
      ],
      cursor: { last_read_ts: 0 },
    };
    const inbox = vi
      .fn<HttpClient['inbox']>()
      .mockResolvedValueOnce(page1)
      .mockResolvedValueOnce(page2)
      .mockResolvedValueOnce(page3);
    const http = { inbox } as unknown as HttpClient;

    const pending = await pendingActionSummary(http, 'dawn', 'nick');

    expect(inbox).toHaveBeenCalledTimes(3);
    expect(inbox.mock.calls[0]?.[1]).toEqual({ unread: true });
    expect(inbox.mock.calls[1]?.[1]).toEqual({ unread: true, since: 2_000 });
    expect(inbox.mock.calls[2]?.[1]).toEqual({ unread: true, since: 3_000 });
    // a, c, e are action-needed; d was discharged on page 2 (stand-downs union across pages).
    expect(pending?.count).toBe(3);
    expect(pending?.since).toBe(1_000);
    expect(pending?.waiting.map((m) => m.id)).toEqual(['a', 'c', 'e']);
  });

  it('stops on a page that is not truncated (an older daemon: one page, the prior behaviour)', async () => {
    const inbox = vi.fn<HttpClient['inbox']>().mockResolvedValue({
      messages: [env({ id: 'a' })],
      cursor: { last_read_ts: 0 },
    });
    const pending = await pendingActionSummary({ inbox } as unknown as HttpClient, 'dawn', 'nick');
    expect(inbox).toHaveBeenCalledTimes(1);
    expect(pending?.count).toBe(1);
  });

  it('returns undefined when nothing waits', async () => {
    const inbox = vi.fn<HttpClient['inbox']>().mockResolvedValue({
      messages: [env({ id: 'a', act: 'status_update', to: { kind: 'team' } })],
      cursor: { last_read_ts: 0 },
    });
    expect(
      await pendingActionSummary({ inbox } as unknown as HttpClient, 'dawn', 'nick'),
    ).toBeUndefined();
  });
});
