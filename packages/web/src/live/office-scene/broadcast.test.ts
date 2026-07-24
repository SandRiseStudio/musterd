import { afterEach, describe, expect, it, vi } from 'vitest';
import { ambientFrameBudgetMs, officeDpr, officeVisible, suspendIgnored } from './broadcast';

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

  describe('ambientFrameBudgetMs', () => {
    it('broadcast renders ambient motion at full rate — 20fps-on-a-30fps-encode is cadence judder', () => {
      expect(ambientFrameBudgetMs(true, 50)).toBe(0);
    });

    it('REGRESSION: a viewer keeps the ~20fps ambient coalescing (a measured, standing win)', () => {
      expect(ambientFrameBudgetMs(false, 50)).toBe(50);
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
