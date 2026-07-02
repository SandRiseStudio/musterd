import type { ErrorCode } from '@musterd/protocol';

/** CLI error carrying a process exit code. Maps protocol error codes per 04-cli.md. */
export class CliError extends Error {
  readonly exitCode: number;
  /** The originating protocol error code, when this wraps a server error — lets callers branch on the
   * failure kind (e.g. treat `conflict` as idempotent) instead of matching the message or exit code. */
  readonly code: ErrorCode | undefined;
  constructor(message: string, exitCode: number, code?: ErrorCode) {
    super(message);
    this.name = 'CliError';
    this.exitCode = exitCode;
    this.code = code;
  }
}

const CODE_EXIT: Record<ErrorCode, number> = {
  server_error: 1,
  bad_request: 2,
  validation: 3,
  unauthorized: 4,
  forbidden: 5,
  not_found: 6,
  conflict: 9,
  member_busy: 10,
  superseded: 11,
  version_mismatch: 1,
  // ADR 078 (SPEC A.8): a seat occupied at claim time reuses the 409/conflict exit (9); an expired
  // grant is an auth refusal (5). The claim command that emits these lands in the P3.3 cutover.
  claim_conflict: 9,
  expired_grant: 5,
};

export function exitForCode(code: ErrorCode): number {
  return CODE_EXIT[code];
}

/** Connection failures (daemon down) → exit 7. */
export function isConnRefused(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /ECONNREFUSED|fetch failed|ENOTFOUND|ECONNRESET/i.test(msg);
}
