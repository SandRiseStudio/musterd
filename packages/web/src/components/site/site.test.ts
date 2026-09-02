import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { NAV_LINKS } from './SiteNav';

describe('site nav', () => {
  it('links every public surface and GitHub, nothing daemon-connected', () => {
    const hrefs = NAV_LINKS.map((l) => l.href);
    expect(hrefs).toEqual(['/docs', '/blog', 'https://github.com/SandRiseStudio/musterd']);
    for (const h of hrefs) expect(h).not.toMatch(/live|board|audit|approvals|broadcast/);
  });

  it('nav renders the wordmark as the home link', () => {
    const src = readFileSync(fileURLToPath(new URL('./SiteNav.tsx', import.meta.url)), 'utf8');
    expect(src).toMatch(/href="\/"/);
  });
});
