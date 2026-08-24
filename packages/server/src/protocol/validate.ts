import { EnvelopeSchema, type Envelope } from '@musterd/protocol';
import { z } from 'zod';
import { MusterdError } from '../errors.js';

/** Parse an unknown value as an Envelope, mapping zod failure to a validation MusterdError. */
export function parseEnvelope(value: unknown): Envelope {
  const result = EnvelopeSchema.safeParse(value);
  if (!result.success) {
    throw new MusterdError('validation', formatZod(result.error));
  }
  return result.data;
}

/** Parse with an arbitrary schema, mapping failure to a bad_request MusterdError. The input type
 *  parameter is `any` so preprocess-wrapped schemas (input `unknown`, e.g. ADR 296 legacy-key
 *  adoption) infer their OUTPUT type instead of collapsing `T` to `unknown`. */
export function parseOrBadRequest<T>(schema: z.ZodType<T, z.ZodTypeDef, any>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new MusterdError('bad_request', formatZod(result.error));
  }
  return result.data;
}

function formatZod(err: z.ZodError): string {
  return err.issues
    .map((i) => {
      const path = i.path.join('.');
      return path ? `${path}: ${i.message}` : i.message;
    })
    .join('; ');
}
