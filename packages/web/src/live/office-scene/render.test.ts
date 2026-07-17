import { describe, expect, it } from 'vitest';
import { homePoses } from './actors';
import { memberColor } from '../format';
import { fitFloor, project } from './iso';
import { DESK_SLOTS, LOUNGE, NOOK } from './layout';
import { computeLightEnv } from './lighting';
import type { PetMode, PetState } from './pet';
import { animatedDeskAnchors, coffeeAnchor, drawDog, glassColor, MACHINE_H, renderScene } from './render';
import { assignSeats } from './seating';
import type { OfficeNode } from './types';

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

/** Every dog pose gets painted somewhere — sleeping in the baked frame, trotting in the live loop — and a
 * pose that throws would take the whole scene's frame down with it, not just the dog. */
describe('drawDog paints every pose', () => {
  const fit = fitFloor(1200, 900);
  const modes: PetMode[] = ['sleep', 'curl', 'sit', 'stretch', 'walk'];

  it.each(modes)('draws the %s pose without throwing, both facings', (mode) => {
    for (const flip of [false, true]) {
      const pet: PetState = { lx: 300, ly: 300, mode, modeT: 0.4, phase: 1.7, flip, path: [], seg: 0, plan: 'nap', sitFor: 5 };
      expect(() => drawDog(mockCtx(), fit, pet, 3.2)).not.toThrow();
    }
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
