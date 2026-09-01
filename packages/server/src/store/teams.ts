import {
  type AgentKeyMint,
  type Policy,
  type PolicyOverride,
  PolicyOverrideSchema,
  PolicySchema,
  TOKEN_PREFIXES,
  type WorkingHours,
} from '@musterd/protocol';
import type { Database } from 'better-sqlite3';
import { ulid } from 'ulid';
import type { z } from 'zod';
import { MusterdError } from '../errors.js';
import { hashToken, newSecret } from './members.js';
import type { TeamRow } from './rows.js';

const SLUG_RE = /^[a-z0-9-]{1,32}$/;

export type BootstrapCredentialUse = 'claim_seat' | 'claim_role' | 'host' | 'legacy';

export interface BootstrapCredential {
  id: string;
  team_id: string;
  key_hash: string;
  use_kind: BootstrapCredentialUse;
  target: string | null;
  label: string | null;
  state: 'active' | 'rotated' | 'revoked';
  expires_at: number | null;
  created_by: string | null;
  created_at: number;
  rotated_at: number | null;
  revoked_at: number | null;
}

export function createTeam(
  db: Database,
  input: {
    slug: string;
    display?: string | null;
    defaultLifecycle?: string;
    workingHours?: WorkingHours | null;
  },
): TeamRow {
  if (!SLUG_RE.test(input.slug)) {
    throw new MusterdError(
      'bad_request',
      `invalid team slug "${input.slug}" (use [a-z0-9-], 1..32)`,
    );
  }
  const existing = getTeamBySlug(db, input.slug);
  if (existing) {
    throw new MusterdError(
      'conflict',
      existing.archived_at
        ? `team "${input.slug}" already exists (archived) — its history keeps the slug`
        : `team "${input.slug}" already exists`,
    );
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
    working_hours: input.workingHours ? JSON.stringify(input.workingHours) : null,
    created_at: now,
    updated_at: now,
  };
  db.prepare(
    `INSERT INTO teams (id, slug, display, default_lifecycle, archived_at, working_hours, created_at, updated_at)
     VALUES (@id, @slug, @display, @default_lifecycle, @archived_at, @working_hours, @created_at, @updated_at)`,
  ).run(row);
  return row;
}

export function getTeamBySlug(db: Database, slug: string): TeamRow | undefined {
  return db.prepare<[string], TeamRow>('SELECT * FROM teams WHERE slug = ?').get(slug);
}

/**
 * Every non-archived team, for the daemon's own periodic passes (ADR 229's sweep). Archived teams are
 * excluded on the same principle as `requireTeam`: a soft-archived team drops off every surface at
 * once, and a background job acting on one would be the exception that makes that untrue.
 */
export function listActiveTeams(db: Database): { id: string; slug: string }[] {
  return db
    .prepare<
      [],
      { id: string; slug: string }
    >('SELECT id, slug FROM teams WHERE archived_at IS NULL')
    .all();
}

/**
 * Like getTeamBySlug but throws not_found. An archived team is invisible here too: every team-scoped
 * route (auth, roster, status, ws join, claim) resolves through this, so soft-archiving a team makes
 * it drop off every surface at once while its rows (history, audit, provenance) survive in the db.
 */
export function requireTeam(db: Database, slug: string): TeamRow {
  const t = getTeamBySlug(db, slug);
  if (!t) throw new MusterdError('not_found', `no team "${slug}"`);
  if (t.archived_at) throw new MusterdError('not_found', `team "${slug}" is archived`);
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

/**
 * Mint a bootstrap credential constrained by a server-held purpose and target (ADR 344).
 * The caller receives the plaintext once; only its hash is retained.
 */
export function mintBootstrapCredential(
  db: Database,
  input: {
    teamId: string;
    useKind: Exclude<BootstrapCredentialUse, 'legacy'>;
    target: string;
    label?: string;
    expiresAt?: number;
    createdBy?: string;
  },
): { credential: BootstrapCredential; agent_key: string; rotated: string[] } {
  const agent_key = newSecret(TOKEN_PREFIXES.agent_key);
  const now = Date.now();
  const credential: BootstrapCredential = {
    id: ulid(),
    team_id: input.teamId,
    key_hash: hashToken(agent_key),
    use_kind: input.useKind,
    target: input.target,
    label: input.label ?? null,
    state: 'active',
    expires_at: input.expiresAt ?? null,
    created_by: input.createdBy ?? null,
    created_at: now,
    rotated_at: null,
    revoked_at: null,
  };
  const rotated = db.transaction(() => {
    const predecessors = db
      .prepare<[string, string, string], { id: string }>(
        `SELECT id FROM agent_bootstrap_credentials
         WHERE team_id = ? AND use_kind = ? AND target = ? AND state = 'active'`,
      )
      .all(input.teamId, input.useKind, input.target)
      .map((row) => row.id);
    // A same-scope mint is the explicit start of a staged rotation. The predecessor remains valid
    // until the admin revokes it, but inventory names the overlap rather than showing two unrelated
    // active records (ADR 344 §5–6).
    db.prepare(
      `UPDATE agent_bootstrap_credentials
       SET state = 'rotated', rotated_at = ?
       WHERE team_id = ? AND use_kind = ? AND target = ? AND state = 'active'`,
    ).run(now, input.teamId, input.useKind, input.target);
    db.prepare(
      `INSERT INTO agent_bootstrap_credentials
        (id, team_id, key_hash, use_kind, target, label, state, expires_at, created_by, created_at, rotated_at, revoked_at)
       VALUES
        (@id, @team_id, @key_hash, @use_kind, @target, @label, @state, @expires_at, @created_by, @created_at, @rotated_at, @revoked_at)`,
    ).run(credential);
    return predecessors;
  })();
  return { credential, agent_key, rotated };
}

/** Resolve an active, unexpired scoped bootstrap credential by its presented secret. */
export function findBootstrapCredential(
  db: Database,
  teamId: string,
  agentKey: string,
): BootstrapCredential | null {
  return (
    db
      .prepare<[string, string, number], BootstrapCredential>(
        `SELECT * FROM agent_bootstrap_credentials
         WHERE team_id = ? AND key_hash = ? AND state IN ('active', 'rotated')
           AND (expires_at IS NULL OR expires_at > ?)
         LIMIT 1`,
      )
      .get(teamId, hashToken(agentKey), Date.now()) ?? null
  );
}

/** Resolve a credential record regardless of lifecycle state, for redacted refusal audit only. */
export function findBootstrapCredentialRecord(
  db: Database,
  teamId: string,
  agentKey: string,
): BootstrapCredential | null {
  return (
    db
      .prepare<[string, string], BootstrapCredential>(
        `SELECT * FROM agent_bootstrap_credentials
         WHERE team_id = ? AND key_hash = ?
         LIMIT 1`,
      )
      .get(teamId, hashToken(agentKey)) ?? null
  );
}

/** Revoke one scoped bootstrap credential. Legacy team keys remain on their compatibility path. */
export function revokeBootstrapCredential(
  db: Database,
  teamId: string,
  credentialId: string,
): boolean {
  const result = db
    .prepare(
      `UPDATE agent_bootstrap_credentials
       SET state = 'revoked', revoked_at = ?
       WHERE id = ? AND team_id = ? AND state IN ('active', 'rotated') AND use_kind <> 'legacy'`,
    )
    .run(Date.now(), credentialId, teamId);
  return result.changes === 1;
}

/** Admin inventory source. Callers must redact key_hash before crossing a transport boundary. */
export function listBootstrapCredentials(db: Database, teamId: string): BootstrapCredential[] {
  return db
    .prepare<[string], BootstrapCredential>(
      `SELECT * FROM agent_bootstrap_credentials
       WHERE team_id = ?
       ORDER BY created_at DESC, id DESC`,
    )
    .all(teamId);
}

/**
 * Set the team governance policy (ADR 185). Stores **only what was chosen** — the sparse doc goes to
 * the row verbatim, and defaults are applied on read by `getPolicy`, never here. Replace semantics,
 * not patch: a key the new doc omits is unset, which is how `--ask-slack-webhook off` and
 * `--reset-policy` restore a real default instead of storing one. Returns the effective policy.
 *
 * The old shape parsed before storing, so the first write of any single knob materialized every
 * default into the row and the schema default was dead for that team from then on — see ADR 185 and
 * the #530 recalibration that had to ship a data change on top of a code change.
 */
export function setPolicy(
  db: Database,
  teamId: string,
  policy: z.input<typeof PolicyOverrideSchema>,
): Policy {
  const stored = PolicyOverrideSchema.parse(policy);
  db.prepare('UPDATE teams SET policy = ?, updated_at = ? WHERE id = ?').run(
    JSON.stringify(stored),
    Date.now(),
    teamId,
  );
  return getPolicy(db, teamId);
}

function readStored(db: Database, teamId: string): unknown {
  const row = db
    .prepare<[string], { policy: string | null }>('SELECT policy FROM teams WHERE id = ?')
    .get(teamId);
  return row?.policy ? JSON.parse(row.policy) : {};
}

/** The team policy, parsed with defaults applied (an unset policy ⇒ all defaults). */
export function getPolicy(db: Database, teamId: string): Policy {
  return PolicySchema.parse(readStored(db, teamId));
}

/**
 * The team policy **as stored** — sparse, only the keys somebody chose (ADR 185). The write path and
 * the explicit-vs-inherited display read this; every consumer of effective values wants `getPolicy`.
 */
export function getStoredPolicy(db: Database, teamId: string): PolicyOverride {
  return PolicyOverrideSchema.parse(readStored(db, teamId));
}

/** Update a team's durable fields in place (ADR 058 reconcile upsert). Preserves id + created_at. */
export function updateTeam(
  db: Database,
  id: string,
  fields: {
    display: string | null;
    defaultLifecycle: string;
    workingHours?: WorkingHours | null;
  },
): void {
  db.prepare(
    'UPDATE teams SET display = ?, default_lifecycle = ?, working_hours = ?, updated_at = ? WHERE id = ?',
  ).run(
    fields.display,
    fields.defaultLifecycle,
    fields.workingHours ? JSON.stringify(fields.workingHours) : null,
    Date.now(),
    id,
  );
}

/**
 * Soft-archive a team (the inverse of `team create`): sets `archived_at`, which requireTeam treats as
 * gone — the team drops off status/rosters and refuses auth, but every row is kept. Resolves the slug
 * directly (not via requireTeam) so the error for an already-archived team names the real state.
 */
export function archiveTeam(db: Database, slug: string): { archived_at: number } {
  const t = getTeamBySlug(db, slug);
  if (!t) throw new MusterdError('not_found', `no team "${slug}"`);
  if (t.archived_at) {
    throw new MusterdError('conflict', `team "${slug}" is already archived`);
  }
  const now = Date.now();
  db.prepare('UPDATE teams SET archived_at = ?, updated_at = ? WHERE id = ?').run(now, now, t.id);
  return { archived_at: now };
}
