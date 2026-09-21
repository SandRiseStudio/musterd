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
      '/watch',
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

/**
 * Tap targets, pinned as arithmetic rather than as geometry.
 *
 * These read CSS source, so they cannot see what a browser lays out — a real gate would measure
 * `getBoundingClientRect()` at phone width in the `scripts/a11y` CDP harness, which is the lane
 * this points at. What they CAN do is stop the two silent regressions that would undo the fix:
 * someone dropping the `min-height` because it looks redundant next to a line box, and someone
 * restoring the nav's old `padding-block` without noticing it is now load-bearing arithmetic.
 *
 * Measured 2026-09-21 at 390x844: the shared chrome shipped 21-22px targets under WCAG 2.2 AA
 * 2.5.8's 24px floor.
 */
describe('tap targets in the shared chrome', () => {
  const read = (p: string) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8');
  const ruleBody = (css: string, selector: string): string => {
    const m = css.match(new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`));
    // Both the match and its capture group are asserted rather than assumed: a selector that
    // stopped existing must fail as "no rule for X", not as a confusing NaN three lines later.
    if (!m?.[1]) throw new Error(`no rule for ${selector}`);
    return m[1];
  };
  const px = (body: string, prop: string): number => {
    const m = body.match(new RegExp(`${prop}:\\s*([\\d.]+)px`));
    return m?.[1] ? Number(m[1]) : 0;
  };
  const minHeight = (css: string, selector: string) => px(ruleBody(css, selector), 'min-height');

  it('every shared-chrome link declares at least the 24px AA floor', () => {
    const site = read('./site.css');
    const footer = read('../Footer.css');
    expect(minHeight(site, '.sitenav__links a')).toBeGreaterThanOrEqual(24);
    expect(minHeight(site, '.sitenav__home')).toBeGreaterThanOrEqual(24);
    expect(minHeight(footer, '.footer__link')).toBeGreaterThanOrEqual(24);
  });

  it('the nav band still adds up to the 50px it has always been', () => {
    const site = read('./site.css');
    const pad = px(ruleBody(site, '.sitenav__inner'), 'padding-block');
    expect(pad * 2 + minHeight(site, '.sitenav__links a')).toBe(50);
  });

  it('the stacked stream links take the 24px floor, not 44 — two 44s there overlap', () => {
    const ss = read('./StreamSection.css');
    // Not a stylistic preference: `.ss__watch` sits 6.4px under `.ss__link`, so 44px boxes around
    // both must overlap, and an obscured target fails 2.5.8 just as a small one does. Measured
    // 2026-09-21: the first cut of the fix buried 15px of one under the other.
    expect(minHeight(ss, '.ss__link')).toBe(24);
    expect(minHeight(ss, '.ss__watch')).toBe(24);
  });
});
