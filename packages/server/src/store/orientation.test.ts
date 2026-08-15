import { makeEnvelope } from '@musterd/protocol';
import { describe, expect, it } from 'vitest';
import { openDb } from '../db/open.js';
import { recordBlockedReport } from './incidents.js';
import { openLane, updateLane } from './lanes.js';
import { addMember } from './members.js';
import { insertMessage } from './messages.js';
import { WHY_BARE_MAX_AGE_MS, deriveNext } from './orientation.js';
import { createTeam } from './teams.js';

function seed() {
  const db = openDb(':memory:');
  const team = createTeam(db, { slug: 'revive' });
  const nick = addMember(db, team, { name: 'nick', kind: 'human' }).row;
  const stanley = addMember(db, team, { name: 'stanley', kind: 'agent' }).row;
  return { db, team, nick, stanley };
}

describe('deriveNext — the orientation brief (ADR 049/084)', () => {
  it('sorts lanes into carrying / shipped / up_next from the daemon state alone', () => {
    const { db, team } = seed();
    // stanley is carrying one active lane...
    const active = openLane(db, team.id, 'revive', 'stanley', { title: 'spine', claim: true });
    updateLane(db, team.id, active.id, 'revive', { state: 'active' });
    // ...has shipped one...
    const shipped = openLane(db, team.id, 'revive', 'stanley', { title: 'migration', claim: true });
    updateLane(db, team.id, shipped.id, 'revive', { state: 'done' });
    // ...and there's an unowned lane anyone could pick up.
    const open = openLane(db, team.id, 'revive', 'nick', { title: 'backlog item' });

    const brief = deriveNext(db, team.id, 'revive', 'stanley');
    expect(brief.member).toBe('stanley');
    expect(brief.in_flight.map((l) => l.id)).toEqual([active.id]);
    expect(brief.shipped.map((l) => l.id)).toEqual([shipped.id]);
    expect(brief.up_next.map((l) => l.id)).toEqual([open.id]);
    expect(brief.why).toBeNull();
  });

  it('surfaces the latest handoff to me or @team as the why, with its goal_id', () => {
    const { db, team, nick } = seed();
    insertMessage(
      db,
      team.id,
      nick.id,
      null,
      makeEnvelope({
        id: 'h1',
        team: 'revive',
        from: 'nick',
        to: { kind: 'team' },
        act: 'handoff',
        body: 'pick up the orientation spine next',
        ts: 1_000,
        meta: { goal_id: 'orientation-spine' },
      }),
    );
    // Pinned to the handoff's own clock: this one names no lane, so it is subject to the
    // WHY_BARE_MAX_AGE_MS bound and would otherwise age out against a real `Date.now()`.
    const brief = deriveNext(db, team.id, 'revive', 'stanley', 3, 5, { now: 1_000 });
    expect(brief.why).not.toBeNull();
    expect(brief.why!.from).toBe('nick');
    expect(brief.why!.body).toContain('orientation spine');
    expect(brief.why!.goal_id).toBe('orientation-spine');
  });

  // The lane that is done-but-not-closed is the one nobody sees: it is not `open`, so `up_next`
  // skips it, and before this it was not in LIVE either, so its own owner's brief said nothing about
  // it at all. Four of dolly's lanes sat that way for days (01KYN3CKJE, 01KYX7YGNK, 01KYX89VFB).
  // NextBriefSchema has always documented in_flight as carrying awaiting_acceptance; only the
  // implementation disagreed.
  it('carries a lane awaiting acceptance — the owner is still on the hook for it', () => {
    const { db, team } = seed();
    const submitted = openLane(db, team.id, 'revive', 'stanley', {
      title: 'merged days ago',
      claim: true,
    });
    updateLane(db, team.id, submitted.id, 'revive', { state: 'awaiting_acceptance' });

    const brief = deriveNext(db, team.id, 'revive', 'stanley');
    expect(brief.in_flight.map((l) => l.id)).toEqual([submitted.id]);
    // ...and it must NOT read as pickup-able work for anyone else.
    expect(brief.up_next).toHaveLength(0);
  });

  // The `why` is enrichment for what you are carrying. A handoff whose lane has since closed is
  // describing finished work, and reads as a live instruction: this brief told dolly that step 7 of
  // the MCP adoption was outstanding four days after the PR carrying step 7 had merged.
  it('skips a handoff whose lane has since resolved, and falls back to the newest live one', () => {
    const { db, team, nick } = seed();
    const stale = openLane(db, team.id, 'revive', 'stanley', {
      title: 'already merged',
      claim: true,
    });
    const live = openLane(db, team.id, 'revive', 'stanley', { title: 'still going', claim: true });
    for (const [id, lane, ts, body] of [
      ['h-live', live.id, 1_000, 'this one is still real'],
      ['h-stale', stale.id, 2_000, 'finish step 7'],
    ] as const) {
      insertMessage(
        db,
        team.id,
        nick.id,
        null,
        makeEnvelope({
          id,
          team: 'revive',
          from: 'nick',
          to: { kind: 'team' },
          act: 'handoff',
          body,
          ts,
          meta: { lane_handoff: { lane } },
        }),
      );
    }
    // The newest handoff is the stale one — without the join it wins on ts alone.
    updateLane(db, team.id, stale.id, 'revive', { state: 'done' });

    const brief = deriveNext(db, team.id, 'revive', 'stanley');
    expect(brief.why).not.toBeNull();
    expect(brief.why!.body).toBe('this one is still real');
  });

  // #745: a named lane that has been submitted is already off the recipient's plate. The why used
  // to skip only `done`/`abandoned`, so a handoff whose PR had merged but whose lane was still
  // awaiting_acceptance kept reading as a live instruction.
  it('skips a handoff whose lane is awaiting acceptance — same #745 out-of-play rule as wakes', () => {
    const { db, team, nick } = seed();
    const submitted = openLane(db, team.id, 'revive', 'stanley', {
      title: 'merged, waiting on accept',
      claim: true,
    });
    const live = openLane(db, team.id, 'revive', 'stanley', { title: 'still going', claim: true });
    for (const [id, lane, ts, body] of [
      ['h-live', live.id, 1_000, 'this one is still real'],
      ['h-submitted', submitted.id, 2_000, 'finish the merged one'],
    ] as const) {
      insertMessage(
        db,
        team.id,
        nick.id,
        null,
        makeEnvelope({
          id,
          team: 'revive',
          from: 'nick',
          to: { kind: 'team' },
          act: 'handoff',
          body,
          ts,
          meta: { lane_handoff: { lane } },
        }),
      );
    }
    updateLane(db, team.id, submitted.id, 'revive', { state: 'awaiting_acceptance' });

    const brief = deriveNext(db, team.id, 'revive', 'stanley');
    expect(brief.why!.body).toBe('this one is still real');
  });

  // The property that makes DERIVING this (rather than storing a flag) the right shape: a rejected
  // acceptance sends the lane back to active and the why becomes that handoff again.
  it('re-serves the why when acceptance sends the named lane back to active', () => {
    const { db, team, nick } = seed();
    const lane = openLane(db, team.id, 'revive', 'stanley', { title: 'bounced', claim: true });
    insertMessage(
      db,
      team.id,
      nick.id,
      null,
      makeEnvelope({
        id: 'h-bounce',
        team: 'revive',
        from: 'nick',
        to: { kind: 'team' },
        act: 'handoff',
        body: 'this came back',
        ts: 1_000,
        meta: { lane_handoff: { lane: lane.id } },
      }),
    );
    updateLane(db, team.id, lane.id, 'revive', { state: 'awaiting_acceptance' });
    expect(deriveNext(db, team.id, 'revive', 'stanley').why).toBeNull();

    updateLane(db, team.id, lane.id, 'revive', { state: 'active' });
    expect(deriveNext(db, team.id, 'revive', 'stanley').why!.body).toBe('this came back');
  });

  // A handoff that names no lane cannot be checked, so it must still be served: abstain by showing
  // it, never by hiding it (ADR 173 — an unknown is not a falsy). Bounded by age, not unbounded:
  // see the WHY_BARE_MAX_AGE_MS pair below.
  it('still serves a handoff that carries no lane reference', () => {
    const { db, team, nick } = seed();
    insertMessage(
      db,
      team.id,
      nick.id,
      null,
      makeEnvelope({
        id: 'h-bare',
        team: 'revive',
        from: 'nick',
        to: { kind: 'team' },
        act: 'handoff',
        body: 'no lane on this one',
        ts: 3_000,
        meta: {},
      }),
    );
    const brief = deriveNext(db, team.id, 'revive', 'stanley', 3, 5, { now: 3_000 });
    expect(brief.why?.body).toBe('no lane on this one');
  });

  // A bare handoff can never be discharged by any event — no lane to check, and nothing reads its
  // prose. Left unbounded it holds the why slot PERMANENTLY. Measured 2026-08-13 across the real
  // ledger: 21 of 22 seats were pinned to a bare handoff, 19 of them to the same 38-day-old
  // completion notice. So age is the only recorded fact left that can retire one, and the bound is
  // set above the whole observed distribution of live handoffs (max 12.8d, p95 6.6d) — it retires
  // nothing that was ever live. Wakes are untouched: this is the why slot only, where showing a
  // dead instruction is not abstention but misdirection.
  it('stops serving a bare handoff once it is older than the age bound', () => {
    const { db, team, nick } = seed();
    insertMessage(
      db,
      team.id,
      nick.id,
      null,
      makeEnvelope({
        id: 'h-bare-old',
        team: 'revive',
        from: 'nick',
        to: { kind: 'team' },
        act: 'handoff',
        body: 'a premise that died two weeks ago',
        ts: 1_000,
        meta: {},
      }),
    );
    const fresh = deriveNext(db, team.id, 'revive', 'stanley', 3, 5, {
      now: 1_000 + WHY_BARE_MAX_AGE_MS,
    });
    expect(fresh.why?.body).toBe('a premise that died two weeks ago');

    const stale = deriveNext(db, team.id, 'revive', 'stanley', 3, 5, {
      now: 1_000 + WHY_BARE_MAX_AGE_MS + 1,
    });
    expect(stale.why).toBeNull();
  });

  // The bound is the fallback for the uncheckable case only. A handoff that names a live lane is a
  // recorded fact and outranks age — it keeps its slot however old it gets.
  it('does not age out a handoff whose named lane is still live', () => {
    const { db, team, nick } = seed();
    const lane = openLane(db, team.id, 'revive', 'stanley', { title: 'still going', claim: true });
    insertMessage(
      db,
      team.id,
      nick.id,
      null,
      makeEnvelope({
        id: 'h-named-old',
        team: 'revive',
        from: 'nick',
        to: { kind: 'team' },
        act: 'handoff',
        body: 'this one is still real',
        ts: 1_000,
        meta: { lane_handoff: { lane: lane.id } },
      }),
    );
    const brief = deriveNext(db, team.id, 'revive', 'stanley', 3, 5, {
      now: 1_000 + WHY_BARE_MAX_AGE_MS * 10,
    });
    expect(brief.why?.body).toBe('this one is still real');
  });

  it('is the zero-compliance floor: empty when nothing is declared', () => {
    const { db, team } = seed();
    const brief = deriveNext(db, team.id, 'revive', 'stanley');
    expect(brief.in_flight).toHaveLength(0);
    expect(brief.shipped).toHaveLength(0);
    expect(brief.up_next).toHaveLength(0);
    expect(brief.why).toBeNull();
  });
});

// ADR 233. Measured: half the unverified self-closes had the named reviewer ONLINE for ~40 minutes
// across an 18h window and still never answered — more awake time than the reviewers who did answer
// (0.67h vs 0.22h). Having time was not the problem; being reminded was. The ask lands once in the
// inbox and is never re-surfaced, and the brief a working seat actually reads had no field for it.
describe('owed_reviews — the verdicts someone is waiting on from ME (ADR 233)', () => {
  function askReview(
    db: ReturnType<typeof seed>['db'],
    teamId: string,
    from: { id: string; name: string },
    toId: string,
    lane: string,
    id: string,
    ts = 1_000,
  ) {
    insertMessage(
      db,
      teamId,
      from.id,
      toId,
      makeEnvelope({
        id,
        team: 'revive',
        from: from.name,
        to: { kind: 'member', name: 'stanley' },
        act: 'ask',
        body: `[lane] acceptance requested`,
        ts,
        meta: { lane_review: { lane }, species: 'approve', tier: 'standard' },
      }),
    );
  }

  it('names a lane whose review ask was routed to me, with who is waiting and since when', () => {
    const { db, team, nick, stanley } = seed();
    const lane = openLane(db, team.id, 'revive', 'nick', { title: 'nick built this', claim: true });
    updateLane(db, team.id, lane.id, 'revive', { state: 'awaiting_acceptance' });
    askReview(db, team.id, nick, stanley.id, lane.id, 'ask-1', 5_000);

    const brief = deriveNext(db, team.id, 'revive', 'stanley');
    expect(brief.owed_reviews).toHaveLength(1);
    expect(brief.owed_reviews[0]!.lane.id).toBe(lane.id);
    expect(brief.owed_reviews[0]!.from).toBe('nick');
    expect(brief.owed_reviews[0]!.ask_id).toBe('ask-1');
    expect(brief.owed_reviews[0]!.ts).toBe(5_000);
  });

  // The whole point: this must survive the seat being heads-down. The inbox scrolls; the brief does
  // not. A seat carrying its own work still owes the verdict.
  it('shows the owed review even while I am carrying my own lanes', () => {
    const { db, team, nick, stanley } = seed();
    const mine = openLane(db, team.id, 'revive', 'stanley', { title: 'my work', claim: true });
    updateLane(db, team.id, mine.id, 'revive', { state: 'active' });
    const theirs = openLane(db, team.id, 'revive', 'nick', { title: 'theirs', claim: true });
    updateLane(db, team.id, theirs.id, 'revive', { state: 'awaiting_acceptance' });
    askReview(db, team.id, nick, stanley.id, theirs.id, 'ask-2');

    const brief = deriveNext(db, team.id, 'revive', 'stanley');
    expect(brief.in_flight.map((l) => l.id)).toEqual([mine.id]);
    expect(brief.owed_reviews.map((r) => r.lane.id)).toEqual([theirs.id]);
  });

  // Answering IS closing the lane (ADR 192, as repaired) — so "still awaiting" is the whole
  // unanswered test. No accept-message bookkeeping to drift out of sync with the lane state.
  it('drops the review once the lane leaves awaiting_acceptance', () => {
    const { db, team, nick, stanley } = seed();
    const lane = openLane(db, team.id, 'revive', 'nick', { title: 'reviewed', claim: true });
    updateLane(db, team.id, lane.id, 'revive', { state: 'awaiting_acceptance' });
    askReview(db, team.id, nick, stanley.id, lane.id, 'ask-3');
    expect(deriveNext(db, team.id, 'revive', 'stanley').owed_reviews).toHaveLength(1);

    updateLane(db, team.id, lane.id, 'revive', { state: 'done' });
    expect(deriveNext(db, team.id, 'revive', 'stanley').owed_reviews).toEqual([]);
  });

  it('never asks me to review my own lane, even if an ask names me', () => {
    const { db, team, nick, stanley } = seed();
    const mine = openLane(db, team.id, 'revive', 'stanley', { title: 'mine', claim: true });
    updateLane(db, team.id, mine.id, 'revive', { state: 'awaiting_acceptance' });
    askReview(db, team.id, nick, stanley.id, mine.id, 'ask-4');

    const brief = deriveNext(db, team.id, 'revive', 'stanley');
    expect(brief.owed_reviews).toEqual([]);
    expect(brief.in_flight.map((l) => l.id)).toEqual([mine.id]); // still MY lane to carry
  });

  it('ignores a review routed to someone else', () => {
    const { db, team, nick } = seed();
    const other = addMember(db, team, { name: 'miley', kind: 'agent' }).row;
    const lane = openLane(db, team.id, 'revive', 'nick', { title: 'not mine', claim: true });
    updateLane(db, team.id, lane.id, 'revive', { state: 'awaiting_acceptance' });
    askReview(db, team.id, nick, other.id, lane.id, 'ask-5');

    expect(deriveNext(db, team.id, 'revive', 'stanley').owed_reviews).toEqual([]);
    expect(deriveNext(db, team.id, 'revive', 'miley').owed_reviews).toHaveLength(1);
  });

  it('is empty when nothing is owed — the common case stays quiet', () => {
    const { db, team } = seed();
    expect(deriveNext(db, team.id, 'revive', 'stanley').owed_reviews).toEqual([]);
  });

  // Oldest first: the one that has been waiting longest is the one most likely to be swept
  // unverified, so it is the one to answer first.
  it('sorts oldest ask first', () => {
    const { db, team, nick, stanley } = seed();
    const a = openLane(db, team.id, 'revive', 'nick', { title: 'a', claim: true });
    const b = openLane(db, team.id, 'revive', 'nick', { title: 'b', claim: true });
    updateLane(db, team.id, a.id, 'revive', { state: 'awaiting_acceptance' });
    updateLane(db, team.id, b.id, 'revive', { state: 'awaiting_acceptance' });
    askReview(db, team.id, nick, stanley.id, b.id, 'ask-new', 9_000);
    askReview(db, team.id, nick, stanley.id, a.id, 'ask-old', 1_000);

    const brief = deriveNext(db, team.id, 'revive', 'stanley');
    expect(brief.owed_reviews.map((r) => r.ask_id)).toEqual(['ask-old', 'ask-new']);
  });
});

describe('brief leads with goals (goals-front-door design)', () => {
  function declareGoal(
    db: ReturnType<typeof seed>['db'],
    teamId: string,
    fromId: string,
    goal: { id: string; title: string; story?: string; wave?: number | 'later' },
    ts: number,
  ) {
    insertMessage(
      db,
      teamId,
      fromId,
      null,
      makeEnvelope({
        id: `gd${ts}-${goal.id}`,
        team: 'revive',
        from: 'nick',
        to: { kind: 'team' },
        act: 'message',
        body: `[goal] ${goal.title}`,
        meta: { goal },
        ts,
      }),
    );
  }

  it('brief leads with unshipped goals, wave-ordered, and up_next puts goal-attached lanes first', () => {
    const { db, team, nick } = seed();
    declareGoal(db, team.id, nick.id, { id: 'g2', title: 'Second', wave: 2 }, 10);
    declareGoal(db, team.id, nick.id, { id: 'g1', title: 'First', wave: 1 }, 20);
    // Two open lanes, the ungrouped one created first — attachment must still win the sort.
    openLane(db, team.id, 'revive', 'nick', { title: 'ungrouped' });
    openLane(db, team.id, 'revive', 'nick', { title: 'on g1', goal_id: 'g1' });
    const brief = deriveNext(db, team.id, 'revive', 'stanley');
    expect(brief.goals.map((g) => g.id)).toEqual(['g1', 'g2']);
    expect(brief.up_next[0]!.goal_id).toBe('g1');
  });

  it('shipped goals are excluded and in-flight sorts before planned at equal wave', () => {
    const { db, team, nick } = seed();
    declareGoal(db, team.id, nick.id, { id: 'ga', title: 'A planned', wave: 1 }, 10);
    declareGoal(db, team.id, nick.id, { id: 'gb', title: 'B in flight', wave: 1 }, 20);
    declareGoal(db, team.id, nick.id, { id: 'gc', title: 'C shipped', wave: 1 }, 30);
    const flight = openLane(db, team.id, 'revive', 'stanley', {
      title: 'w',
      goal_id: 'gb',
      claim: true,
    });
    updateLane(db, team.id, flight.id, 'revive', { state: 'active' });
    const done = openLane(db, team.id, 'revive', 'stanley', {
      title: 'd',
      goal_id: 'gc',
      claim: true,
    });
    updateLane(db, team.id, done.id, 'revive', { state: 'done' });
    const brief = deriveNext(db, team.id, 'revive', 'stanley');
    expect(brief.goals.map((g) => g.id)).toEqual(['gb', 'ga']);
  });
});

describe('review_debt (value-layer design)', () => {
  function insertReadyAudit(
    db: ReturnType<typeof seed>['db'],
    teamId: string,
    target: string,
    ts: number,
    detail: string | null = null,
  ) {
    db.prepare(
      `INSERT INTO audit (id, team_id, ts, actor, action, target, result, detail, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      `rd${ts}-${target}`,
      teamId,
      ts,
      'stanley',
      'lane.ready_for_review',
      target,
      'allow',
      detail,
      ts,
    );
  }
  function awaiting(
    db: ReturnType<typeof seed>['db'],
    teamId: string,
    title: string,
    agoMs: number,
    owner = 'stanley',
    detail: Record<string, unknown> | null = null,
  ) {
    const lane = openLane(db, teamId, 'revive', owner, { title, claim: true });
    const moved = updateLane(db, teamId, lane.id, 'revive', { state: 'awaiting_acceptance' })!;
    insertReadyAudit(
      db,
      teamId,
      moved.id,
      Date.now() - agoMs,
      detail ? JSON.stringify(detail) : null,
    );
    return moved;
  }

  // C — the cap lied by omission. Three rows and no total is indistinguishable from three rows and
  // nothing else, so a seat clears the queue, looks again, and finds more. Measured 2026-08-15:
  // cleared 3, two more appeared, and only then was the depth knowable.
  it('reports the TOTAL waiting, not just the three it shows', () => {
    const { db, team } = seed();
    for (let i = 0; i < 5; i++) awaiting(db, team.id, `l${i}`, (30 - i) * 3_600_000);
    const brief = deriveNext(db, team.id, 'revive', 'nick');
    expect(brief.review_debt).toHaveLength(3);
    expect(brief.review_debt_total).toBe(5);
  });

  it('total equals the shown count when the queue is shallow — no phantom depth', () => {
    const { db, team } = seed();
    awaiting(db, team.id, 'only', 5 * 3_600_000);
    const brief = deriveNext(db, team.id, 'revive', 'nick');
    expect(brief.review_debt_total).toBe(1);
  });

  // B — a lane nobody was ever asked to review. pickReviewCounterpart returns null on a
  // same-model monoculture (ADR 188/253 refuse same_model), the submit records
  // `no_candidate: true`, and then nothing says so: the lane simply waits, looking identical to
  // one with a named reviewer who is merely slow. Three of five lanes on 2026-08-15.
  it('marks a lane that no reviewer was ever asked to review', () => {
    const { db, team } = seed();
    awaiting(db, team.id, 'nobody-asked', 20 * 3_600_000, 'stanley', {
      no_candidate: true,
      family_posture: { state: 'monoculture' },
    });
    awaiting(db, team.id, 'routed', 10 * 3_600_000, 'stanley', { reviewer: 'miley' });
    const brief = deriveNext(db, team.id, 'revive', 'nick');
    const byTitle = new Map(brief.review_debt!.map((r) => [r.title, r]));
    expect(byTitle.get('nobody-asked')!.no_candidate).toBe(true);
    expect(byTitle.get('routed')!.no_candidate).toBe(false);
  });

  it('lists the 3 oldest awaiting-acceptance lanes, oldest first', () => {
    const { db, team } = seed();
    const old1 = awaiting(db, team.id, 'a', 30 * 3_600_000);
    const old2 = awaiting(db, team.id, 'b', 20 * 3_600_000);
    const old3 = awaiting(db, team.id, 'c', 10 * 3_600_000);
    awaiting(db, team.id, 'd', 1_000); // freshest — capped out
    const brief = deriveNext(db, team.id, 'revive', 'nick');
    expect(brief.review_debt!.map((r) => r.id)).toEqual([old1.id, old2.id, old3.id]);
    expect(brief.review_debt![0]!.owner).toBe('stanley');
    expect(brief.review_debt![0]!.waited_ms).toBeGreaterThan(29 * 3_600_000);
  });

  it("excludes the requesting seat's own lanes — self-acceptance is never invited", () => {
    const { db, team } = seed();
    awaiting(db, team.id, 'mine-a', 30 * 3_600_000);
    awaiting(db, team.id, 'mine-b', 20 * 3_600_000);
    // ADR 192: `verified` requires closer ≠ owner, so a seat's own lane is never its
    // candidate review work — the whole field disappears when nothing else waits.
    expect(deriveNext(db, team.id, 'revive', 'stanley').review_debt).toBeUndefined();
    expect(deriveNext(db, team.id, 'revive', 'nick').review_debt).toHaveLength(2);
  });

  it("an excluded own lane frees its cap slot for the next-oldest teammate's lane", () => {
    const { db, team } = seed();
    awaiting(db, team.id, 'mine', 40 * 3_600_000); // oldest, but requester-owned
    const o1 = awaiting(db, team.id, 'a', 30 * 3_600_000, 'nick');
    const o2 = awaiting(db, team.id, 'b', 20 * 3_600_000, 'nick');
    const o3 = awaiting(db, team.id, 'c', 10 * 3_600_000, 'nick');
    awaiting(db, team.id, 'd', 1_000, 'nick'); // freshest — capped out
    const debt = deriveNext(db, team.id, 'revive', 'stanley').review_debt!;
    expect(debt.map((r) => r.id)).toEqual([o1.id, o2.id, o3.id]);
  });

  it('is absent when nothing waits', () => {
    const { db, team } = seed();
    openLane(db, team.id, 'revive', 'stanley', { title: 'live', claim: true });
    expect(deriveNext(db, team.id, 'revive', 'nick').review_debt).toBeUndefined();
  });
});

describe('incidents lead the brief (spec 2026-08-14 inc 1)', () => {
  it('an open incident appears for every member; a terminal one does not', () => {
    const db = openDb(':memory:');
    const team = createTeam(db, { slug: 'revive' });
    addMember(db, team, { name: 'miley', kind: 'agent' });
    recordBlockedReport(db, team.id, 'revive', 'izzo', { gate: 'ci:gates/A11y contrast' }, 'm1');
    recordBlockedReport(db, team.id, 'revive', 'dolly', { gate: 'ci:gates/A11y contrast' }, 'm2');
    const brief = deriveNext(db, team.id, 'revive', 'miley');
    expect(brief.incidents).toHaveLength(1);
    expect(brief.incidents[0]).toMatchObject({
      gate: 'ci:gates/A11y contrast',
      owner_seat: null,
    });
    updateLane(db, team.id, brief.incidents[0]!.lane, 'revive', { state: 'abandoned' });
    expect(deriveNext(db, team.id, 'revive', 'miley').incidents).toHaveLength(0);
  });
});
