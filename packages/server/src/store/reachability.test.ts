import { GENERALIST_CAPABILITIES } from '@musterd/protocol';
import type { Database } from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { PRESENCE_TIMEOUT_MS } from '../config.js';
import { openDb } from '../db/open.js';
import { addMember } from './members.js';
import { attach } from './presence.js';
import {
  adminHumanReachable,
  liveTeammateExists,
  teammateRouteOpen,
  unblockerReachable,
} from './reachability.js';
import type { MemberRow } from './rows.js';
import { createTeam, setPolicy } from './teams.js';

const T = PRESENCE_TIMEOUT_MS;

function makeAdmin(db: Database, m: MemberRow): void {
  db.prepare('UPDATE members SET capabilities = ? WHERE id = ?').run(
    JSON.stringify({ ...GENERALIST_CAPABILITIES, is_admin: true }),
    m.id,
  );
}

function seed() {
  const db = openDb(':memory:');
  const team = createTeam(db, { slug: 'revive' });
  const raiser = addMember(db, team, { name: 'stanley', kind: 'agent' }).row;
  return { db, team, raiser };
}

describe('unblockerReachable (ADR 153 §1)', () => {
  it('a headless solo seat — no human, no teammate — is unreachable (the FB3 shape)', () => {
    const { db, team, raiser } = seed();
    expect(unblockerReachable(db, team.id, raiser.name, T)).toBe(false);
  });

  it('human term: a PRESENT admin human settles it', () => {
    const { db, team, raiser } = seed();
    const nick = addMember(db, team, { name: 'nick', kind: 'human' }).row;
    makeAdmin(db, nick);
    expect(unblockerReachable(db, team.id, raiser.name, T)).toBe(false); // exists but offline, no loud reach
    attach(db, nick.id, 'web', null);
    expect(unblockerReachable(db, team.id, raiser.name, T)).toBe(true);
  });

  it('human term: an OFFLINE admin human counts once the loud reach (ask_slack_webhook) is wired', () => {
    const { db, team, raiser } = seed();
    const nick = addMember(db, team, { name: 'nick', kind: 'human' }).row;
    makeAdmin(db, nick);
    setPolicy(db, team.id, { ask_slack_webhook: 'https://hooks.slack.example/x' });
    expect(adminHumanReachable(db, team.id, T)).toBe(true);
    expect(unblockerReachable(db, team.id, raiser.name, T)).toBe(true);
  });

  it('the webhook alone is NOT reachability — with no admin human seat there is nobody to notify', () => {
    const { db, team, raiser } = seed();
    setPolicy(db, team.id, { ask_slack_webhook: 'https://hooks.slack.example/x' });
    expect(unblockerReachable(db, team.id, raiser.name, T)).toBe(false);
  });

  it('a non-admin human does not satisfy the human term (only an admin can settle a top-tier ask)', () => {
    const { db, team, raiser } = seed();
    const guest = addMember(db, team, { name: 'guest', kind: 'human' }).row;
    attach(db, guest.id, 'web', null);
    expect(adminHumanReachable(db, team.id, T)).toBe(false);
    expect(unblockerReachable(db, team.id, raiser.name, T)).toBe(false);
  });

  it('teammate term: a LIVE agent seat other than the raiser reaches while the route-around is open (D5)', () => {
    const { db, team, raiser } = seed();
    const del = addMember(db, team, { name: 'del', kind: 'agent' }).row;
    expect(unblockerReachable(db, team.id, raiser.name, T)).toBe(false); // exists but not live
    attach(db, del.id, 'claude-code', null);
    expect(liveTeammateExists(db, team.id, raiser.name, T)).toBe(true);
    expect(unblockerReachable(db, team.id, raiser.name, T)).toBe(true);
  });

  it('the raiser itself never counts as its own teammate', () => {
    const { db, team, raiser } = seed();
    attach(db, raiser.id, 'claude-code', null);
    expect(liveTeammateExists(db, team.id, raiser.name, T)).toBe(false);
    expect(unblockerReachable(db, team.id, raiser.name, T)).toBe(false);
  });

  it('teammate term drops when item 2 closes the local-merge route-around (block-posture class) — reachability collapses to human-only', () => {
    const { db, team, raiser } = seed();
    const del = addMember(db, team, { name: 'del', kind: 'agent' }).row;
    attach(db, del.id, 'claude-code', null);
    setPolicy(db, team.id, {
      enforcement: {
        classes: [
          { class: 'local-merge', kind: 'costly-action', match: ['git merge *'], posture: 'block' },
        ],
      },
    });
    expect(unblockerReachable(db, team.id, raiser.name, T)).toBe(false);
    // …but a warn-posture class leaves the route open.
    setPolicy(db, team.id, {
      enforcement: {
        classes: [
          { class: 'local-merge', kind: 'costly-action', match: ['git merge *'], posture: 'warn' },
        ],
      },
    });
    expect(unblockerReachable(db, team.id, raiser.name, T)).toBe(true);
  });

  it('teammateRouteOpen: open on an empty policy, closed only by a matching block-posture class', () => {
    expect(teammateRouteOpen({ classes: [] })).toBe(true);
    expect(
      teammateRouteOpen({
        classes: [
          { class: 'push-remote', kind: 'costly-action', match: ['git push *'], posture: 'block' },
        ],
      }),
    ).toBe(true); // gates the push, not the merge route
  });

  it('teammateRouteOpen: the OBVIOUS glob closes the sibling-worktree route — probe agrees with enforcement (ADR 153 exercise)', () => {
    // The exercise author wrote the obvious `git merge*` intending to close local merges. The probe now
    // tests the worst-case `git -C <main> merge …` form a teammate actually runs; command normalization
    // lifts the `-C` global off, so the block class matches and the route reads CLOSED — no crossing-glob
    // trick, no probe/enforcement disagreement.
    expect(
      teammateRouteOpen({
        classes: [
          { class: 'local-merge', kind: 'costly-action', match: ['git merge*'], posture: 'block' },
        ],
      }),
    ).toBe(false);
    // A warn-posture class of the same shape leaves the route open (posture, not match, is the switch).
    expect(
      teammateRouteOpen({
        classes: [
          { class: 'local-merge', kind: 'costly-action', match: ['git merge*'], posture: 'warn' },
        ],
      }),
    ).toBe(true);
  });
});
