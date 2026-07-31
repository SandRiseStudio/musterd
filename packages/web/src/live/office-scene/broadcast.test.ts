import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ambientFrameBudgetMs,
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
