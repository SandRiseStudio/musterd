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
  'enforce-clear',
  'no-title',
  'refresh-guidance',
  'refresh-hooks',
  'prune-bindings',
  'apply',
  'history',
  'orient',
  'interrupt',
  'detach',
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

/**
 * `--hue <0-359>` (ADR 374): an integer degree on the wheel, or undefined when the flag is absent.
 * Refused here, before any file or request is touched — a bad hue is a typo, not a state.
 */
export function flagHue(flags: Record<string, string | boolean>): number | undefined {
  const raw = flagStr(flags, 'hue');
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > 359)
    throw new CliError(`--hue must be an integer from 0 to 359 (an HSL degree), got "${raw}"`, 2);
  return n;
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

/** Render a byte count in the largest unit that still says something — the render twin of the
 *  byte-valued policy knobs. Sub-MiB values stay in KiB: the resume hygiene bound is 256 KiB since
 *  the 2026-07-29 recalibration, and MiB-only formatting rendered it as "0MiB". */
export function fmtBytes(bytes: number): string {
  const [value, unit] = bytes < 1_048_576 ? [bytes / 1024, 'KiB'] : [bytes / 1_048_576, 'MiB'];
  return `${Number(value.toFixed(1))} ${unit}`;
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
