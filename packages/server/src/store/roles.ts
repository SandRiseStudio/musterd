import { type PartialCapabilities, PartialCapabilitiesSchema } from '@musterd/protocol';
import type { Database } from 'better-sqlite3';

/**
 * The `roles` table (ADR 070, v0.3 P1) — a projection of `roles/<name>.toml`, the durable role
 * defaults a seat's capabilities narrow under. The git file is the source of truth; reconcile keeps
 * this table in sync (upsert present roles, drop absent ones). Stored as a partial-capabilities JSON
 * blob + optional charter.
 */

export interface RoleRow {
  team_id: string;
  name: string;
  capabilities: string; // JSON of PartialCapabilities
  charter: string | null;
  /** One-line summary the roster surfaces (ADR 227). NULL on pre-227 role files. */
  summary: string | null;
  created_at: number;
  updated_at: number;
}

/** Upsert a role's defaults for a team (id/created_at preserved on update). */
export function upsertRole(
  db: Database,
  teamId: string,
  name: string,
  capabilities: PartialCapabilities,
  charter: string | null,
  summary: string | null = null,
): void {
  const now = Date.now();
  db.prepare(
    `INSERT INTO roles (team_id, name, capabilities, charter, summary, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(team_id, name) DO UPDATE SET
       capabilities = excluded.capabilities, charter = excluded.charter, summary = excluded.summary,
       updated_at = excluded.updated_at`,
  ).run(teamId, name, JSON.stringify(capabilities), charter, summary, now, now);
}

/** All role names declared for a team (for reconcile's drop-absent sweep). */
export function listRoleNames(db: Database, teamId: string): string[] {
  return db
    .prepare<[string], { name: string }>('SELECT name FROM roles WHERE team_id = ?')
    .all(teamId)
    .map((r) => r.name);
}

/** Drop the named roles for a team (reconcile removes roles absent from the files). */
export function deleteRoles(db: Database, teamId: string, names: string[]): void {
  if (names.length === 0) return;
  const stmt = db.prepare('DELETE FROM roles WHERE team_id = ? AND name = ?');
  for (const name of names) stmt.run(teamId, name);
}

/** The team's role library for the roster read (ADR 227 discovery): name + one-line summary,
 *  name-ordered so the response is stable. */
export function listRoles(
  db: Database,
  teamId: string,
): Array<{ name: string; summary: string | null }> {
  return db
    .prepare<
      [string],
      { name: string; summary: string | null }
    >('SELECT name, summary FROM roles WHERE team_id = ? ORDER BY name')
    .all(teamId);
}

/** A team's role summaries as a name→summary map (ADR 227 discovery — the roster's one-line face
 *  per role; roles without a summary are absent). */
export function roleSummariesMap(db: Database, teamId: string): Map<string, string> {
  const rows = db
    .prepare<
      [string],
      { name: string; summary: string | null }
    >('SELECT name, summary FROM roles WHERE team_id = ?')
    .all(teamId);
  const map = new Map<string, string>();
  for (const r of rows) if (r.summary) map.set(r.name, r.summary);
  return map;
}

/** A team's role defaults as a name→partial-capabilities map (reconcile uses it to resolve seats). */
export function roleDefaultsMap(db: Database, teamId: string): Map<string, PartialCapabilities> {
  const rows = db.prepare<[string], RoleRow>('SELECT * FROM roles WHERE team_id = ?').all(teamId);
  const map = new Map<string, PartialCapabilities>();
  for (const r of rows) {
    // Defensive parse: a corrupt blob degrades to no-defaults (generalist) rather than throwing.
    map.set(r.name, PartialCapabilitiesSchema.safeParse(JSON.parse(r.capabilities)).data ?? {});
  }
  return map;
}
