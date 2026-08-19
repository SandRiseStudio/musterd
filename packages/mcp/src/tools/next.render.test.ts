import type { Lane, NextBrief } from '@musterd/protocol';
import { describe, expect, it } from 'vitest';
import { fmtNext } from './lanes.js';

function brief(why: NextBrief['why']): NextBrief {
  return { member: 'miley', in_flight: [], up_next: [], shipped: [], next_goal: null, why };
}

describe('fmtNext — the `why` slot carries its age (ADR 264)', () => {
  // The CLI has always dated this line; the MCP rendering did not, so a seat reading `team_next`
  // through the harness saw a handoff with no way to tell a live instruction from a month-old one.
  // Every stale-why incident so far was found by someone noticing the CONTENT was dead — the age is
  // what lets the reader notice first.
  it('renders the handoff age alongside its author', () => {
    const out = fmtNext(
      brief({
        from: 'stanley',
        body: 'packages/web a11y is now uncovered',
        ts: Date.now() - 15 * 24 * 60 * 60 * 1000,
        goal_id: null,
      }),
    );
    expect(out).toContain('why — handoff from stanley');
    expect(out).toContain('15d ago');
  });

  it('keeps the goal when the handoff names one', () => {
    const out = fmtNext(
      brief({ from: 'nick', body: 'pick up the spine', ts: Date.now(), goal_id: 'orientation' }),
    );
    expect(out).toContain('goal=orientation');
  });
});

describe('fmtNext — incident banner leads (spec 2026-08-14 inc 1)', () => {
  it('renders an unclaimed incident first, above everything', () => {
    const b = brief(null);
    b.incidents = [
      {
        lane: '01LANE',
        gate: 'ci:gates/A11y contrast',
        owner_seat: null,
        opened_at: Date.now() - 2 * 60 * 60 * 1000,
      },
    ];
    const out = fmtNext(b);
    const lines = out.split('\n');
    expect(lines[1]).toContain(
      '⚠ incident: ci:gates/A11y contrast — UNCLAIMED (lane 01LANE, open 2h)',
    );
    expect(lines[2]).toContain('park behind it');
  });

  it('renders the owner when claimed, and nothing without incidents (daemon skew tolerated)', () => {
    const owned = brief(null);
    owned.incidents = [{ lane: '01LANE', gate: 'g', owner_seat: 'miley', opened_at: Date.now() }];
    expect(fmtNext(owned)).toContain('owned by miley');
    const skew = brief(null);
    delete (skew as Partial<NextBrief>).incidents;
    expect(fmtNext(skew)).not.toContain('incident');
  });
});

/**
 * The falsifier of ADR 283: a seat reading its brief can tell a lane nobody was asked to review
 * from one whose reviewer went silent — without writing SQL.
 *
 * `unconfirmed` is the word both situations printed before this, and the correct response to each
 * is the response the other one wastes. This is the surface the falsifier names, so it is the
 * surface that has to prove it.
 */
describe('fmtNext — an unconfirmed close says WHY (ADR 283)', () => {
  function shippedBrief(lane: Partial<Lane>): NextBrief {
    const b = brief(null);
    b.shipped = [
      {
        id: '01LANE',
        team: 'revive',
        project: 'agents',
        title: 'the lane',
        detail: '',
        kind: null,
        owner_seat: 'izzo',
        role: null,
        surface_globs: [],
        depends_on: [],
        branch: null,
        goal_id: null,
        risk: [],
        stakes: 'normal',
        stakes_provenance: 'declared',
        merged: null,
        state: 'done',
        created_by: 'izzo',
        created_at: 0,
        claimed_at: null,
        resolved_at: null,
        updated_at: 0,
        ...lane,
      } as Lane,
    ];
    return b;
  }

  it('sends the reader to the ROSTER when no counterpart existed', () => {
    const out = fmtNext(shippedBrief({ verified: false, close_reason: 'no_candidate' }));
    expect(out).toContain('unconfirmed');
    expect(out).toContain('nobody was asked — no eligible counterpart');
  });

  it('sends the reader to a PERSON when one was asked and went silent', () => {
    const out = fmtNext(shippedBrief({ verified: false, close_reason: 'review_timeout' }));
    expect(out).toContain('unconfirmed');
    expect(out).toContain('asked, and the wait ran out');
  });

  it('stays quiet on an accepted close — the reason would only repeat the chip', () => {
    const out = fmtNext(shippedBrief({ verified: true, close_reason: 'counterpart_confirm' }));
    expect(out).not.toContain('unconfirmed');
    expect(out).not.toContain('(');
  });

  it('renders exactly as before when the close recorded no reason (daemon skew)', () => {
    const out = fmtNext(shippedBrief({ verified: false }));
    expect(out).toContain('unconfirmed');
    // No parenthetical invented for a close that said nothing.
    expect(out).not.toContain('nobody was asked');
  });
});
