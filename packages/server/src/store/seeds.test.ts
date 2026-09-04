import type { Database } from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb } from '../db/open.js';
import { listLanes, openLane } from './lanes.js';
import { addMember } from './members.js';
import {
  answerSeedClarification,
  askSeedClarification,
  captureRepoSeed,
  claimSeed,
  createSeedFromRelay,
  listSeeds,
  promoteSeed,
  submitSeedBrief,
} from './seeds.js';
import { createTeam } from './teams.js';
import { getMemberByName } from './members.js';

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

  // Finding 4 (lane-replication spec), dolly's #1179 decline: the Seed promotion opened a lane with
  // no first event. The birth is written by openLane itself, so no caller can leave it out.
  it('a promoted Seed lane is born with a lane.opened row, as the promoting Member', () => {
    const team = createTeam(db, { slug: 'bravo' });
    addMember(db, team, { name: 'nick', kind: 'human', slackUserId: 'U123' });
    const ada = addMember(db, team, { name: 'ada', kind: 'agent' }).row;
    const seed = createSeedFromRelay(db, team.id, {
      id: 'relay-opened',
      source: 'slack',
      body: 'Explore this',
      ts: 1,
      meta: { user: 'U123' },
    });
    claimSeed(db, team.id, seed.id, ada);
    const promoted = submitSeedBrief(db, team.id, team.slug, seed.id, ada, {
      result: 'promote',
      brief,
    });
    const rows = db
      .prepare<
        [string],
        { actor: string | null; detail: string }
      >("SELECT actor, detail FROM audit WHERE action = 'lane.opened' AND target = ? ORDER BY id")
      .all(promoted.linked_lane_id as string);
    expect(rows).toHaveLength(1);
    expect(rows[0].actor).toBe('ada');
    expect(JSON.parse(rows[0].detail)).toMatchObject({
      lane: promoted.linked_lane_id,
      title: 'Test the idea',
      created_by: 'ada',
    });
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

  describe('a document-recorded intention is a Seed (ADR 373 increment 2)', () => {
    it('captures with source repo, no Slack author, and is idempotent on ref — body immutable', () => {
      const team = createTeam(db, { slug: 'bravo' });
      addMember(db, team, { name: 'ryder', kind: 'agent' });
      const ryder = getMemberByName(db, team.id, 'ryder')!;
      const input = {
        ref: 'docs/decisions/354-wake-lease-file-channel.md#left-for-a-sibling-lane',
        body: 'Left for a sibling lane; this ADR fixes the attestation, not the judgement.',
        captured_at: 1_756_857_600_000,
      };
      const first = captureRepoSeed(db, team.id, ryder, input, 10);
      expect(first).toMatchObject({
        source: 'repo',
        relay_id: 'repo:' + input.ref,
        slack_user_id: null,
        submitted_by: 'ryder',
        state: 'open',
        linked_lane_id: null,
        captured_at: input.captured_at,
      });
      const again = captureRepoSeed(db, team.id, ryder, { ...input, body: 'edited' }, 20);
      expect(again.id).toBe(first.id);
      expect(again.body).toBe(input.body);
      expect(listSeeds(db, team.id)).toHaveLength(1);
    });

    it('a lane disposition births the Seed promoted, with linked_lane_id as the provenance edge', () => {
      const team = createTeam(db, { slug: 'bravo' });
      addMember(db, team, { name: 'ryder', kind: 'agent' });
      const ryder = getMemberByName(db, team.id, 'ryder')!;
      const lane = openLane(db, team.id, 'bravo', 'ryder', { title: 'the sibling lane' }, 1);
      const seed = captureRepoSeed(
        db,
        team.id,
        ryder,
        { ref: 'docs/decisions/354.md#a', body: 'Left for a sibling lane', lane_id: lane.id },
        10,
      );
      expect(seed).toMatchObject({
        state: 'promoted',
        linked_lane_id: lane.id,
        promotion: { kind: 'manual', research_skipped: true, at: 10 },
      });
      // No second lane was opened: the edge points at the lane the document named.
      expect(listLanes(db, team.id)).toHaveLength(1);
    });

    it('an open repo Seed whose ref is later disposed with a lane id gets linked; a linked one is left alone', () => {
      const team = createTeam(db, { slug: 'bravo' });
      addMember(db, team, { name: 'ryder', kind: 'agent' });
      const ryder = getMemberByName(db, team.id, 'ryder')!;
      const a = openLane(db, team.id, 'bravo', 'ryder', { title: 'a' }, 1);
      const b = openLane(db, team.id, 'bravo', 'ryder', { title: 'b' }, 2);
      const input = { ref: 'docs/wiki/x.md#y', body: 'not yet built' };
      expect(captureRepoSeed(db, team.id, ryder, input, 10).state).toBe('open');
      const linked = captureRepoSeed(db, team.id, ryder, { ...input, lane_id: a.id }, 20);
      expect(linked).toMatchObject({ state: 'promoted', linked_lane_id: a.id });
      const relinked = captureRepoSeed(db, team.id, ryder, { ...input, lane_id: b.id }, 30);
      expect(relinked.linked_lane_id).toBe(a.id);
    });

    it('refuses a lane id the team does not hold', () => {
      const team = createTeam(db, { slug: 'bravo' });
      addMember(db, team, { name: 'ryder', kind: 'agent' });
      const ryder = getMemberByName(db, team.id, 'ryder')!;
      expect(() =>
        captureRepoSeed(db, team.id, ryder, {
          ref: 'a.md#b',
          body: 'x',
          lane_id: '01M1MMHJP3PQY1QWNJCHV3XEMA',
        }),
      ).toThrow(/not found/);
      expect(listSeeds(db, team.id)).toEqual([]);
    });
  });
});
