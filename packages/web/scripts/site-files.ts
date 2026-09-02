/**
 * The crawler- and agent-facing text files musterd.io serves beside its HTML: robots.txt,
 * sitemap.xml, llms.txt and _headers.
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
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DOCS_MANIFEST } from '../content/docs.manifest';
import { SITE_ORIGIN } from '../src/brand/siteMeta';

const pkgRoot = dirname(dirname(fileURLToPath(import.meta.url)));

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

export function sitemapXml(urls: SiteUrl[] = siteUrls()): string {
  const entries = urls
    .map(({ path, lastmod }) =>
      [
        '  <url>',
        `    <loc>${SITE_ORIGIN}${path}</loc>`,
        ...(lastmod ? [`    <lastmod>${lastmod}</lastmod>`] : []),
        '  </url>',
      ].join('\n'),
    )
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
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
`;
}

/** Everything this module contributes to the build, keyed by the filename it ships as. */
export function siteFiles(): Record<string, string> {
  return {
    'robots.txt': robotsTxt(),
    'sitemap.xml': sitemapXml(),
    'llms.txt': llmsTxt(),
    _headers: headersFile(),
  };
}
