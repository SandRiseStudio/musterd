import { describe, expect, it } from 'vitest';
import { homePoses } from './actors';
import { memberColor } from '../format';
import { fitFloor, project } from './iso';
import { DESK_SLOTS, LOUNGE, NOOK } from './layout';
import { computeLightEnv } from './lighting';
import type { PetMode, PetState } from './pet';
import {
  actorSortAnchor,
  animatedDeskAnchors,
  boardAnchor,
  BOOK_COLORS,
  CLOCK_NUMERALS,
  coffeeAnchor,
  drawDog,
  glassColor,
  MACHINE_H,
  packShelf,
  pawCycle,
  renderScene,
  shelfRnd,
} from './render';
import { assignSeats } from './seating';
import type { OfficeNode, Pose } from './types';
import { projectWallBoard, STICKY_CAP, type WallBoard } from './wallboard';
import type { Lane, LaneState, WorkingHours } from '@musterd/protocol';

/** A minimal lane for wall-board fixtures — only id and state matter to the wall. */
function laneFix(id: string, state: LaneState): Lane {
  return {
    id,
    team: 'revive',
    project: 'default',
    title: 't',
    detail: null,
    owner_seat: null,
    role: null,
    surface_globs: [],
    depends_on: [],
    branch: null,
    goal_id: null,
    risk: [],
    merged: null,
    state,
    created_by: 'nick',
    created_at: 1,
    claimed_at: null,
    resolved_at: null,
    updated_at: 1,
  };
}

function node(name: string, activity: OfficeNode['activity']): OfficeNode {
  return {
    name,
    kind: 'agent',
    presence: 'online',
    activity,
    posture: activity === 'working' ? 'working' : 'idle',
    state: null,
    color: memberColor(name, 'agent'),
    role: '',
    surface: null,
    model: null,
    workTitle: null,
    workSource: null,
    laneState: null,
    moreLanes: 0,
  };
}

/** A no-op 2D context that records nothing — just enough surface for the scene's draw calls so we can
 * assert the whole painter's-order pass runs end to end without throwing. `paints` collects every colour
 * the scene assigns, so a test can check they're all ones canvas can actually parse (see below). */
function mockCtx(paints: string[] = []): CanvasRenderingContext2D {
  const grad = { addColorStop(_stop: number, color: string) { paints.push(color); } };
  const handler: ProxyHandler<Record<string, unknown>> = {
    get(target, prop) {
      if (prop === 'canvas') return { width: 1200, height: 900 };
      if (prop === 'createLinearGradient' || prop === 'createRadialGradient') return () => grad;
      if (prop === 'measureText') return () => ({ width: 0 });
      if (prop in target) return target[prop as string];
      return () => undefined; // every draw method is a no-op
    },
    set(_target, prop, value) {
      if ((prop === 'fillStyle' || prop === 'strokeStyle') && typeof value === 'string') paints.push(value);
      return true; // fillStyle/strokeStyle/font/etc. — accept and ignore
    },
  };
  return new Proxy({}, handler) as unknown as CanvasRenderingContext2D;
}

/**
 * A colour string canvas can actually parse. This is not pedantry: assigning an unparseable `fillStyle`
 * **throws nothing and changes nothing** — the context quietly keeps its previous colour, so the shape is
 * painted in whatever the last draw left behind. The result is a solid that looks fine until an unrelated
 * change reorders the depth sort, and then paints itself the wrong colour with no error anywhere. That is
 * exactly how the kitchenette counter's side faces went green (`mul()` returned `rgb(…)`, which `hexRgb`
 * parsed to `NaN`), so the guard is on the whole scene rather than the one function that regressed.
 */
function parseableColor(c: string): boolean {
  if (/NaN|undefined|null/i.test(c)) return false;
  if (/^#[0-9a-f]{3}$|^#[0-9a-f]{6}$|^#[0-9a-f]{8}$/i.test(c)) return true;
  if (/^rgba?\(\s*[\d.]+\s*,\s*[\d.]+\s*,\s*[\d.]+\s*(,\s*[\d.]+\s*)?\)$/.test(c)) return true;
  if (/^hsla?\(\s*[-\d.]+\s*,\s*[\d.]+%\s*,\s*[\d.]+%\s*(,\s*[\d.]+\s*)?\)$/.test(c)) return true;
  return /^[a-z]+$/i.test(c); // a named colour (transparent, white, …)
}

/** The fan/coffee overlay anchors (Tier-A animated props). The key behaviour: a fan only spins and a mug
 * only steams at an *occupied* desk — an unattended running fan or a steaming fresh mug reads as wrong. */
describe('animatedDeskAnchors', () => {
  const fit = fitFloor(1200, 900);
  const allSlots = new Set(DESK_SLOTS.map((s) => s.id));

  it('animates nothing — no spinning fans, no steaming mugs — when no desks are occupied', () => {
    const { fans, coffees } = animatedDeskAnchors(fit, new Set());
    expect(fans).toHaveLength(0);
    expect(coffees).toHaveLength(0);
  });

  it('spins fans and steams mugs only at occupied desks', () => {
    const full = animatedDeskAnchors(fit, allSlots);
    expect(full.fans.length).toBeGreaterThan(0); // some desks carry a fan (a stable per-desk hash)
    expect(full.coffees.length).toBeGreaterThan(0); // some desks carry a mug
  });

  it('does not put a coffee mug on every desk', () => {
    // fewer steaming mugs than desks even when all are seated → mugs are a per-desk hash, not universal
    expect(animatedDeskAnchors(fit, allSlots).coffees.length).toBeLessThan(DESK_SLOTS.length);
  });

  it('drops a fan the moment its desk empties (gated per-slot, not all-or-nothing)', () => {
    const full = animatedDeskAnchors(fit, allSlots).fans.length;
    const fanSlot = DESK_SLOTS.find((s) => animatedDeskAnchors(fit, new Set([s.id])).fans.length === 1);
    expect(fanSlot).toBeDefined();
    const minusOne = new Set(allSlots);
    minusOne.delete(fanSlot!.id);
    expect(animatedDeskAnchors(fit, minusOne).fans.length).toBe(full - 1);
  });

  it('drops a mug steam the moment its desk empties (empty desk → empty, un-steaming mug)', () => {
    const full = animatedDeskAnchors(fit, allSlots).coffees.length;
    const mugSlot = DESK_SLOTS.find((s) => animatedDeskAnchors(fit, new Set([s.id])).coffees.length === 1);
    expect(mugSlot).toBeDefined();
    const minusOne = new Set(allSlots);
    minusOne.delete(mugSlot!.id);
    expect(animatedDeskAnchors(fit, minusOne).coffees.length).toBe(full - 1);
  });
});

describe('working monitor desktop', () => {
  const fit = fitFloor(1200, 900);

  function paintsFor(activity: OfficeNode['activity']): string[] {
    const member = node('stanley', activity);
    const members = new Map([[member.name, member]]);
    const placements = assignSeats([member]);
    const paints: string[] = [];
    renderScene(mockCtx(paints), fit, placements, members, homePoses(placements, members), 2.4);
    return paints;
  }

  it('renders Stanley’s working window desk as a living desktop', () => {
    // Stanley hashes to desk-slot index 15, whose stable desk ID is 20. The layout's sparse IDs must
    // never make this working, camera-facing screen fall back to the dark idle slab.
    expect(paintsFor('working')).toContain('#2f9a8a');
  });

  it('keeps Stanley’s idle monitor dim', () => {
    expect(paintsFor('idle')).not.toContain('#2f9a8a');
  });
});

/** The full painter's-order pass. An *empty* office still draws all 12 workstations — every chair (the
 * per-desk style variety), every monitor setup, keyboard and mouse — so this exercises the whole furniture
 * surface, including the stable per-desk chair/monitor/peripheral variation, without needing live actors. */
/** Where the break-nook's ambient steam is born. The machine is drawn *and* anchored from the same
 * geometry, and the two drifting apart is silent: the plume simply starts inside the machine and the
 * espresso reads as a small fire. */
describe('coffeeAnchor (the ambient steam source)', () => {
  const fit = fitFloor(1200, 900);

  it('sits above the machine, not inside it — steam leaves the warmer plate', () => {
    const counterTop = project(NOOK.lx + LOUNGE.machine.dx, NOOK.ly + LOUNGE.machine.dy, fit).y - LOUNGE.counter.h * fit.scale;
    const clearance = (counterTop - coffeeAnchor(fit).y) / fit.scale; // screen y grows downward
    expect(clearance).toBeGreaterThanOrEqual(MACHINE_H);
  });

  it('is centred on the machine, so the plume rises off the machine and not the counter beside it', () => {
    expect(coffeeAnchor(fit).x).toBeCloseTo(project(NOOK.lx + LOUNGE.machine.dx, NOOK.ly + LOUNGE.machine.dy, fit).x);
  });
});

/**
 * The wall agile board (`wallLaneBoard`) — the object that replaced the whiteboard. It draws REAL
 * lane data as sticky notes in state-toned columns; the only type it sets is the `+N` overflow
 * badge. Member colours stay off the wall: identity lives on the floor, state lives on the board.
 */
describe('the wall agile board', () => {
  const fit = fitFloor(1200, 900);

  /** A little board: two open, one active, one blocked. */
  const wallData = (): WallBoard =>
    projectWallBoard({
      lanes: [
        laneFix('a', 'open'),
        laneFix('b', 'open'),
        laneFix('c', 'active'),
        laneFix('d', 'blocked'),
      ],
      warnings: [],
    })!;

  /** A ctx that also records `fillText` / stroke colours. */
  function textCtx(paints: string[], texts: string[]): CanvasRenderingContext2D {
    const grad = { addColorStop: (_s: number, c: string) => void paints.push(c) };
    return new Proxy(
      {},
      {
        get(_t, prop) {
          if (prop === 'canvas') return { width: 1200, height: 900 };
          if (prop === 'createLinearGradient' || prop === 'createRadialGradient') return () => grad;
          if (prop === 'measureText') return () => ({ width: 0 });
          if (prop === 'fillText') return (s: string) => void texts.push(s);
          return () => undefined;
        },
        set(_t, prop, value) {
          if ((prop === 'fillStyle' || prop === 'strokeStyle') && typeof value === 'string') paints.push(value);
          return true;
        },
      },
    ) as unknown as CanvasRenderingContext2D;
  }

  const roster = (nodes: OfficeNode[]): Map<string, OfficeNode> => new Map(nodes.map((n) => [n.name, n]));
  const scene = (ctx: CanvasRenderingContext2D, wall: WallBoard | null): void =>
    void renderScene(ctx, fit, new Map(), roster([node('ada', 'working')]), new Map(), 0, 'revive', undefined, null, undefined, null, wall);

  it('paints the face and the lanes in state tones, never member roster colours', () => {
    const paints: string[] = [];
    const nodes = ['ada', 'bo'].map((n) => node(n, 'working'));
    renderScene(textCtx(paints, []), fit, new Map(), roster(nodes), new Map(), 0, 'revive', undefined, null, undefined, null, wallData());
    expect(paints).toContain('#C98F52'); // the cork face
    expect(paints).toContain('#DCBF8E'); // the pale oak frame
    expect(paints).toContain('#5A52C9'); // the active cap — --lc-lane's hex twin
    expect(paints).toContain('#D1503F'); // the blocked cap
    expect(paints).toContain('#EFE8D8'); // an open sticky's paper wash
    expect(paints).toContain('rgba(180, 168, 143, 0.75)'); // its washi tab, at the cap's tone
    for (const n of nodes) expect(paints).not.toContain(n.color);
  });

  it('hangs an empty board when no team is connected: face and caps, zero paper', () => {
    const paints: string[] = [];
    scene(textCtx(paints, []), null);
    expect(paints).toContain('#C98F52'); // cork
    expect(paints).toContain('#5A52C9'); // caps announce their column even bare
    expect(paints).not.toContain('#EFE8D8'); // …but no sticky paper hangs under them
    expect(paints).not.toContain('#D8D4F3');
    expect(paints).not.toContain('rgba(180, 168, 143, 0.75)'); // and no tape holding nothing
  });

  it('paints the Team working-hours sign from schedule data', () => {
    const texts: string[] = [];
    const hours: WorkingHours = {
      timezone: 'America/Los_Angeles',
      days: ['mon', 'tue', 'wed', 'thu', 'fri'],
      start: '11:00',
      end: '15:00',
    };
    renderScene(
      textCtx([], texts),
      fit,
      new Map(),
      roster([node('ada', 'working')]),
      new Map(),
      0,
      'revive',
      undefined,
      null,
      undefined,
      null,
      null,
      hours,
    );
    expect(texts).toContain('TEAM WORKING HOURS');
    expect(texts).toContain('MON–FRI · 11:00 AM–3:00 PM');
    expect(texts).toContain('PACIFIC TIME');
  });

  it('writes only the overflow badge — a column past its cap says +N, nothing else says anything', () => {
    const texts: string[] = [];
    const crowded = projectWallBoard({
      lanes: Array.from({ length: STICKY_CAP + 2 }, (_, i) => laneFix(`L${i}`, 'open')),
      warnings: [],
    })!;
    scene(textCtx([], texts), crowded);
    expect(texts).toContain('+2');
    const quiet: string[] = [];
    scene(textCtx([], quiet), wallData());
    expect(quiet.some((t) => /^\+\d+$/.test(t))).toBe(false);
  });

  /** Fills painted in sticky-paper colours — the wall's DOM-cap analogue: never more than 6 columns
   * of STICKY_CAP notes (each note is two fills: paper + header edge), however big the real board. */
  it('never pins more paper than the cap allows, however many lanes exist', () => {
    const paints: string[] = [];
    const flood = projectWallBoard({
      lanes: Array.from({ length: 80 }, (_, i) => laneFix(`L${i}`, (['open', 'active', 'blocked', 'done'] as const)[i % 4]!)),
      warnings: [],
    })!;
    scene(textCtx(paints, []), flood);
    const paper = new Set(['#EFE8D8', '#E6E3F8', '#D8D4F3', '#F5DAD4', '#DFDCF6', '#D5ECDF']);
    const notes = paints.filter((c) => paper.has(c)).length;
    expect(notes).toBeGreaterThan(0);
    expect(notes).toBeLessThanOrEqual(6 * STICKY_CAP);
  });

  it('boardAnchor returns a finite on-screen box for the hotspot to sit on', () => {
    const a = boardAnchor(fit);
    for (const v of [a.x, a.y, a.w, a.h]) expect(Number.isFinite(v)).toBe(true);
    expect(a.w).toBeGreaterThan(0);
    expect(a.h).toBeGreaterThan(0);
  });
});

/**
 * The books. Packing is a pure function so it can be checked without a canvas — the interesting
 * behaviour is all in the numbers (does a shelf vary, does it stay inside its carcass, is it stable
 * across repaints), and none of it needs a pixel to assert.
 */
describe('packShelf — the books are not a texture swatch', () => {
  const shelf = () => packShelf(0, 0, 58, false);

  it('varies spine width, height and colour across one shelf', () => {
    const run = shelf();
    expect(run.length).toBeGreaterThan(4);
    expect(new Set(run.map((b) => b.w)).size).toBeGreaterThan(1);
    expect(new Set(run.map((b) => b.h)).size).toBeGreaterThan(1);
    expect(new Set(run.map((b) => b.color)).size).toBeGreaterThan(2);
  });

  it('offers a white and a black spine — a shelf of mid-tones reads as a picked palette', () => {
    expect(BOOK_COLORS).toContain('#f4f1ea');
    expect(BOOK_COLORS).toContain('#22201d');
  });

  it('leans a few books and leaves most upright', () => {
    // Sample several shelves: one row is a small sample, and the point is the *proportion*.
    const all = [0, 1, 2, 3].flatMap((si) => [0, 1].flatMap((r) => packShelf(si, r, 58, false)));
    const leaning = all.filter((b) => b.lean !== 0);
    expect(leaning.length).toBeGreaterThan(0);
    expect(leaning.length).toBeLessThan(all.length / 2);
  });

  it('is deterministic — a baked layer that changes between repaints flickers', () => {
    expect(packShelf(2, 1, 58, false)).toEqual(packShelf(2, 1, 58, false));
    expect(shelfRnd(1, 2, 3)).toBe(shelfRnd(1, 2, 3));
  });

  it('gives different shelves different books', () => {
    expect(packShelf(0, 0, 58, false)).not.toEqual(packShelf(1, 0, 58, false));
  });

  it('keeps every book inside the carcass', () => {
    for (const long of [44, 58, 76]) {
      for (const b of packShelf(1, 0, long, false)) {
        expect(Math.abs(b.along) + b.w / 2).toBeLessThanOrEqual(long / 2);
      }
    }
  });

  it('shelves a reversed unit as page edges with no lettering to read', () => {
    const run = packShelf(1, 0, 76, true);
    expect(run.every((b) => b.title === '')).toBe(true);
    expect(run.every((b) => b.color !== '#22201d')).toBe(true);
  });

  it('titles every spine on a normal shelf', () => {
    const run = [0, 1, 2, 3].flatMap((si) => packShelf(si, 0, 58, false));
    expect(run.every((b) => b.title.length > 0)).toBe(true);
    expect(new Set(run.map((b) => b.title)).size).toBeGreaterThan(2);
  });

  it('letters in more than one ink — a shelf of all-white titles reads as one printing run', () => {
    const run = [0, 1, 2, 3].flatMap((si) => [0, 1].flatMap((r) => packShelf(si, r, 58, false)));
    expect(new Set(run.map((b) => b.ink)).size).toBeGreaterThan(2);
  });

  it('packs the books nearly shoulder to shoulder — an airy row reads as a colour swatch', () => {
    const run = packShelf(0, 0, 58, false);
    for (let i = 1; i < run.length; i++) {
      const gap = (run[i]!.along - run[i]!.w / 2) - (run[i - 1]!.along + run[i - 1]!.w / 2);
      expect(gap).toBeLessThan(2);
    }
  });
});

describe('the wall clock has a numbered dial', () => {
  const fit = fitFloor(1200, 900);
  const roster = (nodes: OfficeNode[]): Map<string, OfficeNode> => new Map(nodes.map((n) => [n.name, n]));

  it('sets twelve numerals with the quarters heavier', () => {
    expect(CLOCK_NUMERALS).toHaveLength(12);
    const heavy = CLOCK_NUMERALS.filter((n) => n.big).map((n) => n.hour);
    expect([...heavy].sort((a, b) => a - b)).toEqual([3, 6, 9, 12]);
  });

  it('runs the hours in clock order from 12', () => {
    expect(CLOCK_NUMERALS.map((n) => n.hour)).toEqual([12, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  });

  /** Collects every string the scene sets with `fillText`. */
  function sceneText(): string[] {
    const texts: string[] = [];
    const ctx = new Proxy(
      {},
      {
        get(_t, prop) {
          if (prop === 'canvas') return { width: 1200, height: 900 };
          if (prop === 'createLinearGradient' || prop === 'createRadialGradient')
            return () => ({ addColorStop() {} });
          if (prop === 'measureText') return () => ({ width: 0 });
          if (prop === 'fillText') return (s: string) => void texts.push(s);
          return () => undefined;
        },
        set: () => true,
      },
    ) as unknown as CanvasRenderingContext2D;
    renderScene(ctx, fit, new Map(), roster([node('ada', 'working')]), new Map());
    return texts;
  }

  it('sets the quarters as real type — twelve scribbles on a 26px face is grit, not a clock', () => {
    const texts = sceneText();
    for (const n of CLOCK_NUMERALS.filter((c) => c.big)) {
      expect(texts).toContain(String(n.hour));
    }
  });

  it('leaves the other eight hours as ticks rather than cramming in more numerals', () => {
    const texts = sceneText();
    for (const n of CLOCK_NUMERALS.filter((c) => !c.big)) {
      expect(texts).not.toContain(String(n.hour));
    }
  });

  it('writes no words on the agile board by default — an empty board has nothing to say', () => {
    const texts = sceneText();
    expect(texts.some((t) => /^\+\d+$/.test(t))).toBe(false);
  });
});

describe('the working-hours clock companion', () => {
  const fit = fitFloor(1200, 900);
  const schedule: WorkingHours = {
    timezone: 'America/Los_Angeles',
    days: ['mon', 'tue', 'wed', 'thu', 'fri'],
    start: '11:00',
    end: '15:00',
  };

  it('sets every schedule line through the wall-plane text transform', () => {
    const textEvents: Array<{ text: string; wallTransforms: number }> = [];
    const transforms: number[] = [0];
    const ctx = new Proxy(
      {},
      {
        get(_target, prop) {
          if (prop === 'canvas') return { width: 1200, height: 900 };
          if (prop === 'createLinearGradient' || prop === 'createRadialGradient') return () => ({ addColorStop() {} });
          if (prop === 'measureText') return () => ({ width: 0 });
          if (prop === 'save') return () => transforms.push(transforms.at(-1)!);
          if (prop === 'restore') return () => void transforms.pop();
          if (prop === 'transform') return () => { transforms[transforms.length - 1]! += 1; };
          if (prop === 'fillText') return (text: string) => textEvents.push({ text, wallTransforms: transforms.at(-1)! });
          return () => undefined;
        },
        set: () => true,
      },
    ) as unknown as CanvasRenderingContext2D;

    renderScene(ctx, fit, new Map(), new Map(), new Map(), 4, 'revive', computeLightEnv(12, false), null, undefined, null, null, schedule);

    for (const text of ['TEAM WORKING HOURS', 'MON–FRI · 11:00 AM–3:00 PM', 'PACIFIC TIME']) {
      const matches = textEvents.filter((event) => event.text === text);
      expect(matches, text).not.toHaveLength(0);
      expect(matches.every((event) => event.wallTransforms > 0), text).toBe(true);
    }
  });
});

describe('renderScene draws the whole office without throwing', () => {
  const fit = fitFloor(1200, 900);
  const empty = new Map();

  it('renders an empty office (all desks vacant) — every chair style + monitor setup drawn', () => {
    expect(() => renderScene(mockCtx(), fit, empty, new Map(), new Map())).not.toThrow();
  });

  it('renders through the day and the night lighting envelopes', () => {
    expect(() => renderScene(mockCtx(), fit, empty, new Map(), new Map(), 0, 'revive', computeLightEnv(12, true))).not.toThrow();
    expect(() => renderScene(mockCtx(), fit, empty, new Map(), new Map(), 0, 'revive', computeLightEnv(1, false))).not.toThrow();
  });

  it('only ever assigns colours canvas can parse', () => {
    // The failure this catches is silent by construction — canvas keeps its previous colour rather than
    // throwing — so nothing else in the suite can see it. Run the populated scene (members at desks *and*
    // on the leisure furniture) so every furniture path that shades a face gets exercised.
    const paints: string[] = [];
    const nodes: OfficeNode[] = [
      node('desker', 'working'),
      node('lounger', 'idle'),
      node('reader', 'idle'),
    ];
    const byName = new Map(nodes.map((n) => [n.name, n]));
    const placements = assignSeats(nodes);
    const poses = homePoses(placements, byName);
    renderScene(mockCtx(paints), fit, placements, byName, poses, 1.5, 'revive', computeLightEnv(21, true));

    expect(paints.length).toBeGreaterThan(50); // the pass actually ran
    expect(paints.filter((c) => !parseableColor(c))).toEqual([]);
  });
});

/**
 * The gait. These are the numbers behind "his feet are barely moving" (nick, 2026-07-28), and each one
 * is a property of the walk rather than a snapshot of it — a resize of the dog must not be able to
 * quietly reintroduce the skate.
 */
describe('pawCycle (the dog does not skate)', () => {
  it('carries the paw the full reach, once per cycle', () => {
    const xs = Array.from({ length: 400 }, (_, i) => pawCycle(i / 400).x);
    // Reach is normalised to 1, ±a few percent of overshoot at each end: the paw carries on backward
    // for an instant after lift-off and reaches a little past the plant before it comes down, because
    // the swing leaves and re-enters at stance velocity. That overshoot is the follow-through — a paw
    // that stopped dead on the reach marks would be the sewing machine again.
    expect(Math.max(...xs)).toBeGreaterThan(0.5);
    expect(Math.max(...xs)).toBeLessThan(0.58);
    expect(Math.min(...xs)).toBeLessThan(-0.5);
    expect(Math.min(...xs)).toBeGreaterThan(-0.58);
    expect(pawCycle(0).x).toBeCloseTo(pawCycle(1).x, 10);
  });

  it('holds the floor at a constant speed through stance — the no-scrub rule', () => {
    // A planted paw must track backward at EXACTLY ground speed. Any wobble here is the foot sliding
    // on the floor, which is the entire visual bug this cycle replaced.
    const step = 0.001;
    const vs: number[] = [];
    for (let p = 0.02; p < 0.5; p += 0.02) vs.push((pawCycle(p + step).x - pawCycle(p).x) / step);
    const v0 = vs[0]!;
    for (const v of vs) expect(v).toBeCloseTo(v0, 6);
    expect(v0).toBeLessThan(0); // and backward, not forward
  });

  it('is C¹ across both handoffs, so the paw never stalls mid-air or hitches on landing', () => {
    // One-sided slopes taken right up against each join — a central difference would straddle it and
    // average the very discontinuity under test.
    const h = 1e-6;
    const after = (p: number) => (pawCycle(p + h).x - pawCycle(p).x) / h;
    const before = (p: number) => (pawCycle(p).x - pawCycle(p - h).x) / h;
    const stance = after(0.3);
    expect(after(0.56)).toBeCloseTo(stance, 3); // lift-off: still going backward at ground speed
    expect(before(1)).toBeCloseTo(stance, 3); // touch-down: already going backward at ground speed
  });

  it('lifts the paw only while it is swinging', () => {
    for (let p = 0; p < 0.55; p += 0.05) expect(pawCycle(p).lift).toBe(0);
    expect(pawCycle(0.78).lift).toBeGreaterThan(0.5);
    expect(pawCycle(0.999).lift).toBeLessThan(0.05); // back on the floor as it lands
  });
});

/** Every dog pose gets painted somewhere — sleeping in the baked frame, trotting in the live loop — and a
 * pose that throws would take the whole scene's frame down with it, not just the dog. */
describe('drawDog paints every pose', () => {
  const fit = fitFloor(1200, 900);
  const modes: PetMode[] = ['sleep', 'curl', 'sit', 'stretch', 'walk'];

  it.each(modes)('draws the %s pose without throwing, both facings', (mode) => {
    for (const flip of [false, true]) {
      const pet: PetState = { lx: 300, ly: 300, mode, modeT: 0.4, phase: 1.7, flip, path: [], seg: 0, plan: 'nap', sitFor: 5, speed: 55, face: flip ? -1 : 1, faceMag: 1, depthSign: 1, vel: 55 };
      expect(() => drawDog(mockCtx(), fit, pet, 3.2)).not.toThrow();
    }
  });

  /** The narrow walk headings crossfade in the chest-on/rump-on view — both must paint. */
  it.each([1, -1] as const)('draws the walk at a narrow facing (depthSign %d) without throwing', (depthSign) => {
    const pet: PetState = { lx: 300, ly: 300, mode: 'walk', modeT: 0.4, phase: 1.7, flip: false, path: [], seg: 0, plan: 'nap', sitFor: 5, speed: 55, face: 0.18, faceMag: 0.18, depthSign, vel: 55 };
    expect(() => drawDog(mockCtx(), fit, pet, 3.2)).not.toThrow();
  });

  /**
   * The dog is white with black patches, and both halves of that have to survive every pose. A coat
   * that loses its markings in one pose is the failure worth catching: the patches are what carry the
   * silhouette on a warm floor, so a pose painted in flat white is a dog-shaped hole in the room.
   */
  it.each(modes)('gives the %s pose both a white coat and black markings', (mode) => {
    const paints: string[] = [];
    const pet: PetState = { lx: 300, ly: 300, mode, modeT: 0.4, phase: 1.7, flip: false, path: [], seg: 0, plan: 'nap', sitFor: 5, speed: 55, face: 1, faceMag: 1, depthSign: 1, vel: 55 };
    drawDog(mockCtx(paints), fit, pet, 3.2);
    const lum = (hex: string) => {
      const m = /^#([0-9a-f]{6})$/i.exec(hex);
      if (!m) return null;
      const n = parseInt(m[1]!, 16);
      return (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
    };
    const lums = paints.map(lum).filter((l): l is number => l !== null);
    expect(lums.some((l) => l > 0.85)).toBe(true); // the coat
    expect(lums.some((l) => l < 0.25)).toBe(true); // the markings
  });
});

/** The window glass reads from the same PST lighting as the beams and the veil — bright sky by day, a
 * dark pane by night — so the whole room tells one time-of-day story (office-walls-windows.md). */
describe('glassColor (windows track the day cycle)', () => {
  const rgb = (s: string) => (/rgb\((\d+),\s*(\d+),\s*(\d+)\)/.exec(s) ?? []).slice(1).map(Number);
  const luma = ([r, g, b]: number[]) => 0.299 * r! + 0.587 * g! + 0.114 * b!;

  it('is a bright pane at midday and a dark pane at deep night', () => {
    const day = luma(rgb(glassColor(computeLightEnv(12, true))));
    const night = luma(rgb(glassColor(computeLightEnv(1, false))));
    expect(day).toBeGreaterThan(night + 80); // unmistakably lit vs unlit
    expect(night).toBeLessThan(60); // genuinely dark, not just dimmer
  });

  it('warms toward golden hour rather than staying cold blue', () => {
    // dawn/dusk skew warm (more red than blue); flat midday is the coolest.
    const [dr, , db] = rgb(glassColor(computeLightEnv(6.5, true))); // dawn ramp
    const [nr, , nb] = rgb(glassColor(computeLightEnv(12, true))); // noon
    expect(dr! - db!).toBeGreaterThan(nr! - nb!);
  });
});

describe('where an actor sorts against the furniture', () => {
  const slot = DESK_SLOTS[0]!;
  const couch = { lx: NOOK.lx + LOUNGE.couch.dx, ly: NOOK.ly + LOUNGE.couch.dy };
  const cushion = { lx: couch.lx + 34, ly: couch.ly + 4 };

  function pose(over: Partial<Pose>): Pose {
    return {
      lx: slot.lx,
      ly: slot.ly,
      dir: slot.dir,
      small: false,
      carry: null,
      bubble: null,
      alpha: 1,
      moving: false,
      run: false,
      gesture: 0,
      gestureT: 0,
      phase: 0,
      stride: 0,
      sit: 0,
      ...over,
    };
  }

  it('sits a desk member at their chair, not at their feet', () => {
    const a = actorSortAnchor(pose({ sit: 1 }), slot, undefined);
    expect(a.seatedAtDesk).toBe(true);
    // the chair is CHAIR_OFF behind the desk, i.e. not the pose's own position
    expect(Math.hypot(a.lx - slot.lx, a.ly - slot.ly)).toBeGreaterThan(30);
  });

  it('sorts an errand diner at the couch, never at the desk they came from', () => {
    // The bug: this member's *placement* is still their desk while an errand has sat them on the
    // lounge couch. Keying off the placement sorted them across the room and the office painted over
    // them — they vanished for the length of the meal.
    const p = pose({ ...cushion, sit: 1, depthAt: couch });
    const a = actorSortAnchor(p, slot, undefined);
    expect(a.seatedAtDesk).toBe(false);
    expect(a.lx).toBe(couch.lx);
    expect(a.ly).toBe(couch.ly);
  });

  it('sorts a member at their own feet while the sit blend eases off after standing', () => {
    // The same bug's other face: `sit` eases down rather than switching, so just after getting up the
    // walker still read as seated — and was still sorted at that distant desk, sliding through the
    // lounge furniture on the way out.
    const p = pose({ lx: cushion.lx + 40, ly: cushion.ly + 40, sit: 0.7 });
    const a = actorSortAnchor(p, slot, undefined);
    expect(a.seatedAtDesk).toBe(false);
    expect(a.lx).toBe(p.lx);
    expect(a.ly).toBe(p.ly);
  });

  it('sorts a standing member at their feet even while at their own desk', () => {
    const a = actorSortAnchor(pose({ sit: 0 }), slot, undefined);
    expect(a.seatedAtDesk).toBe(false);
    expect(a.lx).toBe(slot.lx);
  });

  it('still honours a leisure placement that asks to sort with its furniture', () => {
    const p = pose({ ...cushion, sit: 1 });
    const a = actorSortAnchor(p, undefined, { depthAt: couch });
    expect(a.lx).toBe(couch.lx);
  });
});
