/*
 * Steward seat (ADR 112) — the deterministic drift scan (`pnpm steward:scan [--json] [--since <date>]`).
 *
 * The steward's discovery pass: diff reality (git history, ADR statuses) against the declared record
 * (the roadmap) and emit the drift a static check can't — undeclared/unmarked work and stale prose.
 * Read-only and deterministic; it PROPOSES findings. What acts on them (a report, a draft PR, an
 * auto-merged mechanical fix) is the task registry's job (tasks.ts), gated by per-task autonomy.
 *
 * Three finders:
 *   - reverse_drift    — an item still unshipped whose own freezing ADR is already accepted. (The
 *                        roadmap-truth check errors on this at PR time, so it should be empty on main —
 *                        a belt-and-suspenders tripwire.)
 *   - unmarked_feature — a merged `feat` PR in the window that no shipped item anchors and whose cited
 *                        ADRs aren't already a shipped item's `frozenBy`: candidate undeclared/unmarked.
 *   - stale_prose      — a doc line saying "not yet built / not yet implemented" that cites an ADR which
 *                        is now accepted: the record's prose lags reality (we hit this twice by hand).
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  adrAccepted,
  adrByNumber,
  ANCHOR_EPOCH_PR,
  anchoredPRs,
  isShallow,
  mergedPRs,
  repoRoot,
  ROADMAP,
  shippedArcAdrs,
} from './lib.ts';
import { type Autonomy, type FinderId, taskFor } from './tasks.ts';

export interface Finding {
  finder: FinderId;
  /** The owning task (registry) + its autonomy — attached so the workflow acts without re-deriving. */
  task: string;
  autonomy: Autonomy;
  subject: string;
  detail: string;
}

/** Stamp a raw finding with its owning task + autonomy from the registry. */
function annotate(finder: FinderId, subject: string, detail: string): Finding {
  const t = taskFor(finder);
  return { finder, task: t.id, autonomy: t.autonomy, subject, detail };
}

/** Items whose freezing ADR is accepted but which aren't marked shipped — the reverse-stale drift. */
function reverseDrift(): Finding[] {
  return ROADMAP.filter(
    (it) => it.status !== 'shipped' && it.frozenBy !== undefined && adrAccepted(it.frozenBy),
  ).map((it) =>
    annotate(
      'reverse_drift',
      it.id,
      `roadmap item "${it.id}" is "${it.status}", but its freezing ADR ${it.frozenBy} is accepted — likely shipped-but-unmarked.`,
    ),
  );
}

/** Merged feat PRs in the window that no shipped anchor claims and no shipped item's frozenBy covers. */
function unmarkedFeatures(since: string): Finding[] {
  const anchored = anchoredPRs();
  const arcAdrs = shippedArcAdrs(); // ADRs an already-shipped item stands for (frozenBy + refs)
  // The steward's own upkeep PRs and pure docs/test/chore merges aren't features to declare.
  const IGNORE_TYPE = new Set(['docs', 'test', 'chore', 'ci', 'build', 'style', 'refactor']);
  return mergedPRs(since)
    .filter((pr) => pr.pr > ANCHOR_EPOCH_PR) // pre-convention features are legacy-covered by design
    .filter((pr) => pr.type === 'feat' && !anchored.has(pr.pr) && !IGNORE_TYPE.has(pr.type))
    .filter((pr) => pr.adrs.every((a) => !arcAdrs.has(a))) // not part of an already-shipped ADR arc
    .map((pr) =>
      annotate(
        'unmarked_feature',
        `#${pr.pr}`,
        `merged feat #${pr.pr} "${pr.subject}" maps to no shipped roadmap item — candidate unmarked or undeclared work.`,
      ),
    );
}

/** Walk docs/ for markdown files (skip the decisions/ ADRs themselves — their Status line is authoritative). */
function docMarkdownFiles(): string[] {
  const root = join(repoRoot, 'docs');
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const p = join(dir, entry);
      if (statSync(p).isDirectory()) {
        if (entry !== 'decisions') walk(p);
      } else if (entry.endsWith('.md')) {
        out.push(p);
      }
    }
  };
  walk(root);
  return out;
}

/** Doc prose saying "not yet built/implemented" while citing an ADR that is now accepted. */
function staleProse(): Finding[] {
  const findings: Finding[] = [];
  const stale = /not yet (built|implemented|shipped)/i;
  for (const file of docMarkdownFiles()) {
    const text = readFileSync(file, 'utf8');
    if (!stale.test(text)) continue;
    const citedAccepted = [...text.matchAll(/ADR\s+0*(\d+)/gi)]
      .map((m) => Number(m[1]))
      .filter((n, i, a) => a.indexOf(n) === i)
      .filter(adrAccepted);
    if (citedAccepted.length === 0) continue;
    findings.push(
      annotate(
        'stale_prose',
        relative(repoRoot, file),
        `says "not yet built/implemented" but cites now-accepted ADR ${citedAccepted.join(', ')} — prose likely lags reality.`,
      ),
    );
  }
  return findings;
}

/** Render findings as the tracking-issue body (grouped by task, autonomy shown) — the shepherding surface. */
function renderMarkdown(findings: Finding[], since: string): string {
  const lines: string[] = [
    '_Opened by the steward seat ([ADR 112](../blob/main/docs/decisions/112-steward-seat.md)). This issue tracks record drift the static checks can’t catch; it updates each run and closes itself when the drift clears._',
    '',
  ];
  const byTask = new Map<string, Finding[]>();
  for (const f of findings) {
    const g = byTask.get(f.task);
    if (g) g.push(f);
    else byTask.set(f.task, [f]);
  }
  for (const [task, fs] of byTask) {
    lines.push(`### \`${task}\` — ${fs[0]!.autonomy}`, '');
    for (const f of fs) lines.push(`- **${f.subject}** — ${f.detail}`);
    lines.push('');
  }
  lines.push(`_window: merged PRs since ${since}. Re-run: \`pnpm steward:scan\`._`);
  return lines.join('\n');
}

function main(): void {
  const args = process.argv.slice(2);
  const json = args.includes('--json');
  const md = args.includes('--md');
  const sinceIdx = args.indexOf('--since');
  const since = sinceIdx >= 0 ? args[sinceIdx + 1]! : '21 days ago';

  const findings = [...reverseDrift(), ...unmarkedFeatures(since), ...staleProse()];

  if (json) {
    process.stdout.write(JSON.stringify({ since, isShallow, findings }, null, 2) + '\n');
    return;
  }
  if (md) {
    process.stdout.write(renderMarkdown(findings, since) + '\n');
    return;
  }

  if (isShallow) {
    process.stdout.write(
      '⚠ shallow clone — unmarked_feature scan is limited (fetch full history).\n',
    );
  }
  if (findings.length === 0) {
    process.stdout.write('✓ steward scan: no record drift found — the roadmap matches reality.\n');
    return;
  }
  process.stdout.write(
    `steward scan — ${findings.length} finding(s) (window: since ${since}):\n\n`,
  );
  for (const f of findings) {
    process.stdout.write(`  • [${f.task} · ${f.autonomy}] ${f.subject}\n    ${f.detail}\n\n`);
  }
  // Surface the machine-readable form for the workflow to attach.
  process.stdout.write(`(run with --json for the structured findings a task acts on)\n`);
}

// Run only when invoked directly (`node scan.ts`), not when tasks.ts imports the finders.
if (import.meta.url === pathToFileURL(process.argv[1]!).href) main();

export { reverseDrift, unmarkedFeatures, staleProse, adrByNumber };
export type { Finding as ScanFinding };
