import { NO_HINT_REASONS, isRailCandidate } from '@musterd/protocol';
import { describe, expect, it } from 'vitest';
import { openDb } from '../db/open.js';
import { addMember } from '../store/members.js';
import type { MessageRow } from '../store/rows.js';
import { createTeam } from '../store/teams.js';
import { deliveryHintFor } from './nudge.js';

/**
 * The rail's decision, by cause (ADR 173 clause 1; lane `01KYQ9175S`). `deliveryHintFor` used to
 * return a bare `null` for six different facts, so nothing — not the caller, not a counter, not a
 * test — could tell "you addressed the whole team" from "your recipient is asleep". The pre-existing
 * integration test asserted four of those causes as one `toBeUndefined()`, which is the collapse
 * encoded as coverage. Each cause gets its own case here so a future edit cannot silently merge two.
 */
describe('deliveryHintFor — every no-hint answer names its cause', () => {
  const PRESENCE_MS = 45_000;

  const seed = () => {
    const db = openDb(':memory:');
    const team = createTeam(db, { slug: 'dawn' });
    const ada = addMember(db, team, { name: 'ada', kind: 'agent' }).row;
    const bob = addMember(db, team, { name: 'bob', kind: 'agent' }).row;
    return { db, team, ada, bob };
  };

  /** A message row shaped like the send path builds one; only the fields the predicate reads matter. */
  const msg = (over: Partial<MessageRow> & { team_id: string }): MessageRow =>
    ({
      id: 'm1',
      to_kind: 'member',
      act: 'handoff',
      body: '',
      thread_id: null,
      meta: null,
      ts: 1_000,
      created_at: 1_000,
      ...over,
    }) as MessageRow;

  it('not_directed — a team-addressed act has nobody to nudge', () => {
    const { db, team, ada } = seed();
    const d = deliveryHintFor(
      db,
      msg({ team_id: team.id, from_member: ada.id, to_member: null, to_kind: 'team' }),
      'ada',
      PRESENCE_MS,
    );
    expect(d).toEqual({ hint: null, reason: 'not_directed' });
  });

  it('act_not_eligible — directed, but not an act the rail hints on', () => {
    const { db, team, ada, bob } = seed();
    const d = deliveryHintFor(
      db,
      msg({ team_id: team.id, from_member: ada.id, to_member: bob.id, act: 'status_update' }),
      'ada',
      PRESENCE_MS,
    );
    expect(d).toEqual({ hint: null, reason: 'act_not_eligible' });
  });

  it('self_addressed — a doorbell for your own session is noise', () => {
    const { db, team, ada } = seed();
    const d = deliveryHintFor(
      db,
      msg({ team_id: team.id, from_member: ada.id, to_member: ada.id }),
      'ada',
      PRESENCE_MS,
    );
    expect(d).toEqual({ hint: null, reason: 'self_addressed' });
  });

  it('recipient_unknown — to_member does not resolve to a member row', () => {
    const { db, team, ada } = seed();
    const d = deliveryHintFor(
      db,
      msg({ team_id: team.id, from_member: ada.id, to_member: 'no-such-member' }),
      'ada',
      PRESENCE_MS,
    );
    expect(d).toEqual({ hint: null, reason: 'recipient_unknown' });
  });

  // THE ONE THAT MATTERED. This is the reason behind the whole "zero hints on a 190-act day" scare:
  // the single eligible act that day went to an away human with no live session, so declining was
  // correct — and indistinguishable from a dead code path until it had a name.
  it('recipient_not_live — eligible and directed, but nobody is there to hear it', () => {
    const { db, team, ada, bob } = seed();
    const d = deliveryHintFor(
      db,
      msg({ team_id: team.id, from_member: ada.id, to_member: bob.id }),
      'ada',
      PRESENCE_MS,
    );
    expect(d).toEqual({ hint: null, reason: 'recipient_not_live' });
    // …and unlike the three above, this one is a fact ABOUT THE RAIL, so it earns a durable row.
    expect(isRailCandidate('recipient_not_live')).toBe(true);
    expect(isRailCandidate('not_directed')).toBe(false);
    expect(isRailCandidate('act_not_eligible')).toBe(false);
    expect(isRailCandidate('self_addressed')).toBe(false);
  });

  it('every declared reason is reachable — no name without a path to it', () => {
    // Guards the honest failure mode of a named-abstention enum: a reason nobody can produce is
    // decoration, and reads in a report as a category that simply never happens.
    const produced = new Set<string>();
    const { db, team, ada, bob } = seed();
    const base = { team_id: team.id, from_member: ada.id };
    for (const m of [
      msg({ ...base, to_member: null, to_kind: 'team' }),
      msg({ ...base, to_member: bob.id, act: 'status_update' }),
      msg({ ...base, to_member: ada.id }),
      msg({ ...base, to_member: 'ghost' }),
      msg({ ...base, to_member: bob.id }),
    ]) {
      produced.add(deliveryHintFor(db, m, 'ada', PRESENCE_MS).reason);
    }
    // `suppressed_window` needs a prior eligible row and live presence, both exercised end-to-end in
    // the HTTP integration suite; every other declared reason is produced here.
    for (const r of NO_HINT_REASONS) {
      if (r === 'suppressed_window') continue;
      expect(produced.has(r)).toBe(true);
    }
  });
});
