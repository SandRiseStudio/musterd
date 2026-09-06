import { readdirSync } from 'node:fs';

/**
 * The musterd.io deploy allowlist (ADR 302). Everything the public site needs, and nothing else —
 * adding an entry here is a deploy decision, not a build side effect. `stage-site.mjs` stages
 * exactly this set and refuses anything unexpected; `stage-site.test.ts` pins the two lists
 * disjoint.
 */
/**
 * `blog` is the one conditional entry. The route tree prerenders /blog whether or not a post
 * exists, so withholding the directory at STAGE time is what actually keeps an empty section off
 * the public origin — the index, the feed and every post path 404 together, and all of it returns
 * the moment `content/blog` has a file in it. Deciding it here rather than in the build keeps the
 * rule where the other deploy decisions live.
 */
const BLOG_HAS_POSTS =
  readdirSync(new URL('../content/blog', import.meta.url)).filter((n) => n.endsWith('.md')).length >
  0;

export const PUBLIC_ALLOW = [
  'index.html',
  'assets',
  'docs',
  ...(BLOG_HAS_POSTS ? ['blog'] : []),
  // Crawler- and agent-facing text, generated into the build by the `musterd-site-files` plugin in
  // vite.config.ts (see scripts/site-files.ts). These are safe where the daemon routes are not, for
  // the same reason the rest of this list is: static text with no client to boot. `_headers` is read
  // by Cloudflare and never served.
  'robots.txt',
  'sitemap.xml',
  'llms.txt',
  // The whole docs corpus in one fetch, for an agent reader. The per-page markdown mirrors and
  // /blog/rss.xml need no entry of their own: they are emitted INSIDE the already-allowed `docs`
  // and `blog` directories, which this list copies whole.
  'llms-full.txt',
  '_headers',
];

/**
 * Daemon-connected surfaces that must NEVER reach the public origin: with no daemon behind them
 * they render dead UI (ADR 132 puts /live on the daemon origin; ADR 156 keeps it out of packaged
 * installs). Named so the staging script can assert disjointness rather than trusting review.
 */
export const DAEMON_ROUTES = [
  'live',
  'board',
  'audit',
  'approvals',
  'broadcast',
  'character-sheet',
  'office-preview',
];
