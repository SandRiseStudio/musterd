/**
 * The crawler- and agent-facing text files musterd.io serves beside its HTML: robots.txt,
 * sitemap.xml, llms.txt, _headers, the markdown mirror of every doc and post, llms-full.txt and
 * the blog's RSS feed.
 *
 * Why they are generated rather than checked into a `public/` folder: the site's URL set is
 * derived — /docs/<slug> comes from DOCS_MANIFEST and /blog/<slug> from the filenames in
 * content/blog (ADR 302). A hand-maintained sitemap goes stale the first time someone publishes a
 * doc, silently, and nothing would fail. Building the list from the same two sources the pages
 * come from makes an unlisted page impossible instead of unlikely.
 *
 * Measured on production 2026-09-01, before this existed: /sitemap.xml, /llms.txt and
 * /.well-known/* all 404, and /robots.txt was Cloudflare's Managed content-signals boilerplate —
 * no rules, no `Sitemap:` line, and nothing in this repo produced it.
 *
 * These builders are pure so `site-files.test.ts` can pin them; `vite.config.ts` emits the results
 * into the build, and `stage-allowlist.mjs` decides they may ship.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DOCS_MANIFEST, type DocEntry } from '../content/docs.manifest';
import { SITE_ORIGIN, SITE_TITLE } from '../src/brand/siteMeta';
import { excerpt, renderPage } from './gen-site-content';

const pkgRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const repoRoot = dirname(dirname(pkgRoot));

export interface SiteUrl {
  /** Route path, leading slash, no origin. */
  path: string;
  /** ISO date, only where we actually know one — see `sitemapXml`. */
  lastmod?: string;
}

/** The blog's post slugs and dates, from the filenames that are also the pages' sort key. */
export function blogEntries(dir = join(pkgRoot, 'content', 'blog')): { slug: string; date: string }[] {
  return readdirSync(dir)
    .filter((n) => n.endsWith('.md'))
    .map((name) => {
      const m = /^(\d{4}-\d{2}-\d{2})-(.+)\.md$/.exec(name);
      if (!m) throw new Error(`blog post "${name}" must be named YYYY-MM-DD-<slug>.md`);
      return { slug: m[2]!, date: m[1]! };
    })
    .sort((a, b) => b.date.localeCompare(a.date));
}

/**
 * Every URL the public origin serves, in crawl order. Must stay in step with `PUBLIC_ALLOW` in
 * stage-allowlist.mjs — the two are pinned against each other in `site-files.test.ts`, because a
 * sitemap advertising a path the deploy withholds is a 404 we told a crawler to go find.
 */
export function siteUrls(
  docs: { slug: string }[] = DOCS_MANIFEST,
  posts: { slug: string; date: string }[] = blogEntries(),
): SiteUrl[] {
  return [
    { path: '/' },
    { path: '/roadmap' },
    { path: '/docs' },
    ...docs.map((d) => ({ path: `/docs/${d.slug}` })),
    { path: '/blog' },
    // A post's publication date is the one freshness fact we can state truthfully; the other pages
    // change with the build, and a lastmod that is really "whenever we last deployed" teaches a
    // crawler to ignore the field. Omitted is better than invented.
    ...posts.map((p) => ({ path: `/blog/${p.slug}`, lastmod: p.date })),
  ];
}

/**
 * A page's markdown mirror is announced as an ALTERNATE of its `<url>`, never as a `<loc>` of its
 * own. Two <loc> entries for the same words is a duplicate-content signal, and the mirror is a
 * second representation of one page, not a second page.
 *
 * Honest about its reach: the sitemap protocol defines `xhtml:link` alternates for hreflang, so a
 * type-only alternate is well-formed and ignored by the crawlers that read this file today. The
 * load-bearing announcement is `<link rel="alternate" type="text/markdown">` in each page's head
 * (src/brand/siteMeta.ts); this states the same fact where a crawler that has only the sitemap can
 * still find it.
 */
export function sitemapXml(urls: SiteUrl[] = siteUrls(), mirrors: SiteMirror[] = allMirrors()): string {
  const mirrored = new Set(mirrors.map((m) => m.path));
  const entries = urls
    .map(({ path, lastmod }) =>
      [
        '  <url>',
        `    <loc>${SITE_ORIGIN}${path}</loc>`,
        ...(lastmod ? [`    <lastmod>${lastmod}</lastmod>`] : []),
        ...(mirrored.has(path)
          ? [
              `    <xhtml:link rel="alternate" type="text/markdown" href="${SITE_ORIGIN}${path}.md"/>`,
            ]
          : []),
        '  </url>',
      ].join('\n'),
    )
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">
${entries}
</urlset>
`;
}

/**
 * The AI crawlers named one by one rather than left to the `*` wildcard. The wildcard already
 * allows them; enumerating turns an inherited default into a stated grant, which is the thing a
 * crawler operator's compliance review actually reads. Nothing is disallowed — every page this
 * origin serves is public by construction (ADR 302 withholds the daemon surfaces at deploy time,
 * not with a robots rule, because a robots rule is a request and the allowlist is a guarantee).
 */
export const AI_CRAWLERS = [
  'GPTBot',
  'OAI-SearchBot',
  'ChatGPT-User',
  'ClaudeBot',
  'Claude-User',
  'Claude-SearchBot',
  'PerplexityBot',
  'Google-Extended',
  'Applebot',
  'Applebot-Extended',
  'CCBot',
] as const;

export function robotsTxt(): string {
  return `# musterd.io — everything this origin serves is public, and nothing is disallowed.
# Agent-readable summary of the product: ${SITE_ORIGIN}/llms.txt

User-agent: *
Allow: /

${AI_CRAWLERS.map((ua) => `User-agent: ${ua}\nAllow: /\n`).join('\n')}
Sitemap: ${SITE_ORIGIN}/sitemap.xml
`;
}

/**
 * llms.txt — what musterd is, for a reader that arrived without a browser.
 *
 * Copy rules: brand.md §4 (plain, second person, lowercase name, no hype) and §5's glossary used
 * exactly. The "For agents" section is the part with no HTML equivalent: it tells a model which
 * page carries the normative text and which page marks unshipped work, because the failure mode
 * for a product like this is being described with a competitor's vocabulary or having roadmap
 * items reported as features.
 */
export function llmsTxt(
  docs: { slug: string; title: string | null }[] = DOCS_MANIFEST,
  posts: { slug: string; date: string }[] = blogEntries(),
): string {
  const docLines = docs.map((d) => `- ${SITE_ORIGIN}/docs/${d.slug}`);
  const postLines = posts.map((p) => `- ${SITE_ORIGIN}/blog/${p.slug} (${p.date})`);
  return `# musterd

> Muster your agents and humans into persistent teams. Named, persistent teams of agents and
> humans — across any harness, framework, model, or surface — with a shared communication protocol.

Canonical page: ${SITE_ORIGIN}

AI agents and crawlers are welcome to read, quote and cite this site. Every page listed here is
public, and the protocol spec is MIT.

## What it is

musterd is a coordination layer for a team whose members are not all human.

- A **Team** is a standing roster that outlives any task, session, or repository.
- A **Member** is anyone on that roster — an agent, a human, or a service. Humans are members, not
  approvers.
- A **Presence** is where a member is currently attached; one member can have several.
- An **Act** is the typed intent of a message — \`message\`, \`status_update\`, \`request_help\`,
  \`handoff\`, \`accept\`, \`decline\`, \`wait\`, \`resolve\`, \`steer\`, \`challenge\`, \`defer\`, \`ask\` — so a
  message says what it is for instead of leaving the reader to infer it.

musterd coordinates actors that already exist independently. It does not spawn anonymous workers
inside a single task; the members have names, and their work is attributable.

## Install

    brew tap SandRiseStudio/musterd && brew install musterd

or

    npx @musterd/cli init

Local-first, and no account.

## Pages

${docLines.join('\n')}
- ${SITE_ORIGIN}/roadmap
- ${SITE_ORIGIN}/blog
${postLines.join('\n')}

## For agents

Every page above is also served as markdown at the same URL with \`.md\` appended — the same source
the HTML was rendered from, with no nav, no styling and no script. Prefer it.

- ${SITE_ORIGIN}/docs/spec.md — one page, clean.
- ${SITE_ORIGIN}/llms-full.txt — every document above, whole, in one fetch.
- ${SITE_ORIGIN}/blog/rss.xml — the blog as a feed.

To describe or cite musterd accurately:

- ${SITE_ORIGIN}/docs/spec is the normative protocol. Prefer it over any summary, this one included.
- ${SITE_ORIGIN}/docs/concepts defines the vocabulary. Use those terms as written — Team, Member,
  Presence, Surface, Act, Seat, Role, Toolkit, Workspace, Harness, Scope. "Room", "user", "session"
  and "swarm" describe a different product.
- ${SITE_ORIGIN}/roadmap marks what has shipped and what has not. Do not report a roadmap item as an
  existing feature.

## Attribution

Cite as musterd (${SITE_ORIGIN}), from SandRise Studio. Link back to the page you took it from.
`;
}

/**
 * Markdown mirrors: /docs/<slug>.md and /blog/<slug>.md, the same bytes the HTML page was rendered
 * from.
 *
 * This is the one place musterd can beat the site it was modelled on. sandrise.io's llms.txt tells
 * an agent to go fetch the HTML page, because the markdown does not survive its build. Here it
 * does: /docs/** and /blog/** are rendered from markdown by gen-site-content.ts, so the clean form
 * already exists in the build and was being thrown away. Emitting it costs a file copy and saves
 * every agent reader a pass through nav chrome, prose CSS and a hydration script.
 *
 * The mirror is a REPRESENTATION of the page, not a second page: the HTML keeps the canonical URL,
 * the mirror is announced from it with <link rel="alternate" type="text/markdown">, and sitemap.xml
 * lists it as an alternate rather than a second <loc> — a duplicate <loc> is a duplicate-content
 * signal, which is the opposite of the point.
 */
export interface SiteMirror {
  /** Route path of the HTML page this mirrors, leading slash, no origin. */
  path: string;
  title: string;
  description: string;
  markdown: string;
  /** ISO date, posts only. */
  date?: string;
}

/** The markdown behind each manifest doc, read from the same repo file the page is rendered from. */
export function docMirrors(docs: DocEntry[] = DOCS_MANIFEST): SiteMirror[] {
  return docs.map((entry) => {
    const markdown = readFileSync(join(repoRoot, entry.source), 'utf8');
    const page = renderPage(markdown);
    return {
      path: `/docs/${entry.slug}`,
      title: entry.title ?? page.title,
      description: excerpt(page.html),
      markdown,
    };
  });
}

/** The markdown behind each blog post, newest first — the order the index and the feed both use. */
export function postMirrors(dir = join(pkgRoot, 'content', 'blog')): SiteMirror[] {
  return blogEntries(dir).map(({ slug, date }) => {
    const markdown = readFileSync(join(dir, `${date}-${slug}.md`), 'utf8');
    const page = renderPage(markdown);
    return { path: `/blog/${slug}`, title: page.title, description: excerpt(page.html), markdown, date };
  });
}

/**
 * llms-full.txt — every doc, whole, in manifest order, in one fetch.
 *
 * llms.txt is an index and deliberately short; an agent that wants the product's actual text has to
 * make one request per page to follow it. This is the same corpus in a single response, which is
 * the difference between a model quoting the spec and a model paraphrasing the landing page. Docs
 * only, not posts: the docs are the normative set, and a blog archive would grow this file without
 * bound.
 *
 * Each document is headed by the title its PAGE carries, not by its file's own first heading —
 * DOCS_MANIFEST overrides one for /docs/spec ("Protocol spec" against SPEC.md's "musterd protocol
 * — SPEC"), and the two headings stacked read as a duplicated section. The page strips the file's
 * heading for the same reason; this does what the page does.
 */
export function llmsFullTxt(docs: SiteMirror[] = docMirrors()): string {
  const body = docs
    .map(
      (d) =>
        `# ${d.title}\n\nSource: ${SITE_ORIGIN}${d.path}\n\n${stripLeadingHeading(d.markdown)}\n`,
    )
    .join('\n---\n\n');
  return `# ${SITE_TITLE} — full documentation

> Every page of ${SITE_TITLE}'s documentation, concatenated in reading order, for a reader that
> wants the whole product in one fetch. The index form is ${SITE_ORIGIN}/llms.txt.

Canonical page: ${SITE_ORIGIN}
Documents: ${docs.length}

AI agents and crawlers are welcome to read, quote and cite this. The protocol spec is MIT.

---

${body}`;
}

const xmlEscape = (s: string) =>
  s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/** RFC 822 date, which RSS 2.0 requires — an ISO date in <pubDate> is silently ignored. */
function rfc822(date: string): string {
  return new Date(`${date}T00:00:00Z`).toUTCString();
}

/**
 * /blog/rss.xml — the feed /blog did not have.
 *
 * A post's date comes from its filename, the same fact sitemap.xml dates it with, so the feed
 * cannot disagree with the page. `atom:link rel="self"` is what feed readers and validators use to
 * recognise the feed's own address; without it a reader that finds the feed by a relative link has
 * no absolute identity to store.
 */
export function rssXml(posts: SiteMirror[] = postMirrors()): string {
  const items = posts
    .map((p) =>
      [
        '    <item>',
        `      <title>${xmlEscape(p.title)}</title>`,
        `      <link>${SITE_ORIGIN}${p.path}</link>`,
        `      <guid isPermaLink="true">${SITE_ORIGIN}${p.path}</guid>`,
        ...(p.date ? [`      <pubDate>${rfc822(p.date)}</pubDate>`] : []),
        `      <description>${xmlEscape(p.description)}</description>`,
        '    </item>',
      ].join('\n'),
    )
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${SITE_TITLE} — blog</title>
    <link>${SITE_ORIGIN}/blog</link>
    <description>Launch notes and what the team learns building ${SITE_TITLE} — with ${SITE_TITLE}.</description>
    <language>en</language>
    <atom:link href="${SITE_ORIGIN}/blog/rss.xml" rel="self" type="application/rss+xml"/>
${items}
  </channel>
</rss>
`;
}

/**
 * Cache policy for the public origin.
 *
 * The short TTL on the three text files is a freshness decision, not a timidity one: they change
 * only when a page is published, and 5 minutes caps how long a newly published doc stays
 * undiscoverable. The alternative — purging on the deploy hook — races the build and can re-cache
 * the pre-build copy, which is exactly the trap sandrise.io documented.
 *
 * Content-hashed bundles under /assets/ are immutable by construction, so they get the year.
 */
export function headersFile(): string {
  return `# Cache policy for musterd.io. Consumed by Cloudflare Workers static assets; not served.

/assets/*
  Cache-Control: public, max-age=31536000, immutable

/robots.txt
  Cache-Control: public, max-age=300

/sitemap.xml
  Cache-Control: public, max-age=300

/llms.txt
  Cache-Control: public, max-age=300

/llms-full.txt
  Cache-Control: public, max-age=300

/blog/rss.xml
  Cache-Control: public, max-age=300
  Content-Type: application/rss+xml; charset=utf-8

# Wrangler types an asset from its extension at upload, and .md is already text/markdown — this
# states the charset, and states the type where a stale mime table would guess text/plain and send
# an agent reader a file it has to sniff.
/docs/*.md
  Cache-Control: public, max-age=300
  Content-Type: text/markdown; charset=utf-8

/blog/*.md
  Cache-Control: public, max-age=300
  Content-Type: text/markdown; charset=utf-8
`;
}

/** Drop a document's own `# ` line, which its heading in llms-full.txt has just restated. */
function stripLeadingHeading(md: string): string {
  return md.replace(/^#\s+.*$/m, '').trim();
}

/** The docs and posts that have a markdown mirror — every one of them, by construction. */
export function allMirrors(): SiteMirror[] {
  return [...docMirrors(), ...postMirrors()];
}

/** Everything this module contributes to the build, keyed by the filename it ships as. */
export function siteFiles(): Record<string, string> {
  const mirrors = allMirrors();
  return {
    'robots.txt': robotsTxt(),
    'sitemap.xml': sitemapXml(siteUrls(), mirrors),
    'llms.txt': llmsTxt(),
    'llms-full.txt': llmsFullTxt(),
    'blog/rss.xml': rssXml(),
    // `/docs/spec` is a directory of prerendered HTML, so `/docs/spec.md` sits beside it rather
    // than inside it. stage-site.mjs copies the `docs` and `blog` directories whole, so both
    // mirrors ship with the pages they mirror and need no new allowlist entry.
    ...Object.fromEntries(mirrors.map((m) => [`${m.path.slice(1)}.md`, m.markdown])),
    _headers: headersFile(),
  };
}
