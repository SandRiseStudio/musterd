import { z } from 'zod';

/** Shared error codes used by WS error frames and HTTP responses; the CLI maps these to exit codes. */
export const ERROR_CODES = [
  'bad_request',
  'validation',
  'unauthorized',
  'forbidden',
  'not_found',
  'conflict',
  'member_busy',
  'version_mismatch',
  'server_error',
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
  version_mismatch: 426,
  server_error: 500,
};

export const ErrorBodySchema = z.object({
  error: z.object({ code: ErrorCodeSchema, message: z.string() }),
});
export type ErrorBody = z.infer<typeof ErrorBodySchema>;
