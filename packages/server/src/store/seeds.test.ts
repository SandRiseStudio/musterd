import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Database } from 'better-sqlite3';
import { openDb } from '../db/open.js';
import { createTeam } from './teams.js';
import { addMember } from './members.js';
import { listLanes } from './lanes.js';
import {
  answerSeedClarification,
  askSeedClarification,
  claimSeed,
  createSeedFromRelay,
  listSeeds,
  promoteSeed,
  submitSeedBrief,
} from './seeds.js';

const brief = {
  problem: 'A problem',
  context: 'Relevant Team and code context',
  external_evidence: ['External evidence'],
  approaches: [{ approach: 'Build it', tradeoffs: 'Capability versus surface area' }],
  constraints: ['No new dependency'],
  risks: ['Low adoption'],
  unknowns: ['Exact demand'],
  recommendation: 'Run the smallest useful experiment',
  proposed_lane: { title: 'Test the idea', detail: 'Ship one bounded experiment' },
};

describe('shared Seed store (ADR 291)', () => {
  let db: Database;

  beforeEach(() => {
    db = openDb(':memory:');
  });

  afterEach(() => db.close());

  it('persists one immutable relay Seed per Team relay id', () => {
    const team = createTeam(db, { slug: 'bravo' });
    addMember(db, team, { name: 'nick', kind: 'human', slackUserId: 'U123' });
    const relay = {
      id: 'relay-1',
      source: 'slack',
      body: 'A raw idea',
      ts: 1,
      meta: { user: 'U123' },
    } as const;
    const first = createSeedFromRelay(db, team.id, relay);

    expect(first.state).toBe('open');
    expect(listSeeds(db, team.id)).toMatchObject([{ relay_id: 'relay-1', body: 'A raw idea' }]);
    const duplicate = createSeedFromRelay(db, team.id, {
      ...relay,
      body: 'A mutated replay that must not replace the source',
    });
    expect(duplicate.id).toBe(first.id);
    expect(duplicate.body).toBe('A raw idea');
    expect(duplicate.slack_user_id).toBe('U123');
  });

  it('rejects an unknown Slack submitter without creating a Seed', () => {
    const team = createTeam(db, { slug: 'bravo' });

    expect(() =>
      createSeedFromRelay(db, team.id, {
        id: 'relay-unknown',
        source: 'slack',
        body: 'Whose idea is this?',
        ts: 1,
        meta: { user: 'U999' },
      }),
    ).toThrow('unknown_submitter');
    expect(listSeeds(db, team.id)).toEqual([]);
  });

  it('enforces one agent explorer and submitter-only clarification', () => {
    const team = createTeam(db, { slug: 'bravo' });
    const nick = addMember(db, team, {
      name: 'nick',
      kind: 'human',
      slackUserId: 'U123',
    }).row;
    const ada = addMember(db, team, { name: 'ada', kind: 'agent' }).row;
    const bob = addMember(db, team, { name: 'bob', kind: 'agent' }).row;
    const seed = createSeedFromRelay(db, team.id, {
      id: 'relay-claim',
      source: 'slack',
      body: 'Explore this',
      ts: 1,
      meta: { user: 'U123' },
    });

    expect(claimSeed(db, team.id, seed.id, ada).explorer).toBe('ada');
    expect(() => claimSeed(db, team.id, seed.id, bob)).toThrow(/not claimable/);
    expect(() => askSeedClarification(db, team.id, seed.id, bob, 'Which Surface?')).toThrow(
      /active explorer/,
    );
    expect(askSeedClarification(db, team.id, seed.id, ada, 'Which Surface?').state).toBe(
      'needs_clarification',
    );
    expect(() => answerSeedClarification(db, team.id, seed.id, bob, 'CLI')).toThrow(/submitting/);
    expect(answerSeedClarification(db, team.id, seed.id, nick, 'CLI').state).toBe('clarified');
    expect(claimSeed(db, team.id, seed.id, bob).explorer).toBe('bob');
  });

  it('stores a non-actionable exhaustive brief without opening a Lane', () => {
    const team = createTeam(db, { slug: 'bravo' });
    addMember(db, team, { name: 'nick', kind: 'human', slackUserId: 'U123' });
    const ada = addMember(db, team, { name: 'ada', kind: 'agent' }).row;
    const seed = createSeedFromRelay(db, team.id, {
      id: 'relay-complete',
      source: 'slack',
      body: 'Explore this',
      ts: 1,
      meta: { user: 'U123' },
    });
    claimSeed(db, team.id, seed.id, ada);

    const completed = submitSeedBrief(db, team.id, team.slug, seed.id, ada, {
      result: 'complete',
      brief,
      conclusion: 'The evidence does not justify a Lane.',
    });
    expect(completed).toMatchObject({
      state: 'completed',
      final_brief: brief,
      conclusion: 'The evidence does not justify a Lane.',
    });
    expect(completed.completed_at).not.toBeNull();
    expect(listLanes(db, team.id, team.slug)).toEqual([]);
  });

  it('promotes an exhaustive brief atomically and retry-safely into one unowned Lane', () => {
    const team = createTeam(db, { slug: 'bravo' });
    addMember(db, team, { name: 'nick', kind: 'human', slackUserId: 'U123' });
    const ada = addMember(db, team, { name: 'ada', kind: 'agent' }).row;
    const seed = createSeedFromRelay(db, team.id, {
      id: 'relay-promote',
      source: 'slack',
      body: 'Explore this',
      ts: 1,
      meta: { user: 'U123' },
    });
    claimSeed(db, team.id, seed.id, ada);

    const first = submitSeedBrief(db, team.id, team.slug, seed.id, ada, {
      result: 'promote',
      brief,
    });
    const replay = submitSeedBrief(db, team.id, team.slug, seed.id, ada, {
      result: 'promote',
      brief,
    });
    expect(replay.linked_lane_id).toBe(first.linked_lane_id);
    expect(first.promotion).toMatchObject({ kind: 'automatic', research_skipped: false });
    expect(listLanes(db, team.id, team.slug)).toMatchObject([
      { title: 'Test the idea', detail: 'Ship one bounded experiment', owner_seat: null },
    ]);
  });

  it('lets any Member manually promote an unexplored Seed and records skipped research', () => {
    const team = createTeam(db, { slug: 'bravo' });
    const nick = addMember(db, team, {
      name: 'nick',
      kind: 'human',
      slackUserId: 'U123',
    }).row;
    const seed = createSeedFromRelay(db, team.id, {
      id: 'relay-manual',
      source: 'slack',
      body: 'A raw idea',
      ts: 1,
      meta: { user: 'U123' },
    });

    const promoted = promoteSeed(db, team.id, team.slug, seed.id, nick, {});
    expect(promoted.promotion).toMatchObject({ kind: 'manual', research_skipped: true });
    expect(promoted.linked_lane_id).not.toBeNull();
    expect(listLanes(db, team.id, team.slug)).toMatchObject([
      { title: 'A raw idea', owner_seat: null },
    ]);
  });
});
