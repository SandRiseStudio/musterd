import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { MusterdWord } from './MusterdWord';

/**
 * The lockup carries the address only where it is asked to. This is not a style preference: the
 * office mark is stamped on every frame that leaves the app, for a viewer with no address bar, and
 * the site's own nav and footer are read by someone already at that address. One component, two
 * jobs, and the default must stay the quiet one — a `domain` that leaked into SiteNav would put the
 * URL in the corner of the page it points at.
 */
describe('MusterdWord', () => {
  it('is the bare product name by default', () => {
    const html = renderToStaticMarkup(<MusterdWord />);
    expect(html).toContain('musterd');
    expect(html).not.toContain('.io');
  });

  it('carries the address when asked, with the suffix as its own span', () => {
    const html = renderToStaticMarkup(<MusterdWord domain />);
    expect(html).toContain('musterd');
    expect(html).toContain('brand__tld');
    // One flex item, not two: the lockup puts a gap between its children, so a bare `musterd`
    // beside a `.io` span rendered as "musterd .io".
    expect(html).toMatch(/musterd<span class="brand__tld">\.io<\/span>/);
  });
});
