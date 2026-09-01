/**
 * The musterd.io deploy allowlist (ADR 302). Everything the public site needs, and nothing else —
 * adding an entry here is a deploy decision, not a build side effect. `stage-site.mjs` stages
 * exactly this set and refuses anything unexpected; `stage-site.test.ts` pins the two lists
 * disjoint.
 */
export const PUBLIC_ALLOW = [
  'index.html',
  'assets',
  'roadmap',
  'docs',
  'blog',
  // Crawler- and agent-facing text, generated into the build by the `musterd-site-files` plugin in
  // vite.config.ts (see scripts/site-files.ts). These are safe where the daemon routes are not, for
  // the same reason the rest of this list is: static text with no client to boot. `_headers` is read
  // by Cloudflare and never served.
  'robots.txt',
  'sitemap.xml',
  'llms.txt',
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
