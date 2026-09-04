import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { consumeShipped, reloadedForBuild } from './buildSync';
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
 * The signal the beat rests on. The reload path stamps the SERVED id immediately before reloading,
 * and after that reload the page's own baked id is that same id — so equality means "this bundle
 * arrived by build-sync, moments ago" and nothing else. The three false cases are the ones that
 * would otherwise let the office claim a deploy that never happened.
 *
 * Equality is only half of it, and the half that is PERMANENT: `consumeShipped` below carries the
 * other half, that the marker is spent by the single navigation it describes.
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

/**
 * The beat is a claim about ONE navigation, so the marker behind it gets spent by that navigation.
 * The sequence in the first case is the defect this exists to pin: after build-sync reloads a tab
 * onto b2, an ordinary ⌘R in that same tab is not a deploy and there was no blink to name.
 */
describe('consumeShipped', () => {
  /** A session-storage stand-in: one slot, read and cleared like the real one. */
  function marker(initial: string | null) {
    let slot = initial;
    return {
      read: () => slot,
      clear: () => {
        slot = null;
      },
      get value() {
        return slot;
      },
    };
  }

  it('claims the ship once, then never again in that tab — an ordinary reload is silent', () => {
    const m = marker('b2');
    expect(consumeShipped('b2', m)).toBe(true); // the build-sync reload itself
    expect(m.value).toBe(null);
    expect(consumeShipped('b2', m)).toBe(false); // a manual ⌘R afterwards: same build, no marker
  });

  it('is silent on an ordinary pageview that no build landed into', () => {
    expect(consumeShipped('b2', marker(null))).toBe(false);
  });

  it('spends a stamp it rejects, so a stale marker cannot mislead a later load', () => {
    const m = marker('b1'); // written before a build that then arrived some other way
    expect(consumeShipped('b2', m)).toBe(false);
    expect(m.value).toBe(null);
  });

  it('never claims a ship without a baked build id (dev, tests, prerender)', () => {
    expect(consumeShipped(null, marker('b2'))).toBe(false);
  });
});

/**
 * The copy of record says Team the way the brand says Team.
 *
 * brand.md §5 lists "room" in the Not column for Team, and the shipped string opened with "the
 * people in this room" anyway (sloane, 2026-09-04). It survived to a public surface because the gate
 * that enforces §5 cannot see it: `pnpm vocab:check` reads `docs/glossary/terms.ts`, whose banned
 * set is profile / kit / template / worktree — the published table and the linted table are not the
 * same table. Widening the global ban is the wrong repair (a huddle's `room` URL is a real field,
 * and ADR 378 names it), so the constraint is pinned where it applies: the one string here a
 * stranger might quote.
 */
describe('WORKSHOP_NOTICE.full — the copy of record', () => {
  it('says Team, never "room"', () => {
    expect(WORKSHOP_NOTICE.full).not.toMatch(/\brooms?\b/i);
    expect(WORKSHOP_NOTICE.full).toMatch(/\bteam\b/i);
  });

  it('is sloane’s spec verbatim', () => {
    expect(WORKSHOP_NOTICE.full).toBe(
      'This team is building musterd while you watch. Every deploy can restart the stream for a moment, and it comes back on its own.',
    );
  });
});
