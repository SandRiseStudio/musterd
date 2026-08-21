import {
  type AccountStatus,
  AvailabilitySchema,
  WorkingHoursSchema,
  type Capabilities,
  CapabilitiesSchema,
  GENERALIST_CAPABILITIES,
  type Member,
  type MemberKind,
} from '@musterd/protocol';

/** Raw DB row shapes (snake_case, SQLite types). */
export interface TeamRow {
  id: string;
  slug: string;
  display: string | null;
  default_lifecycle: string;
  archived_at: number | null;
  /** v0.3 P3 (ADR 076): sha256 of the team's rotatable agent key. NULL until an admin sets one. */
  agent_key_hash: string | null;
  /** v0.3 P3 (ADR 076): team governance policy as JSON (`{ allow_pre_issued_grants }`). NULL ⇒ defaults. */
  policy: string | null;
  /** Recurring Team schedule, JSON-encoded; null means no Team default (ADR 206). */
  working_hours: string | null;
  created_at: number;
  updated_at: number;
}

export interface MemberRow {
  id: string;
  team_id: string;
  name: string;
  kind: MemberKind;
  role: string;
  /** Every role the seat holds (ADR 227), JSON array projected by reconcile. NULL ⇒ derive from the
   * legacy single `role` (db-only teams, pre-v31 rows). */
  roles: string | null;
  lifecycle: 'forever' | 'session' | 'until';
  lifecycle_until: number | null;
  availability: string | null;
  /** Recurring Member schedule, JSON-encoded; null inherits the Team default (ADR 206). */
  working_hours: string | null;
  token_hash: string | null;
  /** Held-since (ADR 058): set on first authenticated touch, cleared on rotation/reclaim. Null ⇒
   * declared-but-unheld (a stray `claim` may rotate it); non-null ⇒ held, only adoptable. */
  bound_at: number | null;
  /** Read-only observer seat (ADR 063): hidden from roster/counts/presence, can't send. 0/1. */
  observer: number;
  /** How much this observer may see (ADR 136): `'full'` — the whole timeline, the trusted local
   * dashboard; `'public'` — team/broadcast traffic only, a shared watch-link. NULL ⇒ `'full'`
   * (pre-v18 rows, and the default for a mint that doesn't ask). Meaningless when `observer = 0`. */
  observer_scope: string | null;
  /** Admin-set account-status override (ADR 070): disabled|banned|archived. NULL ⇒ derived from
   * occupancy (`bound_at`): held ⇒ active, never-held ⇒ provisioned. */
  account_status: string | null;
  /** Resolved effective capabilities as JSON (ADR 070), projected by reconcile from role defaults ⊕
   * per-seat narrowing. NULL ⇒ the generalist default (a db-only or not-yet-reconciled seat). */
  capabilities: string | null;
  /** v0.3 P3 (ADR 076): sha256 of this human's credential. NULL for agent seats / pre-P3 rows. */
  credential_hash: string | null;
  /** Sticky why-offline (ADR 141): `disconnected` | `signed_off`. NULL ⇒ never stamped / cleared on attach. */
  last_offline_reason: string | null;
  left_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface PresenceRow {
  id: string;
  member_id: string;
  surface: string;
  status: 'online' | 'away' | 'offline';
  conn_id: string | null;
  last_seen_at: number;
  /** Non-null once the connection has dropped: the member stays reclaimable until this time (ADR 010). */
  held_until: number | null;
  /** Why this presence exists, captured at attach (musterd/0.2, ADR 014). Null on pre-0.2 rows. */
  provenance: string | null;
  /** The gracefully-degrading "where" label captured at attach (ADR 014). Null when unknown. */
  workspace: string | null;
  /** The human driving this session, captured at attach (musterd/0.2, ADR 021). Null when none. */
  driver: string | null;
  /** Harness-attested model id for this occupancy (ADR 101). Attested, never verified; null when
   *  the adapter doesn't attest — rendered as `unknown`, never blocks. Re-attestable mid-occupancy. */
  model: string | null;
  /** WHICH TIER produced `model` (ADR 101 increment): `observed` (a harness probe saw it),
   *  `environment`, or `binding` (a declaration). Null when there is no model, and ALSO null on
   *  rows written before migration 42 or by clients that do not send it — "tier not known" is a
   *  distinct fact from "it was declared" and is never defaulted into one. */
  model_source: string | null;
  /** Client-attested build ref of the connecting dist (ADR 135): a git SHA, `-dirty`-suffixed for an
   *  uncommitted build. Null for unstamped/older clients. Only changes with a fresh claim (a build
   *  can only change on process restart), so there is no heartbeat re-attest path. */
  build: string | null;
  /** Client-attested feature epoch for this occupancy (ADR 148): the monotonic capability counter the
   *  connecting dist was built against. Null for older clients. Sticky across ambient heartbeats like
   *  `build`/`model`; the roster renders skew from it in place of the raw build ref. */
  epoch: number | null;
  /** The wake lease that spawned this occupancy (ADR 241) — the daemon-minted `lease_id` the
   *  actuator handed the child, attested back on claim. Null for every occupancy no wake caused,
   *  which is nearly all of them. The only column here that identifies rather than describes. */
  wake_lease: string | null;
  created_at: number;
}

export interface MessageRow {
  id: string;
  team_id: string;
  from_member: string;
  to_kind: 'member' | 'team' | 'broadcast';
  to_member: string | null;
  act: string;
  body: string;
  thread_id: string | null;
  meta: string | null;
  /** Sender's presence provenance at send time (v21, ADR 131 §4) — server-stamped, never wire-fed;
   *  the wake ledger's ping-pong demotion read. Null: pre-v21 row or no live presence at send. */
  from_provenance: string | null;
  ts: number;
  created_at: number;
}

/**
 * Resolve a seat's account status (ADR 070 Axis 1). An admin override (disabled/banned/archived) in
 * the column wins; otherwise it is **derived** from occupancy — a seat that has ever been held
 * (`bound_at`) is `active`, one that never has is `provisioned`. A malformed override degrades to the
 * derived value rather than failing the projection.
 */
export function resolveAccountStatus(row: MemberRow): AccountStatus {
  const override = row.account_status;
  if (override === 'disabled' || override === 'banned' || override === 'archived') return override;
  return row.bound_at !== null ? 'active' : 'provisioned';
}

/** Resolve a seat's effective capabilities (ADR 070): the reconcile-projected JSON, or the generalist
 *  default for a db-only / not-yet-reconciled seat. Parsed defensively (a bad blob ⇒ generalist). */
export function resolveCapabilities(row: MemberRow): Capabilities {
  if (!row.capabilities) return GENERALIST_CAPABILITIES;
  return CapabilitiesSchema.safeParse(JSON.parse(row.capabilities)).data ?? GENERALIST_CAPABILITIES;
}

/**
 * Observer grade (ADR 136). NULL ⇒ `'full'`: a pre-v18 row, or a mint that didn't ask. Defaulting to
 * full is safe *because minting is privileged* — ADR 134 restricts provisioning to a local peer or an
 * admin — so the only seats that reach this default were created by a trusted party. A shared
 * watch-link asks for `'public'` explicitly.
 */
export function resolveObserverScope(row: MemberRow): 'full' | 'public' {
  return row.observer_scope === 'public' ? 'public' : 'full';
}

/** Parse persisted working-hours JSON defensively; malformed legacy data means no schedule. */
export function parseWorkingHours(raw: string | null | undefined) {
  if (!raw) return null;
  try {
    return WorkingHoursSchema.safeParse(JSON.parse(raw)).data ?? null;
  } catch {
    return null;
  }
}

/**
 * May this seat read the team's *directed* traffic — every DM, not just its own?
 *
 * The single predicate behind both enforcement points (`GET /messages` and the firehose). They were
 * two independent `member.observer` / `conn.observer` tests before ADR 136, which is precisely the
 * shape that lets a scoping rule drift out of sync between the history read and the live stream.
 *
 * Full visibility is: an **admin**, or a **full-grade observer** (the trusted local dashboard). Every
 * other seat — ordinary members and public-grade observers alike — is recipient-scoped (ADR 128).
 */
export function hasFullMessageVisibility(row: MemberRow): boolean {
  if (resolveCapabilities(row).is_admin) return true;
  return row.observer === 1 && resolveObserverScope(row) === 'full';
}

/** The roles a seat holds (ADR 227). Defensive parse; NULL/corrupt falls back to the legacy single
 * `role` as a one-entry list (empty ⇒ the roleless generalist). */
export function parseRoles(row: MemberRow): string[] {
  if (row.roles) {
    try {
      const parsed: unknown = JSON.parse(row.roles);
      if (Array.isArray(parsed) && parsed.every((r) => typeof r === 'string')) return parsed;
    } catch {
      // fall through to the legacy derivation
    }
  }
  return row.role ? [row.role] : [];
}

/** Map a member row (+ its team slug) to the public protocol Member shape (no token_hash). */
export function toMember(row: MemberRow, teamSlug: string): Member {
  return {
    id: row.id,
    team: teamSlug,
    name: row.name,
    kind: row.kind,
    role: row.role,
    roles: parseRoles(row),
    lifecycle: row.lifecycle,
    lifecycle_until: row.lifecycle_until,
    // Parse defensively: a malformed/legacy availability blob degrades to `null` (implicit-available)
    // rather than failing the whole roster projection.
    availability: row.availability
      ? (AvailabilitySchema.safeParse(JSON.parse(row.availability)).data ?? null)
      : null,
    working_hours: parseWorkingHours(row.working_hours),
    account_status: resolveAccountStatus(row),
    capabilities: resolveCapabilities(row),
    created_at: row.created_at,
  };
}
