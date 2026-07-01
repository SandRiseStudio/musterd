import { type Request } from '@musterd/protocol';
import { flagStr, type Parsed } from '../args.js';
import { CliError } from '../errors.js';
import { clock, theme } from '../render/theme.js';
import { resolve } from './helpers.js';

/**
 * `musterd requests` / `musterd requests decide <id> --approve|--deny` — the admin surface for the
 * P3.2 request/approval lane (ADR 077). `GET /teams/:slug/requests` and `POST
 * .../requests/:id/decide` already exist server-side (grants + presence attach on approve); this is
 * just the CLI window onto them, admin-only via the server's own 403 (same pattern as `audit`, no
 * client-side admin check needed).
 */
export async function requestsCommand(parsed: Parsed): Promise<number> {
  if (parsed.positionals[0] === 'decide') {
    return decideCommand(parsed);
  }
  return listCommand(parsed);
}

async function listCommand(parsed: Parsed): Promise<number> {
  const { team, http } = resolve(parsed.flags);
  const res = await http.requests(team, { pendingOnly: parsed.flags['pending'] === true });

  if (parsed.flags['json']) {
    process.stdout.write(JSON.stringify(res.requests) + '\n');
    return 0;
  }

  process.stdout.write(
    `${theme.accent('requests')} — ${team} (${res.requests.length} entr${res.requests.length === 1 ? 'y' : 'ies'})\n`,
  );
  if (res.requests.length === 0) {
    process.stdout.write(theme.meta('no requests waiting') + '\n');
    return 0;
  }
  for (const r of res.requests) process.stdout.write(renderRequest(r) + '\n');
  return 0;
}

async function decideCommand(parsed: Parsed): Promise<number> {
  const id = parsed.positionals[1];
  if (!id) throw new CliError('usage: musterd requests decide <id> --approve | --deny', 2);

  const approve = parsed.flags['approve'] === true;
  const deny = parsed.flags['deny'] === true;
  if (approve === deny) {
    throw new CliError('pass exactly one of --approve or --deny', 2);
  }

  const { team, http } = resolve(parsed.flags);

  if (deny) {
    const res = await http.decideRequest(team, id, { decision: 'deny' });
    if (parsed.flags['json']) {
      process.stdout.write(JSON.stringify(res) + '\n');
      return 0;
    }
    process.stdout.write(`${theme.ok('✓')} denied request ${theme.meta(res.request_id)}\n`);
    return 0;
  }

  const ttlHours = parseTtlHours(flagStr(parsed.flags, 'ttl-hours'));
  const once = parsed.flags['once'] === true;
  const standing = parsed.flags['standing'] === true;
  // The three grant lifetimes (GrantLifetimeSchema) are mutually exclusive — reject any two at once.
  if ([once, standing, ttlHours !== undefined].filter(Boolean).length > 1) {
    throw new CliError('pass only one of --once, --standing, or --ttl-hours <n>', 2);
  }
  // Default to `once` — the least-privilege choice (let this one session in). `--standing` mints a
  // grant that survives until revoked, so the seat re-occupies on relaunch without re-approval;
  // `--ttl-hours` bounds it to a window.
  const lifetime = ttlHours !== undefined ? 'ttl' : standing ? 'standing' : 'once';

  const res = await http.decideRequest(team, id, {
    decision: 'approve',
    lifetime,
    ...(ttlHours !== undefined ? { ttl_hours: ttlHours } : {}),
  });

  if (parsed.flags['json']) {
    process.stdout.write(JSON.stringify(res) + '\n');
    return 0;
  }
  process.stdout.write(`${theme.ok('✓')} approved request ${theme.meta(res.request_id)}\n`);
  if (res.delivered) {
    process.stdout.write(
      theme.meta('the waiting session picked up the decision and is live now.') + '\n',
    );
  } else {
    process.stdout.write(
      theme.meta(
        "the requesting session already disconnected — it should re-run `musterd claim <name>` now.",
      ) + '\n',
    );
  }
  return 0;
}

/** `--ttl-hours` must be a positive number when present. */
function parseTtlHours(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw new CliError('--ttl-hours must be a positive number', 2);
  }
  return n;
}

function renderRequest(r: Request): string {
  const ts = theme.meta(clock(r.ts));
  const status =
    r.status === 'pending'
      ? theme.warn('pending')
      : r.status === 'approved'
        ? theme.ok('approved')
        : r.status === 'denied'
          ? theme.err('denied')
          : theme.meta('expired');
  const target = r.target ?? '—';
  return `${ts} ${theme.meta(r.id)} [${r.kind}] ${target} via ${r.surface} — ${status}`;
}
