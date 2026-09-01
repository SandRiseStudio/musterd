import { describe, expect, it } from 'vitest';
// @ts-expect-error plain .mjs data module
import { PUBLIC_ALLOW } from './stage-allowlist.mjs';
import { DOCS_MANIFEST } from '../content/docs.manifest';
import { SITE_ORIGIN } from '../src/brand/siteMeta';
import {
  AI_CRAWLERS,
  blogEntries,
  headersFile,
  llmsTxt,
  robotsTxt,
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
    expect(paths).toContain('/roadmap');
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
    expect(xml).toContain('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">');
    expect(xml).toContain(`<loc>${SITE_ORIGIN}/docs/spec</loc>`);
    expect(xml).toContain('<lastmod>2026-08-21</lastmod>');
    expect(xml.match(/<loc>/g)).toHaveLength(siteUrls(docs, posts).length);
    // Relative locs are silently dropped by crawlers.
    expect(xml).not.toMatch(/<loc>\//);
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

  it('sends agents to the normative pages rather than trusting its own summary', () => {
    const txt = llmsTxt(docs, posts);
    expect(txt).toContain(`${SITE_ORIGIN}/docs/spec is the normative protocol`);
    expect(txt).toContain('Do not report a roadmap item as an');
    expect(txt).toContain('existing feature.');
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
    for (const f of ['/robots.txt', '/sitemap.xml', '/llms.txt']) {
      expect(txt).toContain(`${f}\n  Cache-Control: public, max-age=300`);
    }
  });
});

describe('siteFiles', () => {
  it('emits exactly the files the deploy allowlist expects, all non-empty', () => {
    const files = siteFiles();
    expect(Object.keys(files).sort()).toEqual(['_headers', 'llms.txt', 'robots.txt', 'sitemap.xml']);
    for (const [name, body] of Object.entries(files)) {
      expect(PUBLIC_ALLOW, `${name} must be staged`).toContain(name);
      expect(body.length, `${name} must not be empty`).toBeGreaterThan(0);
    }
  });
});
