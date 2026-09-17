/*
 * The Sunday readout: every traction number in one place, with the ones we cannot measure named.
 *
 *   node scripts/traction.ts          — the readout
 *   node scripts/traction.ts --json   — the same numbers for the weekly log / the plan's artifact
 *   node scripts/traction.ts --init   — create the hand log with its header and an example row
 *
 * Why a command and not a dashboard (traction-plan §6, decided with nick 2026-09-17): the numbers
 * that matter are hand-counted, because the product has no usage analytics on purpose
 * (PRIVACY.md) and the passive proxies lie in our favour (see `npm-downloads.ts` — the npm
 * headline is inflated ~40× by registry mirrors). A web dashboard would be a surface to maintain
 * inside a nine-week window whose whole point is installing musterd on other people's laptops, and
 * founder metrics do not belong in the product's own codebase next to `/live` and `/board`.
 *
 * THE RULE THIS SCRIPT ENFORCES: a number it cannot measure is printed as "not measured", never as
 * zero. Zero is a finding; "not measured" is an admission. Conflating them is how a plan starts
 * lying to the person following it.
 */

import {
  publishedPackages,
  read,
  suspectedMirrorDays,
  type PackageReading,
} from './npm-downloads.ts';

/** One row a human wrote after an event. The funnel in traction-plan §6, one line at a time. */
interface LogRow {
  date: string;
  /** Where this sits in the funnel; `quote` and `pm-*` are not funnel steps but are counted. */
  kind:
    | 'conversation'
    | 'qualified'
    | 'attempt'
    | 'install'
    | 'active'
    | 'quote'
    | 'pm-message'
    | 'pm-chat'
    | 'pm-referral';
  who: string;
  where: string;
  note: string;
}

const LOG_PATH = 'docs/design/traction-log.tsv';
const FUNNEL: LogRow['kind'][] = ['conversation', 'qualified', 'attempt', 'install', 'active'];
const PM: LogRow['kind'][] = ['pm-message', 'pm-chat', 'pm-referral'];

/** Weekly input targets from traction-plan §13, so a low week names itself rather than waiting for Sunday. */
const WEEKLY_TARGET: Partial<Record<LogRow['kind'], number>> = {
  conversation: 20,
  qualified: 6,
  attempt: 3,
  'pm-message': 5,
  'pm-chat': 1,
};

const REPO = 'SandRiseStudio/musterd';

function has(flag: string): boolean {
  return process.argv.includes(flag);
}

/** `gh` is how we read GitHub, because traffic needs auth and nick is already authenticated. */
async function gh(path: string): Promise<unknown | null> {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  try {
    const { stdout } = await promisify(execFile)('gh', ['api', path], { timeout: 20_000 });
    return JSON.parse(stdout) as unknown;
  } catch {
    return null;
  }
}

async function readLog(): Promise<LogRow[] | null> {
  const { readFileSync, existsSync } = await import('node:fs');
  if (!existsSync(LOG_PATH)) return null;
  const lines = readFileSync(LOG_PATH, 'utf8').split('\n');
  const rows: LogRow[] = [];
  for (const line of lines) {
    if (!line.trim() || line.startsWith('#') || line.startsWith('date\t')) continue;
    const [date, kind, who, where, ...rest] = line.split('\t');
    if (!date || !kind) continue;
    // An example row must never move a real count — the whole point of this file is that a number
    // in it corresponds to a person nick actually spoke to.
    if ((who ?? '').includes('EXAMPLE')) continue;
    rows.push({
      date,
      kind: kind as LogRow['kind'],
      who: who ?? '',
      where: where ?? '',
      note: rest.join('\t'),
    });
  }
  return rows;
}

/** Monday of the ISO week a date falls in — the log's bucket, matching the plan's weekly measures. */
function weekOf(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  const day = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - day);
  return d.toISOString().slice(0, 10);
}

function countsFor(rows: LogRow[], week: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of rows.filter((x) => weekOf(x.date) === week)) out[r.kind] = (out[r.kind] ?? 0) + 1;
  return out;
}

/**
 * Which funnel step is starving, by the plan's own diagnostics: conversations high but qualified
 * low means the wrong rooms; qualified high but attempts low means the ask is wrong; attempts high
 * but installs low means the product broke and run 4 should be re-run.
 */
function diagnose(c: Record<string, number>): string | null {
  const n = (k: string) => c[k] ?? 0;
  if (n('conversation') === 0) return 'Nothing logged this week — the funnel cannot say anything.';
  if (n('conversation') >= 10 && n('qualified') <= 2)
    return 'Conversations high, qualified low → wrong rooms. Re-pick the events (§10).';
  if (n('qualified') >= 4 && n('attempt') <= 1)
    return 'Qualified high, attempts low → the ask is wrong, not the product. Change the ask.';
  if (n('attempt') >= 3 && n('install') === 0)
    return 'Attempts high, installs zero → the product broke on their machine. Re-run dogfood run 4.';
  return null;
}

function daysUntil(iso: string): number {
  return Math.ceil((new Date(`${iso}T00:00:00Z`).getTime() - Date.now()) / 86_400_000);
}

async function main(): Promise<void> {
  if (has('--init')) {
    const { writeFileSync, existsSync } = await import('node:fs');
    if (existsSync(LOG_PATH)) {
      console.error(`${LOG_PATH} already exists — not overwriting it.`);
      process.exit(1);
    }
    writeFileSync(
      LOG_PATH,
      [
        '# The hand log behind traction-plan §6 and §16. One line per real event, appended by nick.',
        '# kind: conversation | qualified | attempt | install | active | quote | pm-message | pm-chat | pm-referral',
        '# Tab-separated. "who" is a person, not a count — a row with no name did not happen.',
        'date\tkind\twho\twhere\tnote',
        `${new Date().toISOString().slice(0, 10)}\tconversation\tEXAMPLE — delete me\tStartup Grind\truns Claude Code + Codex; said yes to the question`,
        '',
      ].join('\n'),
    );
    console.log(`Created ${LOG_PATH}. Append one line per conversation; delete the example row.`);
    return;
  }

  const names = await publishedPackages();
  const npm: PackageReading[] = [];
  for (const name of names) {
    try {
      npm.push(await read(name, 14));
    } catch {
      /* a package the registry would not answer for is reported as missing below */
    }
  }
  const mirrorDays = suspectedMirrorDays(npm);
  const currentVersionWeek = npm.reduce((a, r) => a + r.currentVersionWeek, 0);

  const repo = (await gh(`repos/${REPO}`)) as {
    stargazers_count?: number;
    forks_count?: number;
  } | null;
  const views = (await gh(`repos/${REPO}/traffic/views`)) as {
    count?: number;
    uniques?: number;
  } | null;
  const clones = (await gh(`repos/${REPO}/traffic/clones`)) as { uniques?: number } | null;

  const rows = await readLog();
  const thisWeek = weekOf(new Date().toISOString().slice(0, 10));
  const counts = rows ? countsFor(rows, thisWeek) : null;

  if (has('--json')) {
    console.log(
      JSON.stringify(
        {
          measuredAt: new Date().toISOString(),
          week: thisWeek,
          daysToLaunch: daysUntil('2026-10-28'),
          daysToDue: daysUntil('2026-11-20'),
          npm: {
            currentVersionLastWeek: currentVersionWeek,
            perPackage: npm.map((r) => ({
              name: r.name,
              current: r.currentVersionWeek,
              all: r.allVersionsWeek,
            })),
            suspectedMirrorDays: mirrorDays,
          },
          github: repo
            ? {
                stars: repo.stargazers_count ?? null,
                forks: repo.forks_count ?? null,
                views14d: views?.count ?? null,
                uniques14d: views?.uniques ?? null,
                // Inflated by our own auto-refresher — see the note where this prints.
                cloneUniques14d: clones?.uniques ?? null,
              }
            : null,
          site: null,
          funnel: counts,
          diagnosis: counts ? diagnose(counts) : null,
        },
        null,
        2,
      ),
    );
    return;
  }

  const notMeasured = '— not measured';
  console.log(`musterd traction — week of ${thisWeek}`);
  console.log(
    `${daysUntil('2026-10-28')} days to the launch window · ${daysUntil('2026-11-20')} days to Nov 20`,
  );
  console.log('');

  console.log('INSTALLS (hand-counted — the product has no usage analytics, by design)');
  if (!counts) {
    console.log(`  ${notMeasured}: no hand log yet. Create it: pnpm traction --init`);
  } else {
    for (const k of FUNNEL) {
      const target = WEEKLY_TARGET[k];
      const got = counts[k] ?? 0;
      const flag = target !== undefined && got < target ? `  (target ${target})` : '';
      console.log(`  ${k.padEnd(14)} ${String(got).padStart(3)}${flag}`);
    }
    const d = diagnose(counts);
    if (d) console.log(`  → ${d}`);
  }
  console.log('');

  console.log('PM TRACK (traction-plan §16)');
  if (!counts) {
    console.log(`  ${notMeasured}: no hand log yet.`);
  } else {
    for (const k of PM) {
      const target = WEEKLY_TARGET[k];
      const got = counts[k] ?? 0;
      const flag = target !== undefined && got < target ? `  (target ${target})` : '';
      console.log(`  ${k.padEnd(14)} ${String(got).padStart(3)}${flag}`);
    }
  }
  console.log('');

  console.log('NPM — current version only; the headline number is ~40× mirrors');
  if (npm.length === 0) {
    console.log(`  ${notMeasured}: the registry answered nothing.`);
  } else {
    for (const r of npm) {
      console.log(
        `  ${r.name.padEnd(20)} ${String(r.currentVersionWeek).padStart(3)}/wk on ${r.latest}   (${r.allVersionsWeek} across ${r.versionsFetched} versions)`,
      );
    }
    console.log(`  total on the current version, last 7 days: ${currentVersionWeek}`);
    if (mirrorDays.length > 0) console.log(`  suspected mirror sweeps: ${mirrorDays.join(', ')}`);
  }
  console.log('');

  console.log('GITHUB');
  if (!repo) {
    console.log(`  ${notMeasured}: \`gh\` is not installed or not authenticated.`);
  } else {
    console.log(`  stars ${repo.stargazers_count ?? '?'}   forks ${repo.forks_count ?? '?'}`);
    console.log(
      `  14 days: ${views?.count ?? '?'} views, ${views?.uniques ?? '?'} unique visitors`,
    );
    // Clones are NOT a traction number here: the daemon auto-refresher pulls this repo on its own
    // interval, which is why the count reads in the hundreds against 7 human visitors. Printed with
    // that said out loud, because a clone count is exactly the number someone would misquote.
    console.log(
      `  ${clones?.uniques ?? '?'} unique cloners — mostly this machine's auto-refresher, not people`,
    );
  }
  console.log('');

  console.log('MUSTERD.IO');
  console.log(
    `  ${notMeasured}: Cloudflare Web Analytics has no read API without a token. Read it in the dashboard,\n  or mint a token and this section can join the readout.`,
  );
  console.log('');
  console.log(
    'A number this command prints as "not measured" is not zero. Zero is a finding; not measured is an\nadmission — do not quote one as the other.',
  );
}

await main();
