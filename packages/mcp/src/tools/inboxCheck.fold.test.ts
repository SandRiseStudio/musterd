import type { Envelope } from '@musterd/protocol';
import { describe, expect, it } from 'vitest';
import { formatMessage } from './format.js';
import { formatDigestLine, isAmbient, laneIdOf, planInboxCheck } from './inboxCheck.js';

/**
 * The newest tail owes the reader a RELATIONSHIP rule, not "newest N whatever they are" (ADR 433).
 *
 * ADR 429 gave the PINNED set an obligation rule and left the tail ungoverned. Measured on ryder's
 * wake of 2026-09-21 12:21 (lane 01M32QF2X4): one unfiltered `team_inbox_check` rendered 42 acts in
 * full — 17 `[lane]` transitions on lanes she does not own, 22 @team `status_update`, 1 `decline`
 * directed elsewhere, 1 @team message — and exactly ONE act that was hers, the steer that woke
 * her. 63 of 64 surfaced acts were ambient, and the reply weighed 23.7 KiB across three lives
 * whatever ADR 429 un-pinned, because `planInboxCheck` spends `RESULT_BUDGET` to the ceiling.
 *
 * So the tail folds. An ambient act — a teammate's @team status, or a lane transition on a lane the
 * reader neither owns nor depends on — is rendered as ONE LINE (sender, act, id, body head) rather
 * than in full with its meta JSON. It is still rendered, so ADR 287 holds and the cursor walks it.
 * Nothing is dropped: a fold that loses a transition a seat needed is worse than the bytes.
 */

function env(id: string, ts: number, extra: Partial<Envelope> = {}): Envelope {
  return {
    id,
    from: 'dolly',
    act: 'message',
    body: id,
    ts,
    to: { kind: 'team' },
    ...extra,
  } as Envelope;
}

const laneRow = (id: string, ts: number, lane: string, state = 'active') =>
  env(id, ts, {
    body: `[lane] "some title" → ${state}`,
    meta: { lane_state: { lane, title: 'some title', state } },
  });

/** A teammate's status at this team's median body (~592 chars, lane 01M2JZYTAH's measurement). */
const statusRow = (id: string, ts: number) =>
  env(id, ts, {
    act: 'status_update',
    body: `dolly: heads-down on B4, PR up, auto-merge armed. ${'detail '.repeat(78)}`,
  });

/** ryder's inbox, in shape: one steer to her under 40-odd ambient rows. */
function rydersInbox(): Envelope[] {
  const rows: Envelope[] = [];
  for (let i = 0; i < 17; i++) rows.push(laneRow(`l${i}`, 1000 + i, `LANE${i % 5}`));
  for (let i = 0; i < 22; i++) rows.push(statusRow(`s${i}`, 2000 + i));
  rows.push(
    env('d0', 3000, { act: 'decline', to: { kind: 'member', name: 'stanley' }, from: 'wanderer' }),
  );
  rows.push(env('m0', 3001, { body: 'migration note for everyone' }));
  rows.push(
    env('steer', 3002, { act: 'steer', to: { kind: 'member', name: 'ryder' }, from: 'izzo' }),
  );
  return rows.sort((a, b) => a.ts - b.ts);
}

describe('isAmbient — what the tail owes a reader in full', () => {
  it('a directed act is never ambient, whatever its act', () => {
    expect(isAmbient(env('a', 1, { to: { kind: 'member', name: 'me' } }), new Set())).toBe(false);
    expect(
      isAmbient(
        env('a', 1, { act: 'status_update', to: { kind: 'member', name: 'me' } }),
        new Set(),
      ),
    ).toBe(false);
  });
  it('an obligation to the team is never ambient — it is pinned, not folded', () => {
    expect(isAmbient(env('a', 1, { act: 'request_help' }), new Set())).toBe(false);
    expect(isAmbient(env('a', 1, { act: 'ask' }), new Set())).toBe(false);
  });
  it("a teammate's @team status_update is ambient", () => {
    expect(isAmbient(statusRow('s', 1), new Set())).toBe(true);
  });
  it('a plain @team message stays full — a human wrote it to everyone on purpose', () => {
    expect(isAmbient(env('m', 1), new Set())).toBe(false);
  });
  it('a lane transition is ambient unless the reader owns or depends on that lane', () => {
    expect(isAmbient(laneRow('l', 1, 'X'), new Set())).toBe(true);
    expect(isAmbient(laneRow('l', 1, 'X'), new Set(['X']))).toBe(false);
  });
  it('laneIdOf reads every lane_* broadcast shape the daemon emits', () => {
    expect(laneIdOf(laneRow('l', 1, 'X'))).toBe('X');
    expect(laneIdOf(env('l', 1, { meta: { lane_claim: { lane: 'Y', title: 't' } } }))).toBe('Y');
    expect(
      laneIdOf(
        env('l', 1, { meta: { lane_release: { lane: 'Z', title: 't', owner_before: 'a' } } }),
      ),
    ).toBe('Z');
    expect(
      laneIdOf(
        env('l', 1, { meta: { lane_resolve: { lane: 'W', title: 't', state: 'resolved' } } }),
      ),
    ).toBe('W');
    expect(
      laneIdOf(env('l', 1, { meta: { lane_open: { lane: 'V', title: 't', project: 'p' } } })),
    ).toBe('V');
    expect(laneIdOf(env('l', 1))).toBeNull();
    expect(laneIdOf(env('l', 1, { meta: { otel: {} } }))).toBeNull();
  });
});

describe("planInboxCheck — ryder's 64 (lane 01M32QF2X4)", () => {
  it('renders the ONE act that is hers in full and folds the 39 ambient to a line each', () => {
    const plan = planInboxCheck(rydersInbox(), 50);
    const shownIds = plan.shown.map((e) => e.id);
    // Hers: the steer. Directed elsewhere but visible: the decline. Written to everyone: the note.
    expect(shownIds).toEqual(['d0', 'm0', 'steer']);
    expect(plan.folded).toHaveLength(39);
    expect(plan.digested).toHaveLength(0);
    expect(plan.elided).toBe(0);
    // Every row was rendered in one form or the other, so the cursor may pass all of it.
    expect(plan.advanceTo).toBe('steer');
  });

  it('is the size win ADR 429 could not be: the same inbox weighs a fraction rendered', () => {
    const rows = rydersInbox();
    const plan = planInboxCheck(rows, 50);
    const full = rows.map(formatMessage).join('\n').length;
    const folded =
      plan.shown.map(formatMessage).join('\n').length +
      plan.folded.map(formatDigestLine).join('\n').length;
    expect(folded).toBeLessThan(full / 2);
  });

  it('keeps a transition on a lane the reader owns in full', () => {
    const plan = planInboxCheck(rydersInbox(), 50, 0, [], [], new Set(['LANE2']));
    const shownIds = new Set(plan.shown.map((e) => e.id));
    for (const e of rydersInbox()) {
      if (laneIdOf(e) === 'LANE2') expect(shownIds.has(e.id)).toBe(true);
      else if (laneIdOf(e)) expect(shownIds.has(e.id)).toBe(false);
    }
  });

  it('folds newest-first, so under a tight budget the freshest ambient survives', () => {
    // 400 status rows at ~1k each is far past the budget; the fold keeps what fits, newest first,
    // and the cursor stops at the first row it could not render (ADR 287).
    const rows = Array.from({ length: 400 }, (_, i) =>
      env(`s${i}`, 1000 + i, { act: 'status_update', body: 'x'.repeat(1000) }),
    );
    const plan = planInboxCheck(rows, 50);
    expect(plan.shown).toHaveLength(0);
    expect(plan.folded.length).toBeGreaterThan(0);
    expect(plan.folded.length).toBeLessThan(400);
    expect(plan.folded.at(-1)!.id).toBe('s399');
    expect(plan.elided).toBe(400 - plan.folded.length);
    // Unrendered rows are the OLDEST, so the cursor cannot move past the gap they leave.
    expect(plan.advanceTo).toBeNull();
  });

  it('a folded row counts as rendered for the prefix walk — the drain still reaches it', () => {
    const rows = [statusRow('s0', 1), env('m1', 2), statusRow('s2', 3)];
    const plan = planInboxCheck(rows, 50);
    expect(plan.folded.map((e) => e.id)).toEqual(['s0', 's2']);
    expect(plan.digested).toHaveLength(0);
    expect(plan.advanceTo).toBe('s2');
  });
});
