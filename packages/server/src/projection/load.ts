import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  type SeatFile,
  parseSeatFile,
  parseTeamFile,
  seatNameFromPath,
  type TeamFile,
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

export interface TeamSpec {
  rootDir: string;
  team: TeamFile;
  seats: LoadedSeat[];
  /** Per-seat parse/validation errors (fail-closed): the seat is skipped, never silently dropped. */
  errors: string[];
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
  let files: string[] = [];
  try {
    files = readdirSync(seatsDir).filter((f) => f.toLowerCase().endsWith('.toml'));
  } catch {
    files = []; // no seats/ dir yet — a team with no members is valid
  }
  for (const f of files.sort()) {
    const name = seatNameFromPath(f);
    try {
      const seat = parseSeatFile(readFileSync(join(seatsDir, f), 'utf8'), name);
      seats.push({ name, seat });
    } catch (e) {
      errors.push(`${f}: ${(e as Error).message}`);
    }
  }
  return { rootDir, team, seats, errors };
}
