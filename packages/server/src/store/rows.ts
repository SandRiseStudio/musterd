import {
  type AccountStatus,
  AvailabilitySchema,
  type Capabilities,
  CapabilitiesSchema,
  GENERALIST_CAPABILITIES,
  type Member,
} from '@musterd/protocol';

/** Raw DB row shapes (snake_case, SQLite types). */
export interface TeamRow {
  id: string;
  slug: string;
  display: string | null;
  default_lifecycle: string;
  archived_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface MemberRow {
  id: string;
  team_id: string;
  name: string;
  kind: 'agent' | 'human';
  role: string;
  lifecycle: 'forever' | 'session' | 'until';
  lifecycle_until: number | null;
  availability: string | null;
  token_hash: string | null;
  /** Held-since (ADR 058): set on first authenticated touch, cleared on rotation/reclaim. Null ⇒
   * declared-but-unheld (a stray `claim` may rotate it); non-null ⇒ held, only adoptable. */
  bound_at: number | null;
  /** Read-only observer seat (ADR 063): hidden from roster/counts/presence, can't send. 0/1. */
  observer: number;
  /** Admin-set account-status override (ADR 070): disabled|banned|archived. NULL ⇒ derived from
   * occupancy (`bound_at`): held ⇒ active, never-held ⇒ provisioned. */
  account_status: string | null;
  /** Resolved effective capabilities as JSON (ADR 070), projected by reconcile from role defaults ⊕
   * per-seat narrowing. NULL ⇒ the generalist default (a db-only or not-yet-reconciled seat). */
  capabilities: string | null;
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

/** Map a member row (+ its team slug) to the public protocol Member shape (no token_hash). */
export function toMember(row: MemberRow, teamSlug: string): Member {
  return {
    id: row.id,
    team: teamSlug,
    name: row.name,
    kind: row.kind,
    role: row.role,
    lifecycle: row.lifecycle,
    lifecycle_until: row.lifecycle_until,
    // Parse defensively: a malformed/legacy availability blob degrades to `null` (implicit-available)
    // rather than failing the whole roster projection.
    availability: row.availability
      ? (AvailabilitySchema.safeParse(JSON.parse(row.availability)).data ?? null)
      : null,
    account_status: resolveAccountStatus(row),
    capabilities: resolveCapabilities(row),
    created_at: row.created_at,
  };
}
