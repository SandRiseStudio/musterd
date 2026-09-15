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
import { appendAuditRequired, appendReplicatedEvent } from './audit.js';
import { hashToken, newSecret } from './members.js';
import { resolveAccountStatus, type MemberRow, type TeamRow } from './rows.js';

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
  /** ADR 350: the Member proven by the `msac_` used to create this migration successor. */
  migration_target_member_id: string | null;
  /** ADR 350: first successful scoped claim/host authentication; minting alone is not readiness. */
  first_used_at: number | null;
}

export type BootstrapMigrationResult = {
  credential: BootstrapCredential;
  agent_key: string;
  predecessor_credential_id: string;
  replaced_credential_id: string | null;
};

export type BootstrapCutoverReadiness = {
  already_cut_over: boolean;
  unmet_seats: Array<{ member_id: string; name: string }>;
  unmet_hosts: string[];
};

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
    bootstrap_cutover_at: null,
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
  const team = db
    .prepare<
      [string],
      { bootstrap_cutover_at: number | null }
    >('SELECT bootstrap_cutover_at FROM teams WHERE id = ?')
    .get(teamId);
  if (!team) throw new MusterdError('not_found', 'Team not found');
  if (team.bootstrap_cutover_at !== null) {
    throw new MusterdError('conflict', 'legacy bootstrap authority is already cut over');
  }
  const agentKey = newSecret(TOKEN_PREFIXES.agent_key);
  const now = Date.now();
  const keyHash = hashToken(agentKey);
  db.transaction(() => {
    db.prepare(
      `UPDATE agent_bootstrap_credentials
       SET state = 'revoked', revoked_at = ?
       WHERE team_id = ? AND use_kind = 'legacy' AND state IN ('active', 'rotated')`,
    ).run(now, teamId);
    db.prepare('UPDATE teams SET agent_key_hash = ?, updated_at = ? WHERE id = ?').run(
      keyHash,
      now,
      teamId,
    );
    db.prepare(
      `INSERT INTO agent_bootstrap_credentials
        (id, team_id, key_hash, use_kind, target, label, state, expires_at, created_by,
         created_at, rotated_at, revoked_at, migration_target_member_id, first_used_at)
       VALUES (?, ?, ?, 'legacy', NULL, 'team-key-compatibility', 'active', NULL, NULL,
               ?, NULL, NULL, NULL, NULL)`,
    ).run(ulid(), teamId, keyHash, now);
  })();
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
    migration_target_member_id: null,
    first_used_at: null,
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
 * Exchange legacy Team-wide bootstrap authority for a successor restricted to the agent seat proven
 * by its independent `msac_`. Team and Member are derived from stored credential hashes; callers do
 * not declare either identity (ADR 350).
 */
export function migrateLegacyBootstrapCredential(
  db: Database,
  input: { legacyKey: string; seatCredential: string; now?: number },
): BootstrapMigrationResult {
  return db.transaction(() => {
    const now = input.now ?? Date.now();
    const legacy = db
      .prepare<[string, number], BootstrapCredential>(
        `SELECT * FROM agent_bootstrap_credentials
         WHERE key_hash = ? AND use_kind = 'legacy' AND state = 'active'
           AND (expires_at IS NULL OR expires_at > ?)
         LIMIT 1`,
      )
      .get(hashToken(input.legacyKey), now);
    if (!legacy) {
      throw new MusterdError('unauthorized', 'invalid or inactive legacy bootstrap credential');
    }

    const team = db
      .prepare<[string], TeamRow>('SELECT * FROM teams WHERE id = ?')
      .get(legacy.team_id);
    if (!team || team.archived_at !== null) {
      throw new MusterdError(
        'forbidden',
        'legacy bootstrap credential belongs to an archived Team',
      );
    }

    const member = db
      .prepare<[string], MemberRow>(
        `SELECT * FROM members
         WHERE credential_hash = ? AND kind = 'agent' AND observer = 0 AND left_at IS NULL
         LIMIT 1`,
      )
      .get(hashToken(input.seatCredential));
    if (!member) {
      throw new MusterdError('unauthorized', 'invalid or inactive agent seat credential');
    }
    if (member.team_id !== legacy.team_id) {
      throw new MusterdError(
        'forbidden',
        'legacy bootstrap and agent seat credential must identify the same Team',
      );
    }
    const accountStatus = resolveAccountStatus(member);
    if (
      accountStatus === 'disabled' ||
      accountStatus === 'banned' ||
      accountStatus === 'archived'
    ) {
      throw new MusterdError('forbidden', `seat "${member.name}" is ${accountStatus}`);
    }

    const usedSuccessor = db
      .prepare<[string, string], { id: string }>(
        `SELECT id FROM agent_bootstrap_credentials
         WHERE team_id = ? AND migration_target_member_id = ? AND first_used_at IS NOT NULL
         ORDER BY first_used_at DESC, id DESC
         LIMIT 1`,
      )
      .get(legacy.team_id, member.id);
    if (usedSuccessor) {
      throw new MusterdError(
        'conflict',
        `seat "${member.name}" already migrated to a scoped bootstrap credential`,
      );
    }

    const unused = db
      .prepare<[string, string], { id: string }>(
        `SELECT id FROM agent_bootstrap_credentials
         WHERE team_id = ? AND migration_target_member_id = ?
           AND state = 'active' AND first_used_at IS NULL
         ORDER BY created_at DESC, id DESC
         LIMIT 1`,
      )
      .get(legacy.team_id, member.id);
    if (unused) {
      db.prepare(
        `UPDATE agent_bootstrap_credentials
         SET state = 'revoked', revoked_at = ?
         WHERE id = ? AND state = 'active' AND first_used_at IS NULL`,
      ).run(now, unused.id);
    }

    const agent_key = newSecret(TOKEN_PREFIXES.agent_key);
    const credential: BootstrapCredential = {
      id: ulid(),
      team_id: legacy.team_id,
      key_hash: hashToken(agent_key),
      use_kind: 'claim_seat',
      target: member.name,
      label: 'legacy-migration',
      state: 'active',
      expires_at: null,
      created_by: member.name,
      created_at: now,
      rotated_at: null,
      revoked_at: null,
      migration_target_member_id: member.id,
      first_used_at: null,
    };
    db.prepare(
      `INSERT INTO agent_bootstrap_credentials
        (id, team_id, key_hash, use_kind, target, label, state, expires_at, created_by,
         created_at, rotated_at, revoked_at, migration_target_member_id, first_used_at)
       VALUES
        (@id, @team_id, @key_hash, @use_kind, @target, @label, @state, @expires_at, @created_by,
         @created_at, @rotated_at, @revoked_at, @migration_target_member_id, @first_used_at)`,
    ).run(credential);

    return {
      credential,
      agent_key,
      predecessor_credential_id: legacy.id,
      replaced_credential_id: unused?.id ?? null,
    };
  })();
}

/** Record adoption evidence once; legacy compatibility authentication never satisfies readiness. */
export function recordBootstrapCredentialUse(
  db: Database,
  credentialId: string,
  now = Date.now(),
): void {
  db.prepare(
    `UPDATE agent_bootstrap_credentials
     SET first_used_at = COALESCE(first_used_at, ?)
     WHERE id = ? AND use_kind <> 'legacy'`,
  ).run(now, credentialId);
}

/** Derive legacy-key cutover readiness only from durable Team state and observed scoped use. */
export function bootstrapCutoverReadiness(
  db: Database,
  teamId: string,
  now = Date.now(),
): BootstrapCutoverReadiness {
  const team = db.prepare<[string], TeamRow>('SELECT * FROM teams WHERE id = ?').get(teamId);
  if (!team) throw new MusterdError('not_found', 'Team not found');

  const unmet_seats = db
    .prepare<[string, number], { member_id: string; name: string }>(
      `SELECT m.id AS member_id, m.name
       FROM members m
       WHERE m.team_id = ?
         AND m.kind = 'agent'
         AND m.observer = 0
         AND m.bound_at IS NOT NULL
         AND m.left_at IS NULL
         AND (m.account_status IS NULL OR m.account_status NOT IN ('disabled', 'banned', 'archived'))
         AND NOT EXISTS (
           SELECT 1
           FROM agent_bootstrap_credentials c
           WHERE c.team_id = m.team_id
             AND c.use_kind = 'claim_seat'
             AND c.target = m.name
             AND c.state = 'active'
             AND (c.expires_at IS NULL OR c.expires_at > ?)
             AND c.first_used_at IS NOT NULL
         )
       ORDER BY m.name, m.id`,
    )
    .all(teamId, now);

  const unmet_hosts = db
    .prepare<[string, number], { host: string }>(
      `SELECT DISTINCT r.host
       FROM residency r
       JOIN members m ON m.id = r.member_id
       WHERE r.team_id = ?
         AND m.left_at IS NULL
         AND (m.account_status IS NULL OR m.account_status NOT IN ('disabled', 'banned', 'archived'))
         AND NOT EXISTS (
           SELECT 1
           FROM agent_bootstrap_credentials c
           WHERE c.team_id = r.team_id
             AND c.use_kind = 'host'
             AND c.target = r.host
             AND c.state = 'active'
             AND (c.expires_at IS NULL OR c.expires_at > ?)
             AND c.first_used_at IS NOT NULL
         )
       ORDER BY r.host`,
    )
    .all(teamId, now)
    .map((row) => row.host);

  return {
    already_cut_over: team.bootstrap_cutover_at !== null,
    unmet_seats,
    unmet_hosts,
  };
}

/** Transactionally disable one Team's legacy bootstrap authority after its scoped targets are ready. */
export function cutoverLegacyBootstrap(
  db: Database,
  input: { teamId: string; actor: string; force: boolean; now?: number },
): BootstrapCutoverReadiness {
  return db.transaction(() => {
    const now = input.now ?? Date.now();
    const readiness = bootstrapCutoverReadiness(db, input.teamId, now);
    if (readiness.already_cut_over) return readiness;
    if (!input.force && (readiness.unmet_seats.length > 0 || readiness.unmet_hosts.length > 0)) {
      throw new MusterdError('conflict', 'legacy bootstrap cutover is not ready');
    }

    db.prepare(
      `UPDATE agent_bootstrap_credentials
       SET state = 'revoked', revoked_at = ?
       WHERE team_id = ? AND use_kind = 'legacy' AND state IN ('active', 'rotated')`,
    ).run(now, input.teamId);
    db.prepare(
      `UPDATE teams
       SET agent_key_hash = NULL, bootstrap_cutover_at = ?, updated_at = ?
       WHERE id = ?`,
    ).run(now, now, input.teamId);
    appendAuditRequired(db, input.teamId, {
      actor: input.actor,
      action: 'bootstrap_credential.cutover',
      target: input.teamId,
      result: 'allow',
      detail: {
        force: input.force,
        unmet_member_ids: readiness.unmet_seats.map((seat) => seat.member_id),
        unmet_hosts: readiness.unmet_hosts,
      },
    });
    return readiness;
  })();
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

/**
 * Set the policy AND stamp the change for replication (residence-2 census gap 1, 2026-09-03).
 *
 * The write and its `policy.change` event are one unit, the way every lane transition is: the row
 * this daemon holds and the fact its peers will fold are the same fact, or neither happened. The
 * stamped `detail` is the STORED sparse doc — the same thing `setPolicy` put in the row, so a peer
 * that folds it stores exactly what the admin chose and keeps its own defaults alive for the rest
 * (ADR 185).
 *
 * Only the HUB calls this. Policy is hub-authoritative (ADR 325 residence 1): a joiner forwards to
 * the hub and learns the answer back through the fold, so no second origin ever mints the verb.
 */
export function applyPolicyChange(
  db: Database,
  teamId: string,
  actor: string,
  policy: z.input<typeof PolicyOverrideSchema>,
): { policy: Policy; stored: PolicyOverride } {
  return db.transaction(() => {
    const stored = PolicyOverrideSchema.parse(policy);
    const effective = setPolicy(db, teamId, stored);
    appendReplicatedEvent(db, teamId, {
      actor,
      action: 'policy.change',
      target: null,
      result: 'allow',
      detail: stored,
    });
    return { policy: effective, stored };
  })();
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
