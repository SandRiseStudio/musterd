import { ERROR_HTTP_STATUS, type ErrorBody, type ErrorCode } from '@musterd/protocol';

/** The single server error type. Carries a protocol error code; transports serialize it. */
export class MusterdError extends Error {
  readonly code: ErrorCode;
  constructor(code: ErrorCode, message: string) {
    super(message);
    this.name = 'MusterdError';
    this.code = code;
  }

  get httpStatus(): number {
    return ERROR_HTTP_STATUS[this.code];
  }

  toBody(): ErrorBody {
    return { error: { code: this.code, message: this.message } };
  }

  toFrame(): { type: 'error'; code: ErrorCode; message: string } {
    return { type: 'error', code: this.code, message: this.message };
  }
}

/** Coerce any thrown value into a MusterdError (unknown errors become server_error). */
export function asMusterdError(err: unknown): MusterdError {
  if (err instanceof MusterdError) return err;
  const message = err instanceof Error ? err.message : String(err);
  return new MusterdError('server_error', message);
}
