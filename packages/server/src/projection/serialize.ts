import {
  type Capabilities,
  effectiveCapabilities,
  type Lifecycle,
  type PartialCapabilities,
  type SeatFile,
  serializeSeat,
  serializeTeam,
  type TeamFile,
} from '@musterd/protocol';
import type { Database } from 'better-sqlite3';
import { listMembers } from '../store/members.js';
import { roleDefaultsMap } from '../store/roles.js';
import { parseWorkingHours, type MemberRow, type TeamRow } from '../store/rows.js';
import { getTeamBySlug } from '../store/teams.js';

/** The capability fields, as the single list both the diff and the verification walk. */
const CAPABILITY_KEYS = [
  'is_admin',
  'can_flag_urgent',
  'can_observe',
  'can_message',
  'visibility_level',
  'tool_allowlist',
  'declared_resource_scopes',
] as const satisfies ReadonlyArray<keyof Capabilities>;

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
    ...(parseWorkingHours(row.working_hours)
      ? { working_hours: parseWorkingHours(row.working_hours)! }
      : {}),
  };
}

/**
 * A member row → seat-file body. Mirrors the canonical emission rule: `lifecycle`/`until` appear only
 * when the member is not `forever`. `until` is rendered as the daemon-canonical ISO form
 * (`toISOString`, always `.000Z`) — the faithful inverse of the epoch the db stores, so the round-trip
 * is stable (a hand-written non-canonical timestamp is a `fmt` concern, not a correctness one).
 */
export function memberRowToSeat(
  row: MemberRow,
  roleDefaults: PartialCapabilities = {},
): { seat: SeatFile; unrepresentable?: string } {
  const seat: SeatFile = { kind: row.kind, role: row.role };
  if (row.slack_user_id) seat.slack_user_id = row.slack_user_id;
  if (row.lifecycle !== 'forever') {
    seat.lifecycle = row.lifecycle;
    if (row.lifecycle === 'until' && row.lifecycle_until != null) {
      seat.until = new Date(row.lifecycle_until).toISOString();
    }
  }
  const workingHours = parseWorkingHours(row.working_hours);
  if (workingHours) seat.working_hours = workingHours;
  const capsResult = seatCapabilities(row, roleDefaults);
  if (capsResult.override) seat.capabilities = capsResult.override;
  return capsResult.unrepresentable
    ? { seat, unrepresentable: capsResult.unrepresentable }
    : { seat };
}

/**
 * The per-seat capability override to write, or the reason none can express this row.
 *
 * Capabilities are stored on the member row but are RECONSTRUCTED by reconcile as
 * `effectiveCapabilities(roleDefaults, seat.capabilities)` — so the only honest thing to write is an
 * override that reproduces the row exactly through that same function. We therefore build the
 * candidate, then **re-run the real clamp and compare**, rather than reasoning field-by-field about
 * what "narrower" means: the clamp is the authority (booleans are `ceiling && override`, ranks only
 * lower, lists intersect), and duplicating that logic here is how the two would drift.
 *
 * When no override reproduces the row, the capability WIDENS beyond the role ceiling and is
 * genuinely inexpressible — a seat override can only narrow. The caller must say so rather than
 * emit files that would quietly change the roster on the next reconcile, which is the whole defect:
 * `team export` wrote kind+role only, so the ADR 071 creator-admin grant (written straight to the
 * row, with no admin role to hold it) vanished the moment its team's roster moved onto git.
 */
function seatCapabilities(
  row: MemberRow,
  roleDefaults: PartialCapabilities,
): { override?: PartialCapabilities; unrepresentable?: string } {
  if (!row.capabilities) return {}; // never governed → role defaults already say everything
  let stored: Capabilities;
  try {
    stored = effectiveCapabilities(JSON.parse(row.capabilities) as PartialCapabilities, {});
  } catch {
    return {}; // unparseable row: reconcile would rebuild from the role anyway
  }
  const ceiling = effectiveCapabilities(roleDefaults, {});
  const override: PartialCapabilities = {};
  for (const key of CAPABILITY_KEYS) {
    if (JSON.stringify(stored[key]) !== JSON.stringify(ceiling[key])) {
      // `as never` narrows the union per key; the value is by construction the field's own type.
      (override as Record<string, unknown>)[key] = stored[key] as never;
    }
  }
  if (Object.keys(override).length === 0) return {}; // identical to the ceiling — write nothing
  const achieved = effectiveCapabilities(roleDefaults, override);
  const lost = CAPABILITY_KEYS.filter(
    (k) => JSON.stringify(achieved[k]) !== JSON.stringify(stored[k]),
  );
  if (lost.length > 0) {
    return {
      unrepresentable:
        `capabilities [${lost.join(', ')}] widen beyond role "${row.role || '(none)'}" and cannot ` +
        `be written to a seat file — a seat override only narrows. Give the seat a role whose ` +
        `defaults grant them, or they will be lost on the next reconcile.`,
    };
  }
  return { override };
}

export interface ProjectedTeam {
  team: TeamFile;
  seats: Array<{ name: string; seat: SeatFile }>;
  /**
   * Seats whose live capabilities no seat file can express (see {@link memberRowToSeat}). Empty on a
   * healthy team. A caller writing these files to disk MUST surface this — every entry is authority
   * that exists in the db now and will not exist after the next reconcile.
   */
  unrepresentable: string[];
}

/** Project a live team into file structures (no I/O). Returns null if the team is absent. */
export function projectTeamToFiles(db: Database, slug: string): ProjectedTeam | null {
  const t = getTeamBySlug(db, slug);
  if (!t) return null;
  const roleDefaults = roleDefaultsMap(db, t.id);
  const unrepresentable: string[] = [];
  const seats = listMembers(db, t.id).map((m) => {
    const projected = memberRowToSeat(m, roleDefaults.get(m.role) ?? {});
    if (projected.unrepresentable) unrepresentable.push(`${m.name}: ${projected.unrepresentable}`);
    return { name: m.name, seat: projected.seat };
  });
  return { team: teamRowToFile(t), seats, unrepresentable };
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
