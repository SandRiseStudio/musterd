import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  parseRoleFile,
  parseSeatFile,
  parseTeamFile,
  type RoleFile,
  type SeatFile,
  seatNameFromPath,
  serializeRole,
  serializeSeat,
  serializeTeam,
  type TeamFile,
  unknownRosterKeys,
} from '@musterd/protocol';

/**
 * Load a workspace's durable roster (`.musterd/team.toml` + `seats/*.toml`) into a spec the
 * reconciler projects (ADR 058 / projection-reconcile.md). The files are the source of truth; this
 * is the read side.
 */

const MUSTERD_DIR = '.musterd';

export interface LoadedSeat {
  /** The seat name — the filename stem, the one source of truth for identity. */
  name: string;
  seat: SeatFile;
}

export interface LoadedRole {
  /** The role name — the filename stem (like seats). */
  name: string;
  role: RoleFile;
}

export interface TeamSpec {
  rootDir: string;
  team: TeamFile;
  seats: LoadedSeat[];
  /** Role defaults (ADR 070), read from `roles/*.toml`; empty when the team has no roles dir. */
  roles: LoadedRole[];
  /** Per-seat/role parse/validation errors (fail-closed): the entry is skipped, never silently dropped. */
  errors: string[];
  /**
   * Keys a roster file carried that no schema knows — dropped on parse, so the entry projects
   * WITHOUT them. Warnings, never errors, by nick's call (2026-08-21): failing would refuse
   * `autorefresh`'s seat on the live roster today over a `charter` line that has been silently
   * ignored since 2026-08-05.
   *
   * This closes a hole in the promise one field up. "Never silently dropped" was true of ENTRIES
   * and false of FIELDS: a seat with an unknown key parsed clean, projected clean, and lost the key
   * with nothing said. The entry survived; part of it did not.
   */
  warnings: string[];
  /**
   * Roster files whose bytes are not what the serializer would write — ADR 058 guard 2, read here
   * because nothing else reads it anywhere. `musterd fmt --check` has been correct and unrun since
   * the guard was written: two role files on the live roster drifted from 2026-08-04 until a human
   * checked by hand on 2026-08-24, twenty days later. CI cannot cover it (the roster is not in the
   * repo), so the reader is the one process that already opens every roster file on every pass.
   *
   * Deliberately NOT folded into `warnings`: a dropped key loses data, drift is only untidy, and
   * ADR 304's lesson is that a reader must be able to tell them apart. A drifted file still
   * projects — fail-closed here would refuse a seat over a blank line.
   */
  drift: string[];
}

/**
 * Read a roster home. Returns null when the folder has no `team.toml` (it is not a roster home).
 *
 * Fail-closed per seat (seat-file-format.md): a malformed `seats/<name>.toml` lands in `errors` and
 * is skipped — never thrown, so one fat-fingered seat can't take down its siblings. An invalid
 * `team.toml` *does* throw (the team identity itself is in doubt) so the caller can keep the whole
 * prior projection rather than half-apply.
 */
export function loadTeamSpec(rootDir: string): TeamSpec | null {
  const dir = join(rootDir, MUSTERD_DIR);
  const teamPath = join(dir, 'team.toml');
  if (!existsSync(teamPath)) return null;
  const team = parseTeamFile(readFileSync(teamPath, 'utf8'));

  const seatsDir = join(dir, 'seats');
  const seats: LoadedSeat[] = [];
  const errors: string[] = [];
  const warnings: string[] = [];
  const drift: string[] = [];
  /**
   * One string compare per file against the canonical form the serializer would emit. Parsing is
   * whitespace-tolerant by design (guard 1), so this is the only place the byte form is ever
   * judged — and the reason it can be judged cheaply is that the parse already happened.
   */
  const noteDrift = (rel: string, canonical: string, text: string): void => {
    if (canonical !== text) drift.push(rel);
  };
  const noteDropped = (rel: string, kind: 'team' | 'seat' | 'role', text: string): void => {
    const keys = unknownRosterKeys(kind, text);
    if (keys.length > 0) {
      warnings.push(
        `${rel}: dropped unknown key(s) ${keys.join(', ')} — not in the schema, so reconcile ignores them`,
      );
    }
  };
  const teamText = readFileSync(teamPath, 'utf8');
  noteDropped('team.toml', 'team', teamText);
  noteDrift('team.toml', serializeTeam(team), teamText);
  let files: string[] = [];
  try {
    files = readdirSync(seatsDir).filter((f) => f.toLowerCase().endsWith('.toml'));
  } catch {
    files = []; // no seats/ dir yet — a team with no members is valid
  }
  for (const f of files.sort()) {
    const name = seatNameFromPath(f);
    try {
      const text = readFileSync(join(seatsDir, f), 'utf8');
      const seat = parseSeatFile(text, name);
      // Only after a successful parse: an unparseable file's "unknown keys" are noise on top of the
      // error that already explains it.
      noteDropped(`seats/${f}`, 'seat', text);
      noteDrift(`seats/${f}`, serializeSeat(seat), text);
      seats.push({ name, seat });
    } catch (e) {
      errors.push(`${f}: ${(e as Error).message}`);
    }
  }

  // Role defaults (ADR 070) — `roles/<name>.toml`. Optional dir; fail-closed per role like seats.
  const rolesDir = join(dir, 'roles');
  const roles: LoadedRole[] = [];
  let roleFiles: string[] = [];
  try {
    roleFiles = readdirSync(rolesDir).filter((f) => f.toLowerCase().endsWith('.toml'));
  } catch {
    roleFiles = []; // no roles/ dir — a team may define no roles (all seats are generalist)
  }
  for (const f of roleFiles.sort()) {
    const name = seatNameFromPath(f); // same stem rule as seats
    try {
      const text = readFileSync(join(rolesDir, f), 'utf8');
      const role = parseRoleFile(text);
      noteDropped(`roles/${f}`, 'role', text);
      noteDrift(`roles/${f}`, serializeRole(role), text);
      roles.push({ name, role });
    } catch (e) {
      errors.push(`roles/${f}: ${(e as Error).message}`);
    }
  }

  return { rootDir, team, seats, roles, errors, warnings, drift };
}
