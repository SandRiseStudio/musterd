import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
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
});
