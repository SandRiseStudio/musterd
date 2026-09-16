import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ambientFrameBudgetMs,
  coalesceStep,
  officeDpr,
  officeVisible,
  shouldCoalesceDraw,
  suspendIgnored,
} from './broadcast';

/**
 * These are the decisions broadcast mode inverts (ADR 157 + capture-perf draw-rate cap). They are
 * gates, not effects: the render loop, the ambient scheduler and the resize path all consult them,
 * so proving them here proves every gate site at once. The *end-to-end* claim — "a headless page
 * really does keep painting" — is the headless-CDP check in the ADR.
 */
describe('broadcast gates', () => {
  afterEach(() => vi.unstubAllGlobals());

  describe('officeVisible', () => {
    it('runs the loop with a hidden document when broadcasting', () => {
      vi.stubGlobal('document', { visibilityState: 'hidden' });
      expect(officeVisible(true)).toBe(true);
    });

    it('REGRESSION: a normal office still parks when the tab is hidden', () => {
      vi.stubGlobal('document', { visibilityState: 'hidden' });
      expect(officeVisible(false)).toBe(false);
    });

    it('a normal office runs while the tab is visible', () => {
      vi.stubGlobal('document', { visibilityState: 'visible' });
      expect(officeVisible(false)).toBe(true);
    });

    it('never even reads the document when broadcasting (a headless page has no visibility to read)', () => {
      const visibilityState = vi.fn(() => 'hidden');
      vi.stubGlobal('document', {
        get visibilityState() {
          return visibilityState();
        },
      });
      expect(officeVisible(true)).toBe(true);
      expect(visibilityState).not.toHaveBeenCalled();
    });
  });

  describe('officeDpr', () => {
    it('pins to 1 when broadcasting, whatever the display reports', () => {
      vi.stubGlobal('window', { devicePixelRatio: 2 });
      expect(officeDpr(true, 2)).toBe(1);
    });

    it('REGRESSION: a normal office still renders at the capped device DPR', () => {
      vi.stubGlobal('window', { devicePixelRatio: 2 });
      expect(officeDpr(false, 2)).toBe(2);
    });

    it('caps a 3× display and floors a missing ratio at 1', () => {
      vi.stubGlobal('window', { devicePixelRatio: 3 });
      expect(officeDpr(false, 2)).toBe(2);
      vi.stubGlobal('window', { devicePixelRatio: 0 });
      expect(officeDpr(false, 2)).toBe(1);
    });
  });

  describe('ambientFrameBudgetMs', () => {
    it('broadcast coalesces to the capture fps — not full rAF, not the viewer 20fps ambient cap', () => {
      // 20fps content on a 30fps encode is #368 cadence judder; uncapped rAF wastes compositor work
      // the encoder never sees (capture-perf plan). Matching paint rate to capture fps is the fix.
      expect(ambientFrameBudgetMs(true, 50, 30)).toBe(1000 / 30);
      expect(ambientFrameBudgetMs(true, 50, 25)).toBe(1000 / 25);
    });

    it('defaults capture fps to 30 when broadcast omits it (CLI / ADR 157 default)', () => {
      expect(ambientFrameBudgetMs(true, 50)).toBe(1000 / 30);
    });

    it('nonsense capture fps falls back to 30 rather than zero-budget (which would paint every rAF)', () => {
      expect(ambientFrameBudgetMs(true, 50, 0)).toBe(1000 / 30);
      expect(ambientFrameBudgetMs(true, 50, -5)).toBe(1000 / 30);
      expect(ambientFrameBudgetMs(true, 50, Number.NaN)).toBe(1000 / 30);
    });

    it('REGRESSION: a viewer keeps the ~20fps ambient coalescing (a measured, standing win)', () => {
      expect(ambientFrameBudgetMs(false, 50)).toBe(50);
      expect(ambientFrameBudgetMs(false, 50, 25)).toBe(50); // capture fps is ignored off-broadcast
    });
  });

  describe('shouldCoalesceDraw', () => {
    it('broadcast coalesces even during walks/cues — that is when the office is most expensive', () => {
      // Known gap in the plan's candidate #1: the budget alone only fires when ambientOnly.
      // Without this, walks still paint every rAF and the cap buys almost nothing on a live team.
      expect(shouldCoalesceDraw(true, false)).toBe(true);
      expect(shouldCoalesceDraw(true, true)).toBe(true);
    });

    it('REGRESSION: a viewer only coalesces ambient-only stretches', () => {
      expect(shouldCoalesceDraw(false, true)).toBe(true);
      expect(shouldCoalesceDraw(false, false)).toBe(false);
    });
  });

  describe('coalesceStep', () => {
    /** Drive the scheduler with a fixed rAF period for `n` ticks; count draws. */
    const run = (rafMs: number | (() => number), budgetMs: number, n: number) => {
      let phase = 0;
      let draws = 0;
      for (let i = 0; i < n; i++) {
        const r = coalesceStep(phase, typeof rafMs === 'number' ? rafMs : rafMs(), budgetMs);
        phase = r.phase;
        if (r.draw) draws++;
      }
      return draws;
    };

    it('MEASURED 2026-09-16: a rAF running AT the budget with jitter must never drop a draw', () => {
      // On the performance-4x box at 1080p20 Chrome's rAF ran ~19-20Hz — a period equal to the 50ms
      // budget. The old `acc < budget → skip` rule dropped every tick that landed a hair early, and
      // delivered fps read 14.9 while ffmpeg said 20. That gap was padding, and it looked choppy.
      let i = 0;
      const jitter = () => (i++ % 2 === 0 ? 49 : 51);
      expect(run(jitter, 50, 400)).toBe(400);
    });

    it('a rAF slower than the budget draws on every tick', () => {
      expect(run(66.7, 50, 300)).toBe(300);
    });

    it('a 60Hz rAF on a 50ms budget still coalesces to 20/s (the viewer ambient cap, unchanged)', () => {
      expect(run(1000 / 60, 50, 600)).toBe(200);
    });

    it('a 30Hz rAF on a 50ms budget draws 2 of 3 — neither 15/s (drop) nor 30/s (waste)', () => {
      // Nearest-tick rounding alone would draw every tick here; carrying the remainder is what makes
      // the long-run rate land on the budget.
      expect(run(1000 / 30, 50, 300)).toBe(200);
    });

    it('a rAF a hair faster than the budget lands the long-run rate on the budget, not above it', () => {
      // 20.5Hz rAF, 20fps budget: 1000 ticks ≈ 48.8s → 976 draws expected, ±1.
      const draws = run(1000 / 20.5, 50, 1000);
      expect(draws).toBeGreaterThanOrEqual(975);
      expect(draws).toBeLessThanOrEqual(977);
    });

    it('a stall does not bank a burst of catch-up draws', () => {
      // One 2s rAF gap (laptop lid, GC pause) then a steady 60Hz: the phase is clamped, so the next
      // few ticks do not all draw to "repay" the gap.
      let phase = coalesceStep(0, 2000, 50).phase;
      let draws = 0;
      for (let i = 0; i < 6; i++) {
        const r = coalesceStep(phase, 1000 / 60, 50);
        phase = r.phase;
        if (r.draw) draws++;
      }
      expect(draws).toBeLessThanOrEqual(2);
    });
  });

  describe('suspendIgnored', () => {
    it('a stream never parks — setSuspended(true) is a no-op when broadcasting', () => {
      expect(suspendIgnored(true, true)).toBe(true);
    });

    it('leaves resume alone, and leaves a normal office fully suspendable', () => {
      expect(suspendIgnored(true, false)).toBe(false);
      expect(suspendIgnored(false, true)).toBe(false);
      expect(suspendIgnored(false, false)).toBe(false);
    });
  });
});
