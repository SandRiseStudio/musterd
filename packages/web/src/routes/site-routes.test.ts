import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { siteUrls } from '../../scripts/site-files';

const read = (f: string) => readFileSync(fileURLToPath(new URL(f, import.meta.url)), 'utf8');

const CONTENT_ROUTES = [
  'roadmap.tsx',
  'docs.index.tsx',
  'docs.$slug.tsx',
  'blog.index.tsx',
  'blog.$slug.tsx',
];

/**
 * The route file that serves each public URL. `/docs/x` and `/docs/y` are one file, so this maps
 * the SHAPE of the path rather than the path — but it is derived from `siteUrls()`, the same list
 * sitemap.xml is built from, so a new public URL with no route file fails here instead of 404ing
 * in front of a crawler we sent to find it.
 */
function routeFileFor(path: string): string {
  if (path === '/') return 'index.tsx';
  const [, section, slug] = path.split('/');
  if (!section) throw new Error(`unroutable public path ${path}`);
  if (section === 'roadmap') return 'roadmap.tsx';
  return slug ? `${section}.$slug.tsx` : `${section}.index.tsx`;
}

describe('public content routes', () => {
  for (const f of CONTENT_ROUTES) {
    it(`${f} renders site chrome and generated content only`, () => {
      const src = read(`./${f}`);
      expect(src).toContain('SiteNav');
      expect(src).toContain('SiteFooter');
      expect(src, 'content routes must not touch daemon modules').not.toMatch(/from '\.\.\/live\//);
    });
  }
  // Shipped 2026-08-21 and measured on production: every page inherited __root.tsx's og:* verbatim,
  // so /blog/launch/ advertised og:url https://musterd.io and og:title "musterd". A shared link to
  // any page described the homepage. pageHead() is what gives a page its own identity.
  for (const f of CONTENT_ROUTES) {
    it(`${f} sets its own page metadata rather than inheriting the root's`, () => {
      const src = read(`./${f}`);
      expect(src).toContain('pageHead(');
      expect(src, 'a bare title inherits the root og:*').not.toMatch(/meta:\s*\[\{\s*title/);
    });
  }

  it('slug routes prerender from the generated lists', () => {
    expect(read('./docs.$slug.tsx')).toContain('docsPages');
    expect(read('./blog.$slug.tsx')).toContain('blogPosts');
  });
});

/*
 * The gate the site did not have on 2026-09-01, when every page shipped without a canonical link
 * and without a line of structured data. Both are invisible in a browser and in every screenshot,
 * so nothing but a test notices when a new route forgets them — which is how all six route files
 * came to be missing them at once.
 *
 * The chain is: every URL in sitemap.xml resolves to a route file; every route file goes through
 * `pageHead` with a `graph`; and `pageHead` always emits the canonical, the description and the
 * `script:ld+json` entry (pinned in ../brand/siteMeta.test.ts). Each link is checkable, so no
 * route can be public and undescribed.
 */
describe('structured data and canonical coverage', () => {
  const files = [...new Set(siteUrls().map((u) => routeFileFor(u.path)))];

  it('covers every url the sitemap advertises', () => {
    // Guards the map itself: a new public section with no route file must fail loudly here.
    expect(files.sort()).toEqual([
      'blog.$slug.tsx',
      'blog.index.tsx',
      'docs.$slug.tsx',
      'docs.index.tsx',
      'index.tsx',
      'roadmap.tsx',
    ]);
  });

  for (const f of ['index.tsx', ...CONTENT_ROUTES]) {
    it(`${f} emits a canonical and a structured-data graph`, () => {
      const src = read(`./${f}`);
      expect(src, 'pageHead is what emits <link rel="canonical">').toContain('pageHead(');
      expect(src, 'every public page declares an entity, not just prose').toMatch(/graph:\s*\[/);
    });
  }
});
