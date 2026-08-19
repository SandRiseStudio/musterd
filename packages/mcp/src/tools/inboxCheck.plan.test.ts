import type { Envelope } from '@musterd/protocol';
import { describe, expect, it } from 'vitest';
import { planInboxCheck } from './inboxCheck.js';

/**
 * The read cursor never advances past an unread the view did not render (ADR 287).
 *
 * `team_inbox_check` kept the newest `limit` of the unread set and then marked the newest message
 * read. The cursor is a single `last_read_ts` watermark (`server/src/store/cursors.ts`), so that
 * one call jumped it past every older unread the slice had just discarded — messages the reader
 * never saw and that will never be unread again.
 *
 * Measured 2026-08-19 against the live ledger: in its busiest 4-hour window every seat on this team
 * could see 163-186 messages (izzo 184, miley 180, stanley 172, wanderer 170, gptbot 165) against a
 * default limit of 50. The worst case silently consumes 136 of them.
 *
 * The CLI has always held the invariant and says so at `cli/src/commands/inbox.ts:20` — "All unread
 * are always shown even when they exceed this — the read cursor never advances past an unread the
 * view didn't render." This is that same guarantee, on the surface every agent seat actually uses.
 */

function env(id: string, ts: number): Envelope {
  return { id, from: 'stanley', act: 'message', body: id, ts } as Envelope;
}

/** Ascending by ts, the order the tool builds before it slices. */
const ordered = (n: number) => Array.from({ length: n }, (_, i) => env(`m${i}`, 1000 + i));

describe('planInboxCheck — no unread is consumed unseen (ADR 287)', () => {
  it('advances the cursor over a burst that fits', () => {
    const plan = planInboxCheck(ordered(10), 50);
    expect(plan.shown).toHaveLength(10);
    expect(plan.elided).toBe(0);
    // Nothing was hidden, so the watermark may move to the newest.
    expect(plan.advanceTo).toBe('m9');
  });

  it('REFUSES to advance when the limit hid older unread — the whole defect', () => {
    const plan = planInboxCheck(ordered(120), 50);
    // Newest-first relevance is preserved: the reader still gets the 50 that matter most.
    expect(plan.shown).toHaveLength(50);
    expect(plan.shown[0]!.id).toBe('m70');
    expect(plan.shown.at(-1)!.id).toBe('m119');
    // …but the 70 it could not show stay unread rather than being marked read behind the reader.
    expect(plan.elided).toBe(70);
    expect(plan.advanceTo).toBeNull();
  });

  it('holds at the exact boundary — a full view with nothing behind it still advances', () => {
    const plan = planInboxCheck(ordered(50), 50);
    expect(plan.elided).toBe(0);
    expect(plan.advanceTo).toBe('m49');
  });

  it('one over the boundary stops the cursor', () => {
    const plan = planInboxCheck(ordered(51), 50);
    expect(plan.elided).toBe(1);
    expect(plan.advanceTo).toBeNull();
  });

  it('an empty inbox advances nothing and invents no id', () => {
    const plan = planInboxCheck([], 50);
    expect(plan.shown).toEqual([]);
    expect(plan.elided).toBe(0);
    expect(plan.advanceTo).toBeNull();
  });

  it('a reader who raises the limit drains the backlog and the cursor follows', () => {
    // The escape hatch the notice names has to actually work, or the seat livelocks on the same 50.
    const plan = planInboxCheck(ordered(120), 200);
    expect(plan.shown).toHaveLength(120);
    expect(plan.elided).toBe(0);
    expect(plan.advanceTo).toBe('m119');
  });
});
