import { createHash, randomBytes } from 'node:crypto';
import type { Availability, Lifecycle, MemberKind } from '@musterd/protocol';
import type { Database } from 'better-sqlite3';
import { ulid } from 'ulid';
import { MusterdError } from '../errors.js';
import type { MemberRow, TeamRow } from './rows.js';
import { requireTeam } from './teams.js';

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Bump a member's `updated_at` to now — used as an observer's last-seen for the idle TTL (ADR 064). */
export function touchSeen(db: Database, memberId: string): void {
  db.prepare('UPDATE members SET updated_at = ? WHERE id = ?').run(Date.now(), memberId);
}

/**
 * Reap idle observer seats (ADR 064): hard-delete `observer = 1` members whose `updated_at` predates
 * `idleCutoffTs` and that have no live presence (last seen after `liveCutoffTs`). Skips any observer
 * still referenced by a message (no `to_member` cascade) — left for manual cleanup rather than an FK
 * failure. Presence + cursor rows cascade. Returns the reaped members for logging.
 */
export function reapStaleObservers(
  db: Database,
  idleCutoffTs: number,
  liveCutoffTs: number,
): { id: string; name: string; team_id: string }[] {
  const stale = db
    .prepare<[number, number], { id: string; name: string; team_id: string }>(
      `SELECT id, name, team_id FROM members
       WHERE observer = 1
         AND updated_at < ?
         AND id NOT IN (SELECT member_id FROM presence WHERE held_until IS NULL AND last_seen_at > ?)
         AND id NOT IN (SELECT from_member FROM messages)
         AND id NOT IN (SELECT to_member FROM messages WHERE to_member IS NOT NULL)`,
    )
    .all(idleCutoffTs, liveCutoffTs);
  if (stale.length > 0) {
    const del = db.prepare('DELETE FROM members WHERE id = ?');
    db.transaction(() => {
      for (const m of stale) del.run(m.id);
    })();
  }
  return stale;
}

function newToken(): string {
  return 'mskd_' + randomBytes(24).toString('base64url');
}

export interface AddMemberInput {
  name: string;
  kind: MemberKind;
  role?: string;
  lifecycle?: Lifecycle;
  lifecycleUntil?: number | null;
  availability?: Record<string, unknown> | null;
  /** Provision a read-only observer seat (ADR 063): hidden from roster/counts/presence, can't send. */
  observer?: boolean;
}

/** Add a member to a team and mint its one-time token. Returns the row plus the plaintext token. */
export function addMember(
  db: Database,
  team: TeamRow,
  input: AddMemberInput,
): { row: MemberRow; token: string } {
  if (!input.name || /\s/.test(input.name)) {
    throw new MusterdError(
      'bad_request',
      'member name is required and must not contain whitespace',
    );
  }
  const existing = getMemberByName(db, team.id, input.name);
  if (existing && existing.left_at === null) {
    throw new MusterdError('conflict', `member "${input.name}" already exists in "${team.slug}"`);
  }
  const lifecycle = input.lifecycle ?? (team.default_lifecycle as Lifecycle);
  if (lifecycle === 'until' && !input.lifecycleUntil) {
    throw new MusterdError('bad_request', 'lifecycle "until" requires a timestamp');
  }
  const token = newToken();
  const now = Date.now();
  const row: MemberRow = {
    id: ulid(),
    team_id: team.id,
    name: input.name,
    kind: input.kind,
    role: input.role ?? '',
    lifecycle,
    lifecycle_until: input.lifecycleUntil ?? null,
    availability: input.availability ? JSON.stringify(input.availability) : null,
    token_hash: hashToken(token),
    // A freshly minted seat is *declared*, not yet *held* — bound_at is stamped on first auth touch
    // (ADR 058). The INSERT omits the column, so it defaults to NULL; kept here for the typed row.
    bound_at: null,
    observer: input.observer ? 1 : 0,
    left_at: null,
    created_at: now,
    updated_at: now,
  };
  db.prepare(
    `INSERT INTO members
       (id, team_id, name, kind, role, lifecycle, lifecycle_until, availability, token_hash, observer, left_at, created_at, updated_at)
     VALUES
       (@id, @team_id, @name, @kind, @role, @lifecycle, @lifecycle_until, @availability, @token_hash, @observer, @left_at, @created_at, @updated_at)`,
  ).run(row);
  return { row, token };
}

export function getMemberByName(db: Database, teamId: string, name: string): MemberRow | undefined {
  return db
    .prepare<[string, string], MemberRow>('SELECT * FROM members WHERE team_id = ? AND name = ?')
    .get(teamId, name);
}

export function getMemberById(db: Database, id: string): MemberRow | undefined {
  return db.prepare<[string], MemberRow>('SELECT * FROM members WHERE id = ?').get(id);
}

export function listMembers(db: Database, teamId: string): MemberRow[] {
  return db
    .prepare<
      [string],
      MemberRow
    >('SELECT * FROM members WHERE team_id = ? AND left_at IS NULL ORDER BY created_at')
    .all(teamId);
}

/** Authenticate a token to a specific member in a specific team. Throws unauthorized/forbidden. */
export function authMember(
  db: Database,
  teamSlug: string,
  token: string,
): { team: TeamRow; member: MemberRow } {
  const team = requireTeam(db, teamSlug);
  const hash = hashToken(token);
  const member = db
    .prepare<
      [string, string],
      MemberRow
    >('SELECT * FROM members WHERE team_id = ? AND token_hash = ? AND left_at IS NULL')
    .get(team.id, hash);
  if (!member)
    throw new MusterdError(
      'unauthorized',
      `invalid token for team "${teamSlug}" — this member may not exist on the database this daemon is serving ` +
        `(a daemon started against a different MUSTERD_DB will not recognize tokens minted elsewhere)`,
    );
  // First authenticated touch flips a *declared* seat to *held* (ADR 058). Durable across the holder
  // going offline — unlike presence — so a stray plain `claim` can't rotate a live token away.
  if (member.bound_at === null) {
    const now = Date.now();
    db.prepare('UPDATE members SET bound_at = ? WHERE id = ? AND bound_at IS NULL').run(
      now,
      member.id,
    );
    member.bound_at = now;
  }
  return { team, member };
}

/** Is this seat currently *held* (someone has authenticated its token)? See {@link authMember}. */
export function isHeld(member: MemberRow): boolean {
  return member.bound_at !== null;
}

export interface MemberIdentityFields {
  kind: MemberKind;
  role: string;
  lifecycle: Lifecycle;
  lifecycleUntil: number | null;
}

/**
 * Update a live member's durable identity in place (ADR 058 reconcile UPDATE path). Preserves `id`,
 * `token_hash`, and `bound_at` — the daemon-private anchors that must survive a reconcile so the
 * message log and any live token stay valid.
 */
export function updateMemberIdentity(db: Database, id: string, f: MemberIdentityFields): void {
  db.prepare(
    'UPDATE members SET kind = ?, role = ?, lifecycle = ?, lifecycle_until = ?, updated_at = ? WHERE id = ?',
  ).run(f.kind, f.role, f.lifecycle, f.lifecycleUntil, Date.now(), id);
}

/**
 * Revive a tombstoned seat (ADR 058: file re-added after deletion). Preserves `id` so the message
 * log stays continuous, but **re-mints the token** (deletion was a revocation) and clears `bound_at`
 * back to *declared*. Returns the fresh plaintext token.
 */
export function reviveMember(db: Database, id: string, f: MemberIdentityFields): string {
  const token = newToken();
  db.prepare(
    `UPDATE members
       SET kind = ?, role = ?, lifecycle = ?, lifecycle_until = ?,
           token_hash = ?, bound_at = NULL, left_at = NULL, updated_at = ?
     WHERE id = ?`,
  ).run(f.kind, f.role, f.lifecycle, f.lifecycleUntil, hashToken(token), Date.now(), id);
  return token;
}

/** Force a held seat back to *declared* without deleting it (operator reclaim / unbind, ADR 058). */
export function clearBound(db: Database, id: string): void {
  db.prepare('UPDATE members SET bound_at = NULL, updated_at = ? WHERE id = ?').run(Date.now(), id);
}

/**
 * Re-mint a live seat's token without touching its identity (ADR 058 project-and-return). Used when a
 * declared-but-unheld seat (e.g. one projected from a `git pull`) is claimed: it hands the claimer a
 * fresh token and leaves `bound_at` null until they authenticate. Returns the new plaintext token.
 */
export function rotateToken(db: Database, id: string): string {
  const token = newToken();
  db.prepare('UPDATE members SET token_hash = ?, updated_at = ? WHERE id = ?').run(
    hashToken(token),
    Date.now(),
    id,
  );
  return token;
}

/**
 * Set (or clear) a member's self-declared availability (SPEC A.6 Axis 2; ADR 044). Reuses the
 * existing `members.availability` TEXT column — JSON-encoded, no migration. Passing `null` returns
 * the member to the implicit-`available` default. Never inferred: only the member's own act sets it.
 */
export function setAvailability(
  db: Database,
  memberId: string,
  availability: Availability | null,
): void {
  db.prepare('UPDATE members SET availability = ?, updated_at = ? WHERE id = ?').run(
    availability ? JSON.stringify(availability) : null,
    Date.now(),
    memberId,
  );
}

export function leaveMember(db: Database, memberId: string): void {
  db.prepare('UPDATE members SET left_at = ?, updated_at = ? WHERE id = ?').run(
    Date.now(),
    Date.now(),
    memberId,
  );
}

export { newToken };
