/**
 * The capability model's closed sets (ADR 070) as plain tuples — no zod. `capabilities.ts` builds
 * its enums from these and re-exports them, so there is one list per vocabulary; the browser reads
 * them without pulling zod into its bundle (`guards.ts`).
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
export type AccountStatus = (typeof ACCOUNT_STATUSES)[number];

/** The **admin-set** subset an admin may write to a seat-file; `provisioned`/`active` are derived from
 *  occupancy (never-occupied ⇒ `provisioned`), never stored. */
export const ADMIN_ACCOUNT_STATUSES = ['disabled', 'banned', 'archived'] as const;
export type AdminAccountStatus = (typeof ADMIN_ACCOUNT_STATUSES)[number];

/** `can_message` scope — whom a seat may message (`none` = muted). */
export const CAN_MESSAGE_SCOPES = ['team', 'none'] as const;
export type CanMessage = (typeof CAN_MESSAGE_SCOPES)[number];

/** What team state a seat may see. */
export const VISIBILITY_LEVELS = ['admin', 'team'] as const;
export type VisibilityLevel = (typeof VISIBILITY_LEVELS)[number];
