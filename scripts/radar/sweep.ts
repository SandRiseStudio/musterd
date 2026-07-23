/**
 * Research radar dry-sweep + optional M3 triage (ADR 056 ingest).
 *
 * Fetches arXiv + HF Papers, dedups against docs/research/radar/seen.json, prints a report.
 * With `--triage`, runs tier-1/tier-2 LLM scoring (requires ANTHROPIC_API_KEY).
 * Print-only — never writes seen.json, digests, or thesis docs (M4).
 *
 *   pnpm radar:sweep [--json] [--since <days>] [--limit <n>] [--triage]
 */
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DEFAULT_PRINT_LIMIT, DEFAULT_SINCE_DAYS, radarDir, repoRoot, seenPath } from './config.ts';
import { loadSeen, mergeCandidates, partitionBySeen } from './dedup.ts';
import { sweepArxiv, sweepHf, type FetchFn } from './fetch.ts';
import { requireAnthropicKey } from './llm.ts';
import { runTriage, type CompleteFn } from './triage.ts';
import type { RadarCandidate, SweepReport, TriageReport } from './types.ts';

export interface SweepArgs {
  json: boolean;
  sinceDays: number;
  limit: number;
  triage: boolean;
  /** Injected for tests. */
  fetchFn?: FetchFn;
  seenFile?: string;
  apiKey?: string;
  completeFn?: CompleteFn;
  promptBody?: string;
}

export function parseArgs(argv: string[]): SweepArgs {
  let json = false;
  let sinceDays = DEFAULT_SINCE_DAYS;
  let limit = DEFAULT_PRINT_LIMIT;
  let triage = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--json') json = true;
    else if (a === '--triage') triage = true;
    else if (a === '--since') {
      const v = Number(argv[++i]);
      if (!Number.isFinite(v) || v < 1)
        throw new Error('--since requires a positive number of days');
      sinceDays = Math.floor(v);
    } else if (a === '--limit') {
      const v = Number(argv[++i]);
      if (!Number.isFinite(v) || v < 1) throw new Error('--limit requires a positive integer');
      limit = Math.floor(v);
    } else if (a === '--help' || a === '-h') {
      printHelp();
      process.exit(0);
    } else if (a === '--dry-run') {
      // Default/only write mode — accepted for plan flag parity
    } else {
      throw new Error(`unknown flag: ${a} (try --help)`);
    }
  }
  return { json, sinceDays, limit, triage };
}

function printHelp(): void {
  console.log(`Usage: pnpm radar:sweep [--json] [--since <days>] [--limit <n>] [--triage]

  Dry-sweep arXiv + HF Papers for multi-agent / human-agent research.
  Dedups against docs/research/radar/seen.json. Print-only (does not mark seen).

  --json         machine-readable SweepReport
  --since <n>    lookback days (default ${DEFAULT_SINCE_DAYS})
  --limit <n>    max new candidates to print / feed into triage (default ${DEFAULT_PRINT_LIMIT})
  --triage       run tier-1 + tier-2 LLM triage (needs ANTHROPIC_API_KEY)
  --dry-run      no-op (print-only is the only write mode until M4)
`);
}

export async function runSweep(args: SweepArgs): Promise<SweepReport> {
  const warnings: string[] = [];
  const fetchFn = args.fetchFn;
  const [arxiv, hf] = await Promise.all([
    sweepArxiv({ sinceDays: args.sinceDays, fetchFn }),
    sweepHf({ sinceDays: args.sinceDays, fetchFn }),
  ]);
  if (arxiv.warning) warnings.push(arxiv.warning);
  if (hf.warning) warnings.push(hf.warning);

  const merged = mergeCandidates([arxiv.candidates, hf.candidates]);
  const seen = loadSeen(args.seenFile ?? seenPath);
  const { fresh, alreadySeen } = partitionBySeen(merged, seen);
  const truncated = fresh.length > args.limit;
  const printed = fresh.slice(0, args.limit);

  let triage: TriageReport | undefined;
  if (args.triage) {
    const apiKey = args.apiKey ?? requireAnthropicKey();
    triage = await runTriage({
      candidates: printed,
      apiKey,
      fetchFn,
      completeFn: args.completeFn,
      promptBody: args.promptBody,
    });
    warnings.push(...triage.warnings);
  }

  return {
    generated: new Date().toISOString(),
    since_days: args.sinceDays,
    candidates_fetched: merged.length,
    already_seen: alreadySeen.length,
    new_count: fresh.length,
    printed: printed.length,
    truncated,
    new: printed,
    warnings,
    triage,
  };
}

function formatHuman(report: SweepReport): string {
  const lines: string[] = [];
  lines.push(`research radar dry-sweep · last ${report.since_days}d`);
  lines.push(
    `fetched ${report.candidates_fetched} · already_seen ${report.already_seen} · new ${report.new_count}` +
      (report.truncated ? ` (showing ${report.printed}, truncated)` : ''),
  );
  if (report.warnings.length) {
    for (const w of report.warnings) lines.push(`⚠ ${w}`);
  }
  lines.push('');
  if (report.new.length === 0) {
    lines.push('(no new candidates)');
  } else if (!report.triage) {
    for (const c of report.new) {
      lines.push(formatRow(c));
    }
  }

  if (report.triage) {
    lines.push(...formatTriage(report.triage));
  }

  lines.push('');
  lines.push(`seen ledger: ${seenPath} (read-only until M4)`);
  lines.push(`radar dir:   ${radarDir}`);
  return lines.join('\n');
}

function formatTriage(t: TriageReport): string[] {
  const lines: string[] = [];
  lines.push(
    `triage ${t.prompt_version} · tier1=${t.tier1_model} · tier2=${t.tier2_model} · floor=${t.relevance_floor}`,
  );
  lines.push(
    `candidates_in ${t.candidates_in} · shortlisted ${t.shortlisted}` +
      (t.shortlist_truncated ? ' (shortlist truncated)' : '') +
      ` · surfaced ${t.surfaced.length}`,
  );
  lines.push('');
  if (t.surfaced.length === 0) {
    lines.push('(no surfaced papers — all ignore or empty shortlist)');
  } else {
    for (const r of t.surfaced) {
      lines.push(`[${r.verdict}] ${r.score.toFixed(2)} ${r.id}  ${r.title}`);
      lines.push(`  ${r.url}`);
      lines.push(`  what: ${r.one_line}`);
      lines.push(`  why:  ${r.why_musterd}`);
      lines.push(`  gut:  ${r.gut_check}`);
      lines.push(`  conf: ${r.confidence.toFixed(2)}`);
      lines.push('');
    }
  }
  return lines;
}

function formatRow(c: RadarCandidate): string {
  const src = c.source.padEnd(5);
  const date = (c.published || '????-??-??').padEnd(10);
  const title = c.title.length > 90 ? `${c.title.slice(0, 87)}...` : c.title;
  return `${src} ${date} ${c.id.padEnd(12)} ${title}\n       ${c.url}`;
}

/** Thesis / ledger paths the dry-sweep must never write (test hook). */
export function forbiddenWritePaths(): string[] {
  return [
    join(repoRoot, 'docs', 'design', 'research-foundation.md'),
    join(repoRoot, 'docs', 'research', 'radar', 'seen.json'),
  ];
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const report = await runSweep(args);
  if (args.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(`${formatHuman(report)}\n`);
  }
  if (report.candidates_fetched === 0 && report.warnings.length) {
    process.exitCode = 2;
  }
  if (report.triage && report.triage.warnings.some((w) => w.startsWith('tier-1 failed'))) {
    process.exitCode = 2;
  }
}

// Run only when invoked directly (`node sweep.ts`), not when tests import helpers.
if (import.meta.url === pathToFileURL(process.argv[1]!).href) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
