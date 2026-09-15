import type { Envelope, HuddleView } from '@musterd/protocol';
import { deriveHuddles } from '@musterd/protocol/wire';

/**
 * The huddle surface's web-side reading (ADR 378 increment 2).
 *
 * The fold itself is `deriveHuddles` in the protocol package — a huddle is a thread, so what a
 * huddle IS (which rows belong to it, who is in it, whether it is closed) is a reading of the wire
 * that every surface must answer identically. This module holds only what /live and /broadcast add
 * on top: which huddles are still open, who is actually gathered in one, and the budget AS DISPLAY.
 *
 * **The budget is a declaration, never a rule.** The daemon runs no clocks and neither does this
 * page (ADR 378 §4, ADR 131 §7): nothing here closes a huddle, hides one, or greys it out for going
 * over. An over-budget huddle stays open, stays visible, and says so — that is the honest surface of
 * a team that said six turns and took nine.
 */
export interface HuddleBudgetView {
  /** Rows on the thread so far — the count readers do themselves, because nothing stores it. */
  turnsUsed: number;
  turnsDeclared?: number;
  /** Declared minus used; negative once the huddle has run past what it said. */
  turnsLeft?: number;
  overTurns: boolean;
  /** Declared end minus the clock passed in; negative once that moment is behind us. */
  msLeft?: number;
  overTime: boolean;
  /** `none` — nothing declared. `within` — inside what was declared. `spent` — past it, still open. */
  phase: 'none' | 'within' | 'spent';
}

/** Still going: a root whose thread carries no `resolve`. */
export function openHuddles(views: HuddleView[]): HuddleView[] {
  return views.filter((v) => !v.closed);
}

/**
 * Who is in the room right now — the opener and everyone who has taken a turn in a huddle that is
 * still open. Being NAMED at the root is an invitation, not attendance: a seat that never spoke is
 * not gathered, and the office must not draw it at the table as if it were.
 */
export function gatheredSeats(views: HuddleView[]): Set<string> {
  const seats = new Set<string>();
  for (const v of openHuddles(views)) for (const name of v.spoke) seats.add(name);
  return seats;
}

/**
 * The budget as it reads at `now`. Clock-dependent by construction, so it lives OUTSIDE the
 * derivation's memo — the same seam `askPhase` took (#1158): the fold is pure over the timeline and
 * re-runs only when the timeline changes; the clock re-reads on the tick.
 */
export function huddleBudget(view: HuddleView, now: number): HuddleBudgetView {
  const turnsUsed = view.turns.length;
  const declared = view.budget;
  if (!declared || (declared.turns === undefined && declared.until === undefined)) {
    return { turnsUsed, overTurns: false, overTime: false, phase: 'none' };
  }
  const turnsLeft = declared.turns === undefined ? undefined : declared.turns - turnsUsed;
  const msLeft = declared.until === undefined ? undefined : declared.until - now;
  const overTurns = turnsLeft !== undefined && turnsLeft < 0;
  const overTime = msLeft !== undefined && msLeft < 0;
  return {
    turnsUsed,
    ...(declared.turns === undefined ? {} : { turnsDeclared: declared.turns }),
    ...(turnsLeft === undefined ? {} : { turnsLeft }),
    overTurns,
    ...(msLeft === undefined ? {} : { msLeft }),
    overTime,
    phase: overTurns || overTime ? 'spent' : 'within',
  };
}

/**
 * The gathering, straight off the timeline the page already holds (backfill + the `team-all`
 * firehose, ADR 061). No endpoint, no roster, no room state — the same substrate the asks rail folds.
 * `me` is irrelevant to who is in the room, so the fold is asked for as nobody.
 */
export function gatheredFrom(envelopes: Envelope[]): Set<string> {
  return gatheredSeats(deriveHuddles(envelopes, ''));
}
