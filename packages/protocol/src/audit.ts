import { z } from 'zod';
import { WIRE_ATTESTATION_SOURCES } from './model.js';

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
  /**
   * The model `actor` was attesting WHEN this row was written, and which tier attested it (ADR
   * 101/158; lane 01M2PAFNAS) — read from the actor's live presence at the write edge and frozen
   * on the row, so a later re-attestation never rewrites history. Null when the row names no
   * actor, when the actor attested nothing at the time, or on rows written before the columns
   * existed (absent from an older daemon: absence is not an assertion, ADR 236). `actor_model_source`
   * is null beside a real `actor_model` when the tier was unknown — never defaulted to `binding`.
   */
  actor_model: z.string().nullish(),
  actor_model_source: z.enum(WIRE_ATTESTATION_SOURCES).nullish(),
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
  'agent_seat_credential.minted',
  'agent_seat_credential.rotated',
  'agent_session_lease.minted',
  'agent_session_lease.renewed',
  'agent_session_lease.revoked',
  'governed.policy.change',
  'governed.launch.issue',
  'governed.launch.consume',
  'governed.launch.refused',
  'governed.launch.revoke',
  'governed.request.allow',
  'governed.request.deny',
] as const;
export type P3AuditAction = (typeof P3_AUDIT_ACTIONS)[number];
