import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  type Binding,
  type Lifecycle,
  type MemberKind,
  parseSeatFile,
  type SeatFile,
  serializeSeat,
  serializeTeam,
  type TeamFile,
} from '@musterd/protocol';
import { flagStr, type Parsed } from '../args.js';
import { HttpClient } from '../client.js';
import {
  loadConfig,
  recordRosterHome,
  rememberIdentity,
  saveBinding,
  saveConfig,
} from '../config.js';
import { CliError } from '../errors.js';
import { theme } from '../render/theme.js';
import { hint, success } from '../render/ui.js';
import { writeSeatFile } from '../roster.js';
import { resolve } from './helpers.js';

export async function teamCommand(parsed: Parsed): Promise<number> {
  const sub = parsed.positionals[0];
  if (sub === 'create') return teamCreate(parsed);
  if (sub === 'add') return teamAdd(parsed);
  if (sub === 'observe') return teamObserve(parsed);
  if (sub === 'remove') return teamRemove(parsed);
  if (sub === 'export') return teamExport(parsed);
  throw new CliError('usage: musterd team <create|add|observe|remove|export> ...', 2);
}

async function teamCreate(parsed: Parsed): Promise<number> {
  const slug = parsed.positionals[1];
  if (!slug)
    throw new CliError('usage: musterd team create <slug> [--as <you>] [--role <role>]', 2);
  const config = loadConfig();
  const server = flagStr(parsed.flags, 'server') ?? config.server;
  const name = flagStr(parsed.flags, 'as') ?? defaultUser();
  const role = flagStr(parsed.flags, 'role');
  const display = flagStr(parsed.flags, 'display');
  const http = new HttpClient({ server });
  const res = await http.createTeam(slug, { name, ...(role ? { role } : {}) }, display);

  // v0.3 (ADR 075): the creator is the team's first admin and authenticates with their **human
  // credential** (mscr_) from the composite mint (SPEC A.7); the team **agent key** (mskey_) is what
  // agents claim with, handed out separately. `res.agent_key`/`res.human_credential` are shown once.
  const credential = res.human_credential as string;
  config.server = server;
  config.current = slug;
  config.agentKeys[slug] = res.agent_key as string; // ADR 075: keep the team key for `musterd agent`
  config.identities[slug] = { name, key: credential, surface: 'cli' };
  rememberIdentity(config, { team: slug, name, key: credential, surface: 'cli' }); // ADR 059 vault
  saveConfig(config);
  // Auto-bind the creating folder so it's immediately *active* — you can act here without `--as`,
  // while every other unbound folder stays read-only (ADR 036). The binding carries the folder's
  // claim secret (here the creator's credential) so resolveIdentity yields the admin here.
  const binding: Binding = {
    server,
    team: slug,
    agent_key: credential,
    surface: 'cli',
    claim: { mode: 'seat', name },
  };
  saveBinding(process.cwd(), binding);

  if (parsed.flags['json']) {
    process.stdout.write(JSON.stringify({ team: res.team, member: res.member }) + '\n');
    return 0;
  }
  process.stdout.write(success(`team "${slug}" created`, { next: 'musterd status' }) + '\n');
  process.stdout.write(
    `  on the team as ${theme.memberName(name, 'human')} ${theme.meta(`(human${role ? `, ${role}` : ''})`)}\n`,
  );
  process.stdout.write(theme.meta('bound this folder as your seat — act here with no --as') + '\n');
  process.stdout.write(hint('add members: musterd team add <name> --kind agent') + '\n');
  return 0;
}

async function teamAdd(parsed: Parsed): Promise<number> {
  const name = parsed.positionals[1];
  const kind = flagStr(parsed.flags, 'kind') as MemberKind | undefined;
  if (!name || (kind !== 'agent' && kind !== 'human')) {
    throw new CliError('usage: musterd team add <name> --kind <agent|human> [--role <role>]', 2);
  }
  // Adding a member is an admin act, so it needs an *active* identity (binding/env/--as), not just
  // an ambient global-config default (ADR 036). `resolve()` enforces that.
  const { team, http } = resolve(parsed.flags);

  const role = flagStr(parsed.flags, 'role');
  const lifecycle = flagStr(parsed.flags, 'lifecycle') as Lifecycle | undefined;
  const until = flagStr(parsed.flags, 'until');
  // ADR 058 §5: for a file-backed team the file is the single writer — write `seats/<name>.toml`
  // first, then `addMember` becomes project-and-return (the daemon reconciles the file, mints, hands
  // back the token). A db-only team has no roster home, so this is skipped and the daemon originates.
  const home = loadConfig().rosterHome[team];
  if (home) {
    writeSeatFile(home, name, { kind, role, lifecycle, until });
  }
  const res = await http.addMember(team, {
    name,
    kind,
    role,
    ...(lifecycle ? { lifecycle } : {}),
    ...(until ? { lifecycle_until: Date.parse(until) } : {}),
  });

  if (parsed.flags['json']) {
    // v0.3 (ADR 069): a human gets an mscr_ credential (shown once); an agent is credential-less and
    // claims with the team agent key. The vestigial `token` is no longer an authenticator.
    process.stdout.write(
      JSON.stringify({
        member: res.member,
        ...(res.human_credential ? { human_credential: res.human_credential } : {}),
      }) + '\n',
    );
    return 0;
  }
  process.stdout.write(
    success(
      `added ${theme.memberName(name, kind)} ${theme.meta(`(${kind}${role ? `, ${role}` : ''})`)} to ${team}`,
    ) + '\n',
  );
  if (kind === 'agent') {
    // Agents authenticate with the team agent key (mskey_) + a seat claim (ADR 069/075) — not a per-seat
    // token. The simplest hand-off is `musterd agent` in the agent's folder (isolated worktree + MCP).
    const agentKey = loadConfig().agentKeys[team] ?? 'mskey_…';
    process.stdout.write(theme.meta('connect this agent via MCP with the team agent key:') + '\n');
    process.stdout.write(
      theme.meta(
        `  MUSTERD_TEAM=${team} MUSTERD_AGENT_KEY=${agentKey} MUSTERD_CLAIM=seat:${name} MUSTERD_SURFACE=claude-code`,
      ) + '\n',
    );
    process.stdout.write(
      theme.meta('— or skip the wiring: ') +
        theme.accent(`musterd agent ${name} --team ${team}`) +
        theme.meta(` builds an isolated worktree + MCP for it (safe to run now).`) +
        '\n',
    );
  } else {
    // Humans authenticate with their own credential (mscr_), shown once here.
    process.stdout.write(
      theme.meta(`they authenticate with their credential (shown once — store it now):`) + '\n',
    );
    process.stdout.write(
      theme.meta(`  musterd join ${team} --as ${name} --key ${res.human_credential}`) + '\n',
    );
  }
  return 0;
}

/**
 * Provision a read-only observer seat (ADR 063): a seat that watches the whole-team firehose from the
 * dashboard but is hidden from the roster/counts/presence and cannot send. Resolved like `team export`
 * (server + slug from flags/config, no active identity needed) since the dashboard provisions it
 * out-of-band; observers are db-only even on a file-backed team, so no seat file is written.
 */
async function teamObserve(parsed: Parsed): Promise<number> {
  const name = parsed.positionals[1];
  if (!name) throw new CliError('usage: musterd team observe <name> [--team <slug>]', 2);
  const config = loadConfig();
  const server = flagStr(parsed.flags, 'server') ?? config.server;
  const team = flagStr(parsed.flags, 'team') ?? config.current;
  if (!team) throw new CliError('no team — pass --team <slug> or set a current team', 2);
  const http = new HttpClient({ server });
  const res = await http.addMember(team, { name, kind: 'human', observer: true });

  if (parsed.flags['json']) {
    process.stdout.write(JSON.stringify({ member: res.member, token: res.token }) + '\n');
    return 0;
  }
  process.stdout.write(
    success(
      `observer "${name}" ready for ${team} ${theme.meta('— read-only, hidden from the roster')}`,
    ) + '\n',
  );
  process.stdout.write(
    hint(`open /live and connect:  team ${team}   as ${name}   token ${res.token}`) + '\n',
  );
  return 0;
}

/**
 * Soft-remove a member from a team's roster (ADR 019). The sanctioned way to clear a mistaken or
 * stale member instead of editing the daemon's DB: it sets `left_at`, so the member drops off every
 * roster/auth path while its message history + provenance survive. Idempotent — an already-removed
 * (or never-existing) member is a clean `not_found`, not an error stack.
 */
async function teamRemove(parsed: Parsed): Promise<number> {
  const name = parsed.positionals[1];
  if (!name) throw new CliError('usage: musterd team remove <name>', 2);
  const { team, http } = resolve(parsed.flags);
  const res = await http.removeMember(team, name);
  if (parsed.flags['json']) {
    process.stdout.write(JSON.stringify(res) + '\n');
    return 0;
  }
  process.stdout.write(
    success(`removed ${theme.memberName(res.member, res.kind)} from ${team}`) + '\n',
  );
  process.stdout.write(theme.meta('off the roster; message history is kept') + '\n');
  return 0;
}

/** The roster fields `team export` needs from a live member (a subset of MemberSummary). */
export interface RosterMember {
  name: string;
  kind: MemberKind;
  role: string;
  lifecycle: Lifecycle;
  lifecycle_until?: number | null;
}

/**
 * Project a live roster into canonical durable files (ADR 058 / migration-bootstrap.md), keyed by
 * path. Pure + token-free — no secret ever reaches a file. Runs the format-layer parity self-check
 * (serialize → parse reproduces each seat's identity) so a serializer bug aborts the export instead
 * of silently writing files that don't reproduce the roster.
 */
export function rosterToFiles(
  slug: string,
  members: RosterMember[],
): { teamToml: string; seatFiles: Record<string, string> } {
  const team: TeamFile = { slug, lifecycle: 'forever' };
  const seatFiles: Record<string, string> = {};
  for (const m of members) {
    const seat: SeatFile = { kind: m.kind, role: m.role ?? '' };
    if (m.lifecycle && m.lifecycle !== 'forever') {
      seat.lifecycle = m.lifecycle;
      if (m.lifecycle === 'until' && m.lifecycle_until) {
        seat.until = new Date(m.lifecycle_until).toISOString();
      }
    }
    const text = serializeSeat(seat);
    const back = parseSeatFile(text, m.name);
    if (
      back.kind !== seat.kind ||
      (back.role ?? '') !== (seat.role ?? '') ||
      back.lifecycle !== seat.lifecycle ||
      back.until !== seat.until
    ) {
      throw new CliError(
        `parity check failed for seat "${m.name}" — the roster files would not reproduce the live roster`,
        1,
      );
    }
    seatFiles[`${m.name}.toml`] = text;
  }
  return { teamToml: serializeTeam(team), seatFiles };
}

/**
 * One-time db→file inversion (migration-bootstrap.md): read the live roster, write the canonical
 * `.musterd/` files in this folder, and register it as the team's roster home (the cutover signal).
 * Refuses if `team.toml` already exists (idempotency without clobber). No token touches a file; the
 * very next reconcile is a no-op UPDATE that preserves every live token (D ≡ C by construction).
 */
async function teamExport(parsed: Parsed): Promise<number> {
  const slug = parsed.positionals[1];
  if (!slug) throw new CliError('usage: musterd team export <slug>', 2);
  const dir = process.cwd();
  const musterdDir = join(dir, '.musterd');
  const teamFile = join(musterdDir, 'team.toml');
  if (existsSync(teamFile)) {
    throw new CliError(
      `"${slug}" already looks file-backed — ${teamFile} exists (refusing to clobber hand-edits)`,
      1,
    );
  }
  const config = loadConfig();
  const server = flagStr(parsed.flags, 'server') ?? config.server;
  const http = new HttpClient({ server });
  const { members } = await http.roster(slug);
  const { teamToml, seatFiles } = rosterToFiles(
    slug,
    members.map((m) => ({
      name: m.name,
      kind: m.kind,
      role: m.role,
      lifecycle: m.lifecycle,
      lifecycle_until: m.lifecycle_until ?? null,
    })),
  );

  mkdirSync(join(musterdDir, 'seats'), { recursive: true });
  writeFileSync(teamFile, teamToml);
  for (const [fname, body] of Object.entries(seatFiles)) {
    writeFileSync(join(musterdDir, 'seats', fname), body);
  }
  recordRosterHome(config, slug, dir);
  saveConfig(config);

  const count = Object.keys(seatFiles).length;
  if (parsed.flags['json']) {
    process.stdout.write(
      JSON.stringify({ slug, rosterHome: dir, seats: Object.keys(seatFiles) }) + '\n',
    );
    return 0;
  }
  process.stdout.write(
    success(`exported "${slug}" roster → .musterd/ (${count} seat${count === 1 ? '' : 's'})`, {
      next: 'musterd reload',
    }) + '\n',
  );
  process.stdout.write(
    theme.meta(
      'these files are now the source of truth — git add + commit them for a reviewable roster.',
    ) + '\n',
  );
  process.stdout.write(
    theme.meta(
      'provisioning (team add/claim) is file-backed immediately; `musterd reload` makes the daemon track edits.',
    ) + '\n',
  );
  return 0;
}

function defaultUser(): string {
  return process.env['USER'] ?? process.env['USERNAME'] ?? 'me';
}
