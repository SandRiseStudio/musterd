import { describe, expect, it } from 'vitest';
import type { Goal, Lane, LaneWarning } from '@musterd/protocol';
import { buildGoalGrid, RUNWAY_DOT_CAP } from './goalGrid';
import * as grid from './goalGrid';

const lane = (over: Partial<Lane> = {}): Lane => ({
  id: 'L1',
  team: 'revive',
  project: 'default',
  title: 'write the launch post',
  detail: null,
  owner_seat: null,
  role: null,
  surface_globs: [],
  depends_on: [],
  branch: null,
  goal_id: null,
  risk: [],
  stakes: 'normal' as const,
  stakes_provenance: 'declared' as const,
  merged: null,
  state: 'open',
  created_by: 'nick',
  created_at: 1,
  claimed_at: null,
  resolved_at: null,
  updated_at: 1,
  ...over,
});

const goal = (over: Partial<Goal> = {}): Goal => ({
  id: 'g1',
  title: 'Native harness',
  wave: null,
  depends_on: [],
  declared_by: 'nick',
  declared_at: 1,
  status: 'in-flight',
  epoch: 0,
  ...over,
});

const staleWarning = (subject: string, detail: string): LaneWarning => ({
  kind: 'stale_acceptance',
  subject,
  with: subject,
  owner: null,
  detail,
});

const NOW = 1_000_000;

describe('buildGoalGrid — zones', () => {
  it('maps lane states to runway zones, both review spellings, abandoned excluded', () => {
    const lanes = [
      lane({ id: 'a', goal_id: 'g1', state: 'open' }),
      lane({ id: 'b', goal_id: 'g1', state: 'claimed', owner_seat: 'june' }),
      lane({ id: 'c', goal_id: 'g1', state: 'active', owner_seat: 'cleo' }),
      lane({ id: 'd', goal_id: 'g1', state: 'blocked', owner_seat: 'june' }),
      lane({ id: 'e', goal_id: 'g1', state: 'awaiting_acceptance', owner_seat: 'june' }),
      lane({ id: 'f', goal_id: 'g1', state: 'ready_for_review', owner_seat: 'june' }),
      lane({ id: 'g', goal_id: 'g1', state: 'done', resolved_at: 500 }),
      lane({ id: 'h', goal_id: 'g1', state: 'abandoned' }),
    ];
    const card = buildGoalGrid(lanes, [goal()], NOW).cards[0]!;
    const byId = new Map(card.dots.map((d) => [d.lane, d]));
    expect(byId.get('a')!.zone).toBe('backlog');
    expect(byId.get('b')!.zone).toBe('working');
    expect(byId.get('c')!.zone).toBe('working');
    expect(byId.get('d')!.zone).toBe('working');
    expect(byId.get('d')!.tone).toBe('blocked');
    expect(byId.get('e')!.zone).toBe('review');
    expect(byId.get('f')!.zone).toBe('review');
    expect(byId.get('g')!.zone).toBe('shipped');
    expect(byId.has('h')).toBe(false);
  });

  it('claimed/active are riders with their owner; the rest are dots', () => {
    const lanes = [
      lane({ id: 'b', goal_id: 'g1', state: 'claimed', owner_seat: 'june' }),
      lane({ id: 'c', goal_id: 'g1', state: 'active', owner_seat: 'cleo' }),
      lane({ id: 'd', goal_id: 'g1', state: 'blocked', owner_seat: 'june' }),
      lane({ id: 'a', goal_id: 'g1', state: 'open' }),
    ];
    const card = buildGoalGrid(lanes, [goal()], NOW).cards[0]!;
    const byId = new Map(card.dots.map((d) => [d.lane, d]));
    expect(byId.get('b')!.kind).toBe('rider');
    expect(byId.get('b')!.owner).toBe('june');
    expect(byId.get('c')!.kind).toBe('rider');
    expect(byId.get('d')!.kind).toBe('dot');
    expect(byId.get('a')!.kind).toBe('dot');
  });

  it('x is deterministic and stays inside the zone band', () => {
    const lanes = [lane({ id: 'a', goal_id: 'g1', state: 'claimed', owner_seat: 'june' })];
    const one = buildGoalGrid(lanes, [goal()], NOW).cards[0]!.dots[0]!;
    const two = buildGoalGrid(lanes, [goal()], NOW).cards[0]!.dots[0]!;
    expect(one.x).toBe(two.x);
    expect(one.x).toBeGreaterThanOrEqual(25);
    expect(one.x).toBeLessThan(50);
  });

  it('caps dots at RUNWAY_DOT_CAP with overflow, counts preserved', () => {
    const lanes = Array.from({ length: 20 }, (_, i) =>
      lane({ id: `L${i}`, goal_id: 'g1', state: 'open' }),
    );
    const card = buildGoalGrid(lanes, [goal()], NOW).cards[0]!;
    expect(card.dots).toHaveLength(RUNWAY_DOT_CAP);
    expect(card.overflow).toBe(6);
    expect(card.counts.total).toBe(20);
  });

  it('marks the most recently resolved done lane latest (✨)', () => {
    const lanes = [
      lane({ id: 'old', goal_id: 'g1', state: 'done', resolved_at: 100 }),
      lane({ id: 'new', goal_id: 'g1', state: 'done', resolved_at: 900 }),
    ];
    const card = buildGoalGrid(lanes, [goal()], NOW).cards[0]!;
    const byId = new Map(card.dots.map((d) => [d.lane, d]));
    expect(byId.get('new')!.latest).toBe(true);
    expect(byId.get('old')!.latest).toBe(false);
  });
});

describe('buildGoalGrid — cards', () => {
  it('chip derivation: planned→queued, in-flight 0 done→just started, else in flight', () => {
    // declared_at is explicit: ADR 257 breaks status ties by recency, so leaving it equal would
    // make the expected order depend on sort stability rather than on the rule under test.
    const goals = [
      goal({ id: 'q', title: 'Q', status: 'planned', declared_at: 3 }),
      goal({ id: 'j', title: 'J', status: 'in-flight', declared_at: 2 }),
      goal({ id: 'f', title: 'F', status: 'in-flight', declared_at: 1 }),
    ];
    const lanes = [
      lane({ id: 'a', goal_id: 'j', state: 'active', owner_seat: 'june' }),
      lane({ id: 'b', goal_id: 'f', state: 'done', resolved_at: 10 }),
      lane({ id: 'c', goal_id: 'f', state: 'active', owner_seat: 'cleo' }),
    ];
    const cards = buildGoalGrid(lanes, goals, NOW).cards;
    // in-flight sorts ahead of planned (ADR 257), newest-declared first within a status.
    expect(cards.map((c) => [c.id, c.chip])).toEqual([
      ['j', 'just started'],
      ['f', 'in flight'],
      ['q', 'queued'],
    ]);
  });

  it('story uses goal.story, falls back to lane facts, else null', () => {
    const withStory = goal({ id: 'g1', story: 'plain words', declared_at: 3 });
    const noStory = goal({ id: 'g2', title: 'Other', declared_at: 2 });
    const bare = goal({ id: 'g3', title: 'Bare', status: 'planned', declared_at: 1 });
    const lanes = [lane({ id: 'a', goal_id: 'g2', state: 'active', owner_seat: 'x', created_at: NOW - 86_400_000 })];
    const cards = buildGoalGrid(lanes, [withStory, noStory, bare], NOW).cards;
    expect(cards[0]!.story).toBe('plain words');
    expect(cards[1]!.story).toMatch(/1 lane · started 1d ago/);
    expect(cards[2]!.story).toBeNull();
  });

  it('a lane naming an undeclared goal id gets a declared:false card under the raw id', () => {
    const lanes = [lane({ id: 'a', goal_id: 'mystery', state: 'active', owner_seat: 'x' })];
    const cards = buildGoalGrid(lanes, [goal()], NOW).cards;
    const myst = cards.find((c) => c.id === 'mystery')!;
    expect(myst.declared).toBe(false);
    expect(myst.title).toBe('mystery');
  });

  it('"Not on a goal yet" card is last, chip lanes, and absent when all lanes attached', () => {
    const lanes = [
      lane({ id: 'a', goal_id: 'g1', state: 'open' }),
      lane({ id: 'b', goal_id: null, state: 'open' }),
    ];
    const cards = buildGoalGrid(lanes, [goal()], NOW).cards;
    const last = cards[cards.length - 1]!;
    expect(last.id).toBeNull();
    expect(last.title).toBe('Not on a goal yet');
    expect(last.chip).toBe('lanes');
    const attached = buildGoalGrid([lanes[0]!], [goal()], NOW).cards;
    expect(attached.some((c) => c.id === null)).toBe(false);
  });

  it('shipped goals go to the shelf, not cards; the newest declaration leads (ADR 257)', () => {
    const goals = [
      goal({ id: 'older', title: 'Older', declared_at: 1 }),
      goal({ id: 'newer', title: 'Newer', declared_at: 2 }),
      goal({ id: 'gs', title: 'Landed', declared_at: 3, status: 'shipped' }),
    ];
    const model = buildGoalGrid([], goals, NOW);
    expect(model.cards.map((c) => c.id)).toEqual(['newer', 'older']);
    expect(model.shippedShelf).toEqual([{ id: 'gs', title: 'Landed', outcome: null }]);
  });

  it('a shelved goal ("later") sorts behind everything unshelved, however recent', () => {
    const goals = [
      goal({ id: 'shelved', title: 'Shelved', wave: 'later', declared_at: 99 }),
      goal({ id: 'live', title: 'Live', declared_at: 1 }),
    ];
    expect(buildGoalGrid([], goals, NOW).cards.map((c) => c.id)).toEqual(['live', 'shelved']);
  });

  it('pulse is the team-wide latest done lane; lastMoved is per-card', () => {
    const lanes = [
      lane({ id: 'a', goal_id: 'g1', state: 'done', resolved_at: 500, title: 'first ship' }),
      lane({ id: 'b', goal_id: null, state: 'done', resolved_at: 900, title: 'late ship' }),
      lane({ id: 'c', goal_id: 'g1', state: 'active', owner_seat: 'x', updated_at: 800, title: 'mover' }),
    ];
    const model = buildGoalGrid(lanes, [goal()], NOW);
    expect(model.pulse).toEqual({ title: 'late ship', at: 900 });
    expect(model.cards[0]!.lastMoved).toEqual({ lane: 'c', title: 'mover', at: 800 });
  });

  it('empty goals input yields no cards (route falls back to columns)', () => {
    const model = buildGoalGrid([lane({ id: 'a' })], [], NOW);
    expect(model.cards).toEqual([]);
  });
});

describe('buildGoalGrid — the value layer (outcome notes, visible review debt)', () => {
  const note = { text: 'seats stopped re-deriving the board', by: 'stanley', at: 4_000 };

  it('carries a shipped goal outcome onto the shelf, and null when nobody wrote one', () => {
    const goals = [
      goal({ id: 'told', title: 'Told', status: 'shipped', declared_at: 2, outcome: note }),
      goal({ id: 'mute', title: 'Mute', status: 'shipped', declared_at: 1 }),
    ];
    expect(buildGoalGrid([], goals, NOW).shippedShelf).toEqual([
      { id: 'told', title: 'Told', outcome: note },
      { id: 'mute', title: 'Mute', outcome: null },
    ]);
  });

  it('an outcome on an unshipped goal rides the card beside the story, not instead of it', () => {
    const card = buildGoalGrid(
      [],
      [goal({ id: 'g1', story: 'the promise', outcome: note })],
      NOW,
    ).cards[0]!;
    expect(card.story).toBe('the promise');
    expect(card.outcome).toEqual(note);
  });

  it('a card with no outcome reports null rather than borrowing the story', () => {
    const card = buildGoalGrid([], [goal({ id: 'g1', story: 'the promise' })], NOW).cards[0]!;
    expect(card.outcome).toBeNull();
  });

  it('a stale_acceptance warning marks its dot and counts on the card', () => {
    const lanes = [
      lane({ id: 'old', goal_id: 'g1', state: 'awaiting_acceptance', owner_seat: 'june' }),
      lane({ id: 'fresh', goal_id: 'g1', state: 'awaiting_acceptance', owner_seat: 'june' }),
    ];
    const model = buildGoalGrid(lanes, [goal()], NOW, [
      staleWarning('old', 'waiting 14h for acceptance — team_next surfaces it'),
    ]);
    const card = model.cards[0]!;
    expect(card.counts.review).toBe(2);
    expect(card.counts.stale).toBe(1);
    expect(card.staleNote).toBe('waiting 14h for acceptance — team_next surfaces it');
    const byId = new Map(card.dots.map((d) => [d.lane, d]));
    expect(byId.get('old')!.stale).toBe(true);
    expect(byId.get('fresh')!.stale).toBe(false);
  });

  it('quotes the daemon on age — no warning means no debt, however long the lane sat', () => {
    const ancient = lane({
      id: 'a',
      goal_id: 'g1',
      state: 'awaiting_acceptance',
      owner_seat: 'june',
      updated_at: NOW - 40 * 3_600_000,
    });
    const card = buildGoalGrid([ancient], [goal()], NOW).cards[0]!;
    expect(card.counts.stale).toBe(0);
    expect(card.staleNote).toBeNull();
    expect(card.dots[0]!.stale).toBe(false);
  });

  it('ignores warnings of other kinds, and lanes on other cards', () => {
    const lanes = [
      lane({ id: 'mine', goal_id: 'g1', state: 'awaiting_acceptance', owner_seat: 'june' }),
      lane({ id: 'theirs', goal_id: 'g2', state: 'awaiting_acceptance', owner_seat: 'june' }),
    ];
    const model = buildGoalGrid(lanes, [goal({ id: 'g1' }), goal({ id: 'g2' })], NOW, [
      { kind: 'surface_overlap', subject: 'mine', with: 'theirs', owner: 'june', detail: 'overlap' },
      staleWarning('theirs', 'waiting 20h for acceptance'),
    ]);
    const byGoal = new Map(model.cards.map((c) => [c.id, c]));
    expect(byGoal.get('g1')!.counts.stale).toBe(0);
    expect(byGoal.get('g2')!.counts.stale).toBe(1);
  });
});

describe('resolveBoardView', () => {
  it('honors a stored choice, maps legacy goals to grid, defaults by goal count', () => {
    const { resolveBoardView } = grid;
    expect(resolveBoardView('columns', 5)).toBe('columns');
    expect(resolveBoardView('grid', 0)).toBe('grid');
    expect(resolveBoardView('goals', 0)).toBe('grid');
    expect(resolveBoardView(null, 3)).toBe('grid');
    expect(resolveBoardView(null, 0)).toBe('columns');
    expect(resolveBoardView('nonsense', 0)).toBe('columns');
    expect(resolveBoardView('nonsense', 2)).toBe('grid');
  });
});

describe('goalFilter', () => {
  it('undefined = all, null = goal-less only, id = that goal', () => {
    const { goalFilter } = grid;
    const lanes = [
      lane({ id: 'a', goal_id: 'g1' }),
      lane({ id: 'b', goal_id: null }),
      lane({ id: 'c', goal_id: 'g2' }),
    ];
    expect(goalFilter(lanes, undefined).map((l) => l.id)).toEqual(['a', 'b', 'c']);
    expect(goalFilter(lanes, null).map((l) => l.id)).toEqual(['b']);
    expect(goalFilter(lanes, 'g1').map((l) => l.id)).toEqual(['a']);
  });
});

describe('buildGoalGrid — retracted goals (goal-retract design)', () => {
  it('a retracted goal renders no card and no shipped-shelf entry', () => {
    const goals = [
      goal({ id: 'live', title: 'Live goal' }),
      goal({ id: 'gone', title: 'Withdrawn goal', retracted: { by: 'dolly', at: 5 } }),
      goal({
        id: 'gone-shipped',
        title: 'Withdrawn shipped',
        status: 'shipped',
        retracted: { by: 'dolly', at: 6 },
      }),
    ];
    const model = buildGoalGrid([], goals, NOW);
    expect(model.cards.map((c) => c.title)).toEqual(['Live goal']);
    expect(model.shippedShelf).toEqual([]);
  });

  it('lanes on a retracted goal do not vanish — they fall to the undeclared-goal card', () => {
    const goals = [goal({ id: 'gone', title: 'Withdrawn', retracted: { by: 'dolly', at: 5 } })];
    const lanes = [lane({ id: 'L9', goal_id: 'gone', state: 'active' })];
    const model = buildGoalGrid(lanes, goals, NOW);
    expect(model.cards).toHaveLength(1);
    expect(model.cards[0]!.id).toBe('gone');
    expect(model.cards[0]!.declared).toBe(false);
  });
});
