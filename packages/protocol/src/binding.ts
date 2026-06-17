import { z } from 'zod';
import { SurfaceSchema } from './acts.js';

/**
 * The workspace identity binding (ADR 018). One file per workspace —
 * `<workspace>/.musterd/binding.json` — is the single source of truth for "who am I here",
 * read by both the CLI and the MCP adapter so they can't drift. It holds a token, so it lives
 * outside version control (init gitignores it) and is written 0600.
 */
export const BINDING_DIR = '.musterd';
export const BINDING_FILE = 'binding.json';

export const BindingSchema = z.object({
  server: z.string(),
  team: z.string(),
  member: z.string(),
  token: z.string(),
  surface: SurfaceSchema,
});

export type Binding = z.infer<typeof BindingSchema>;
