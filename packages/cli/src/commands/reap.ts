import type { Parsed } from '../args.js';
import { resolveRead } from './helpers.js';

/**
 * `musterd reap [--yes]` (ADR 242) — reclaim orphaned MCP sidecar processes.
 *
 * The CLI never kills anything itself: it reads the daemon's latest footprint tick, shows what the
 * sampler classified `orphaned`, and — only with `--yes` — asks the daemon to reap those pids. The
 * daemon re-verifies every pid against the live process table at kill time (allowlist match + still
 * orphaned) and refuses the rest with named reasons, so a stale sample can never kill a recycled
 * pid. No interactive prompt: list first, `--yes` to apply, matching the CLI's non-interactive
 * convention.
 */

interface FootprintStackLike {
  classification: string;
  procs: number;
  rss_kb: number;
  pids: string;
}
export interface FootprintTickLike {
  ts: number;
  stacks: FootprintStackLike[];
  machine: {
    swap_used_mb: number | null;
    swap_total_mb: number | null;
    free_mem_mb: number | null;
  };
}
export interface ReapResultLike {
  killed: number[];
  refused: { pid: number; reason: string }[];
}

/** Pids of every orphaned stack in the tick; a malformed pids blob is skipped, never thrown on. */
export function orphanPids(tick: FootprintTickLike): number[] {
  const pids: number[] = [];
  for (const s of tick.stacks) {
    if (s.classification !== 'orphaned') continue;
    try {
      const parsed = JSON.parse(s.pids) as unknown;
      if (Array.isArray(parsed))
        pids.push(...parsed.filter((p): p is number => Number.isInteger(p)));
    } catch {
      /* a malformed blob loses its pids, not the command */
    }
  }
  return pids;
}

export function renderReapPlan(tick: FootprintTickLike): string {
  const orphaned = tick.stacks.filter((s) => s.classification === 'orphaned');
  const procs = orphaned.reduce((sum, s) => sum + s.procs, 0);
  if (procs === 0) return 'no orphaned MCP sidecars — nothing to reap.';
  const mb = Math.round(orphaned.reduce((sum, s) => sum + s.rss_kb, 0) / 1024);
  return (
    `${procs} orphaned MCP sidecar proc${procs === 1 ? '' : 's'} (~${mb} MB RSS) from ended sessions.\n` +
    `run again with --yes to reap them (the daemon re-verifies each pid before any kill).`
  );
}

export function renderReapResult(result: ReapResultLike): string {
  const lines = [`killed ${result.killed.length} proc${result.killed.length === 1 ? '' : 's'}`];
  if (result.refused.length > 0) {
    lines.push(
      `refused ${result.refused.length}: ` +
        result.refused.map((r) => `${r.pid} (${r.reason})`).join(', '),
    );
  }
  return lines.join('\n');
}

export async function reapCommand(parsed: Parsed): Promise<number> {
  const { http, team } = resolveRead(parsed.flags);
  const tick = await http.footprint(team);
  if (!tick) {
    process.stdout.write(
      'the daemon has no footprint data yet (older daemon, or its sampler just started).\n',
    );
    return 0;
  }
  if (parsed.flags['yes'] !== true) {
    process.stdout.write(renderReapPlan(tick) + '\n');
    return 0;
  }
  const pids = orphanPids(tick);
  if (pids.length === 0) {
    process.stdout.write('no orphaned MCP sidecars — nothing to reap.\n');
    return 0;
  }
  const result = await http.reapFootprint(team, pids);
  process.stdout.write(renderReapResult(result) + '\n');
  return 0;
}
