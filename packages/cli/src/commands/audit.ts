import { type AuditEntry, type MemberKind } from '@musterd/protocol';
import { flagStr, type Parsed } from '../args.js';
import { CliError } from '../errors.js';
import { clock, theme } from '../render/theme.js';
import { kindLookup, resolve } from './helpers.js';

/**
 * `musterd audit [--limit <n>] [--before <ms-epoch>] [--json]` — read the governance audit log
 * (ADR 071) via the admin-only `GET /teams/:slug/audit`. Pretty-prints entries newest-first;
 * `--limit` (1..500) and `--before` page older entries; `--json` passes the raw array through.
 * `action` is an open string (ADR 074) — unknown verbs render plainly instead of erroring, so P3's
 * new actions don't require a CLI release. Admin-only, so it needs an **explicit** acting identity
 * (ADR 036): an ambient global-config read can't list who-did-what across the team.
 */
export async function auditCommand(parsed: Parsed): Promise<number> {
  const { team, http } = resolve(parsed.flags);

  const limit = parseLimit(flagStr(parsed.flags, 'limit'));
  const before = parseBefore(flagStr(parsed.flags, 'before'));

  const res = await http.audit(team, {
    ...(limit !== undefined ? { limit } : {}),
    ...(before !== undefined ? { before } : {}),
  });

  if (parsed.flags['json']) {
    process.stdout.write(JSON.stringify(res.audit) + '\n');
    return 0;
  }

  // A roster read gives the actor→kind lookup so named actors color by kind (agent vs human), like
  // `inbox`. Best-effort: a failed read falls back to 'agent' (kindLookup's default).
  const roster = await http.roster(team).catch(() => ({ members: [] }));
  const kindOf = kindLookup(roster.members);

  process.stdout.write(
    `${theme.accent('audit')} — ${team} (${res.audit.length} entr${res.audit.length === 1 ? 'y' : 'ies'})\n`,
  );
  if (res.audit.length === 0) {
    process.stdout.write(theme.meta('no governed decisions recorded yet') + '\n');
    return 0;
  }
  for (const e of res.audit) process.stdout.write(renderAuditEntry(e, kindOf) + '\n');

  // Page hint: the oldest entry's ts is the next `--before` cursor.
  const oldest = res.audit[res.audit.length - 1]!;
  process.stdout.write(
    theme.meta(`musterd audit --before ${oldest.ts} to page older entries`) + '\n',
  );
  return 0;
}

/** `--limit` must be an integer in the server's 1..500 window; anything else is a usage error. */
function parseLimit(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1 || n > 500 || !Number.isInteger(n)) {
    throw new CliError('--limit must be an integer in 1..500', 2);
  }
  return n;
}

/** `--before` is a positive ms-epoch integer (the ts of an entry to page beneath). */
function parseBefore(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0 || !Number.isInteger(n)) {
    throw new CliError('--before must be a positive ms-epoch integer', 2);
  }
  return n;
}

function renderAuditEntry(e: AuditEntry, kindOf: (name: string) => MemberKind): string {
  const ts = theme.meta(clock(e.ts));
  const actor =
    e.actor === null ? theme.meta('system') : theme.memberName(e.actor, kindOf(e.actor));
  const action = theme.meta(e.action);
  const result = e.result === 'allow' ? theme.ok('allow') : theme.err('deny');
  const target = e.target === null ? theme.meta('—') : e.target;
  const detail = e.detail ? ' ' + theme.meta(JSON.stringify(e.detail)) : '';
  return `${ts} ${actor} [${action}] ${result} → ${target}${detail}`;
}
