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
  totalJsGzipBytes: number;
  maxChunkGzipBytes: number;
  totalCssGzipBytes: number;
  totalFontBytes: number;
  allowedFontFamilies: string[];
}

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
const gzipSize = (file: string) => gzipSync(readFileSync(file)).length;

const js = files.filter((f) => f.endsWith('.js'));
const css = files.filter((f) => f.endsWith('.css'));
const fonts = files.filter((f) => /\.(woff2?|ttf|otf)$/.test(f));

const jsSizes = js.map((f) => ({ file: relative(distClient, f), gzip: gzipSize(f) }));
const totalJs = jsSizes.reduce((s, c) => s + c.gzip, 0);
const totalCss = css.reduce((s, f) => s + gzipSize(f), 0);
const totalFont = fonts.reduce((s, f) => s + statSync(f).size, 0);

const failures: string[] = [];

if (totalJs > budgets.totalJsGzipBytes) {
  const top = jsSizes
    .sort((a, b) => b.gzip - a.gzip)
    .slice(0, 5)
    .map((c) => `    ${kb(c.gzip)}  ${c.file}`)
    .join('\n');
  failures.push(
    `total JS gzip ${kb(totalJs)} > budget ${kb(budgets.totalJsGzipBytes)}; largest chunks:\n${top}`,
  );
}

for (const chunk of jsSizes) {
  if (chunk.gzip > budgets.maxChunkGzipBytes) {
    failures.push(
      `chunk ${chunk.file} gzip ${kb(chunk.gzip)} > per-chunk budget ${kb(budgets.maxChunkGzipBytes)}`,
    );
  }
}

if (totalCss > budgets.totalCssGzipBytes) {
  failures.push(`total CSS gzip ${kb(totalCss)} > budget ${kb(budgets.totalCssGzipBytes)}`);
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

console.log(
  `perf:check — JS gzip ${kb(totalJs)}/${kb(budgets.totalJsGzipBytes)} · CSS gzip ${kb(totalCss)}/${kb(budgets.totalCssGzipBytes)} · fonts ${kb(totalFont)}/${kb(budgets.totalFontBytes)} (${fonts.length} files) · largest chunk ${kb(Math.max(...jsSizes.map((c) => c.gzip)))}/${kb(budgets.maxChunkGzipBytes)}`,
);

if (failures.length > 0) {
  console.error('\nperf:check FAILED — the built web client exceeds docs/perf/budgets.json:\n');
  for (const f of failures) console.error(`  ✗ ${f}`);
  console.error(
    '\nEither shrink the change (lazy-load, drop the dependency, subset the font) or — if the cost is justified — raise the budget in docs/perf/budgets.json in this PR and log the measured cost in docs/perf/web-live-baseline.md (see ADR 151).',
  );
  process.exit(1);
}
