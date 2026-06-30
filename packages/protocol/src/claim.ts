import { z } from 'zod';

/**
 * Folder **claim policy** (provisioning-recipe.md §5; ADR 018 ladder). `init` is once-per-folder and
 * writes a *policy*, not a fixed identity (claim-on-first-use): a session arrives unclaimed and is
 * given an identity when it's first used. The policy decides what `team_join {}` (and adapter
 * autojoin) does by default:
 *
 * - `chat`  — assign-in-chat (the editor default): nothing auto-claims; a human names the seat
 *   (`team_join {as}` / `musterd claim <name>`).
 * - `seat`  — solo bind: auto-claim the named seat.
 * - `role`  — pool: auto-claim the next open `<role>-<n>` handle.
 *
 * Autojoin fires ⇔ a default claim exists (`seat`/`role`); `chat` never auto-claims.
 */
export const ClaimPolicySchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('chat') }),
  z.object({ mode: z.literal('seat'), name: z.string().min(1) }),
  z.object({ mode: z.literal('role'), role: z.string().min(1) }),
]);
export type ClaimPolicy = z.infer<typeof ClaimPolicySchema>;

/** A seat name (and a role handle's base) must be a single token — the server rejects whitespace. */
const isBareToken = (v: string): boolean => v.length > 0 && !/\s/.test(v);

/**
 * Parse the `MUSTERD_CLAIM` grammar (the env half of the ADR 018 env→binding ladder) into a policy.
 * Grammar: unset / empty / `chat` → assign-in-chat; `seat:Ada` → solo bind; `role:backend` → pool.
 * An unrecognized / malformed value degrades to `chat` (never throws — a bad env var must not wedge
 * a session before it can even claim a seat).
 */
export function parseClaimPolicy(raw: string | undefined | null): ClaimPolicy {
  const s = (raw ?? '').trim();
  if (s === '' || s.toLowerCase() === 'chat') return { mode: 'chat' };
  const colon = s.indexOf(':');
  if (colon > 0) {
    const kind = s.slice(0, colon).trim().toLowerCase();
    const value = s.slice(colon + 1).trim();
    if (kind === 'seat' && isBareToken(value)) return { mode: 'seat', name: value };
    if (kind === 'role' && isBareToken(value)) return { mode: 'role', role: value };
  }
  return { mode: 'chat' };
}

/** Render a policy back into the `MUSTERD_CLAIM` grammar (binding write / env injection). */
export function formatClaimPolicy(policy: ClaimPolicy): string {
  switch (policy.mode) {
    case 'seat':
      return `seat:${policy.name}`;
    case 'role':
      return `role:${policy.role}`;
    case 'chat':
      return 'chat';
  }
}

/**
 * A **pending presence** marker (provisioning-recipe.md §6; ADR 033). An adapter that loads into an
 * unclaimed folder is *reachable but holds no seat*; it drops one of these files at
 * `.musterd/pending/<code>.json` so the L2 `musterd claim` can see it, list it when several coexist,
 * and disambiguate with `--for <code>`. The `code` is shown in the session's first output. Keyed by
 * `(team, workspace, connId, driver)` per the recipe; holds **no token** (it has no seat yet), so it
 * is not a secret. Delivery of the claimed identity is via the workspace binding (ADR 018), not this
 * file — the marker is the *visibility + disambiguation* affordance, not an IPC channel.
 */
export const PENDING_DIR = 'pending';

/**
 * The per-session **resolution** an external `musterd claim --for <code>` drops next to a pending
 * marker (ADR 034, extends ADR 033) so an *already-running* unclaimed adapter can occupy the seat and
 * go online without relaunching. Written `<code>.resolved.json` (0600); keyed by the same `code` as the
 * marker it answers. P3 (ADR 075): it now carries only the assigned **seat** name — the adapter already
 * holds the team agent key (`MUSTERD_AGENT_KEY`) and claims `{seat}` with it; no per-seat token exists.
 */
export const RESOLVED_SUFFIX = '.resolved.json';
export const ResolvedSessionSchema = z.object({
  seat: z.string().min(1),
});
export type ResolvedSession = z.infer<typeof ResolvedSessionSchema>;

export const PendingSessionSchema = z.object({
  /** Short human-typable disambiguation code, shown in the session's first output. */
  code: z.string().min(1),
  team: z.string(),
  workspace: z.string(),
  surface: z.string(),
  driver: z.string().optional(),
  /** The adapter's per-session connection id (the recipe's key tuple). */
  connId: z.string(),
  ts: z.number().int(),
});
export type PendingSession = z.infer<typeof PendingSessionSchema>;

/**
 * Pick the next open pool handle for a role — the lowest `<role>-<n>` (n ≥ 1) not in `taken`.
 * Used by `team_join {role}` / `musterd claim --role` to auto-mint the next free seat in a pool
 * (the recipe's `backend-2`). `taken` is the set of member names currently on the roster.
 */
export function nextRoleHandle(role: string, taken: Iterable<string>): string {
  const used = taken instanceof Set ? taken : new Set(taken);
  for (let n = 1; ; n++) {
    const handle = `${role}-${n}`;
    if (!used.has(handle)) return handle;
  }
}
