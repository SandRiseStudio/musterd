import type { NextBrief } from '@musterd/protocol';
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
