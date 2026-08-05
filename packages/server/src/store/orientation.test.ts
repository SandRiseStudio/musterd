import { makeEnvelope } from '@musterd/protocol';
import { describe, expect, it } from 'vitest';
import { openDb } from '../db/open.js';
import { openLane, updateLane } from './lanes.js';
import { addMember } from './members.js';
import { insertMessage } from './messages.js';
import { deriveNext } from './orientation.js';
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
    const brief = deriveNext(db, team.id, 'revive', 'stanley');
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

  // A handoff that names no lane cannot be checked, so it must still be served: abstain by showing
  // it, never by hiding it (ADR 173 — an unknown is not a falsy).
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
    const brief = deriveNext(db, team.id, 'revive', 'stanley');
    expect(brief.why?.body).toBe('no lane on this one');
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
