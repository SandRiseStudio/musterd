import {
  type Lifecycle,
  type SeatFile,
  serializeSeat,
  serializeTeam,
  type TeamFile,
} from '@musterd/protocol';
import type { Database } from 'better-sqlite3';
import { listMembers } from '../store/members.js';
import type { MemberRow, TeamRow } from '../store/rows.js';
import { getTeamBySlug } from '../store/teams.js';

/**
 * Serialize the db projection back into durable-file structures (ADR 058). Two consumers: the
 * semantic round-trip guard (guard 1 — prove the projection is a faithful materialized view) and
 * `team export` (migration-bootstrap.md — derive files from a live roster).
 */

export function teamRowToFile(row: TeamRow): TeamFile {
  return {
    slug: row.slug,
    ...(row.display ? { display: row.display } : {}),
    lifecycle: row.default_lifecycle as Lifecycle,
  };
}

/**
 * A member row → seat-file body. Mirrors the canonical emission rule: `lifecycle`/`until` appear only
 * when the member is not `forever`. `until` is rendered as the daemon-canonical ISO form
 * (`toISOString`, always `.000Z`) — the faithful inverse of the epoch the db stores, so the round-trip
 * is stable (a hand-written non-canonical timestamp is a `fmt` concern, not a correctness one).
 */
export function memberRowToSeat(row: MemberRow): SeatFile {
  const seat: SeatFile = { kind: row.kind, role: row.role };
  if (row.lifecycle !== 'forever') {
    seat.lifecycle = row.lifecycle;
    if (row.lifecycle === 'until' && row.lifecycle_until != null) {
      seat.until = new Date(row.lifecycle_until).toISOString();
    }
  }
  return seat;
}

export interface ProjectedTeam {
  team: TeamFile;
  seats: Array<{ name: string; seat: SeatFile }>;
}

/** Project a live team into file structures (no I/O). Returns null if the team is absent. */
export function projectTeamToFiles(db: Database, slug: string): ProjectedTeam | null {
  const t = getTeamBySlug(db, slug);
  if (!t) return null;
  const seats = listMembers(db, t.id).map((m) => ({ name: m.name, seat: memberRowToSeat(m) }));
  return { team: teamRowToFile(t), seats };
}

/** Render a projected team to canonical file text, keyed by relative path under `.musterd/`. */
export function serializeProjectedTeam(p: ProjectedTeam): {
  teamToml: string;
  seatFiles: Record<string, string>;
} {
  const seatFiles: Record<string, string> = {};
  for (const { name, seat } of p.seats) {
    seatFiles[`${name}.toml`] = serializeSeat(seat);
  }
  return { teamToml: serializeTeam(p.team), seatFiles };
}
