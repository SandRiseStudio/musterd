import { z } from 'zod';

/**
 * The v0.3 seat capability model (ADR 070, P1 of ADR 069) — the **typed substrate** for governance.
 * P1 ships the shape + its projection only; **nothing here is enforced yet** (P2 wires the Universe-1
 * fields into `routeEnvelope` / the roster projection). The fixed v0.2 set — no RBAC engine (a tar pit
 * to avoid early). Split by universe (ADR 026): musterd **enforces** Universe-1 in-band; Universe-2 is
 * **declared/provisioned only** — stored and served, never enforced (filesystem/tool access is the
 * harness's job).
 */

/** Account status — Axis 1 (SPEC A.6). `provisioned`/`active` are occupancy-derived; the rest are
 *  admin-set. Non-`active`/`provisioned` states gate claim/send in P2. */
export const ACCOUNT_STATUSES = [
  'provisioned',
  'active',
  'disabled',
  'banned',
  'archived',
] as const;
export const AccountStatusSchema = z.enum(ACCOUNT_STATUSES);
export type AccountStatus = (typeof ACCOUNT_STATUSES)[number];

/** The **admin-set** subset an admin may write to a seat-file; `provisioned`/`active` are derived from
 *  occupancy (never-occupied ⇒ `provisioned`), never stored. */
export const ADMIN_ACCOUNT_STATUSES = ['disabled', 'banned', 'archived'] as const;
export const AdminAccountStatusSchema = z.enum(ADMIN_ACCOUNT_STATUSES);
export type AdminAccountStatus = (typeof ADMIN_ACCOUNT_STATUSES)[number];

/** `can_message` scope — whom a seat may message (`none` = muted). The "specific roles" scope the
 *  design mentions is a roadmap refinement; v0.3 ships `team | none`. */
export const CanMessageSchema = z.enum(['team', 'none']);
export type CanMessage = z.infer<typeof CanMessageSchema>;

/** What team state a seat may see. `admin` sees everything (credentials/grants/audit/policy/all
 *  charters); `team` is the need-to-know projection (teammate handles + presence + acts to it). */
export const VisibilityLevelSchema = z.enum(['admin', 'team']);
export type VisibilityLevel = z.infer<typeof VisibilityLevelSchema>;

/**
 * The full effective capability record a seat carries. Universe-1 (enforced in P2): `is_admin`,
 * `can_flag_urgent`, `can_observe`, `can_message`, `visibility_level`. Universe-2 (declared only):
 * `tool_allowlist`, `declared_resource_scopes`.
 */
export const CapabilitiesSchema = z.object({
  is_admin: z.boolean(),
  can_flag_urgent: z.boolean(),
  can_observe: z.boolean(),
  can_message: CanMessageSchema,
  visibility_level: VisibilityLevelSchema,
  tool_allowlist: z.array(z.string()),
  declared_resource_scopes: z.array(z.string()),
});
export type Capabilities = z.infer<typeof CapabilitiesSchema>;

/** A partial capability override — what a `roles/<name>.toml` default or a per-seat narrowing carries
 *  (any subset of the fields). */
export const PartialCapabilitiesSchema = CapabilitiesSchema.partial();
export type PartialCapabilities = z.infer<typeof PartialCapabilitiesSchema>;

/**
 * The **generalist default** — preserves today's behaviour exactly (everyone may do everything): urgent
 * ungated, observe allowed, message the team, the `team` roster view, no declared scopes. `is_admin` is
 * the one non-permissive default (admin = creator-only); the team creator's seat sets it explicitly.
 */
export const GENERALIST_CAPABILITIES: Capabilities = {
  is_admin: false,
  can_flag_urgent: true,
  can_observe: true,
  can_message: 'team',
  visibility_level: 'team',
  tool_allowlist: [],
  declared_resource_scopes: [],
};

// Narrowing order for the scoped fields: a seat may move DOWN this rank, never up.
const CAN_MESSAGE_RANK: Record<CanMessage, number> = { none: 0, team: 1 };
const VISIBILITY_RANK: Record<VisibilityLevel, number> = { team: 0, admin: 1 };

/**
 * Narrow `override` against a `ceiling`, **never widening** (ADR 070). A boolean may only go
 * `true→false`; a scope may only move down its rank (`team→none`, `admin→team`); a declared list may
 * only subset (an empty ceiling list = "unrestricted", so a seat may declare a narrowing list under it).
 * An absent override field leaves the ceiling untouched. Pure.
 */
export function clampNarrow(
  ceiling: Capabilities,
  override: PartialCapabilities = {},
): Capabilities {
  const bool = (c: boolean, o: boolean | undefined) => (o === undefined ? c : c && o);
  const list = (c: string[], o: string[] | undefined) =>
    o === undefined ? c : c.length === 0 ? o : o.filter((x) => c.includes(x));
  return {
    is_admin: bool(ceiling.is_admin, override.is_admin),
    can_flag_urgent: bool(ceiling.can_flag_urgent, override.can_flag_urgent),
    can_observe: bool(ceiling.can_observe, override.can_observe),
    can_message:
      override.can_message === undefined
        ? ceiling.can_message
        : CAN_MESSAGE_RANK[override.can_message] < CAN_MESSAGE_RANK[ceiling.can_message]
          ? override.can_message
          : ceiling.can_message,
    visibility_level:
      override.visibility_level === undefined
        ? ceiling.visibility_level
        : VISIBILITY_RANK[override.visibility_level] < VISIBILITY_RANK[ceiling.visibility_level]
          ? override.visibility_level
          : ceiling.visibility_level,
    tool_allowlist: list(ceiling.tool_allowlist, override.tool_allowlist),
    declared_resource_scopes: list(
      ceiling.declared_resource_scopes,
      override.declared_resource_scopes,
    ),
  };
}

/**
 * Resolve a seat's effective capabilities: `generalist ⊕ roleDefaults` is the **ceiling** (roles are
 * admin-defined, so they set the ceiling freely — including `is_admin` for an admin role), then the
 * per-seat `override` **narrows** it (never widens). The single source of truth for what a seat may do,
 * shared by CLI, server, and (later) the MCP adapter.
 */
export function effectiveCapabilities(
  roleDefaults: PartialCapabilities = {},
  seatOverride: PartialCapabilities = {},
): Capabilities {
  // Roles set the ceiling freely (each unset field falls back to generalist). Explicit `??` per field
  // rather than a spread, so an absent partial key never reads as `undefined` under exactOptionalProps.
  const g = GENERALIST_CAPABILITIES;
  const ceiling: Capabilities = {
    is_admin: roleDefaults.is_admin ?? g.is_admin,
    can_flag_urgent: roleDefaults.can_flag_urgent ?? g.can_flag_urgent,
    can_observe: roleDefaults.can_observe ?? g.can_observe,
    can_message: roleDefaults.can_message ?? g.can_message,
    visibility_level: roleDefaults.visibility_level ?? g.visibility_level,
    tool_allowlist: roleDefaults.tool_allowlist ?? g.tool_allowlist,
    declared_resource_scopes: roleDefaults.declared_resource_scopes ?? g.declared_resource_scopes,
  };
  return clampNarrow(ceiling, seatOverride);
}

/** A Role: admin-defined default capabilities (partial — unset fields fall back to generalist) + an
 *  optional charter. Stored as `roles/<name>.toml`; the identity half of the CLI role-template that the
 *  server now owns (ADR 070). */
export const RoleSchema = z.object({
  name: z.string(),
  capabilities: PartialCapabilitiesSchema.default({}),
  charter: z.string().optional(),
});
export type Role = z.infer<typeof RoleSchema>;
