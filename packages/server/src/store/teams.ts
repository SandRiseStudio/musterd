import type { Database } from 'better-sqlite3';
import { ulid } from 'ulid';
import { type AgentKeyMint, type Policy, PolicySchema, TOKEN_PREFIXES } from '@musterd/protocol';
import type { z } from 'zod';
import { MusterdError } from '../errors.js';
import { hashToken, newSecret } from './members.js';
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
    agent_key_hash: null,
    policy: null,
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

/* ── v0.3 P3 team secrets + policy (ADR 076) ─────────────────────────────────────────────────────
 * Team-scoped secrets live on the team row (agent key is one-per-team, rotatable); only the sha256
 * hash is stored (SPEC A.2). Plaintext is returned once at mint and never persisted/logged. */

/**
 * Rotate (or set) the team agent key: mint a fresh `mskey_` secret, store its hash, return the
 * plaintext **once**. Any prior key is invalidated by the overwrite.
 */
export function rotateAgentKey(db: Database, teamId: string): AgentKeyMint {
  const agentKey = newSecret(TOKEN_PREFIXES.agent_key);
  db.prepare('UPDATE teams SET agent_key_hash = ?, updated_at = ? WHERE id = ?').run(
    hashToken(agentKey),
    Date.now(),
    teamId,
  );
  return { agent_key: agentKey };
}

/** The team's agent-key hash, or null if none is set. */
export function getAgentKeyHash(db: Database, teamId: string): string | null {
  const row = db
    .prepare<
      [string],
      { agent_key_hash: string | null }
    >('SELECT agent_key_hash FROM teams WHERE id = ?')
    .get(teamId);
  return row?.agent_key_hash ?? null;
}

/** Set the team governance policy (overwrites). Re-parses to apply defaults; returns the stored policy. */
export function setPolicy(
  db: Database,
  teamId: string,
  policy: z.input<typeof PolicySchema>,
): Policy {
  const parsed = PolicySchema.parse(policy);
  db.prepare('UPDATE teams SET policy = ?, updated_at = ? WHERE id = ?').run(
    JSON.stringify(parsed),
    Date.now(),
    teamId,
  );
  return parsed;
}

/** The team policy, parsed with defaults applied (an unset policy ⇒ all defaults). */
export function getPolicy(db: Database, teamId: string): Policy {
  const row = db
    .prepare<[string], { policy: string | null }>('SELECT policy FROM teams WHERE id = ?')
    .get(teamId);
  return PolicySchema.parse(row?.policy ? JSON.parse(row.policy) : {});
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
