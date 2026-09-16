import type { Envelope } from '@musterd/protocol';
import { describe, expect, it } from 'vitest';
import { planInboxCheck } from './inboxCheck.js';

/**
 * The drain must run on the fetch the tool ACTUALLY performs (lane 01M2NGB60Q).
 *
 * Lane 01M2GT874Y made the walk ordinary and proved it — but it proved it against `ordered` arrays
 * built in the test, and `planInboxCheck` was handed every unread row. The tool never sees that.
 * `registerInboxCheck` always passes a `limit` (`args.limit ?? 50`, inboxCheck.ts), and a named
 * `limit` selects the NEWEST TAIL on the server (`listInbox`, server/src/store/messages.ts:278 —
 * "take the NEWEST `limit` (DESC + LIMIT)"); the oldest-first PREFIX read (`headLimit`) is served
 * only to a caller that names NO limit (server/src/transport/http.ts:5590). A tail does not begin
 * at the cursor, so the fetch reports `unread_remaining > 0`, the digest block is skipped, and
 * `advanceTo` is null. Every check. Forever.
 *
 * MEASURED 2026-09-16 ~16:2xZ, adapter fb283e5c, seat stanley on revive: two consecutive
 * `team_inbox_check` calls (default, then `limit: 3`) each returned 01M2H1TP9D as their oldest row
 * with no digest lines, `elided_unread` 338 then 361. Zero rows walked; the count grew only
 * because new acts landed. sloane, same build, 2090 behind: the default check moved the cursor
 * zero and `limit: 2100` walked 56 — the escape hatch works because a tail that big covers the
 * whole backlog, which is the one case where the tail IS contiguous with the cursor.
 *
 * So the fix cannot live in the slicing. The call has to fetch the prefix as well as the tail, and
 * these tests model the server's two reads faithfully rather than an unbounded array.
 */

function env(id: string, ts: number, extra: Partial<Envelope> = {}): Envelope {
  return {
    id,
    from: 'stanley',
    act: 'message',
    body: id,
    ts,
    to: { kind: 'team' },
    ...extra,
  } as Envelope;
}

const unreadFrom = (n: number) => Array.from({ length: n }, (_, i) => env(`m${i}`, 1000 + i));

/** Waiting acts the server pins into a bounded page (listInbox, messages.ts:290). */
function isPinned(e: Envelope): boolean {
  if (e.act === 'request_help' || e.act === 'ask') return true;
  return e.to?.kind === 'member' && e.act !== 'message' && e.act !== 'resolve';
}

/**
 * `GET /inbox?unread=1&limit=N` as the daemon answers it: the newest N, union the pinned waiting
 * acts, ascending; plus the count this reply could not carry.
 */
function fetchTail(unread: Envelope[], limit: number) {
  const byId = new Map<string, Envelope>();
  for (const e of unread.slice(Math.max(0, unread.length - limit))) byId.set(e.id, e);
  for (const e of unread.filter(isPinned)) byId.set(e.id, e);
  const messages = [...byId.values()].sort((a, b) => a.ts - b.ts || a.id.localeCompare(b.id));
  return { messages, unread_remaining: unread.length - messages.length };
}

/** `GET /inbox?unread=1` with NO limit: the oldest `headLimit` — a prefix that starts at the cursor. */
function fetchHead(unread: Envelope[], headLimit = 200) {
  return { messages: unread.slice(0, headLimit) };
}

describe('the default check drains (lane 01M2NGB60Q)', () => {
  it('FALSIFIER: a seat 700 behind, at the default limit, walked ZERO rows on the tail alone', () => {
    const unread = unreadFrom(700);
    const tail = fetchTail(unread, 50);
    // This is exactly what the tool did: plan over the tail, with the fetch remainder as the bound.
    const plan = planInboxCheck(tail.messages, 50, tail.unread_remaining);
    expect(plan.digested).toEqual([]);
    expect(plan.advanceTo).toBeNull();
  });

  it('with the prefix in hand, the same call advances over what it rendered', () => {
    const unread = unreadFrom(700);
    const tail = fetchTail(unread, 50);
    const head = fetchHead(unread);
    const plan = planInboxCheck(tail.messages, 50, tail.unread_remaining, [], head.messages);
    expect(plan.advanceTo).not.toBeNull();
    expect(plan.digested.length).toBeGreaterThan(0);
    // The walk starts AT the cursor — the oldest unread — never in the unrendered middle.
    expect(plan.digested[0]!.id).toBe('m0');
  });

  it('reaches zero unread through ordinary default checks, rendering every row before passing it', () => {
    let unread = unreadFrom(700);
    const rendered = new Set<string>();
    let calls = 0;
    while (unread.length > 0 && calls < 100) {
      const tail = fetchTail(unread, 50);
      const head = fetchHead(unread);
      const plan = planInboxCheck(tail.messages, 50, tail.unread_remaining, [], head.messages);
      calls++;
      for (const e of [...plan.shown, ...plan.digested]) rendered.add(e.id);
      expect(plan.advanceTo).not.toBeNull();
      const cut = unread.findIndex((e) => e.id === plan.advanceTo);
      // The watermark is positional: everything at or before advanceTo becomes read, so every one
      // of those rows must have been rendered by some call before it was passed (ADR 287).
      for (const e of unread.slice(0, cut + 1)) expect(rendered.has(e.id)).toBe(true);
      unread = unread.slice(cut + 1);
    }
    expect(unread).toHaveLength(0);
    expect(rendered.size).toBe(700);
    expect(calls).toBeLessThanOrEqual(8);
  });

  it('holds the cursor when the PREFIX itself was cut short of a row it did not render', () => {
    // A head bounded at 200 out of 700 is still contiguous from the cursor, so the walk is legal —
    // but it must stop inside what it rendered, never at the end of a prefix it never reached.
    const unread = unreadFrom(700);
    const plan = planInboxCheck(
      fetchTail(unread, 50).messages,
      50,
      fetchTail(unread, 50).unread_remaining,
      [],
      fetchHead(unread, 200).messages,
    );
    const advanced = unread.findIndex((e) => e.id === plan.advanceTo);
    const renderedIds = new Set([...plan.shown, ...plan.digested].map((e) => e.id));
    for (const e of unread.slice(0, advanced + 1)) expect(renderedIds.has(e.id)).toBe(true);
  });

  it('a prefix the caller could not fetch changes nothing — the old behaviour, unchanged', () => {
    const unread = unreadFrom(700);
    const tail = fetchTail(unread, 50);
    const plan = planInboxCheck(tail.messages, 50, tail.unread_remaining, [], []);
    expect(plan.advanceTo).toBeNull();
  });
});
