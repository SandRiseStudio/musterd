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
