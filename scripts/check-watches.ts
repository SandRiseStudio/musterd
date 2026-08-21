/*
 * The watch gate — a pre-registered longitudinal question cannot rot into an unread sweep.
 *
 * Three rules, deliberately scoped differently:
 *
 *   A. no watch outlives its `revisit_by`   — TREE check (plus a diff half for immutability)
 *   B. a frequency claim carries a watch    — DIFF check, never a tree check
 *   C. a resolution posts back              — DIFF check
 *
 * RULE A BREAKS THE BUILD ON A DATE ROLLOVER WITH NO CODE CHANGE. That is uncomfortable and it is
 * the design, inherited verbatim from `check-controls.ts`, which already does exactly this from
 * `format:check` today. Its pressure valve is the honest one: resolve the watch, or mark it
 * `void: unattended`. Voiding is not a dodge — it records that nobody looked, which is the datum
 * ADR 294 wants and the thing ADR 166's sweep hid for 25 days. Both leave a record; ignoring it
 * does not.
 *
 * WHY IMMUTABILITY IS A RULE AND NOT A CONVENTION. The failure this primitive exists to prevent is
 * a sweep that renews itself for free — ADR 166's ran 5,679 times over 24.8 days and was never
 * read. Renewal has to cost a decision, so `revisit_by` cannot move: continuing a question means a
 * NEW watch file, with a new question, in a diff someone reviews.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decisionSection } from './adr-sections.ts';
import { parseWatch, scalar, validateWatch, type Watch } from './watches.ts';

export interface ChangedWatch {
  readonly path: string;
  readonly head: Watch;
  readonly base: Watch | null;
}

/** A1 — tree check. Any open watch past its date, anywhere in the repo. */
export function ruleA(watches: Watch[], today: string): string[] {
  const errors: string[] = [];
  for (const w of watches) {
    if (scalar(w, 'status') !== 'open') continue;
    const revisitBy = scalar(w, 'revisit_by');
    if (revisitBy === undefined || revisitBy >= today) continue;
    errors.push(
      `${w.path} — open past its \`revisit_by\` (${revisitBy}, today ${today}). ` +
        `Opened by ${scalar(w, 'opened_by') ?? 'an unnamed seat'}. ` +
        'Resolve it with a verdict, or mark it `status: void` with ' +
        '`resolution: "unattended — revisit_by passed with nobody reading the series. No verdict."` ' +
        'Voiding is legitimate: it records that we failed to look. Moving the date is not.',
    );
  }
  return errors;
}

/** A2 — diff check. `revisit_by` is immutable once a watch is on main. */
export function ruleAImmutable(changed: ChangedWatch[]): string[] {
  const errors: string[] = [];
  for (const { path, head, base } of changed) {
    if (base === null) continue;
    const was = scalar(base, 'revisit_by');
    const now = scalar(head, 'revisit_by');
    if (was !== undefined && now !== undefined && was !== now) {
      errors.push(
        `${path} — \`revisit_by\` moved ${was} → ${now}. A watch cannot be renewed in place. ` +
          'Continuing the question means a NEW watch file, with a new question, in a diff someone ' +
          'reviews — that cost is the whole mechanism preventing a sweep that renews itself for free.',
      );
    }
  }
  return errors;
}

/**
 * Frequency of a time-varying quantity — the tell that a claim needs a window, not a moment.
 *
 * Deliberately EXCLUDES `always` / `never`. Those are ADR 294 `absence`-class claims: ubiquitous in
 * ordinary prose, and the controls registry's problem rather than this one. Including them would
 * fire on most Decisions in the corpus and get the rule switched off.
 */
export const FREQUENCY_TERMS = [
  'flaky',
  'intermittent',
  'intermittently',
  'rare',
  'rarely',
  'usually',
  'often',
  'frequently',
  'occasionally',
  'sometimes',
  'sporadic',
  'sporadically',
  'under load',
  'most of the time',
] as const;

/** A waiver has to carry a reason. `Snapshot-debt: none` on its own is an assertion, not an argument. */
const SNAPSHOT_DEBT = /^-?\s*(?:\*\*)?Snapshot-debt:?(?:\*\*)?:?\s*(\S.*)$/m;

function satisfiesSnapshotDebt(text: string): boolean {
  const value = SNAPSHOT_DEBT.exec(text)?.[1]?.trim();
  if (value === undefined) return false;
  // `none` alone is a bare waiver; `none — <why>` is a waiver with its reasoning attached.
  return !/^none\.?$/i.test(value);
}

/**
 * DIFF-SCOPED BY ITS CALLER, NEVER TREE-SCOPED. `check-change-adr.ts:176` records why: making that
 * gate a tree check "would fire on every PR touching one of those 94". Measured here on 2026-08-21:
 * 14 of 292 existing ADRs carry a frequency term in their `## Decision`. Not most of them — but 14
 * failures an author cannot fix, on a PR that touched none of them, is how a gate gets switched off.
 *
 * NOTE: `base...HEAD` sees COMMITTED changes only, matching `check-change-adr.ts`. A staged-but-
 * uncommitted ADR will not be judged until it is committed. That is the house convention (these
 * gates are written for CI on a pushed branch), not an oversight.
 */
export function ruleB(adrs: { path: string; text: string }[]): string[] {
  const errors: string[] = [];
  for (const { path, text } of adrs) {
    const decision = decisionSection(text);
    if (decision === null) continue;
    if (satisfiesSnapshotDebt(text)) continue;

    const hit = FREQUENCY_TERMS.find((term) =>
      new RegExp(`\\b${term.replace(/ /g, '\\s+')}\\b`, 'i').test(decision),
    );
    if (hit === undefined) continue;

    errors.push(
      `${path} — \`## Decision\` asserts a frequency claim (\`${hit}\`). A frequency claim is a ` +
        'window, not a moment. Either cite a watch:\n' +
        '      Snapshot-debt: docs/watches/<date>-<slug>.md\n' +
        '    or waive it with a reason:\n' +
        '      Snapshot-debt: none — <why this is not a snapshot you are asserting>',
    );
  }
  return errors;
}

/**
 * A verdict that lands only in `docs/watches/` is a verdict nobody reads — the exact failure this
 * primitive exists to end. Resolving a watch must move the file the watch names as depending on it,
 * so the answer arrives where the decision lives.
 *
 * Fires on ANY transition into a terminal state, including terminal → terminal: changing a `void`
 * to a `resolved` is a new verdict and the reader of the decision deserves to see it.
 */
export function ruleC(changed: ChangedWatch[], changedPaths: string[]): string[] {
  const errors: string[] = [];
  const touched = new Set(changedPaths);

  for (const { path, head, base } of changed) {
    const now = scalar(head, 'status');
    if (now === undefined || now === 'open') continue;
    if (base !== null && scalar(base, 'status') === now) continue;

    const claimRef = scalar(head, 'claim_ref');
    if (claimRef === undefined || touched.has(claimRef)) continue;

    errors.push(
      `${path} — resolved to \`${now}\` without touching its \`claim_ref\` (${claimRef}). ` +
        'A resolution has to post back: record the verdict as a dated note on the decision that ' +
        'depended on it, in the same diff. Otherwise the answer lives somewhere nobody reads, ' +
        'which is the failure the watch was opened to prevent.',
    );
  }
  return errors;
}

export function readWatches(repoRoot: string): Watch[] {
  const dir = join(repoRoot, 'docs/watches');
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith('.md'));
  } catch {
    return [];
  }
  const watches: Watch[] = [];
  for (const name of names) {
    const path = `docs/watches/${name}`;
    const w = parseWatch(path, readFileSync(join(dir, name), 'utf8'));
    if (w !== null) watches.push(w);
  }
  return watches;
}

function git(...args: string[]): string {
  return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

/**
 * The merge-base against `origin/main`, or null when it cannot be resolved.
 *
 * NOT imported from `check-change-adr.ts`, which resolves its base at module top level and would
 * run the whole ADR gate on import. Same precedence as that file so the two agree in CI.
 *
 * Returns null rather than exiting, because unlike that gate this one also has TREE rules that stay
 * valid without a base — a shallow clone should still be told about an overdue watch. What it must
 * never do is skip the diff rules SILENTLY; see `main`.
 */
function resolveBase(): string | null {
  const flagIdx = process.argv.indexOf('--base');
  const requested =
    (flagIdx !== -1 ? process.argv[flagIdx + 1] : undefined) ??
    process.env['WATCH_BASE'] ??
    process.env['CHANGE_ADR_BASE'] ??
    'origin/main';
  try {
    return git('merge-base', 'HEAD', requested).trim();
  } catch {
    return null;
  }
}

function main(): void {
  const repoRoot = process.cwd();
  const today = new Date().toISOString().slice(0, 10);
  const watches = readWatches(repoRoot);

  const errors = [...watches.flatMap((w) => validateWatch(w, { repoRoot })), ...ruleA(watches, today)];

  const base = resolveBase();
  if (base === null) {
    // Announced, never silent. A rule that did not run and says nothing is indistinguishable from a
    // rule that ran and found nothing — the `absence` failure this whole primitive is about.
    process.stderr.write(
      '! watch:check — no merge-base against origin/main, so rules B and C DID NOT RUN ' +
        '(frequency claims, resolution post-back). Fetch origin/main, or pass --base <ref>.\n',
    );
  } else {
    const changedPaths = git('diff', '--name-only', `${base}...HEAD`).split('\n').filter(Boolean);

    const changedAdrs = changedPaths
      .filter((p) => /^docs\/decisions\/\d+-.*\.md$/.test(p))
      .filter((p) => existsSync(join(repoRoot, p)))
      .map((p) => ({ path: p, text: readFileSync(join(repoRoot, p), 'utf8') }));

    const changedWatches: ChangedWatch[] = changedPaths
      .filter((p) => /^docs\/watches\/.*\.md$/.test(p))
      .flatMap((p) => {
        if (!existsSync(join(repoRoot, p))) return []; // deleted in this diff
        const head = parseWatch(p, readFileSync(join(repoRoot, p), 'utf8'));
        if (head === null) return [];
        // Absent at the base means new; `git show` exits non-zero, and that IS the signal.
        let baseWatch: Watch | null = null;
        try {
          baseWatch = parseWatch(p, git('show', `${base}:${p}`));
        } catch {
          baseWatch = null;
        }
        return [{ path: p, head, base: baseWatch }];
      });

    errors.push(...ruleB(changedAdrs), ...ruleAImmutable(changedWatches), ...ruleC(changedWatches, changedPaths));
  }

  if (errors.length > 0) {
    process.stderr.write(`✗ watch:check\n\n${errors.map((e) => `  ${e}\n`).join('\n')}\n`);
    process.exit(1);
  }
  process.stdout.write(`✓ watch:check — ${watches.length} watch(es), none past their revisit_by.\n`);
}

// The robust form, matching check-wiki.ts:164. Not check-controls.ts's `file://` template literal,
// which breaks on any path needing URL encoding.
if (process.argv[1] === fileURLToPath(import.meta.url)) main();
