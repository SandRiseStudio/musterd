import { z } from 'zod';

/**
 * The governance audit log entry (ADR 071) — the append-only who-did-what trace a team admin reads
 * via `GET /teams/:slug/audit`. One row per governed decision (`urgent.flagged/denied`,
 * `send.denied`, `member.reclaim/remove`, `observe.denied` in P2).
 *
 * `action` is an **OPEN string**, deliberately not enumerated: ADR 071 shapes the table for the P3
 * verbs (`grant.*`, `claim.*`, `account_status.change`, `key.rotate`, `policy.change`,
 * `request.decide`) that will add rows, not schema. Enumerating here would force a protocol bump on
 * every new verb; the open string keeps the wire contract forward-compatible. The CLI renders
 * unknown actions plainly rather than rejecting them (ADR 074).
 *
 * `detail` is the JSON context the server parses back to an object (`{ reason }`,
 * `{ fallback: 'no-admin' }`, …); it never carries secrets and is `null` when absent.
 */
export const AuditEntrySchema = z.object({
  id: z.string(),
  ts: z.number().int(),
  /** Seat name that initiated the op; null for system/reaper writes. */
  actor: z.string().nullable(),
  /** Dotted governance verb. Open string — see file doc. */
  action: z.string(),
  /** Affected seat/resource name; null when not seat-scoped. */
  target: z.string().nullable(),
  /** The authorization outcome; an executed governance op is `allow`. */
  result: z.enum(['allow', 'deny']),
  /** JSON-serializable context; null when the entry carries none. */
  detail: z.record(z.string(), z.unknown()).nullable(),
});
export type AuditEntry = z.infer<typeof AuditEntrySchema>;

/** Response body of `GET /teams/:slug/audit` — entries newest-first, capped by `limit`/`before`. */
export const AuditResponseSchema = z.object({
  audit: z.array(AuditEntrySchema),
});
export type AuditResponse = z.infer<typeof AuditResponseSchema>;

/**
 * The P3 audit-verb vocabulary (ADR 078) — the dotted governance actions the P3 server emits. This is
 * a **reference tuple, not an enum**: `AuditEntrySchema.action` stays an OPEN string (ADR 074) so a new
 * verb never forces a protocol bump. It exists to pin the names June's P3.1 substrate + Cleo's P3.2
 * handshake emit (`grant.issue`/`grant.use`/`grant.revoke`, `claim.occupy`/`claim.refused`,
 * `request.decide`, `key.rotate`, `policy.change`, `account_status.change`) so the audit log + its
 * tests use one consistent vocabulary. P2's verbs (`urgent.flagged`/`denied`, `send.denied`,
 * `member.reclaim`/`remove`, `observe.denied`, ADR 071) precede these.
 */
export const P3_AUDIT_ACTIONS = [
  'grant.issue',
  'grant.use',
  'grant.revoke',
  'claim.occupy',
  'claim.refused',
  'request.decide',
  'key.rotate',
  'policy.change',
  'account_status.change',
] as const;
export type P3AuditAction = (typeof P3_AUDIT_ACTIONS)[number];
