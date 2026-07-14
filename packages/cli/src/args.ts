import { CliError } from './errors.js';

/** Minimal argv parser (ADR 002: no arg-parsing dependency). Splits flags from positionals. */
export interface Parsed {
  positionals: string[];
  flags: Record<string, string | boolean>;
  /** Repeated --meta k=v collected here. */
  metaPairs: string[];
}

const BOOLEAN_FLAGS = new Set([
  'watch',
  'wait',
  'interrupt-check',
  'unread',
  'peek',
  'json',
  'no-color',
  'no-bell',
  'once',
  'quiet',
  'urgent',
  'follow',
  'force',
  'insecure-trust-proxy',
  'pending',
  'approve',
  'deny',
  'standing',
  'autojoin',
  'live',
  'purge',
  'stdin',
  'reset-policy',
  'wake',
]);

export function parseArgs(argv: string[]): Parsed {
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};
  const metaPairs: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg.startsWith('--')) {
      const name = arg.slice(2);
      if (BOOLEAN_FLAGS.has(name)) {
        flags[name] = true;
        continue;
      }
      const next = argv[i + 1];
      const value = next !== undefined && !next.startsWith('--') ? (i++, next) : true;
      if (name === 'meta' && typeof value === 'string') {
        metaPairs.push(value);
      } else {
        flags[name] = value;
      }
    } else {
      positionals.push(arg);
    }
  }
  return { positionals, flags, metaPairs };
}

export function flagStr(flags: Record<string, string | boolean>, name: string): string | undefined {
  const v = flags[name];
  return typeof v === 'string' ? v : undefined;
}

/**
 * Parse a human duration flag (`45s`, `15m`, `2h`) to milliseconds. The unit suffix is REQUIRED —
 * minute-scale knobs (wake cooldowns) sit next to second-scale ones (watchdog timeouts), so a bare
 * number is ambiguous; refuse it and show the shape. (`musterd host --timeout` predates this and
 * keeps its bare-seconds contract.)
 */
export function parseDurationMs(raw: string, flag: string): number {
  const m = /^(\d+(?:\.\d+)?)(s|m|h)$/.exec(raw.trim());
  if (!m) {
    throw new CliError(`${flag} wants a duration like 45s, 15m, or 2h (got "${raw}")`, 2);
  }
  const mult = m[2] === 's' ? 1_000 : m[2] === 'm' ? 60_000 : 3_600_000;
  return Math.round(Number(m[1]) * mult);
}

/** Render milliseconds as the shortest exact unit (`1800000` → `30m`) — the render twin of
 *  {@link parseDurationMs} for policy summaries. */
export function fmtDurationMs(ms: number): string {
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000}h`;
  if (ms % 60_000 === 0) return `${ms / 60_000}m`;
  if (ms % 1_000 === 0) return `${ms / 1_000}s`;
  return `${ms}ms`;
}

/** Parse `--meta k=v` pairs into an object, coercing numbers/booleans. */
export function parseMeta(pairs: string[]): Record<string, unknown> | undefined {
  if (pairs.length === 0) return undefined;
  const out: Record<string, unknown> = {};
  for (const p of pairs) {
    const eq = p.indexOf('=');
    if (eq === -1) continue;
    const key = p.slice(0, eq);
    const raw = p.slice(eq + 1);
    out[key] = coerce(raw);
  }
  return out;
}

function coerce(raw: string): unknown {
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (raw !== '' && !Number.isNaN(Number(raw))) return Number(raw);
  return raw;
}
