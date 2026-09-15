import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { hasBlog } from '../../content/generated/site-content';
import { NAV_LINKS } from './SiteNav';

describe('site nav', () => {
  it('links every public surface and GitHub, nothing daemon-connected', () => {
    const hrefs = NAV_LINKS.map((l) => l.href);
    // /blog is conditional on there being a post — asserted as a rule below rather than pinned to
    // whichever state content/blog happens to be in.
    expect(hrefs.filter((h) => h !== '/blog')).toEqual([
      '/docs',
      'https://github.com/SandRiseStudio/musterd',
    ]);
    for (const h of hrefs) expect(h).not.toMatch(/live|board|audit|approvals|broadcast/);
  });

  it('offers the blog exactly when there is a post to read', () => {
    expect(NAV_LINKS.some((l) => l.href === '/blog')).toBe(hasBlog);
  });

  it('nav renders the wordmark as the home link', () => {
    const src = readFileSync(fileURLToPath(new URL('./SiteNav.tsx', import.meta.url)), 'utf8');
    expect(src).toMatch(/href="\/"/);
  });
});
