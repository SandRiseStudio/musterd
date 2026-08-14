/*
 * The routing freeze: keep the three files that decide WHO IS ASKED still, so the scheduled
 * ADR 260 re-run has a window it can actually read. The date lives in FREEZE_UNTIL below and is
 * paired with a LaunchAgent — it has already moved once and will move again.
 *
 *   pnpm routing-freeze:check [--base <ref>]
 *
 * WHY THIS EXISTS. The 2026-08-14 Eval (#837) could not be read in either direction — not credit,
 * not disproof — because routing changed inside its window. The re-run's window guard (#842) now
 * detects that condition, and its first live run counted **11 routing commits and 4 policy changes
 * in 7 days**. Detection alone therefore buys nothing: on that rate the re-run reports UNREADABLE
 * again and the team learns nothing twice. A measurement window on a system this active has to be
 * made, not found.
 *
 * WHAT IT IS NOT. Not a prohibition. Routing work that needs to happen still happens — put
 * `[unfreeze: why]` in a commit message on the branch and this gate passes. What it cannot be is
 * ACCIDENTAL: the whole failure mode being prevented is a window quietly contaminated by a change
 * nobody connected to the measurement. Breaking the freeze on purpose is a legitimate call that
 * costs one line and voids one statistic; breaking it by accident costs a week.
 *
 * SELF-EXPIRING. After FREEZE_UNTIL this gate is inert — it prints and exits 0 without consulting
 * the diff. A freeze that outlives its measurement is just friction, and friction nobody can
 * explain is removed by whoever trips over it at the worst possible moment.
 *
 * ONE LIST, NOT TWO. The frozen paths are imported from the Eval itself (`ROUTING_PATHS`), so the
 * files the team holds still are by construction the files the instrument watches. Two hand-kept
 * lists would drift, and the drift would look like a clean window over a system that moved — the
 * original failure, re-created on purpose.
 */
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROUTING_PATHS } from './research/adr-260-acceptance-eval.ts';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');

/**
 * The measurement window closes when the scheduled re-run fires — the LaunchAgent
 * `studio.sandrise.musterd-adr260-rerun`, currently 2026-09-11 09:07.
 *
 * KEEP THESE TWO IN STEP. If the run moves, this moves with it: a FREEZE_UNTIL earlier than the run
 * means the routing files thaw before the window closes and the run reports UNREADABLE anyway; a
 * FREEZE_UNTIL later than the run means the team is held still for a measurement that already
 * happened. Verify with `launchctl print gui/$(id -u)/studio.sandrise.musterd-adr260-rerun`.
 */
export const FREEZE_UNTIL = Date.parse('2026-09-11T09:07:00-07:00');

/** `[unfreeze: reason]` anywhere in a commit message on the branch releases the gate. */
export const UNFREEZE_RE = /\[unfreeze:([^\]]*)\]/i;

export interface FreezeVerdict {
  frozen: boolean;
  violations: string[];
  override: string | null;
}

/**
 * Pure decision, so it can be tested without a repo. `now` past FREEZE_UNTIL means inert.
 */
export function freezeVerdict(
  changedPaths: string[],
  commitMessages: string[],
  now: number,
): FreezeVerdict {
  if (now >= FREEZE_UNTIL) return { frozen: false, violations: [], override: null };
  const violations = changedPaths.filter((p) => (ROUTING_PATHS as readonly string[]).includes(p));
  const override =
    commitMessages.map((m) => UNFREEZE_RE.exec(m)?.[1]?.trim()).find((r) => r !== undefined) ?? null;
  return { frozen: true, violations, override: override || null };
}

function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

function resolveBase(): string {
  const flagIdx = process.argv.indexOf('--base');
  const requested =
    (flagIdx !== -1 ? process.argv[flagIdx + 1] : undefined) ??
    process.env['ROUTING_FREEZE_BASE'] ??
    'origin/main';
  try {
    return git('merge-base', 'HEAD', requested).trim();
  } catch {
    process.stderr.write(
      `✗ cannot resolve base ref \`${requested}\` — fetch it first (CI uses fetch-depth: 0), ` +
        `or pass --base <ref>.\n`,
    );
    process.exit(1);
  }
}

function main(): void {
  const now = Date.now();
  if (now >= FREEZE_UNTIL) {
    process.stdout.write(
      `routing freeze expired ${new Date(FREEZE_UNTIL).toISOString().slice(0, 10)} — gate inert. ` +
        `Delete this gate and its package.json entry when you next touch them.\n`,
    );
    return;
  }
  const base = resolveBase();
  const changed = git('diff', '--name-only', `${base}...HEAD`).split('\n').filter(Boolean);
  const messages = git('log', '--format=%B', `${base}..HEAD`).split('\n');
  const v = freezeVerdict(changed, messages, now);

  if (v.violations.length === 0) {
    process.stdout.write('✓ routing freeze intact — no frozen path in this change.\n');
    return;
  }
  // Derived, never a literal: the date moved once already, and a hardcoded copy in a message is
  // how a gate ends up confidently naming a window that no longer exists.
  const until = new Date(FREEZE_UNTIL).toISOString().slice(0, 16).replace('T', ' ');
  if (v.override !== null) {
    process.stdout.write(
      `⚠ routing freeze DELIBERATELY BROKEN — passing on \`[unfreeze: ${v.override}]\`.\n` +
        `  Touched: ${v.violations.join(', ')}\n` +
        `  The ${until} measurement window is now void. The re-run will detect this on its own ` +
        `and report UNREADABLE; say so in the lane rather than letting someone quote the number.\n`,
    );
    return;
  }
  process.stderr.write(
    `✗ routing freeze (until ${until}) — this change touches a file the ADR 260 re-run measures:\n` +
      v.violations.map((p) => `    ${p}\n`).join('') +
      `\n  Those three files decide who gets asked to accept, so changing them mid-window makes the\n` +
      `  re-run unreadable — the exact failure the 2026-08-14 Eval hit (docs/wiki/acceptance-routing.md).\n\n` +
      `  If this change genuinely needs to land now, that is allowed and it is not a fight: put\n` +
      `  \`[unfreeze: why]\` in a commit message on this branch. The gate passes, the window is\n` +
      `  recorded as void, and the measurement moves to the next clean window.\n`,
  );
  process.exit(1);
}

if (process.argv[1]?.endsWith('check-routing-freeze.ts')) main();
