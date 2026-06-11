import type { ErrorCode } from '@musterd/protocol';

/** CLI error carrying a process exit code. Maps protocol error codes per 04-cli.md. */
export class CliError extends Error {
  readonly exitCode: number;
  constructor(message: string, exitCode: number) {
    super(message);
    this.name = 'CliError';
    this.exitCode = exitCode;
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
  version_mismatch: 1,
};

export function exitForCode(code: ErrorCode): number {
  return CODE_EXIT[code];
}

/** Connection failures (daemon down) → exit 7. */
export function isConnRefused(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /ECONNREFUSED|fetch failed|ENOTFOUND|ECONNRESET/i.test(msg);
}
