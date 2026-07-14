import { describe, expect, it } from 'vitest';
import { fitFloor } from './iso';
import { DESK_SLOTS } from './layout';
import { computeLightEnv } from './lighting';
import { animatedDeskAnchors, glassColor } from './render';

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
