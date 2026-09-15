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

  it('never passes an unread the limit hid — the whole defect', () => {
    const plan = planInboxCheck(ordered(120), 50);
    // Newest-first relevance is preserved: the reader still gets the 50 that matter most.
    expect(plan.shown).toHaveLength(50);
    expect(plan.shown[0]!.id).toBe('m70');
    expect(plan.shown.at(-1)!.id).toBe('m119');
    // …and the 70 it could not show in full are not marked read behind the reader: they are either
    // rendered in digest form (lane 01M2GT874Y) or left unread, never silently consumed.
    const rendered = new Set([...plan.shown, ...plan.digested].map((e) => e.id));
    const passed = ordered(120).slice(
      0,
      ordered(120).findIndex((e) => e.id === plan.advanceTo) + 1,
    );
    for (const e of passed) expect(rendered.has(e.id)).toBe(true);
    expect(plan.elided + plan.digested.length).toBe(70);
  });

  it('holds at the exact boundary — a full view with nothing behind it still advances', () => {
    const plan = planInboxCheck(ordered(50), 50);
    expect(plan.elided).toBe(0);
    expect(plan.advanceTo).toBe('m49');
  });

  it('one over the boundary does not consume the one unseen', () => {
    const plan = planInboxCheck(ordered(51), 50);
    expect(plan.shown.map((e) => e.id)).not.toContain('m0');
    // Either it is rendered in digest form and passed, or it is elided and the cursor holds.
    if (plan.advanceTo !== null) expect(plan.digested.map((e) => e.id)).toContain('m0');
    else expect(plan.elided).toBe(1);
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

  it('holds the cursor for unread the FETCH could not carry, not only for what the slice cut', () => {
    // The daemon now bounds an unbounded inbox read, so `ordered` is no longer proof of how much is
    // waiting: a complete-looking slice can sit on top of thousands the fetch never returned. If the
    // count the server reports were ignored here, this call would advance the watermark past every
    // one of them — ADR 287's loss, reached through the fetch instead of through the slice.
    const plan = planInboxCheck(ordered(50), 50, 4_800);
    expect(plan.shown).toHaveLength(50);
    expect(plan.elided).toBe(4_800);
    expect(plan.advanceTo).toBeNull();
  });

  it('still advances when the fetch carried everything', () => {
    const plan = planInboxCheck(ordered(10), 50, 0);
    expect(plan.elided).toBe(0);
    expect(plan.advanceTo).not.toBeNull();
  });

  it('keeps an old unread handoff when the newest slice is team broadcasts', () => {
    const handoff = env('handoff-old', 1, {
      act: 'handoff',
      to: { kind: 'member', name: 'Ada' },
    });
    const plan = planInboxCheck([handoff, ...ordered(100)], 50);
    expect(plan.shown.map((e) => e.id)).toContain('handoff-old');
    expect(plan.shown.map((e) => e.id)).toContain('m99');
    // A bounded fetch is the case that cannot digest, and there the pinned row still holds the cursor.
    expect(planInboxCheck([handoff, ...ordered(100)], 50, 10).advanceTo).toBeNull();
  });

  it('names a drain limit that covers the elided unread, not the fetched slice', () => {
    const plan = planInboxCheck(ordered(50), 50, 100);
    expect(plan.shown).toHaveLength(50);
    expect(plan.elided).toBe(100);
    expect(plan.drainLimit).toBe(150);
  });

  it('pins an old unread ask so newest-N broadcasts cannot bury it', () => {
    const asked = env('ask-old', 1, {
      act: 'ask',
      to: { kind: 'member', name: 'Ada' },
    });
    const plan = planInboxCheck([asked, ...ordered(100)], 50);
    expect(plan.shown.map((e) => e.id)).toContain('ask-old');
    expect(planInboxCheck([asked, ...ordered(100)], 50, 10).advanceTo).toBeNull();
  });

  it('does not pin an ask this seat already answered — answered is not waiting', () => {
    const asked = env('ask-old', 1, {
      act: 'ask',
      to: { kind: 'member', name: 'Ada' },
    });
    const plan = planInboxCheck([asked, ...ordered(100)], 50, 0, ['ask-old']);
    expect(plan.shown.map((e) => e.id)).not.toContain('ask-old');
    // The 100 broadcasts still overflow the limit; the answered ask drains with the digest instead of
    // occupying the view (ADR 287 + lane 01M2GT874Y).
    expect(plan.digested.map((e) => e.id)).toContain('ask-old');
  });
});

/**
 * The cursor treadmill (lane 01M2GT874Y, measured 2026-09-14). Holding the cursor ENTIRELY on any
 * elision made the state self-sustaining: a seat past its `limit` elided on every check, advanced
 * never, and so stayed past its limit. delta's cursor sat unmoved for 9.9 days across 22 checks on
 * 6 days; stanley's for 101 minutes across 6 checks — single-machine on the hub, so not federation.
 *
 * The fix keeps ADR 287's rule exactly — the cursor never passes a row this call did not render —
 * and changes what "render" covers: the oldest unread, contiguous from the cursor, are rendered as
 * one-line digest entries (bounded per call), so the watermark can walk over them. A seat behind by
 * any amount now drains at the default limit in a bounded number of ordinary checks.
 */
describe('planInboxCheck — a seat behind by more than `limit` still drains (lane 01M2GT874Y)', () => {
  /** Walk the seat's checks the way the tool does: what `advanceTo` names is read next time. */
  function drain(total: number, limit: number) {
    let unread = ordered(total);
    const rendered = new Set<string>();
    let calls = 0;
    while (unread.length > 0 && calls < 100) {
      const plan = planInboxCheck(unread, limit);
      calls++;
      for (const e of plan.shown) rendered.add(e.id);
      for (const e of plan.digested) rendered.add(e.id);
      if (plan.advanceTo === null) break;
      const cut = unread.findIndex((e) => e.id === plan.advanceTo);
      // The watermark is positional: everything at or before advanceTo becomes read.
      for (const e of unread.slice(0, cut + 1)) {
        expect(rendered.has(e.id)).toBe(true);
      }
      unread = unread.slice(cut + 1);
    }
    return { calls, left: unread.length, rendered };
  }

  it('FALSIFIER: a seat 700 behind, checking at the default limit, advances its cursor', () => {
    const plan = planInboxCheck(ordered(700), 50);
    expect(plan.advanceTo).not.toBeNull();
  });

  it('reaches zero unread through ordinary checks, and every row was rendered before it was passed', () => {
    const { calls, left, rendered } = drain(700, 50);
    expect(left).toBe(0);
    expect(rendered.size).toBe(700);
    // Bounded, and not "one giant drain": the digest is capped so a call stays readable.
    expect(calls).toBeGreaterThan(1);
    expect(calls).toBeLessThanOrEqual(5);
  });

  it('digests the OLDEST rows contiguously from the cursor and shows the newest in full', () => {
    const plan = planInboxCheck(ordered(700), 50);
    expect(plan.shown.map((e) => e.id)).toEqual(
      ordered(700)
        .slice(650)
        .map((e) => e.id),
    );
    expect(plan.digested[0]!.id).toBe('m0');
    expect(plan.digested.at(-1)!.id).toBe(`m${plan.digested.length - 1}`);
    // advanceTo is the end of the contiguous rendered prefix, never a row in the unrendered middle.
    expect(plan.advanceTo).toBe(plan.digested.at(-1)!.id);
    expect(plan.elided).toBe(700 - 50 - plan.digested.length);
    expect(plan.drainLimit).toBe(700);
  });

  it('when the digest reaches the full slice, everything is rendered and the cursor goes to the newest', () => {
    const plan = planInboxCheck(ordered(120), 50);
    expect(plan.shown).toHaveLength(50);
    expect(plan.digested.map((e) => e.id)).toEqual(ordered(70).map((e) => e.id));
    expect(plan.elided).toBe(0);
    expect(plan.advanceTo).toBe('m119');
  });

  it('never digests what the FETCH did not carry — an incomplete slice still holds the cursor', () => {
    // `ordered` is the newest tail of a bounded fetch, so it is not contiguous with the cursor:
    // digesting its oldest rows and advancing would step over everything the fetch cut.
    const plan = planInboxCheck(ordered(120), 50, 30);
    expect(plan.digested).toEqual([]);
    expect(plan.advanceTo).toBeNull();
    expect(plan.elided).toBe(100);
  });

  it('a pinned need inside the digest range is shown in full, once, and the cursor passes it', () => {
    const handoff = env('handoff-old', 1, { act: 'handoff', to: { kind: 'member', name: 'Ada' } });
    const plan = planInboxCheck([handoff, ...ordered(700)], 50);
    expect(plan.shown.map((e) => e.id)).toContain('handoff-old');
    expect(plan.digested.map((e) => e.id)).not.toContain('handoff-old');
    const cut = ordered(700).findIndex((e) => e.id === plan.advanceTo);
    expect(cut).toBeGreaterThan(0);
  });

  it('a pinned need BEYOND the digest range stays unread and is pinned again next call', () => {
    const handoff = env('handoff-mid', 1400, {
      act: 'handoff',
      to: { kind: 'member', name: 'Ada' },
    });
    // ts 1400 sits at index ~400 of 700 — past the digest window, before the newest 50.
    const rows = [...ordered(700), handoff].sort((a, b) => a.ts - b.ts);
    const plan = planInboxCheck(rows, 50);
    expect(plan.shown.map((e) => e.id)).toContain('handoff-mid');
    const advanced = rows.findIndex((e) => e.id === plan.advanceTo);
    expect(advanced).toBeLessThan(rows.findIndex((e) => e.id === 'handoff-mid'));
  });

  it('a discharged ask in the digest range is drained by it rather than pinned forever', () => {
    const asked = env('ask-old', 1, { act: 'ask', to: { kind: 'member', name: 'Ada' } });
    const plan = planInboxCheck([asked, ...ordered(700)], 50, 0, ['ask-old']);
    expect(plan.shown.map((e) => e.id)).not.toContain('ask-old');
    expect(plan.digested.map((e) => e.id)).toContain('ask-old');
  });
});
