import { createHash, randomBytes } from 'node:crypto';
import {
  type Availability,
  type CredentialMint,
  type Lifecycle,
  type MemberKind,
  type WorkingHours,
  TOKEN_PREFIXES,
} from '@musterd/protocol';
import type { Database } from 'better-sqlite3';
import { ulid } from 'ulid';
import { MusterdError } from '../errors.js';
import { releaseInFlightClaimsForSeat } from './lanes.js';
import type { MemberRow, TeamRow } from './rows.js';
import { parseRoles, resolveCapabilities } from './rows.js';
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
 * Cap concurrent idle observers per team (ADR 196): after the ADR 064 TTL pass, keep at most
 * `maxIdlePerTeam` idle (no live presence) observers per team — freshest `updated_at` first —
 * and hard-delete the rest. Same message-FK skip as {@link reapStaleObservers}. Live-connected
 * seats are never capped out. Returns the reaped members for logging.
 */
export function reapExcessIdleObservers(
  db: Database,
  maxIdlePerTeam: number,
  liveCutoffTs: number,
): { id: string; name: string; team_id: string }[] {
  if (maxIdlePerTeam < 1) return [];
  const idle = db
    .prepare<[number], { id: string; name: string; team_id: string; updated_at: number }>(
      `SELECT id, name, team_id, updated_at FROM members
       WHERE observer = 1
         AND left_at IS NULL
         AND id NOT IN (SELECT member_id FROM presence WHERE held_until IS NULL AND last_seen_at > ?)
         AND id NOT IN (SELECT from_member FROM messages)
         AND id NOT IN (SELECT to_member FROM messages WHERE to_member IS NOT NULL)
       ORDER BY team_id, updated_at DESC`,
    )
    .all(liveCutoffTs);
  const excess: { id: string; name: string; team_id: string }[] = [];
  let currentTeam = '';
  let kept = 0;
  for (const row of idle) {
    if (row.team_id !== currentTeam) {
      currentTeam = row.team_id;
      kept = 0;
    }
    if (kept < maxIdlePerTeam) {
      kept += 1;
      continue;
    }
    excess.push({ id: row.id, name: row.name, team_id: row.team_id });
  }
  if (excess.length > 0) {
    const del = db.prepare('DELETE FROM members WHERE id = ?');
    db.transaction(() => {
      for (const m of excess) del.run(m.id);
    })();
  }
  return excess;
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
  workingHours?: WorkingHours | null;
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
    // Projected by reconcile (ADR 227), like capabilities — a fresh seat is NULL (⇒ derived from
    // the single `role` label) until the file-backed roles are reconciled in.
    roles: null,
    lifecycle,
    lifecycle_until: input.lifecycleUntil ?? null,
    availability: input.availability ? JSON.stringify(input.availability) : null,
    working_hours: input.workingHours ? JSON.stringify(input.workingHours) : null,
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
    last_offline_reason: null,
    left_at: null,
    created_at: now,
    updated_at: now,
  };
  db.prepare(
    `INSERT INTO members
       (id, team_id, name, kind, role, lifecycle, lifecycle_until, availability, working_hours, token_hash, observer, observer_scope, account_status, capabilities, left_at, created_at, updated_at)
     VALUES
       (@id, @team_id, @name, @kind, @role, @lifecycle, @lifecycle_until, @availability, @working_hours, @token_hash, @observer, @observer_scope, @account_status, @capabilities, @left_at, @created_at, @updated_at)`,
  ).run(row);
  return { row, token };
}

export function getMemberByName(db: Database, teamId: string, name: string): MemberRow | undefined {
  return db
    .prepare<[string, string], MemberRow>('SELECT * FROM members WHERE team_id = ? AND name = ?')
    .get(teamId, name);
}

/**
 * The seat holding a role (ADR 227) — the fallback owner for an unclaimed incident (ADR 271).
 *
 * Two things this does that the inline `WHERE role = ? LIMIT 1` copies in http.ts and ws.ts do not,
 * both of which matter when the answer decides who gets assigned work:
 *
 * - It reads the ADR 227 **roles array**, not only the legacy single `role` column. A seat whose
 *   platform role lives in the JSON is invisible to those copies, and a fallback owner who exists
 *   but cannot be found is indistinguishable from no owner at all.
 * - It is **deterministic**. `LIMIT 1` with no ORDER BY lets SQLite pick, so two seats holding one
 *   role would route by whim and the assignment would not be reproducible from the audit log.
 *
 * Departed seats are skipped: assigning an incident to someone who left is a lane that will never
 * move, and it looks owned on the board while nobody is on it.
 */
export function getMemberByRole(db: Database, teamId: string, role: string): MemberRow | undefined {
  return db
    .prepare<[string], MemberRow>(
      'SELECT * FROM members WHERE team_id = ? AND left_at IS NULL ORDER BY created_at, id',
    )
    .all(teamId)
    .find((row) => parseRoles(row).includes(role));
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
  if (token.startsWith(TOKEN_PREFIXES.seat)) {
    return { team, member: authByServiceToken(db, team, token, actingSeat) };
  }

  // v0.3 hard cutover (ADR 069 decision 2): the v0.2 per-seat token (`mskd_`) auth path is removed
  // for peer seats — the only credentials are the team agent key (`mskey_`), a human credential
  // (`mscr_`), and a service seat's own token (`mskd_`, ADR 232 — kind-bound, see above).
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
    throw new MusterdError('forbidden', agentKeySeatKindRefusal(actingSeat, member.kind).message);
  return member;
}

/**
 * SECURITY — the one statement of the agent-key seat-kind rule: **the shared team agent key may only
 * reach an AGENT seat.**
 *
 * It lives here, beside `authByAgentKey`, because three surfaces enforce it and they must not drift:
 * `authByAgentKey` (acting as a seat), the HTTP claim path, and both WebSocket claim branches. The
 * claim surfaces enforced it nowhere until this was extracted — `authByAgentKey` blocked *acting* as
 * a human seat, but claim resolves its target separately, so an agent key aimed at the human admin
 * seat was accepted and queued as a pending request (observed: HTTP 202) for an admin to approve.
 * That is the privilege-escalation path the acting check exists to close, reached one step earlier.
 *
 * The claim surfaces must apply this **after** target resolution — a `role` target can resolve to a
 * human seat — and **before** the grant/request branches, so no admin is ever asked to approve a
 * poisoned claim and no pending row leaks.
 */
export function agentKeyMayOccupy(member: Pick<MemberRow, 'kind' | 'observer'>): boolean {
  // Observer seats are minted `kind: 'human'` with `observer: 1` (ADR 063) and are claimed with the
  // team agent key by design — the /live wall and every watch-link are exactly that. They carry no
  // authority to inherit: an observer is hidden from the roster and cannot send, so occupying one
  // escalates nothing. Caught by three observer tests when this guard first read `kind === 'agent'`
  // alone; the rule is about AUTHORITY, not the nominal kind column.
  return member.kind === 'agent' || member.observer === 1;
}

/**
 * The refusal for {@link agentKeyMayOccupy} — shared so every surface says the same thing.
 *
 * Deliberately states what is *refused* rather than what is allowed, because the two callers enforce
 * slightly different rules and one enumeration cannot be true for both: the claim surfaces admit
 * agent **and** observer seats ({@link agentKeyMayOccupy}), while `authByAgentKey` admits agent seats
 * only — an observer is `kind: 'human'` and read-only, so it may be *occupied* with the team key but
 * never *acted as*. Naming the refused seat is accurate on both paths; naming the permitted set is
 * not.
 */
export function agentKeySeatKindRefusal(
  seat: string,
  kind: MemberKind = 'human',
): { message: string; hint: string } {
  // ADR 232: a service seat is equally out of the shared key's reach — its own minted `mskd_`
  // token is its identity, and the hint differs (there is no join flow for a cron).
  if (kind === 'service') {
    return {
      message:
        `the service seat "${seat}" is not reachable with the team agent key; it authenticates ` +
        'with its own service token',
      hint: 'musterd service install delivers the token file (ADR 232)',
    };
  }
  return {
    message:
      `the human seat "${seat}" is not reachable with the team agent key; it authenticates with ` +
      'its own credential',
    hint: `musterd join <team> --as ${seat} --key mscr_…`,
  };
}

/**
 * Service-token (`mskd_`) auth (ADR 232 §5): self-identifying, **kind-bound to `service`** — the
 * SQL predicate is the guard, exactly like `authByCredential`'s `kind = 'human'`. The `mskd_` seat
 * token has been minted by `addMember`/`reviveMember` all along; the v0.3 cutover removed its auth
 * path for *peer* seats (agents ride the shared team key, humans their credential) and that removal
 * stands. A ledger seat is the one actor with no folder to bind and no human to hold a credential —
 * its own minted token is its identity: no binding, no folder, no shared key. First touch stamps
 * `bound_at` (declared → held), which is what lets ambient presence (ADR 057) derive freshness from
 * its authenticated actions.
 */
function authByServiceToken(
  db: Database,
  team: TeamRow,
  token: string,
  actingSeat: string | undefined,
): MemberRow {
  const member = db
    .prepare<
      [string, string],
      MemberRow
    >("SELECT * FROM members WHERE team_id = ? AND token_hash = ? AND left_at IS NULL AND kind = 'service'")
    .get(team.id, hashToken(token));
  if (!member)
    throw new MusterdError('unauthorized', `invalid service token for team "${team.slug}"`);
  if (actingSeat && actingSeat !== member.name)
    throw new MusterdError(
      'forbidden',
      `service token identifies "${member.name}", not "${actingSeat}"`,
    );
  markBound(db, member.id);
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
  workingHours?: WorkingHours | null;
}

/**
 * Update a live member's durable identity in place (ADR 058 reconcile UPDATE path). Preserves `id`,
 * `token_hash`, and `bound_at` — the daemon-private anchors that must survive a reconcile so the
 * message log and any live token stay valid.
 */
export function updateMemberIdentity(db: Database, id: string, f: MemberIdentityFields): void {
  db.prepare(
    'UPDATE members SET kind = ?, role = ?, lifecycle = ?, lifecycle_until = ?, working_hours = ?, updated_at = ? WHERE id = ?',
  ).run(
    f.kind,
    f.role,
    f.lifecycle,
    f.lifecycleUntil,
    f.workingHours ? JSON.stringify(f.workingHours) : null,
    Date.now(),
    id,
  );
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
           working_hours = ?, token_hash = ?, bound_at = NULL, left_at = NULL, updated_at = ?
     WHERE id = ?`,
  ).run(
    f.kind,
    f.role,
    f.lifecycle,
    f.lifecycleUntil,
    f.workingHours ? JSON.stringify(f.workingHours) : null,
    hashToken(token),
    Date.now(),
    id,
  );
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
  roles?: string[],
): void {
  // `roles` (ADR 227) rides the governance write because reconcile is its single writer, like
  // capabilities; callers that don't project roles (admin routes, tests) leave the column untouched.
  if (roles === undefined) {
    db.prepare(
      'UPDATE members SET account_status = ?, capabilities = ?, updated_at = ? WHERE id = ?',
    ).run(accountStatus, capabilities, Date.now(), id);
    return;
  }
  db.prepare(
    'UPDATE members SET account_status = ?, capabilities = ?, roles = ?, updated_at = ? WHERE id = ?',
  ).run(accountStatus, capabilities, JSON.stringify(roles), Date.now(), id);
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
  const member = getMemberById(db, memberId);
  const now = Date.now();
  db.prepare(
    "UPDATE members SET left_at = ?, last_offline_reason = 'left_team', updated_at = ? WHERE id = ?",
  ).run(now, now, memberId);
  // ADR 196: soft-remove must free in-flight WIP — otherwise the board asserts ownership for a
  // name every roster filter already drops. awaiting_acceptance keeps the owner (verified-ness).
  if (member && member.left_at === null) {
    releaseInFlightClaimsForSeat(db, member.team_id, member.name, now);
  }
}

/** Sticky offline reason for an intentional seat release (unbind) — ADR 141, presence-honesty §2.3. */
export function markSeatReleased(db: Database, memberId: string): void {
  db.prepare(
    "UPDATE members SET last_offline_reason = 'seat_released', updated_at = ? WHERE id = ?",
  ).run(Date.now(), memberId);
}

/** Sticky offline reason for a clean session exit (graceful release) — presence-honesty §2.3. */
export function markSessionEnded(db: Database, memberId: string): void {
  db.prepare(
    "UPDATE members SET last_offline_reason = 'session_ended', updated_at = ? WHERE id = ?",
  ).run(Date.now(), memberId);
}

export { newToken };
