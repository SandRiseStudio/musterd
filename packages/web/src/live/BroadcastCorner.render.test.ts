import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { reloadedForBuild } from './buildSync';
import { broadcastCorner, WORKSHOP_NOTICE } from '../routes/broadcast';

/**
 * The corner /broadcast speaks from — two facts asserted on a public surface, so both are pinned
 * at the construction: the notice that the feed may blink because the room is shipping the thing
 * being watched, and where to find the team. The address is per team, never derived from the slug:
 * a team that streams has not thereby claimed a mailbox.
 */
describe('broadcastCorner', () => {
  it('carries the workshop notice, its long form on the title, and musterd.io for every team', () => {
    const html = renderToStaticMarkup(broadcastCorner('anyteam'));
    expect(html).toContain(WORKSHOP_NOTICE.chip);
    expect(html).toContain(`title="${WORKSHOP_NOTICE.full}"`);
    expect(html).toContain('musterd.io');
    expect(html).not.toContain('@musterd.io');
  });
  it('names the address only for a team that has one', () => {
    expect(renderToStaticMarkup(broadcastCorner('revive'))).toContain('revive@musterd.io');
    expect(renderToStaticMarkup(broadcastCorner(null))).not.toContain('@musterd.io');
  });

  /**
   * The blink notice is not a permanent caption any more — it is a beat that fires when a build
   * actually landed. So what has to hold is that the two states say different things, that the
   * resting one does NOT carry the apology, and that the long form survives on the title in both:
   * it is the copy of record on a public surface either way.
   */
  describe('the ship beat', () => {
    it('rests as a mark, with no claim about the feed blinking', () => {
      const html = renderToStaticMarkup(broadcastCorner('revive'));
      expect(html).toContain(WORKSHOP_NOTICE.chip);
      expect(html).not.toContain(WORKSHOP_NOTICE.shipped);
      expect(html).not.toContain('blink while we ship');
      expect(html).not.toContain('bc__notice--shipped');
    });

    it('names the blink in the past tense only when a build just landed', () => {
      const html = renderToStaticMarkup(broadcastCorner('revive', true));
      expect(html).toContain(WORKSHOP_NOTICE.shipped);
      expect(html).toContain('bc__notice--shipped');
      expect(html).toContain(`title="${WORKSHOP_NOTICE.full}"`);
    });
  });
});

/**
 * The signal the beat rests on. `setReloadedFor` stamps the SERVED id immediately before reloading,
 * and after that reload the page's own baked id is that same id — so equality means "this bundle
 * arrived by build-sync, moments ago" and nothing else. The three false cases are the ones that
 * would otherwise let the office claim a deploy that never happened.
 */
describe('reloadedForBuild', () => {
  it('is true only when the stamp names the build now running', () => {
    expect(reloadedForBuild('b2', 'b2')).toBe(true);
  });
  it('is false for a stamp from an older served build', () => {
    expect(reloadedForBuild('b2', 'b1')).toBe(false);
  });
  it('is false for an ordinary pageview that was never reloaded', () => {
    expect(reloadedForBuild('b2', null)).toBe(false);
  });
  it('is false with no baked build id at all — dev and tests never claim a ship', () => {
    expect(reloadedForBuild(null, 'b2')).toBe(false);
    expect(reloadedForBuild(null, null)).toBe(false);
  });
});
