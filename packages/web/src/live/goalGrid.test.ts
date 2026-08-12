import { describe, expect, it } from 'vitest';
import type { Goal, Lane } from '@musterd/protocol';
import { buildGoalGrid, RUNWAY_DOT_CAP } from './goalGrid';

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
  wave: 1,
  depends_on: [],
  declared_by: 'nick',
  declared_at: 1,
  status: 'in-flight',
  epoch: 0,
  ...over,
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
    const goals = [
      goal({ id: 'q', title: 'Q', wave: 1, status: 'planned' }),
      goal({ id: 'j', title: 'J', wave: 2, status: 'in-flight' }),
      goal({ id: 'f', title: 'F', wave: 3, status: 'in-flight' }),
    ];
    const lanes = [
      lane({ id: 'a', goal_id: 'j', state: 'active', owner_seat: 'june' }),
      lane({ id: 'b', goal_id: 'f', state: 'done', resolved_at: 10 }),
      lane({ id: 'c', goal_id: 'f', state: 'active', owner_seat: 'cleo' }),
    ];
    const cards = buildGoalGrid(lanes, goals, NOW).cards;
    expect(cards.map((c) => [c.id, c.chip])).toEqual([
      ['q', 'queued'],
      ['j', 'just started'],
      ['f', 'in flight'],
    ]);
  });

  it('story uses goal.story, falls back to lane facts, else null', () => {
    const withStory = goal({ id: 'g1', story: 'plain words' });
    const noStory = goal({ id: 'g2', title: 'Other', wave: 2 });
    const bare = goal({ id: 'g3', title: 'Bare', wave: 3, status: 'planned' });
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

  it('shipped goals go to the shelf, not cards; wave orders the cards', () => {
    const goals = [
      goal({ id: 'g2', title: 'Second', wave: 2 }),
      goal({ id: 'g1', title: 'First', wave: 1 }),
      goal({ id: 'gs', title: 'Landed', wave: 0, status: 'shipped' }),
    ];
    const model = buildGoalGrid([], goals, NOW);
    expect(model.cards.map((c) => c.id)).toEqual(['g1', 'g2']);
    expect(model.shippedShelf).toEqual([{ id: 'gs', title: 'Landed' }]);
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
