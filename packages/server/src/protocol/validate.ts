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

/** Parse with an arbitrary schema, mapping failure to a bad_request MusterdError. */
export function parseOrBadRequest<T>(schema: z.ZodType<T>, value: unknown): T {
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
