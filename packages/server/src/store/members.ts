import { createHash, randomBytes } from 'node:crypto';
import {
  type Availability,
  type CredentialMint,
  type Lifecycle,
  type MemberKind,
  TOKEN_PREFIXES,
} from '@musterd/protocol';
import type { Database } from 'better-sqlite3';
import { ulid } from 'ulid';
import { MusterdError } from '../errors.js';
import type { MemberRow, TeamRow } from './rows.js';
import { resolveCapabilities } from './rows.js';
import { getAgentKeyHash, requireTeam } from './teams.js';

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

/**
 * Mint a fresh opaque secret with a typed prefix (`prefix_ + base64url(24 random bytes)`) — the shared
 * scheme for seat tokens (`mskd_`) and the v0.3 P3 agent keys / grants / credentials (ADR 069 decision
 * 1). Always stored as its `hashToken` (sha256-hex); the plaintext is returned once and never persisted
 * or logged. Use the {@link TOKEN_PREFIXES} from `@musterd/protocol` for the prefix.
 */
export function newSecret(prefix: string): string {
  return prefix + randomBytes(24).toString('base64url');
}

function newToken(): string {
  return newSecret('mskd_');
}

/** Set (or clear) a member's credential hash (ADR 076, P3.1). */
export function setCredentialHash(db: Database, memberId: string, hash: string | null): void {
  db.prepare('UPDATE members SET credential_hash = ?, updated_at = ? WHERE id = ?').run(
    hash,
    Date.now(),
    memberId,
  );
}

/** Mint a fresh `mscr_` human credential for a member: store its hash, return the plaintext **once**. */
export function mintCredential(db: Database, memberId: string): CredentialMint {
  const credential = newSecret(TOKEN_PREFIXES.credential);
  setCredentialHash(db, memberId, hashToken(credential));
  return { credential };
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
  /** Observer grade (ADR 136): `'public'` sees only team/broadcast traffic — what a shared watch-link
   *  gets. Omitted ⇒ `'full'` (the local dashboard). Ignored unless `observer`. */
  observerScope?: 'full' | 'public';
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
  // A *tombstoned* row (soft-removed, `left_at` set) still squats the (team, name) UNIQUE index, so a
  // plain INSERT would dead-end on a constraint error with no CLI way out — the recurring "departed
  // name can't be reused" trap (ADR 065). Re-adding a removed name is a revive, not a new row: reuse
  // the seat's id (keeps message history continuous) and re-mint the token (ADR 058 `reviveMember`).
  if (existing) {
    const token = reviveMember(db, existing.id, {
      kind: input.kind,
      role: input.role ?? '',
      lifecycle,
      lifecycleUntil: input.lifecycleUntil ?? null,
    });
    const row = getMemberById(db, existing.id)!;
    return { row, token };
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
    // Grade is meaningless off an observer seat — keep it NULL there rather than storing a value that
    // reads as if it governs an ordinary member (ADR 136).
    observer_scope: input.observer ? (input.observerScope ?? 'full') : null,
    // Governance is projected by reconcile (ADR 070), not at mint — a fresh seat is NULL (⇒ derived
    // account status + generalist capabilities) until the file-backed values are reconciled in.
    account_status: null,
    capabilities: null,
    credential_hash: null,
    left_at: null,
    created_at: now,
    updated_at: now,
  };
  db.prepare(
    `INSERT INTO members
       (id, team_id, name, kind, role, lifecycle, lifecycle_until, availability, token_hash, observer, observer_scope, account_status, capabilities, left_at, created_at, updated_at)
     VALUES
       (@id, @team_id, @name, @kind, @role, @lifecycle, @lifecycle_until, @availability, @token_hash, @observer, @observer_scope, @account_status, @capabilities, @left_at, @created_at, @updated_at)`,
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

/**
 * Authenticate a request to a specific member (seat) in a team. Throws unauthorized/forbidden.
 *
 * v0.3 P3 (ADR 077, SPEC A.7) **prefix-dispatch** — the hard cutover removed the v0.2 per-seat token
 * (`mskd_`); the only credentials are:
 *  - `mskey_` (team agent key): authenticates the *harness*, not a seat — so the acting seat must be
 *    named by the caller (`actingSeat`: the Envelope `from` on a send, or the `x-musterd-seat` header on
 *    a read, per SPEC A.7 §253). Authorizes on a valid team key + an existing, active seat. Single-active
 *    occupancy is enforced at *claim* time (the handshake), not re-checked per request — and we
 *    deliberately do **not** gate on live presence / `isHeld`: gating auth on presence would regress the
 *    ambient-presence ergonomics (ADR 057) (a bursty stateless agent past the presence TTL would lock
 *    itself out).
 *  - `mscr_` (human credential): self-identifying — resolves the human seat by `credential_hash`. The
 *    credential is the authority; if `actingSeat` is supplied it must match.
 *  - anything else → `unauthorized` (the `mskd_` path is gone, ADR 069 decision 2).
 */
export function authMember(
  db: Database,
  teamSlug: string,
  token: string,
  actingSeat?: string,
): { team: TeamRow; member: MemberRow } {
  const team = requireTeam(db, teamSlug);

  if (token.startsWith(TOKEN_PREFIXES.agent_key)) {
    return { team, member: authByAgentKey(db, team, token, actingSeat) };
  }
  if (token.startsWith(TOKEN_PREFIXES.credential)) {
    return { team, member: authByCredential(db, team, token, actingSeat) };
  }

  // v0.3 hard cutover (ADR 069 decision 2): the v0.2 per-seat token (`mskd_`) auth path is removed —
  // the only credentials are the team agent key (`mskey_`) and a human credential (`mscr_`).
  throw new MusterdError(
    'unauthorized',
    `unrecognized credential for team "${teamSlug}" — present a team agent key (mskey_) or a human credential (mscr_)`,
  );
}

/**
 * Agent-key (`mskey_`) auth: a valid team agent key + an acting seat the caller names (SPEC A.7 §253).
 * The key authorizes "an authorized harness on this team"; the seat is the identity it is acting as.
 */
function authByAgentKey(
  db: Database,
  team: TeamRow,
  key: string,
  actingSeat: string | undefined,
): MemberRow {
  const keyHash = getAgentKeyHash(db, team.id);
  if (!keyHash || hashToken(key) !== keyHash)
    throw new MusterdError('unauthorized', `invalid agent key for team "${team.slug}"`);
  if (!actingSeat)
    throw new MusterdError(
      'unauthorized',
      'agent-key auth must name the acting seat — set the Envelope `from` (send) or the `x-musterd-seat` ' +
        'header (reads), per SPEC A.7 §253',
    );
  const member = getMemberByName(db, team.id, actingSeat);
  if (!member || member.left_at !== null)
    throw new MusterdError('unauthorized', `no active seat "${actingSeat}" in team "${team.slug}"`);
  // SECURITY — occupancy binds key→seat (focal point 2). The team agent key is **shared** across all the
  // team's agent harnesses, so it must NOT be able to act as a *human* seat: otherwise any agent could
  // set `x-musterd-seat: <admin>` and impersonate the human admin → privilege escalation (admin ops).
  // A human seat is reachable only via that human's own `mscr_` credential (authByCredential, kind-bound).
  if (member.kind !== 'agent')
    throw new MusterdError(
      'forbidden',
      `the team agent key may only act as an agent seat; the human seat "${actingSeat}" authenticates with its own credential`,
    );
  return member;
}

/** Human-credential (`mscr_`) auth: self-identifying; the credential is the authority for its seat. */
function authByCredential(
  db: Database,
  team: TeamRow,
  credential: string,
  actingSeat: string | undefined,
): MemberRow {
  const member = db
    .prepare<
      [string, string],
      MemberRow
    >("SELECT * FROM members WHERE team_id = ? AND credential_hash = ? AND left_at IS NULL AND kind = 'human'")
    .get(team.id, hashToken(credential));
  if (!member)
    throw new MusterdError('unauthorized', `invalid human credential for team "${team.slug}"`);
  if (actingSeat && actingSeat !== member.name)
    throw new MusterdError(
      'forbidden',
      `credential identifies "${member.name}", not "${actingSeat}"`,
    );
  return member;
}

/** Is this seat currently *held* (someone has authenticated its token)? See {@link authMember}. */
export function isHeld(member: MemberRow): boolean {
  return member.bound_at !== null;
}

/**
 * Does any live seat on the team hold the `is_admin` capability (ADR 071)? The empty-admin fallback for
 * governance routes (reclaim/remove) reads this: a team with **zero** admins stays on the v0.2 open
 * behaviour (any member may operate) so enforcement never breaks an un-migrated team — and self-activates
 * the instant a seat declares admin (creator default, or a seat-file `[capabilities] is_admin = true`).
 */
export function teamHasAdmin(db: Database, teamId: string): boolean {
  return listMembers(db, teamId).some((m) => resolveCapabilities(m).is_admin);
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
 * Mark a seat *held* (ADR 058): the first time it is occupied, stamp `bound_at`. Idempotent — only sets
 * when still null, so a re-occupy never rotates the original hold time. In v0.2 the first authenticated
 * token touch did this; post-cutover (ADR 069) the claim OCCUPY is the first-occupancy signal, so it
 * calls this — keeping the durable "held" marker and the ADR 070 active derivation intact.
 */
export function markBound(db: Database, id: string): void {
  db.prepare('UPDATE members SET bound_at = ? WHERE id = ? AND bound_at IS NULL').run(
    Date.now(),
    id,
  );
}

/**
 * Project a seat's governance state onto its member row (ADR 070, v0.3 P1). Kept **separate** from the
 * identity/mint paths so reconcile is the single writer of capabilities + the admin account-status
 * override, and the mint/revive/db-only paths stay untouched (their rows default to NULL ⇒
 * generalist/derived, the backward-compatible state). `accountStatus` is the admin override only
 * (disabled/banned/archived) or NULL; `capabilities` is the resolved effective JSON.
 */
export function setMemberGovernance(
  db: Database,
  id: string,
  accountStatus: string | null,
  capabilities: string,
): void {
  db.prepare(
    'UPDATE members SET account_status = ?, capabilities = ?, updated_at = ? WHERE id = ?',
  ).run(accountStatus, capabilities, Date.now(), id);
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
