/**
 * Radar M4 — the emit rail: weekly digest + seen-ledger append (research-radar-plan §4.5, §5).
 *
 * A digest is a TRIAGE artifact — emitting an untriaged sweep is refused, because a bare candidate
 * list has no verdicts for a human to act on. The seen ledger gains EVERY candidate that entered
 * triage, not only the surfaced ones the plan first sketched: marking only surfaced ids would
 * re-pay tier-1 for the same ignores every single week (the fetch window overlaps the cadence).
 * A same-week re-emit refuses rather than overwriting — the first digest is data.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadSeen } from './dedup.ts';
import { isoWeekString } from './fetch.ts';
import type { SweepReport, Tier2Result, TriageVerdict } from './types.ts';

/** ISO-8601 week of an ISO date/timestamp string, e.g. 2026-W35. */
export function isoWeek(dateISO: string): string {
  return isoWeekString(new Date(`${dateISO.slice(0, 10)}T00:00:00Z`));
}

const VERDICT_ORDER: readonly TriageVerdict[] = ['consider-ADR', 'record-as-evidence'];

export function renderDigest(report: SweepReport): string {
  const t = report.triage;
  if (t === undefined) {
    throw new Error('cannot emit a digest without triage — run with --triage');
  }
  const week = isoWeek(report.generated);
  const lines: string[] = [
    '---',
    `week: ${week}`,
    `generated: ${report.generated.slice(0, 10)}`,
    `prompt_version: ${t.prompt_version}`,
    `tier1_model: ${t.tier1_model}`,
    `tier2_model: ${t.tier2_model}`,
    // What was judged, not what was fetched — the digest reports on the triaged set.
    `candidates_seen: ${report.printed}`,
    `shortlisted: ${t.shortlisted}`,
    '---',
    '',
    `# Research radar — ${week}`,
    '',
    `Swept the last ${report.since_days} days: ${report.candidates_fetched} fetched, ` +
      `${report.already_seen} already seen, ${report.new_count} new, ${report.printed} triaged.`,
    '',
  ];
  for (const verdict of VERDICT_ORDER) {
    const entries = t.surfaced.filter((r) => r.verdict === verdict);
    if (entries.length === 0) continue;
    lines.push(`## ${verdict}`, '');
    for (const r of entries) lines.push(...renderEntry(r));
  }
  if (t.surfaced.length === 0) {
    lines.push('_No papers surfaced this week — everything scored below the relevance floor._', '');
  }
  const dropped = t.tier1.filter((h) => !h.keep).length;
  const ignored = t.shortlisted - t.surfaced.length;
  lines.push(
    `— tier-1 dropped ${dropped}, tier-2 ignored ${ignored}, relevance floor ${t.relevance_floor}.`,
  );
  for (const w of [...report.warnings, ...t.warnings]) lines.push(`⚠ ${w}`);
  lines.push('');
  return lines.join('\n');
}

function renderEntry(r: Tier2Result): string[] {
  return [
    `- **[${r.title}](${r.url})** — score ${r.score.toFixed(2)}, confidence ${r.confidence.toFixed(2)} (\`${r.id}\`)`,
    `  - what: ${r.one_line}`,
    `  - why musterd: ${r.why_musterd}`,
    `  - gut: ${r.gut_check}`,
    '',
  ];
}

export interface EmitResult {
  digestPath: string;
  appended: { arxiv: number; hf: number; exn: number };
}

/** Write the weekly digest into `radarDir` and append every triaged candidate to its seen.json. */
export function emitDigest(report: SweepReport, radarDir: string): EmitResult {
  const md = renderDigest(report);
  mkdirSync(radarDir, { recursive: true });
  const digestPath = join(radarDir, `${isoWeek(report.generated)}.md`);
  if (existsSync(digestPath)) {
    throw new Error(`digest already exists for this week: ${digestPath} — not overwriting`);
  }
  writeFileSync(digestPath, md);

  const seenFile = join(radarDir, 'seen.json');
  const seen = existsSync(seenFile) ? loadSeen(seenFile) : { arxiv: [], hf: [], exn: [] };
  const appended = { arxiv: 0, hf: 0, exn: 0 };
  for (const c of report.new) {
    const ledger = seen[c.source];
    if (ledger.includes(c.id)) continue;
    ledger.push(c.id);
    appended[c.source]++;
  }
  writeFileSync(seenFile, `${JSON.stringify(seen, null, 2)}\n`);
  return { digestPath, appended };
}
