import { classify, type ArchaeologyReport, type WasteClass } from '../archaeology/engine.js';
import { DEFAULT_EXCLUDES, extractFacts } from '../archaeology/git.js';
import { flagStr, type Parsed } from '../args.js';
import { CliError } from '../errors.js';
import { theme } from '../render/theme.js';

/**
 * `musterd archaeology --start <sha>` — the cookoff wasted-work reference collector (ADR 123 /
 * ADR 122 §5). Classifies every authored line in the window after the kickoff commit per predicate
 * set v1 (W3 duplicated → W1 abandoned → W2 clobbered → W4 conflict churn) from git alone: no
 * daemon, no musterd state, actor identity from git attribution (ADR 109). This is also the seed
 * of the parked self-diagnosis funnel — it runs on any repo.
 */

const USAGE =
  'usage: musterd archaeology --start <sha> [--delivered <ref>] [--repo <path>] ' +
  '[--exclude <glob>[,<glob>…]] [--json]';

const CLASS_LABEL: Record<WasteClass, string> = {
  W3: 'W3 duplicated',
  W1: 'W1 abandoned',
  W2: 'W2 clobbered',
  W4: 'W4 conflict churn',
};

function render(report: ArchaeologyReport): string {
  const lines: string[] = [];
  const pct = report.wastedPct.toFixed(1);
  lines.push(
    `wasted-work ${theme.warn(`${pct}%`)} — ${report.wastedTotal}/${report.totalAuthoredLines} authored lines (predicate set ${report.predicateSet})`,
  );
  for (const cls of ['W3', 'W1', 'W2', 'W4'] as WasteClass[]) {
    lines.push(`  ${CLASS_LABEL[cls].padEnd(18)} ${String(report.wasted[cls]).padStart(6)}`);
  }
  lines.push('');
  lines.push('by actor:');
  const actors = Object.entries(report.byActor).sort((a, b) => b[1].authored - a[1].authored);
  for (const [actor, a] of actors) {
    const apct = a.authored === 0 ? '0.0' : ((a.wasted / a.authored) * 100).toFixed(1);
    lines.push(
      `  ${theme.memberName(actor, 'agent').padEnd(40)} ${String(a.authored).padStart(6)} authored  ${String(a.wasted).padStart(6)} wasted  (${apct}%)`,
    );
  }
  lines.push('');
  lines.push(
    theme.meta(
      'line-level approximation (ADR 123 honest edges) — read with the acceptance-test guardrail, never alone',
    ),
  );
  return lines.join('\n');
}

export async function archaeologyCommand(
  parsed: Parsed,
  baseDir: string = process.cwd(),
): Promise<number> {
  const start = flagStr(parsed.flags, 'start');
  if (!start) throw new CliError(`--start <sha> (the kickoff commit) is required\n${USAGE}`, 2);
  const repo = flagStr(parsed.flags, 'repo') ?? baseDir;
  const delivered = flagStr(parsed.flags, 'delivered');
  const excludeRaw = flagStr(parsed.flags, 'exclude');
  const exclude = excludeRaw
    ? excludeRaw
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    : DEFAULT_EXCLUDES;

  let report: ArchaeologyReport;
  try {
    report = classify(extractFacts({ repo, start, exclude, ...(delivered ? { delivered } : {}) }));
  } catch (err) {
    throw new CliError(`git archaeology failed: ${(err as Error).message.split('\n')[0]}`, 1);
  }

  const out = parsed.flags['json'] ? JSON.stringify(report, null, 2) : render(report);
  // The full JSON (per-line verdicts) can exceed the pipe buffer; bin.ts process.exit()s on
  // return, so an unawaited write would truncate. Flush before returning.
  await new Promise<void>((resolve) => process.stdout.write(out + '\n', () => resolve()));
  return 0;
}
