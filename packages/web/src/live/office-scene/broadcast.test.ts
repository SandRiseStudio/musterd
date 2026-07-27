import { afterEach, describe, expect, it, vi } from 'vitest';
import { frameBudgetMs, officeDpr, officeVisible, suspendIgnored } from './broadcast';

/**
 * These are the three decisions broadcast mode inverts (ADR 157). They are gates, not effects: the
 * render loop, the ambient scheduler and the resize path all consult `officeVisible`, so proving it
 * here proves every gate site at once. The *end-to-end* claim — "a headless page really does keep
 * painting" — is the headless-CDP check in the ADR, which is the only place a real Canvas2D exists.
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

  describe('frameBudgetMs', () => {
    const viewer = { broadcast: false, streamFps: 0, ambientCapMs: 50 };
    const stream = { broadcast: true, ambientCapMs: 50 };

    it('REGRESSION: a viewer keeps the ~20fps ambient coalescing (a measured, standing win)', () => {
      expect(frameBudgetMs({ ...viewer, ambientOnly: true })).toBe(50);
    });

    it('a viewer paints every frame once something real is moving', () => {
      expect(frameBudgetMs({ ...viewer, ambientOnly: false })).toBe(0);
    });

    it('a broadcast paints at the encode rate — half the work of full rAF, still 1:1 cadence', () => {
      expect(frameBudgetMs({ ...stream, streamFps: 30, ambientOnly: false })).toBeCloseTo(33.33, 1);
    });

    it('caps a broadcast during real motion too — where the render cost actually is', () => {
      // The old shape only capped when nothing was happening, which is when drawing is cheapest.
      expect(frameBudgetMs({ ...stream, streamFps: 30, ambientOnly: false })).toBe(
        frameBudgetMs({ ...stream, streamFps: 30, ambientOnly: true }),
      );
    });

    it('never coalesces a broadcast to the ambient 20fps — that is the judder the encode punishes', () => {
      expect(frameBudgetMs({ ...stream, streamFps: 30, ambientOnly: true })).toBeLessThan(50);
    });

    it('follows the stream rate rather than assuming 30', () => {
      expect(frameBudgetMs({ ...stream, streamFps: 60, ambientOnly: true })).toBeCloseTo(16.67, 1);
      expect(frameBudgetMs({ ...stream, streamFps: 15, ambientOnly: true })).toBeCloseTo(66.67, 1);
    });

    it('paints everything when the stream rate is unknown — judder costs more than CPU', () => {
      expect(frameBudgetMs({ ...stream, streamFps: 0, ambientOnly: true })).toBe(0);
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
