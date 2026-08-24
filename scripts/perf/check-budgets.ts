/*
 * Enforce the web UI performance budgets (ADR 151).
 *
 *   pnpm perf:check   — fail (exit 1) when the built client exceeds docs/perf/budgets.json
 *
 * Guards the wins of the /live perf arc (#326–#331: Lighthouse 49→85, transfer 1,077→381 KB) against
 * silent regression — the #1 vector being "added a dependency / a font / a big component". Measures
 * bytes only, because bytes are the one dimension CI can check without a daemon + headless Chrome;
 * runtime metrics (LCP, FPS, DOM size) stay on the manual harness (scripts/perf/live-baseline.mjs,
 * ritual in docs/perf/web-live-baseline.md).
 *
 * Budgets are gzip for text (what the daemon actually serves — sendFile negotiates br/gzip) and raw
 * for fonts (already-compressed formats ship as-is). The font-family allowlist exists because the
 * retired Inter/JetBrains families once sat in dist as 503 KB of never-fetched @font-face rules
 * (#329) — a new family must be a deliberate re-font, not a dependency side-effect.
 *
 * TWO JS budgets, because they answer different questions (ADR 183):
 *   initialJsGzipBytes — the worst route's EAGER graph: the entry plus everything the prerendered
 *     HTML tells the browser to fetch before the page is interactive. This is what a viewer feels,
 *     and it is the number lazy-loading moves.
 *   totalJsGzipBytes  — every .js in dist/client, lazy chunks included. This is how much code the
 *     product carries, which is what rots. Lazy-loading CANNOT move it (only raise it, by per-chunk
 *     overhead), so its remedy is deleting code or dropping a dependency.
 * Enforcing only the total is what ADR 151 shipped, and it made the gate's own first suggestion
 * impossible to satisfy — measured 2026-07-29: splitting the room-tone engine moved 1.3 KB out of
 * the initial payload and moved the total the WRONG way, 243.3 → 243.7 KB.
 *
 * Needs `pnpm build` first (same trap as typecheck: dist/ is gitignored).
 * Runs on Node's native TypeScript (no build step, no deps).
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');
const distClient = join(repoRoot, 'packages', 'web', 'dist', 'client');

interface Budgets {
  initialJsGzipBytes: number;
  totalJsGzipBytes: number;
  maxChunkGzipBytes: number;
  appCssGzipBytes: number;
  siteCssGzipBytes: number;
  sharedCssGzipBytes: number;
  cssBundles: Record<CssGroup, string[]>;
  totalFontBytes: number;
  allowedFontFamilies: string[];
}

type CssGroup = 'app' | 'site' | 'shared';

const budgets: Budgets = JSON.parse(
  readFileSync(join(repoRoot, 'docs', 'perf', 'budgets.json'), 'utf8'),
);

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

let files: string[];
try {
  files = walk(distClient);
} catch {
  console.error(
    `perf:check: ${relative(repoRoot, distClient)} not found — run \`pnpm build\` first (dist/ is gitignored, same as the typecheck trap).`,
  );
  process.exit(1);
}

const kb = (n: number) => `${(n / 1024).toFixed(1)} KB`;

const gzipCache = new Map<string, number>();
function gzipSize(file: string): number {
  let cached = gzipCache.get(file);
  if (cached === undefined) {
    cached = gzipSync(readFileSync(file)).length;
    gzipCache.set(file, cached);
  }
  return cached;
}

const js = files.filter((f) => f.endsWith('.js'));
const css = files.filter((f) => f.endsWith('.css'));
const fonts = files.filter((f) => /\.(woff2?|ttf|otf)$/.test(f));

const jsSizes = js.map((f) => ({ file: relative(distClient, f), gzip: gzipSize(f) }));
const totalJs = jsSizes.reduce((s, c) => s + c.gzip, 0);
const totalFont = fonts.reduce((s, f) => s + statSync(f).size, 0);

/*
 * CSS is budgeted per surface, not as one number (ADR 310): musterd.io and the daemon app share
 * this build but not a fate, and one shared ceiling meant a site-only change could be blocked by
 * office bytes (and vice versa — it happened, 2026-08-24, 6 bytes free). Bundles are classified by
 * pre-hash basename against budgets.cssBundles; an unlisted bundle is a FAILURE, not a silent
 * bucket, for the same reason the font allowlist exists — a new stylesheet is a deliberate act.
 */
const cssGroupBudget: Record<CssGroup, number> = {
  app: budgets.appCssGzipBytes,
  site: budgets.siteCssGzipBytes,
  shared: budgets.sharedCssGzipBytes,
};
const cssSizes = css.map((f) => {
  const name = relative(distClient, f);
  const base = name
    .split('/')
    .pop()!
    .replace(/-[^-.]+\.css$/, '');
  const group = (Object.keys(budgets.cssBundles) as CssGroup[]).find((g) =>
    budgets.cssBundles[g].includes(base),
  );
  return { file: name, base, group, gzip: gzipSize(f) };
});
const cssGroupTotal = (g: CssGroup) =>
  cssSizes.filter((c) => c.group === g).reduce((s, c) => s + c.gzip, 0);

/*
 * Each prerendered route ships an index.html naming its own eager graph: the entry <script> plus a
 * <link rel="modulepreload"> per statically-imported chunk. Dynamic imports are absent by
 * construction, which is exactly the distinction we want — so the HTML is the measurement, and no
 * bundler-internal manifest has to be trusted or kept in sync.
 */
const routeHtml = files.filter((f) => f.endsWith('index.html'));
const routeInitial = routeHtml
  .map((html) => {
    const route = `/${relative(distClient, html).replace(/(^|\/)index\.html$/, '')}`;
    const refs = new Set(
      [...readFileSync(html, 'utf8').matchAll(/(?:src|href)="\/assets\/([^"]+\.js)"/g)].map(
        (m) => m[1]!,
      ),
    );
    const chunks = [...refs].map((f) => ({
      file: f,
      gzip: gzipSize(join(distClient, 'assets', f)),
    }));
    return { route, chunks, gzip: chunks.reduce((s, c) => s + c.gzip, 0) };
  })
  .sort((a, b) => b.gzip - a.gzip);

const failures: string[] = [];

const worst = routeInitial[0];
if (!worst) {
  /*
   * A build that emits no prerendered route HTML would make the initial-payload budget silently
   * vacuous — a gate that always passes is worse than no gate, so this is a failure, not a skip.
   */
  failures.push(
    `found no prerendered route HTML under ${relative(repoRoot, distClient)}, so the initial-payload budget could not be measured — if the build output moved, fix this checker rather than letting the budget pass vacuously (ADR 183)`,
  );
} else if (worst.gzip > budgets.initialJsGzipBytes) {
  const top = [...worst.chunks]
    .sort((a, b) => b.gzip - a.gzip)
    .slice(0, 5)
    .map((c) => `    ${kb(c.gzip)}  ${c.file}`)
    .join('\n');
  failures.push(
    `initial JS gzip ${kb(worst.gzip)} on the worst route (${worst.route}) > budget ${kb(budgets.initialJsGzipBytes)}; its largest eager chunks:\n${top}\n` +
      `    → this is the budget lazy-loading moves: a dynamic import drops a chunk out of the eager graph.`,
  );
}

if (totalJs > budgets.totalJsGzipBytes) {
  const top = jsSizes
    .sort((a, b) => b.gzip - a.gzip)
    .slice(0, 5)
    .map((c) => `    ${kb(c.gzip)}  ${c.file}`)
    .join('\n');
  failures.push(
    `total JS gzip ${kb(totalJs)} across ${jsSizes.length} chunks > budget ${kb(budgets.totalJsGzipBytes)}; largest chunks:\n${top}\n` +
      `    → lazy-loading will NOT move this number (it only adds per-chunk overhead): delete code, drop the dependency, or raise the budget deliberately.`,
  );
}

for (const chunk of jsSizes) {
  if (chunk.gzip > budgets.maxChunkGzipBytes) {
    failures.push(
      `chunk ${chunk.file} gzip ${kb(chunk.gzip)} > per-chunk budget ${kb(budgets.maxChunkGzipBytes)}`,
    );
  }
}

for (const c of cssSizes) {
  if (!c.group) {
    failures.push(
      `css bundle ${c.file} (basename \`${c.base}\`) is not classified in budgets.cssBundles — a new stylesheet must be assigned to app, site, or shared deliberately (ADR 310), not budgeted by accident`,
    );
  }
}

for (const group of Object.keys(cssGroupBudget) as CssGroup[]) {
  const total = cssGroupTotal(group);
  if (total > cssGroupBudget[group]) {
    const own = cssSizes
      .filter((c) => c.group === group)
      .sort((a, b) => b.gzip - a.gzip)
      .map((c) => `    ${kb(c.gzip)}  ${c.file}`)
      .join('\n');
    failures.push(
      `${group} CSS gzip ${kb(total)} > budget ${kb(cssGroupBudget[group])}; its bundles:\n${own}\n` +
        `    → trim this surface's own stylesheets, or raise ${group}CssGzipBytes deliberately (ADR 183/310) — the other surfaces' budgets are not this failure's remedy.`,
    );
  }
}

if (totalFont > budgets.totalFontBytes) {
  failures.push(`total font bytes ${kb(totalFont)} > budget ${kb(budgets.totalFontBytes)}`);
}

for (const f of fonts) {
  const name = relative(distClient, f);
  const base = name.split('/').pop()!;
  if (!budgets.allowedFontFamilies.some((fam) => base.startsWith(`${fam}-`))) {
    failures.push(
      `font ${name} is not in the allowed families [${budgets.allowedFontFamilies.join(', ')}] — a new family is a deliberate re-font (update docs/perf/budgets.json in the same PR), not a dependency side-effect`,
    );
  }
}

const initialSummary = worst
  ? `initial JS gzip ${kb(worst.gzip)}/${kb(budgets.initialJsGzipBytes)} (worst route ${worst.route}, ${worst.chunks.length} eager chunks)`
  : 'initial JS gzip UNMEASURED';
console.log(
  `perf:check — ${initialSummary} · total JS gzip ${kb(totalJs)}/${kb(budgets.totalJsGzipBytes)} (${jsSizes.length} chunks) · CSS gzip app ${kb(cssGroupTotal('app'))}/${kb(budgets.appCssGzipBytes)} · site ${kb(cssGroupTotal('site'))}/${kb(budgets.siteCssGzipBytes)} · shared ${kb(cssGroupTotal('shared'))}/${kb(budgets.sharedCssGzipBytes)} · fonts ${kb(totalFont)}/${kb(budgets.totalFontBytes)} (${fonts.length} files) · largest chunk ${kb(Math.max(...jsSizes.map((c) => c.gzip)))}/${kb(budgets.maxChunkGzipBytes)}`,
);

if (failures.length > 0) {
  console.error('\nperf:check FAILED — the built web client exceeds docs/perf/budgets.json:\n');
  for (const f of failures) console.error(`  ✗ ${f}`);
  console.error(
    '\nEach failure above names the remedy that can actually move that number — the two JS budgets have different\n' +
      'ones (ADR 183). If the cost is justified instead, raise the budget in docs/perf/budgets.json in this PR and log\n' +
      'the measured cost in docs/perf/web-live-baseline.md (see ADR 151). Budgets are re-baselined on a cadence, so\n' +
      'a tight fit is not a reason to raise: check whether a scheduled re-baseline is due first.',
  );
  process.exit(1);
}
