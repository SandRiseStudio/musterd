import { z } from 'zod';

/** Shared error codes used by WS error frames and HTTP responses; the CLI maps these to exit codes.
 *  P3 (ADR 078) adds `claim_conflict` (seat occupied; SPEC A.8) and `expired_grant` (grant expired). */
export const ERROR_CODES = [
  'bad_request',
  'validation',
  'unauthorized',
  'forbidden',
  'not_found',
  'conflict',
  'member_busy',
  'superseded',
  'version_mismatch',
  'server_error',
  'claim_conflict',
  'expired_grant',
  // Federation 3c (ADR 325 §Offline semantics): a hub-authoritative act — a lane claim on an
  // enrolled joiner — refuses while the hub is unreachable, with its OWN code so a caller can tell
  // "the hub said no" from "the hub could not be asked". Never a provisional claim.
  'hub_unreachable',
  // ADR 328 §4, enforced (ADR 355 amendment): a claim for a seat the hub has bound to ANOTHER node.
  // Authorization, not contention — the lane may be free; the node is not entitled to speak for
  // that seat. Its own code because the next move is neither "retry" nor "ask for a handoff": it
  // is an admin unbind, or claiming from the machine the seat lives on.
  'bound_elsewhere',
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];
export const ErrorCodeSchema = z.enum(ERROR_CODES);

/** HTTP status for each error code (02-protocol.md). */
export const ERROR_HTTP_STATUS: Record<ErrorCode, number> = {
  bad_request: 400,
  validation: 422,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  member_busy: 409,
  superseded: 409,
  version_mismatch: 426,
  server_error: 500,
  // ADR 078 (SPEC A.8): a seat occupied at claim time is 409; an expired grant is 403 — aligned with
  // June's P3.1 substrate (ADR 076), which mints + rejects grants and emits this code. SPEC A.8 allows
  // 410/403; 403 wins to keep the two protocol edits converging without conflict.
  claim_conflict: 409,
  expired_grant: 403,
  hub_unreachable: 503,
  bound_elsewhere: 403,
};

export const ErrorBodySchema = z.object({
  error: z.object({ code: ErrorCodeSchema, message: z.string() }),
});
export type ErrorBody = z.infer<typeof ErrorBodySchema>;
