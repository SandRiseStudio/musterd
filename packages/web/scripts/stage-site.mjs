/**
 * Stage the public site for musterd.io: copy ONLY the landing route out of the build into
 * `dist/site`, which is what `wrangler.jsonc` deploys.
 *
 * Why a staging step at all: `pnpm build` prerenders every route, including /live, /board, /audit,
 * /approvals and the previews. Those are daemon-connected surfaces — on a public origin with no
 * daemon behind them they render dead UI, which is exactly what ADR 132 (live viewer lives on the
 * daemon origin) and ADR 156 (/live is out of scope for packaged installs) forbid. Deploying
 * `dist/client` wholesale would ship all of them. So the allowlist below is the deploy's safety
 * property, and this script fails loudly rather than shipping something it did not expect.
 */
import { cp, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { injectBeacon } from './beacon.mjs';
import { DAEMON_ROUTES, PUBLIC_ALLOW } from './stage-allowlist.mjs';

const pkgRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const BUILD = join(pkgRoot, 'dist', 'client');
const STAGE = join(pkgRoot, 'dist', 'site');

// The allowlist and the daemon set live in stage-allowlist.mjs (ADR 302) so tests can pin them.
const ALLOW = PUBLIC_ALLOW;

function die(msg) {
  console.error(`stage-site: ${msg}`);
  process.exit(1);
}

for (const r of DAEMON_ROUTES) {
  if (ALLOW.includes(r)) die(`allowlist contains daemon-connected route \`${r}\` — see ADR 302`);
}

const built = await readdir(BUILD).catch(() => die(`no build at ${BUILD} — run \`pnpm build\` first`));

for (const name of ALLOW) {
  if (!built.includes(name)) die(`build is missing \`${name}\` — did the prerender change?`);
}

await rm(STAGE, { recursive: true, force: true });
await mkdir(STAGE, { recursive: true });
for (const name of ALLOW) {
  await cp(join(BUILD, name), join(STAGE, name), { recursive: true });
}

// Verify what we are about to hand wrangler, rather than trusting the copy above: a route directory
// reaching the public origin is the one failure this script exists to prevent.
const staged = await readdir(STAGE);
const unexpected = staged.filter((n) => !ALLOW.includes(n));
if (unexpected.length > 0) die(`refusing to deploy — unexpected entries staged: ${unexpected.join(', ')}`);

// Cloudflare Web Analytics goes in HERE rather than in the shared shell, so the beacon reaches the
// public artifact and nothing else: dist/client — which is what the daemon serves /live, /board,
// /audit, /approvals and /broadcast from (ADR 132/156) — stays free of any third-party script.
// The zone's own `auto_install` ruleset cannot do this itself: it rewrites HTML at the edge, which
// never happens for an assets-only Worker, so it has been enabled and unreached since 2026-08-21.
const pages = await htmlFiles(STAGE);
if (pages.length === 0) die('staged no HTML — nothing would be recorded, and the site would be empty');
for (const page of pages) {
  const withBeacon = injectBeacon(await readFile(page, 'utf8'));
  if (withBeacon === null) die(`no </head> in ${relative(STAGE, page)} — refusing to deploy a page that records nothing`);
  await writeFile(page, withBeacon);
}
console.log(`stage-site: beacon in ${pages.length} page(s)`);

const withheld = built.filter((n) => !ALLOW.includes(n));
const bytes = await du(STAGE);
console.log(`stage-site: staged ${staged.join(', ')} → dist/site (${(bytes / 1024 / 1024).toFixed(1)} MB)`);
if (withheld.length > 0) {
  // "not staged", not "daemon-only": most of these are daemon routes, but a section can also be
  // withheld for having nothing in it yet (blog, with no posts). Calling all of them daemon-only
  // taught the reader something false about the ones that are not.
  console.log(`stage-site: withheld ${withheld.length} unstaged path(s): ${withheld.join(', ')}`);
}

/** Every staged .html, recursively — one per prerendered route, plus the docs and blog slug pages. */
async function htmlFiles(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await htmlFiles(p)));
    else if (entry.name.endsWith('.html')) out.push(p);
  }
  return out;
}

async function du(dir) {
  let total = 0;
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    total += entry.isDirectory() ? await du(p) : (await stat(p)).size;
  }
  return total;
}
