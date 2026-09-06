/**
 * Per-model answered-ask latency, read from the live corpus rather than staged.
 *
 * WHY THIS EXISTS, and what it is NOT. `docs/research/frontier-cadence-manifest.md` is a CONTROLLED
 * experiment: a fresh team from a pinned topology, two agent seats plus a human, one varied term
 * (`model`), scored against the prior model's run. It has never run (0 findings cite it, 2026-09-05).
 * This script does not run it and cannot substitute for it — every term the manifest pins is free
 * here. It answers a smaller question the corpus can already answer: **when a directed ask was
 * answered, how long did the answering seat take, grouped by the model that seat attested?**
 *
 * The manifest's leaderboard is blocked on N. This is not that N. It is the observational floor
 * under it, and its confounds are large enough that it must never be quoted as a model ranking:
 *
 *   1. SEATS ARE NOT EXCHANGEABLE. Each model sits in different seats doing different work —
 *      2026-09-05: grok-4.6 is one seat, claude-opus-5 is twelve. Seat, role and task all vary
 *      with model, so any difference is confounded with the job.
 *   2. THE CLOCK IS WALL-CLOCK ON A TEAM THAT EXISTS ~5h A DAY (lane 01KZ9B4BXH). An ask raised at
 *      midnight and answered at 09:00 scores 9 hours of nobody being there. Models whose seats
 *      happen to run in working hours look faster for a reason that is not the model.
 *   3. THE STAMP MIXES OBSERVATION AND DECLARATION (docs/wiki/model-attestation.md). A per-model
 *      aggregate over this corpus needs the tier, which the act log does not carry — so a row here
 *      is "what the seat said it was", not a verified id.
 *   4. ANSWERED ASKS ONLY. An ask nobody ever answered contributes nothing, so this is conditional
 *      on being answered — the same survivorship the acceptance eval had to bracket (ADR 277).
 *
 * MEDIAN, NOT MEAN. The spread is dominated by overnight gaps: the mean for claude-opus-5 is ~7h
 * against a max of 6.8 days. A mean over that is a statement about sleep.
 *
 * READ-ONLY over `~/.musterd/musterd.db`. Touches no lane, no seat, no daemon.
 *
 *   node --disable-warning=ExperimentalWarning scripts/research/frontier-cadence-observational.ts [--json]
 */
// `node:sqlite`, not better-sqlite3: that dependency lives in packages/server, and a research
// script must not drag a package dependency into scripts/ to read a file it only ever reads.
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export interface Pair {
  model: string;
  seconds: number;
  answerer: string;
}

export interface ModelRow {
  model: string;
  n: number;
  seats: number;
  medianSeconds: number;
  p90Seconds: number;
  /** Median over answers that landed within 4h — the crude working-hours filter (confound 2). */
  medianWithin4h: number | null;
  nWithin4h: number;
}

/** Median of a numeric list; the caller guarantees non-empty. */
export function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

export function quantile(xs: number[], q: number): number {
  const s = [...xs].sort((a, b) => a - b);
  const i = Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1));
  return s[i]!;
}

const WITHIN = 4 * 3600;

export function summarise(pairs: Pair[], minN = 3): ModelRow[] {
  const by = new Map<string, Pair[]>();
  for (const p of pairs) {
    // `default` is not a model — it is an unattested occupancy's placeholder, and averaging it
    // would invent a family. Dropped loudly here rather than silently in a WHERE clause.
    if (p.model === 'default' || p.model === 'unknown') continue;
    (by.get(p.model) ?? by.set(p.model, []).get(p.model)!).push(p);
  }
  const rows: ModelRow[] = [];
  for (const [model, ps] of by) {
    if (ps.length < minN) continue;
    const secs = ps.map((p) => p.seconds);
    const fast = secs.filter((s) => s <= WITHIN);
    rows.push({
      model,
      n: ps.length,
      seats: new Set(ps.map((p) => p.answerer)).size,
      medianSeconds: Math.round(median(secs)),
      p90Seconds: Math.round(quantile(secs, 0.9)),
      medianWithin4h: fast.length ? Math.round(median(fast)) : null,
      nWithin4h: fast.length,
    });
  }
  return rows.sort((a, b) => b.n - a.n);
}

export function load(dbPath = join(homedir(), '.musterd', 'musterd.db')): Pair[] {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return db
      .prepare(
        `SELECT json_extract(ans.meta,'$.model') AS model,
                (ans.ts - ask.ts) / 1000.0        AS seconds,
                ans.from_member                   AS answerer
           FROM messages ans
           JOIN messages ask ON ask.id = json_extract(ans.meta,'$.in_reply_to')
          WHERE ans.act IN ('accept','decline')
            AND ask.act = 'ask'
            AND ans.ts >= ask.ts
            AND json_extract(ans.meta,'$.model') IS NOT NULL`,
      )
      .all() as unknown as Pair[];
  } finally {
    db.close();
  }
}

function fmt(s: number): string {
  if (s < 90) return `${Math.round(s)}s`;
  if (s < 5400) return `${(s / 60).toFixed(1)}m`;
  return `${(s / 3600).toFixed(1)}h`;
}

function main(): void {
  const rows = summarise(load());
  if (process.argv.includes('--json')) {
    process.stdout.write(JSON.stringify({ rows, generated_at: Date.now() }, null, 2) + '\n');
    return;
  }
  const total = rows.reduce((n, r) => n + r.n, 0);
  process.stdout.write(
    `answered-ask latency by the ANSWERER's attested model — ${total} pairs, ${rows.length} models\n` +
      `NOT a model ranking: seats, roles and tasks vary with model, and the clock is wall-clock.\n\n` +
      `model                            n  seats   median     p90   median<4h  n<4h\n`,
  );
  for (const r of rows) {
    process.stdout.write(
      `${r.model.padEnd(32)}${String(r.n).padStart(3)}${String(r.seats).padStart(7)}` +
        `${fmt(r.medianSeconds).padStart(9)}${fmt(r.p90Seconds).padStart(8)}` +
        `${(r.medianWithin4h === null ? '—' : fmt(r.medianWithin4h)).padStart(12)}` +
        `${String(r.nWithin4h).padStart(6)}\n`,
    );
  }
  process.stdout.write(
    `\nthe <4h columns drop answers that spanned a night — the same row, with the biggest confound crudely removed.\n`,
  );
}

if (process.argv[1]?.endsWith('frontier-cadence-observational.ts')) main();
