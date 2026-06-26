import type { Database } from 'better-sqlite3';
import { ulid } from 'ulid';
import { MusterdError } from '../errors.js';
import type { TeamRow } from './rows.js';

const SLUG_RE = /^[a-z0-9-]{1,32}$/;

export function createTeam(
  db: Database,
  input: { slug: string; display?: string | null; defaultLifecycle?: string },
): TeamRow {
  if (!SLUG_RE.test(input.slug)) {
    throw new MusterdError(
      'bad_request',
      `invalid team slug "${input.slug}" (use [a-z0-9-], 1..32)`,
    );
  }
  if (getTeamBySlug(db, input.slug)) {
    throw new MusterdError('conflict', `team "${input.slug}" already exists`);
  }
  const now = Date.now();
  const row: TeamRow = {
    id: ulid(),
    slug: input.slug,
    display: input.display ?? null,
    default_lifecycle: input.defaultLifecycle ?? 'forever',
    archived_at: null,
    created_at: now,
    updated_at: now,
  };
  db.prepare(
    `INSERT INTO teams (id, slug, display, default_lifecycle, archived_at, created_at, updated_at)
     VALUES (@id, @slug, @display, @default_lifecycle, @archived_at, @created_at, @updated_at)`,
  ).run(row);
  return row;
}

export function getTeamBySlug(db: Database, slug: string): TeamRow | undefined {
  return db.prepare<[string], TeamRow>('SELECT * FROM teams WHERE slug = ?').get(slug);
}

/** Like getTeamBySlug but throws not_found. */
export function requireTeam(db: Database, slug: string): TeamRow {
  const t = getTeamBySlug(db, slug);
  if (!t) throw new MusterdError('not_found', `no team "${slug}"`);
  return t;
}

/** Update a team's durable fields in place (ADR 058 reconcile upsert). Preserves id + created_at. */
export function updateTeam(
  db: Database,
  id: string,
  fields: { display: string | null; defaultLifecycle: string },
): void {
  db.prepare(
    'UPDATE teams SET display = ?, default_lifecycle = ?, updated_at = ? WHERE id = ?',
  ).run(fields.display, fields.defaultLifecycle, Date.now(), id);
}

export function archiveTeam(db: Database, slug: string): void {
  const t = requireTeam(db, slug);
  db.prepare('UPDATE teams SET archived_at = ?, updated_at = ? WHERE id = ?').run(
    Date.now(),
    Date.now(),
    t.id,
  );
}
