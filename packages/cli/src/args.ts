/** Minimal argv parser (ADR 002: no arg-parsing dependency). Splits flags from positionals. */
export interface Parsed {
  positionals: string[];
  flags: Record<string, string | boolean>;
  /** Repeated --meta k=v collected here. */
  metaPairs: string[];
}

const BOOLEAN_FLAGS = new Set([
  'watch',
  'unread',
  'peek',
  'json',
  'no-color',
  'no-bell',
  'once',
  'follow',
  'insecure-trust-proxy',
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
