import { z } from 'zod';
import { SurfaceSchema } from './acts.js';
import { ClaimPolicySchema } from './claim.js';

/**
 * The workspace identity binding (ADR 018). One file per workspace —
 * `<workspace>/.musterd/binding.json` — is the single source of truth for "who am I here",
 * read by both the CLI and the MCP adapter so they can't drift. It holds a token, so it lives
 * outside version control (init gitignores it) and is written 0600.
 *
 * Claim-on-first-use (provisioning-recipe.md §5; ADR 032): `member`/`token` are **optional** — a
 * folder may be bound to a *claim policy* with no fixed identity (the pending-presence state), and a
 * seat is filled in when it's first claimed (`musterd claim` / `team_join`). A binding with neither
 * a concrete identity nor a non-`chat` policy is "unclaimed": reachable, holding no seat.
 */
export const BINDING_DIR = '.musterd';
export const BINDING_FILE = 'binding.json';

export const BindingSchema = z.object({
  server: z.string(),
  team: z.string(),
  member: z.string().optional(),
  token: z.string().optional(),
  surface: SurfaceSchema,
  /** Folder claim policy (ADR 018 ladder); absent ⇒ assign-in-chat. */
  claim: ClaimPolicySchema.optional(),
});

export type Binding = z.infer<typeof BindingSchema>;

/** Does this binding carry a concrete, claimed identity (member + token), vs only a policy? */
export function isClaimed(
  binding: Binding,
): binding is Binding & { member: string; token: string } {
  return Boolean(binding.member && binding.token);
}
