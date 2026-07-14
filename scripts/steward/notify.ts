/*
 * Steward seat (ADR 112 §3) — the residency-arm trigger (`pnpm steward:notify [--dry-run]`).
 *
 * The cadence-source swap ADR 112 named and ADR 131 pre-registered: instead of a CI cron LAUNCHING
 * the steward agent (arm A — the GitHub Action's `agent` job), a local scheduled run of THIS script
 * performs the same deterministic drift scan and, per task with findings, sends ONE directed
 * `request_help` act to the `steward` seat. The steward is enrolled in harness residency, so the
 * unanswered act rides the batched wake lane and `musterd host` resurrects the seat on this machine
 * — same charter, different trigger (arm B). GitHub Actions cannot reach the laptop-local daemon,
 * which is exactly why the trigger must live here.
 *
 * Injection bar (ADR 088/131 §6): the act body is composed from STRUCTURED fields only — task ids
 * and counts, never finder detail text (which quotes PR titles and doc prose — teammate-authored
 * content must not become a directed-act body a wake later composes context from). The woken
 * steward re-runs `pnpm steward:scan --json` itself for the full findings.
 *
 * Identity: the send authenticates as whatever seat binds the CWD — the runbook provisions a
 * dedicated `steward-scan` agent seat and runs this from its workspace (honest machine provenance;
 * an unattended `--as nick` would be a lie on the audit trail).
 */
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { reverseDrift, staleProse, unmarkedFeatures, type ScanFinding } from './scan.ts';

export interface DriftAsk {
  to: string;
  body: string;
}

/** Group findings by owning task → one structured ask per task (counts + ids only, no prose). */
export function driftAsks(findings: ScanFinding[], recipient = 'steward'): DriftAsk[] {
  const byTask = new Map<string, ScanFinding[]>();
  for (const f of findings) {
    const g = byTask.get(f.task);
    if (g) g.push(f);
    else byTask.set(f.task, [f]);
  }
  return [...byTask.entries()].map(([task, fs]) => ({
    to: recipient,
    body:
      `steward-scan: task "${task}" has ${fs.length} finding(s) — ` +
      `run \`pnpm steward:scan --json\` in your workspace and work the task per its charter.`,
  }));
}

export type SendFn = (ask: DriftAsk) => void;

/** Send via the musterd CLI — the CWD's binding is the identity (the `steward-scan` seat). */
function cliSend(ask: DriftAsk): void {
  const r = spawnSync('musterd', ['send', '--act', 'request_help', '--to', ask.to, ask.body], {
    encoding: 'utf8',
  });
  if (r.status !== 0) {
    throw new Error(`musterd send failed (${r.status}): ${(r.stderr || r.stdout).trim()}`);
  }
}

export function runNotify(
  findings: ScanFinding[],
  send: SendFn,
  log: (line: string) => void = (l) => process.stdout.write(l + '\n'),
): number {
  const asks = driftAsks(findings);
  if (asks.length === 0) {
    log('✓ steward notify: no record drift — nothing to ask the steward.');
    return 0;
  }
  for (const ask of asks) {
    send(ask);
    log(`→ request_help → ${ask.to}: ${ask.body}`);
  }
  log(
    `${asks.length} ask(s) sent — the batched wake lane wakes the enrolled steward within its cooldown.`,
  );
  return 0;
}

function main(): void {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const sinceIdx = args.indexOf('--since');
  const since = sinceIdx >= 0 ? args[sinceIdx + 1]! : '21 days ago';
  const findings = [...reverseDrift(), ...unmarkedFeatures(since), ...staleProse()];
  const send: SendFn = dryRun
    ? (ask) => process.stdout.write(`[dry-run] would send to ${ask.to}: ${ask.body}\n`)
    : cliSend;
  process.exitCode = runNotify(findings, send);
}

if (import.meta.url === pathToFileURL(process.argv[1]!).href) main();
