import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { blogEntries, siteUrls } from '../../scripts/site-files';
import { SITE_ORIGIN, absoluteUrl } from '../brand/siteMeta';

const read = (f: string) => readFileSync(fileURLToPath(new URL(f, import.meta.url)), 'utf8');

const CONTENT_ROUTES = [
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
    // Guards the map itself: a new public section with no route file must fail loudly here. The
    // blog's two route files are present only while a post is — the section leaves the sitemap
    // whole when content/blog is empty, rather than advertising an index with nothing in it.
    expect(files.sort()).toEqual(
      [
        ...(blogEntries().length > 0 ? ['blog.$slug.tsx', 'blog.index.tsx'] : []),
        'docs.$slug.tsx',
        'docs.index.tsx',
        'index.tsx',
      ].sort(),
    );
  });

  for (const f of ['index.tsx', ...CONTENT_ROUTES]) {
    it(`${f} emits a canonical and a structured-data graph`, () => {
      const src = read(`./${f}`);
      expect(src, 'pageHead is what emits <link rel="canonical">').toContain('pageHead(');
      expect(src, 'every public page declares an entity, not just prose').toMatch(/graph:\s*\[/);
    });
  }
});

/*
 * ONE SPELLING OF A URL RETURNS 200, AND IT IS THE SPELLING WE PUBLISH.
 *
 * This is the gate that was missing on 2026-09-16, when musterd.io had gone a month with its home
 * page not indexed at all. Search Console's reason was "Duplicate without user-selected canonical",
 * Google-selected canonical `http://musterd.io/` — because Cloudflare served the site on plain HTTP
 * with a 200 beside HTTPS, so two spellings of every page returned 200 and Google picked the
 * insecure one. The canonical tag was present and correct the whole time; it loses to a duplicate
 * that answers 200.
 *
 * Fixing that surfaced the same defect one layer down, in our own asset config. The prerender emits
 * `docs/spec/index.html`, and Workers Assets' default `html_handling: "auto-trailing-slash"` serves
 * that at `/docs/spec/` while `/docs/spec` answers 307 — a TEMPORARY redirect, which tells Google
 * specifically not to consolidate signals onto the target. Meanwhile `siteUrls()` put `/docs/spec`
 * in sitemap.xml and `pageHead` put `/docs/spec` in the canonical. So the chain was:
 *
 *     sitemap says /docs/spec  ->  307  ->  /docs/spec/  ->  canonical says /docs/spec  ->  307 ...
 *
 * and the canonical target was never a page that returns 200. It had not yet cost us anything only
 * because Google had not crawled the docs pages; they were requested for indexing that same day.
 *
 * Neither failure is visible in a browser, in a screenshot, or in any other test here: both pages
 * render perfectly. Only the relationship between three files is wrong — the asset config, the
 * sitemap builder and the canonical builder — and nothing compared them. These cases do.
 */
describe('one spelling of a URL returns 200, and it is the one we publish', () => {
  const wrangler = read('../../wrangler.jsonc');

  it('the asset server serves the same URL spelling the sitemap and canonical advertise', () => {
    // `siteUrls()` is the single source for sitemap.xml, and `pageHead`/`absoluteUrl` build the
    // canonical from the same `path` strings — so the form here IS the form we publish everywhere.
    const published = siteUrls().map((u) => u.path);
    const slashed = published.filter((p) => p !== '/' && p.endsWith('/'));
    expect(slashed, 'sitemap paths carry no trailing slash').toEqual([]);

    // Therefore the asset server must drop it too. Under the default "auto-trailing-slash" every
    // one of those published URLs answers 307 instead of 200.
    expect(
      wrangler,
      'published URLs have no trailing slash, so html_handling must be "drop-trailing-slash" — ' +
        'the default serves them as 307 redirects to a URL we advertise nowhere',
    ).toMatch(/"html_handling":\s*"drop-trailing-slash"/);
  });

  it('the canonical of a page is the page, never a redirect to it', () => {
    // absoluteUrl is what pageHead hands to <link rel="canonical">. Pinning it against the sitemap
    // form is what makes "canonical === the URL that returns 200" checkable without a live fetch:
    // the previous case fixed the 200 to the sitemap form, and this one fixes the canonical to it.
    for (const { path } of siteUrls()) {
      expect(absoluteUrl(path)).toBe(`${SITE_ORIGIN}${path}`);
      if (path !== '/') {
        expect(absoluteUrl(path), `canonical for ${path} must not end in a slash`).not.toMatch(/\/$/);
      }
    }
  });

  it('nothing reintroduces a second 200 for the same page', () => {
    // not_found_handling:"none" is the other half. With an SPA fallback, ANY misspelling of a path
    // would return 200 and the shell would boot — an unbounded supply of duplicates for every page,
    // which is the ADR 132 daemon-route leak and this canonical problem at the same time.
    expect(wrangler).toMatch(/"not_found_handling":\s*"none"/);
  });
});
