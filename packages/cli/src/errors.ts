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
  // Federation 3c (ADR 355): the hub could not be asked to arbitrate a claim. Its own exit so a
  // script can tell "refused" (9) from "could not be decided" — retry later, never claim anyway.
  hub_unreachable: 12,
};

export function exitForCode(code: ErrorCode): number {
  return CODE_EXIT[code];
}

/**
 * Connection failures (daemon down) → exit 7.
 *
 * Deliberately broad: for *reporting* "can't reach the daemon", every one of these means the same
 * thing to a human. It is therefore the WRONG predicate for deciding whether to retry — see
 * {@link connectionNeverEstablished}.
 */
export function isConnRefused(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /ECONNREFUSED|fetch failed|ENOTFOUND|ECONNRESET/i.test(msg);
}

/**
 * Retry schedule for a request whose connection was refused (§ {@link connectionNeverEstablished}).
 *
 * A daemon bounce is a routine hole in HTTP availability, measured 2026-07-29 at **849ms** against a
 * throwaway daemon killed and relaunched the way `service refresh` does it. The auto-refresher has
 * driven that bounce **116 times** on the dogfood machine, every one through live sessions — its
 * quiet-period guard has never once deferred, because on a 12-seat box "some seat is connected" is
 * the steady state. The sum covers the measured outage about twice over while a daemon that is
 * genuinely stopped still fails in under two seconds. Mirrors the MCP adapter's schedule.
 *
 * Applied to WRITES only (§ {@link worthRetrying}).
 */
export const RETRY_DELAYS_MS = [250, 500, 1000];

/**
 * Only a write earns a retry. Losing an act is the damage; a lost read costs nothing, because the next
 * poll fetches it again.
 *
 * This matters most in the CLI, which is what the harness hooks invoke: `GET
 * /inbox/interrupt-check` runs at every tool boundary (ADR 088) in a fresh short-lived process, so an
 * in-process circuit breaker cannot help it. Retrying reads would therefore add the full retry budget
 * to every tool call for as long as the daemon stayed stopped.
 */
export function worthRetrying(method: string): boolean {
  return method !== 'GET';
}

/**
 * True only when the TCP connection was never established — the one case where re-sending is provably
 * safe, because the request never reached the server and so cannot have been acted on once already.
 *
 * A **reset** connection is excluded on purpose: it was live, the daemon may have processed the body
 * before dying, and re-posting would duplicate the act (a second message, a second lane claim).
 * Node's fetch gives refusal and reset the *same* `TypeError: fetch failed` message and puts the real
 * code only on `cause.code`, so this reads the cause where {@link isConnRefused} reads text and
 * cannot tell them apart.
 */
export function connectionNeverEstablished(err: unknown): boolean {
  return (err as { cause?: { code?: string } } | null | undefined)?.cause?.code === 'ECONNREFUSED';
}
