import type { Envelope } from '@musterd/protocol';
import { describe, expect, it } from 'vitest';
import { formatMessage } from './format.js';
import {
  BODY_CAP,
  RESULT_BUDGET,
  capBody,
  formatDigestLine,
  planInboxCheck,
} from './inboxCheck.js';

/**
 * The reply has a SIZE contract, not only a row contract (lane 01M2JZYTAH).
 *
 * miley started a session on 2026-09-15 and ran one ordinary `team_inbox_check`. The harness
 * refused the whole result — "exceeds maximum allowed tokens" — and wrote it to a file, so a
 * seat's first act of orientation returned a path instead of its inbox. Measured on that exact
 * payload: 90 rows, 93,222 chars of message BODY alone, 114,079 chars of structured content.
 * Median body 592 chars, max 4,593. No single monster act — the aggregate.
 *
 * Every bound in inboxCheck.ts was a ROW COUNT (`limit` 50, DIGEST_ROWS 250), and the file's own
 * header asserted the conclusion it never enforced: "the tool-result ceiling is ~70k chars; 50 full
 * rows plus this many digest lines stays well under". At today's body sizes that is false, and it
 * had been false for weeks — ten saved tool-result files across two seats' project dirs, 63KB to
 * 130KB, every one a refused reply.
 *
 * So: rows are derived from a byte budget, never the other way round. ADR 287 is untouched — a row
 * dropped for budget is either digested (and the cursor walks it) or elided (and the cursor holds).
 */

function env(id: string, ts: number, body: string, extra: Partial<Envelope> = {}): Envelope {
  return {
    id,
    from: 'stanley',
    act: 'message',
    body,
    ts,
    to: { kind: 'team' },
    ...extra,
  } as Envelope;
}

/** The shape that broke it: a long backlog of real-sized bodies, with waiting acts scattered in. */
function backlog(n: number, bodyLen: number): Envelope[] {
  return Array.from({ length: n }, (_, i) =>
    env(`m${i}`, 1000 + i, 'x'.repeat(bodyLen), {
      // Every tenth is a pinned waiting act — the set that is unioned on top of `limit` and has no
      // cap of its own. This is what made one call render 90 rows against a limit of 50.
      ...(i % 10 === 0 ? { act: 'request_help', to: { kind: 'member', name: 'Ada' } } : {}),
    }),
  );
}

/** What the tool actually hands the harness: the rendered rows plus the digest lines. */
function replySize(plan: ReturnType<typeof planInboxCheck>): number {
  return (
    plan.shown.map((m) => formatMessage(m)).join('\n').length +
    plan.digested.map(formatDigestLine).join('\n').length
  );
}

describe('planInboxCheck — the reply is bounded in BYTES', () => {
  it('holds the budget on the payload that actually failed: 1500 unread, 5k bodies', () => {
    const plan = planInboxCheck(backlog(1500, 5000), 50);
    expect(replySize(plan)).toBeLessThanOrEqual(RESULT_BUDGET);
  });

  it('holds the budget when every row is a pinned waiting act — the set with no row cap', () => {
    const all = Array.from({ length: 400 }, (_, i) =>
      env(`p${i}`, 1000 + i, 'y'.repeat(4000), {
        act: 'request_help',
        to: { kind: 'member', name: 'Ada' },
      }),
    );
    const plan = planInboxCheck(all, 50);
    expect(replySize(plan)).toBeLessThanOrEqual(RESULT_BUDGET);
    // And it must still show SOMETHING — a budget that renders nothing is the same outage.
    expect(plan.shown.length).toBeGreaterThan(0);
  });

  it('holds the budget for one act far bigger than the whole budget', () => {
    const plan = planInboxCheck([env('huge', 1000, 'z'.repeat(RESULT_BUDGET * 3))], 50);
    expect(replySize(plan)).toBeLessThanOrEqual(RESULT_BUDGET);
    expect(plan.shown).toHaveLength(1);
  });

  it('leaves an ordinary inbox completely untouched', () => {
    const plan = planInboxCheck(backlog(12, 400), 50);
    expect(plan.shown).toHaveLength(12);
    expect(plan.elided).toBe(0);
    expect(plan.advanceTo).toBe('m11');
    // No truncation marker anywhere: every body is whole.
    expect(plan.shown.every((m) => m.body.length === 400)).toBe(true);
  });

  /* ADR 287 is the invariant this change must not dent: a row the reply could not carry is not
   * quietly consumed. Dropping for BUDGET has to behave exactly like dropping for `limit`. */
  it('never advances the cursor past a row the budget dropped', () => {
    const plan = planInboxCheck(backlog(1500, 5000), 50);
    const rendered = new Set([...plan.shown, ...plan.digested].map((m) => m.id));
    expect(rendered.has(plan.advanceTo!)).toBe(true);
    const all = backlog(1500, 5000).map((m) => m.id);
    // Everything at or before the watermark was rendered in one form or the other.
    for (const id of all.slice(0, all.indexOf(plan.advanceTo!) + 1)) {
      expect(rendered.has(id)).toBe(true);
    }
  });

  it('counts every unrendered row as elided, so the reader is told', () => {
    const rows = backlog(1500, 5000);
    const plan = planInboxCheck(rows, 50);
    expect(plan.shown.length + plan.digested.length + plan.elided).toBe(rows.length);
  });
});

describe('capBody — one act cannot starve the rest, and nothing is lost', () => {
  it('leaves a body at or under the cap exactly as it was', () => {
    const e = env('a', 1, 'x'.repeat(BODY_CAP));
    expect(capBody(e)).toBe(e);
  });

  it('truncates a longer body and says how much is missing', () => {
    const e = env('a', 1, 'x'.repeat(BODY_CAP + 500));
    const capped = capBody(e);
    expect(capped.body.length).toBeLessThan(e.body.length);
    expect(capped.body).toMatch(/\+500 chars/);
  });

  /* Truncation is only honest if the rest is reachable. Before this lane nothing in the MCP surface
   * or over HTTP could fetch a message by id, so a truncated body was a lost body. */
  it('names the way to read the whole act, by id', () => {
    const capped = capBody(env('01M2ABC', 1, 'x'.repeat(BODY_CAP * 2)));
    expect(capped.body).toContain('01M2ABC');
    expect(capped.body).toMatch(/ids/);
  });
});
