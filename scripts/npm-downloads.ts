/*
 * What the npm registry says about musterd's install count, with the mirrors subtracted.
 *
 *   node scripts/npm-downloads.ts            — the last 14 days
 *   node scripts/npm-downloads.ts --days 30  — a longer window
 *   node scripts/npm-downloads.ts --json     — machine-readable, for the weekly log
 *
 * Why this is not a one-line curl (measured 2026-09-16, the day the traction plan named npm
 * downloads as a passive proxy):
 *
 *   `downloads/point/last-month/@musterd/cli` answered **223**, and the daily series behind it
 *   alternated between 0–3 downloads a day and sudden bursts where all four published packages
 *   moved in near-lockstep — 339 / 307 / 356 / 326 in the week of Aug 3, 296 / 279 / 287 / 294 in
 *   the week of Jul 20. Two things say those bursts are registry mirrors and scrapers rather than
 *   people:
 *
 *     - LOCKSTEP ACROSS THE SCOPE. A real `npx @musterd/cli init` pulls the CLI *and* its
 *       dependencies, so the CLI leads and the rest follow. Four packages moving by the same
 *       amount on the same day is something walking the whole `@musterd` scope.
 *     - OLD VERSIONS. In that same week the CLI was fetched across EIGHT versions including
 *       0.0.0 and 0.0.1. Nobody installs 0.0.0; mirrors walk the version list.
 *
 *   So the headline number is inflated roughly 40× against the thing we actually want to know —
 *   did a stranger install this — and a reader who quotes "223 downloads last month" in a launch
 *   post or an application would be wrong by that factor. This script reports the number that
 *   survives both tells: downloads of the CURRENT version only, with the lockstep days named.
 *
 * Falsifier for the whole premise: if a burst day ever shows the CLI leading its dependencies and
 * the downloads landing on the current version, the mirror reading is wrong for that day and this
 * script's `suspected mirror` flag should stop firing. That is also what a real launch looks like,
 * so the flag going quiet during a spike is the good outcome, not a bug.
 */

interface DayPoint {
  day: string;
  downloads: number;
}

interface PackageReading {
  name: string;
  latest: string;
  /** Downloads of `latest` over the last 7 days — the closest thing to "someone installed it". */
  currentVersionWeek: number;
  /** Every version's downloads over the same 7 days, including the ones nobody would install. */
  allVersionsWeek: number;
  /** How many distinct versions were fetched: >3 is the scope-walker tell. */
  versionsFetched: number;
  /** Daily totals over the reporting window, oldest first. */
  daily: DayPoint[];
}

const REGISTRY = 'https://registry.npmjs.org';
const API = 'https://api.npmjs.org';

/** A day counts as a suspected mirror sweep when every package moves together, well above the floor. */
const LOCKSTEP_FLOOR = 8;
const LOCKSTEP_SPREAD = 0.5;

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i === -1 ? undefined : process.argv[i + 1];
}

async function getJson(url: string): Promise<unknown> {
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} — ${url}`);
  return res.json();
}

function isoDaysAgo(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

/**
 * The published packages, read from the workspace rather than a hardcoded list, so a new package
 * appears here the release after it appears in `packages/`.
 */
async function publishedPackages(): Promise<string[]> {
  const { readdirSync, readFileSync, existsSync } = await import('node:fs');
  const { join } = await import('node:path');
  const root = join(import.meta.dirname, '..', 'packages');
  const names: string[] = [];
  for (const dir of readdirSync(root)) {
    const manifest = join(root, dir, 'package.json');
    if (!existsSync(manifest)) continue;
    const pkg = JSON.parse(readFileSync(manifest, 'utf8')) as { name?: string; private?: boolean };
    if (pkg.name && !pkg.private) names.push(pkg.name);
  }
  return names.sort();
}

async function read(name: string, days: number): Promise<PackageReading> {
  const enc = encodeURIComponent(name);
  const meta = (await getJson(`${REGISTRY}/${enc}`)) as { 'dist-tags'?: Record<string, string> };
  const latest = meta['dist-tags']?.latest ?? 'unknown';

  const perVersion = (await getJson(`${API}/versions/${enc}/last-week`)) as {
    downloads?: Record<string, number>;
  };
  const versions = perVersion.downloads ?? {};
  const currentVersionWeek = versions[latest] ?? 0;
  const allVersionsWeek = Object.values(versions).reduce((a, b) => a + b, 0);
  const versionsFetched = Object.values(versions).filter((n) => n > 0).length;

  const range = (await getJson(
    `${API}/downloads/range/${isoDaysAgo(days)}:${isoDaysAgo(0)}/${enc}`,
  )) as { downloads?: DayPoint[] };

  return {
    name,
    latest,
    currentVersionWeek,
    allVersionsWeek,
    versionsFetched,
    daily: range.downloads ?? [],
  };
}

/** Days where every package moved together and well above the floor — a scope walk, not installs. */
function suspectedMirrorDays(readings: PackageReading[]): string[] {
  const days = readings[0]?.daily.map((d) => d.day) ?? [];
  return days.filter((day) => {
    const counts = readings.map((r) => r.daily.find((d) => d.day === day)?.downloads ?? 0);
    const min = Math.min(...counts);
    const max = Math.max(...counts);
    if (min < LOCKSTEP_FLOOR) return false;
    return (max - min) / max <= LOCKSTEP_SPREAD;
  });
}

async function main(): Promise<void> {
  const days = Number(arg('--days') ?? 14);
  const names = await publishedPackages();
  const readings: PackageReading[] = [];
  for (const name of names) {
    try {
      readings.push(await read(name, days));
    } catch (err) {
      console.error(`  ! ${name}: ${(err as Error).message}`);
    }
  }
  if (readings.length === 0) {
    console.error('No package read — the registry answered nothing. Network?');
    process.exit(1);
  }

  const mirrorDays = suspectedMirrorDays(readings);
  const mirrored = new Set(mirrorDays);
  const realDaily = (r: PackageReading) =>
    r.daily.filter((d) => !mirrored.has(d.day)).reduce((a, d) => a + d.downloads, 0);

  if (process.argv.includes('--json')) {
    console.log(
      JSON.stringify(
        {
          measuredAt: new Date().toISOString(),
          windowDays: days,
          suspectedMirrorDays: mirrorDays,
          packages: readings.map((r) => ({
            name: r.name,
            latest: r.latest,
            currentVersionLastWeek: r.currentVersionWeek,
            allVersionsLastWeek: r.allVersionsWeek,
            versionsFetchedLastWeek: r.versionsFetched,
            windowExcludingMirrorDays: realDaily(r),
          })),
        },
        null,
        2,
      ),
    );
    return;
  }

  const pad = Math.max(...readings.map((r) => r.name.length));
  console.log(
    `npm downloads — last ${days} days, measured ${new Date().toISOString().slice(0, 10)}`,
  );
  console.log('');
  console.log(
    `${'package'.padEnd(pad)}  latest   current-ver/wk   all-ver/wk   versions   ${days}d minus mirror days`,
  );
  for (const r of readings) {
    console.log(
      `${r.name.padEnd(pad)}  ${r.latest.padEnd(7)}  ${String(r.currentVersionWeek).padStart(13)}   ${String(
        r.allVersionsWeek,
      ).padStart(
        10,
      )}   ${String(r.versionsFetched).padStart(8)}   ${String(realDaily(r)).padStart(18)}`,
    );
  }
  console.log('');
  if (mirrorDays.length > 0) {
    console.log(
      `Suspected mirror sweeps (all packages moved together, ≥${LOCKSTEP_FLOOR}/day): ${mirrorDays.join(', ')}`,
    );
  } else {
    console.log('No lockstep days in this window.');
  }
  const totalReal = readings.reduce((a, r) => a + realDaily(r), 0);
  console.log(
    'Read left to right, weakest signal last:\n' +
      "  current-ver/wk  — the number a stranger's install moves. THIS is the traction proxy.\n" +
      '  all-ver/wk      — includes versions nobody would install; the gap is the mirror floor.\n' +
      '  versions        — distinct versions fetched in a week; >3 means something is walking the list.\n' +
      `  ${days}d minus mirror days — an UPPER BOUND only: it drops the lockstep days but still counts\n` +
      `                    old-version fetches on ordinary days (${totalReal} across all packages here).`,
  );
}

await main();
