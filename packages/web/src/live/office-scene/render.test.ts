import { describe, expect, it } from 'vitest';
import { fitFloor } from './iso';
import { DESK_SLOTS } from './layout';
import { animatedDeskAnchors } from './render';

/** The fan/coffee overlay anchors (Tier-A animated props). The key behaviour: a fan only spins at an
 * *occupied* desk — an unattended running fan reads as wrong — while coffee steam stays on every mug. */
describe('animatedDeskAnchors', () => {
  const fit = fitFloor(1200, 900);
  const allSlots = new Set(DESK_SLOTS.map((s) => s.id));

  it('spins no fans when no desks are occupied, but still steams every coffee mug', () => {
    const { fans, coffees } = animatedDeskAnchors(fit, new Set());
    expect(fans).toHaveLength(0);
    expect(coffees.length).toBeGreaterThan(0);
  });

  it('spins a fan at every occupied fan-desk when all desks are seated', () => {
    const empty = animatedDeskAnchors(fit, new Set()).fans.length; // 0
    const full = animatedDeskAnchors(fit, allSlots).fans;
    expect(empty).toBe(0);
    expect(full.length).toBeGreaterThan(0); // some desks carry a fan (a stable per-desk hash)
  });

  it('coffee-steam count is independent of occupancy (a fresh cup outlives a member stepping away)', () => {
    const a = animatedDeskAnchors(fit, new Set()).coffees.length;
    const b = animatedDeskAnchors(fit, allSlots).coffees.length;
    expect(a).toBe(b);
  });

  it('drops a fan the moment its desk empties (gated per-slot, not all-or-nothing)', () => {
    const full = animatedDeskAnchors(fit, allSlots).fans.length;
    // Occupy every desk *except* one that carries a fan → exactly one fewer spinning fan.
    const fanSlot = DESK_SLOTS.find((s) => {
      const withOnly = animatedDeskAnchors(fit, new Set([s.id])).fans.length;
      return withOnly === 1; // this slot has a fan
    });
    expect(fanSlot).toBeDefined();
    const minusOne = new Set(allSlots);
    minusOne.delete(fanSlot!.id);
    expect(animatedDeskAnchors(fit, minusOne).fans.length).toBe(full - 1);
  });
});
