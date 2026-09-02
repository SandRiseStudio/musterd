import { describe, expect, it } from 'vitest';
// @ts-expect-error plain .mjs data module
import { PUBLIC_ALLOW } from './stage-allowlist.mjs';
import { DOCS_MANIFEST } from '../content/docs.manifest';
import { SITE_ORIGIN } from '../src/brand/siteMeta';
import {
  AI_CRAWLERS,
  allMirrors,
  blogEntries,
  docMirrors,
  headersFile,
  llmsFullTxt,
  llmsTxt,
  postMirrors,
  robotsTxt,
  rssXml,
  siteFiles,
  siteUrls,
  sitemapXml,
} from './site-files';

const docs = [
  { slug: 'getting-started', title: null },
  { slug: 'spec', title: 'Protocol spec' },
];
const posts = [
  { slug: 'launch', date: '2026-08-21' },
  { slug: 'older', date: '2026-01-02' },
];

describe('siteUrls', () => {
  it('lists a URL for every manifest doc and every blog post', () => {
    const paths = siteUrls(docs, posts).map((u) => u.path);
    for (const d of docs) expect(paths).toContain(`/docs/${d.slug}`);
    for (const p of posts) expect(paths).toContain(`/blog/${p.slug}`);
    expect(paths).toContain('/');
    // /roadmap was retired from the origin on 2026-09-02 — the roadmap is ROADMAP.md in the repo.
    expect(paths).not.toContain('/roadmap');
  });

  it('covers the real manifest and the real blog directory, not just the fixtures', () => {
    const paths = siteUrls().map((u) => u.path);
    for (const entry of DOCS_MANIFEST) expect(paths).toContain(`/docs/${entry.slug}`);
    for (const post of blogEntries()) expect(paths).toContain(`/blog/${post.slug}`);
  });

  /**
   * A sitemap entry the deploy withholds is a 404 we sent a crawler to find. Every URL's first
   * path segment must be something `stage-site.mjs` actually stages.
   */
  it('never advertises a path outside the deploy allowlist', () => {
    for (const { path } of siteUrls()) {
      const root = path === '/' ? 'index.html' : path.split('/')[1]!;
      expect(PUBLIC_ALLOW).toContain(root);
    }
  });

  it('dates only the pages whose date is a real fact', () => {
    for (const url of siteUrls(docs, posts)) {
      if (url.path.startsWith('/blog/')) expect(url.lastmod).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      else expect(url.lastmod).toBeUndefined();
    }
  });
});

describe('sitemap.xml', () => {
  it('is absolute-URL XML with one <loc> per page', () => {
    const xml = sitemapXml(siteUrls(docs, posts));
    expect(xml).toMatch(/^<\?xml version="1\.0" encoding="UTF-8"\?>/);
    expect(xml).toContain('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"');
    expect(xml).toContain(`<loc>${SITE_ORIGIN}/docs/spec</loc>`);
    expect(xml).toContain('<lastmod>2026-08-21</lastmod>');
    expect(xml.match(/<loc>/g)).toHaveLength(siteUrls(docs, posts).length);
    // Relative locs are silently dropped by crawlers.
    expect(xml).not.toMatch(/<loc>\//);
  });

  /**
   * The acceptance the markdown mirrors had to meet: a page and its mirror are ONE url. Listing
   * both as <loc> would tell a crawler the site publishes the same words twice, which is the
   * duplicate-content signal the mirrors exist despite, not because of.
   */
  it('announces a mirror as an alternate of its page, never as a second loc', () => {
    const xml = sitemapXml();
    for (const m of allMirrors()) {
      expect(xml).toContain(
        `<xhtml:link rel="alternate" type="text/markdown" href="${SITE_ORIGIN}${m.path}.md"/>`,
      );
      expect(xml, 'a mirror must not have its own <loc>').not.toContain(
        `<loc>${SITE_ORIGIN}${m.path}.md</loc>`,
      );
    }
    expect(xml).toContain('xmlns:xhtml="http://www.w3.org/1999/xhtml"');
    expect(xml.match(/<loc>/g)).toHaveLength(siteUrls().length);
  });

  it('marks up only the pages that have a mirror', () => {
    // Every remaining public page comes from markdown, so every one carries its mirror link. The
    // landing page is the exception — it is a component, not a document.
    const home = sitemapXml().split('<url>').find((u) => u.includes(`<loc>${SITE_ORIGIN}/</loc>`));
    expect(home).toBeDefined();
    expect(home).not.toContain('text/markdown');
  });
});

describe('robots.txt', () => {
  it('points at the sitemap and disallows nothing', () => {
    const txt = robotsTxt();
    expect(txt).toContain(`Sitemap: ${SITE_ORIGIN}/sitemap.xml`);
    expect(txt).toContain('User-agent: *\nAllow: /');
    expect(txt).not.toContain('Disallow');
  });

  it('names each AI crawler explicitly rather than leaving the grant to the wildcard', () => {
    const txt = robotsTxt();
    for (const ua of AI_CRAWLERS) expect(txt).toContain(`User-agent: ${ua}\nAllow: /`);
    // The two that most often get quietly omitted.
    expect(AI_CRAWLERS).toContain('ClaudeBot');
    expect(AI_CRAWLERS).toContain('GPTBot');
  });
});

describe('llms.txt', () => {
  it('opens with the product name and a positioning blockquote', () => {
    const txt = llmsTxt(docs, posts);
    expect(txt.startsWith('# musterd\n')).toBe(true);
    expect(txt).toContain('> Muster your agents and humans into persistent teams.');
    expect(txt).toContain(`Canonical page: ${SITE_ORIGIN}`);
  });

  it('states the crawl grant and lists every page as an absolute URL', () => {
    const txt = llmsTxt(docs, posts);
    expect(txt).toContain('welcome to read, quote and cite');
    for (const d of docs) expect(txt).toContain(`${SITE_ORIGIN}/docs/${d.slug}`);
    for (const p of posts) expect(txt).toContain(`${SITE_ORIGIN}/blog/${p.slug}`);
  });

  it('points agents at the markdown mirrors, the full corpus and the feed', () => {
    // The line that makes tier 3 discoverable at all: llms.txt is where an agent looks first, so
    // the mirrors have to be announced here as well as in each page's head.
    const txt = llmsTxt(docs, posts);
    expect(txt).toContain('`.md` appended');
    expect(txt).toContain(`${SITE_ORIGIN}/llms-full.txt`);
    expect(txt).toContain(`${SITE_ORIGIN}/blog/rss.xml`);
  });

  it('sends agents to the normative pages rather than trusting its own summary', () => {
    const txt = llmsTxt(docs, posts);
    expect(txt).toContain(`${SITE_ORIGIN}/docs/spec is the normative protocol`);
    expect(txt).toContain('do not report a roadmap item as an existing feature');
    // …and it sends them to the repo for it, since the page is no longer on this origin.
    expect(txt).toContain('ROADMAP.md in the repository');
    expect(txt).not.toContain(`${SITE_ORIGIN}/roadmap`);
  });

  /** brand.md §4: no hype vocabulary, ever, on a public surface. */
  it('carries none of the banned vocabulary', () => {
    const txt = llmsTxt().toLowerCase();
    for (const word of [
      'revolutionary',
      'magic',
      'supercharge',
      '10x',
      'game-changing',
      'cutting-edge',
      'world-class',
      'seamless',
      'innovative',
    ]) {
      expect(txt).not.toContain(word);
    }
  });

  /**
   * brand.md §5: the glossary terms are load-bearing. The synonyms appear here on purpose — the
   * point of the "For agents" section is to name them as wrong, so this pins that they are only
   * ever quoted as counter-examples and never used as the vocabulary.
   */
  it('defines the glossary terms and names the synonyms as wrong', () => {
    const txt = llmsTxt();
    for (const term of ['Team', 'Member', 'Presence', 'Act']) expect(txt).toContain(`**${term}**`);
    for (const synonym of ['Room', 'user', 'session', 'swarm']) {
      expect(txt).toContain(`"${synonym}"`);
    }
    expect(txt).toContain('describe a different product');
  });
});

describe('_headers', () => {
  it('gives hashed assets a year and the crawler files five minutes', () => {
    const txt = headersFile();
    expect(txt).toContain('/assets/*\n  Cache-Control: public, max-age=31536000, immutable');
    for (const f of ['/robots.txt', '/sitemap.xml', '/llms.txt', '/llms-full.txt']) {
      expect(txt).toContain(`${f}\n  Cache-Control: public, max-age=300`);
    }
  });

  it('types the mirrors and the feed rather than leaving an agent to sniff them', () => {
    const txt = headersFile();
    for (const g of ['/docs/*.md', '/blog/*.md']) {
      expect(txt).toContain(`${g}\n  Cache-Control: public, max-age=300\n  Content-Type: text/markdown; charset=utf-8`);
    }
    expect(txt).toContain('Content-Type: application/rss+xml; charset=utf-8');
  });
});

/*
 * The markdown mirrors, llms-full.txt and the feed — tier 3 of the discoverability arc.
 *
 * The point of the mirrors, stated once: /docs/** and /blog/** are rendered FROM markdown at build
 * time, so the agent-readable form already exists in the build. sandrise.io, the site this work was
 * modelled on, throws it away and tells agents in its llms.txt to fetch the HTML instead.
 */
describe('markdown mirrors', () => {
  it('mirrors every manifest doc and every post, one for one', () => {
    const paths = allMirrors().map((m) => m.path);
    for (const entry of DOCS_MANIFEST) expect(paths).toContain(`/docs/${entry.slug}`);
    for (const post of blogEntries()) expect(paths).toContain(`/blog/${post.slug}`);
    expect(paths).toHaveLength(DOCS_MANIFEST.length + blogEntries().length);
  });

  it('carries the source markdown, not a re-render of the HTML', () => {
    const spec = docMirrors().find((m) => m.path === '/docs/spec');
    // SPEC.md's own first heading, which the HTML page strips into <h1> and the mirror keeps.
    expect(spec?.markdown).toMatch(/^#\s/m);
    expect(spec?.markdown, 'a mirror must be markdown, not markup').not.toContain('<div class="prose');
  });

  it('takes its title and description from the same render the page uses', () => {
    for (const m of allMirrors()) {
      expect(m.title.length, `${m.path} needs a title`).toBeGreaterThan(0);
      expect(m.description.length, `${m.path} needs a description`).toBeGreaterThan(0);
    }
    // The manifest's explicit title wins over the file's own heading, as it does for the page.
    expect(docMirrors().find((m) => m.path === '/docs/spec')?.title).toBe('Protocol spec');
  });

  it('ships each mirror beside the page it mirrors', () => {
    const files = siteFiles();
    for (const m of allMirrors()) expect(files).toHaveProperty(`${m.path.slice(1)}.md`);
  });
});

describe('llms-full.txt', () => {
  it('contains every manifest doc, whole, in manifest order', () => {
    const full = llmsFullTxt();
    const positions = DOCS_MANIFEST.map((entry) => {
      const doc = docMirrors().find((m) => m.path === `/docs/${entry.slug}`)!;
      // Everything below the document's own heading, which the file's own heading replaces.
      const body = doc.markdown.replace(/^#\s+.*$/m, '').trim();
      const at = full.indexOf(body);
      expect(at, `${entry.slug} must appear whole`).toBeGreaterThan(-1);
      return at;
    });
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });

  it('heads each document with its page title, never with two headings in a row', () => {
    const full = llmsFullTxt();
    // The manifest renames SPEC.md on the page; llms-full.txt must agree with the page, and must
    // not stack that title on top of the file's own "# musterd protocol — SPEC".
    expect(full).toContain('# Protocol spec\n');
    expect(full).not.toContain('# musterd protocol — SPEC');
    expect(full).not.toMatch(/^#\s+.*\n\n#\s/m);
  });

  it('says where each document came from and where the index form lives', () => {
    const full = llmsFullTxt();
    for (const entry of DOCS_MANIFEST) {
      expect(full).toContain(`Source: ${SITE_ORIGIN}/docs/${entry.slug}`);
    }
    expect(full).toContain(`${SITE_ORIGIN}/llms.txt`);
    expect(full).toContain('welcome to read, quote and cite');
  });

  it('carries the docs only — a blog archive would grow it without bound', () => {
    const full = llmsFullTxt();
    for (const post of postMirrors()) expect(full).not.toContain(post.markdown.trim());
  });
});

describe('blog rss', () => {
  it('is RSS 2.0 with an absolute self link', () => {
    const xml = rssXml();
    expect(xml).toMatch(/^<\?xml version="1\.0" encoding="UTF-8"\?>/);
    expect(xml).toContain('<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">');
    expect(xml).toContain(
      `<atom:link href="${SITE_ORIGIN}/blog/rss.xml" rel="self" type="application/rss+xml"/>`,
    );
  });

  it('has one item per post, newest first, with a permalink guid', () => {
    const posts = postMirrors();
    const xml = rssXml();
    expect(xml.match(/<item>/g)).toHaveLength(posts.length);
    for (const p of posts) {
      expect(xml).toContain(`<link>${SITE_ORIGIN}${p.path}</link>`);
      expect(xml).toContain(`<guid isPermaLink="true">${SITE_ORIGIN}${p.path}</guid>`);
    }
    const order = posts.map((p) => xml.indexOf(`<link>${SITE_ORIGIN}${p.path}</link>`));
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  /** RSS 2.0 requires RFC 822; a reader silently ignores an ISO date and the post loses its order. */
  it('dates every item in RFC 822, from the same filename the sitemap dates it with', () => {
    const xml = rssXml();
    const dates = [...xml.matchAll(/<pubDate>([^<]+)<\/pubDate>/g)].map((m) => m[1]!);
    expect(dates).toHaveLength(postMirrors().length);
    for (const d of dates) {
      expect(d).toMatch(/^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/);
    }
  });

  it('escapes markup in a title rather than emitting broken XML', () => {
    const xml = rssXml([
      { path: '/blog/x', title: 'Ampersands & <angles>', description: 'A "quoted" line.', markdown: '', date: '2026-01-01' },
    ]);
    expect(xml).toContain('<title>Ampersands &amp; &lt;angles&gt;</title>');
    expect(xml).toContain('&quot;quoted&quot;');
  });
});

describe('siteFiles', () => {
  it('emits exactly the files the deploy allowlist expects, all non-empty', () => {
    const files = siteFiles();
    const mirrors = allMirrors().map((m) => `${m.path.slice(1)}.md`);
    expect(Object.keys(files).sort()).toEqual(
      ['_headers', 'blog/rss.xml', 'llms-full.txt', 'llms.txt', 'robots.txt', 'sitemap.xml', ...mirrors].sort(),
    );
    for (const [name, body] of Object.entries(files)) {
      // A file inside an allowed directory is staged by that directory; a root file needs its own
      // entry. Both must resolve to something the deploy actually copies.
      const root = name.includes('/') ? name.split('/')[0]! : name;
      expect(PUBLIC_ALLOW, `${name} must be staged`).toContain(root);
      expect(body.length, `${name} must not be empty`).toBeGreaterThan(0);
    }
  });
});
