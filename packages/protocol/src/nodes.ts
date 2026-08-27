import { z } from 'zod';

/**
 * The machine-credential surface (ADR 328), increment 3a of the ADR 325 federation build.
 *
 * A node is a machine-*team* principal, not a machine: federation is per-team by ADR 325's topology
 * (one team, one authority), so a daemon hosting two teams is admitted separately at two hubs,
 * revocable separately at each, and holds two node identities with two independent `origin_seq`
 * streams (ADR 331 §Decision 1).
 *
 * Every secret here follows the four kinds that came before: minted with a typed prefix, stored only
 * as a sha256 hash, returned in plaintext exactly once and never re-fetchable.
 */

/** `POST /teams/:slug/nodes/invite` — the enrollment code, shown **once**. */
export const NodeInviteMintSchema = z.object({
  invite: z.string(),
  /** When the code stops being accepted — ADR 328 §2 bounds trust-on-first-use by a short window. */
  expires_at: z.number().int(),
});
export type NodeInviteMint = z.infer<typeof NodeInviteMintSchema>;

/**
 * `POST /teams/:slug/nodes/join` — the joiner **presents** the node id it minted under migration
 * v47 rather than receiving a fresh one (ADR 331 §Decision 1). That is a change of who allocates the
 * identifier, not of who vouches for it: the hub still authenticates, still writes the
 * credential→origin binding itself under a guarded CAS, and still refuses an id already bound to a
 * different credential. What a sender proposes is not what a sender chose.
 */
export const NodeJoinRequestSchema = z.object({
  code: z.string().min(1),
  node_id: z.string().min(1),
  label: z.string().min(1),
});
export type NodeJoinRequest = z.infer<typeof NodeJoinRequestSchema>;

/** The durable machine credential, shown **once**. */
export const NodeJoinResponseSchema = z.object({
  node_credential: z.string(),
  node_id: z.string(),
  team: z.string(),
});
export type NodeJoinResponse = z.infer<typeof NodeJoinResponseSchema>;

/**
 * A node as an admin sees it. `credential_prefix` is the token *kind*, never a leading slice of the
 * secret and never the hash — enough to say "this node is enrolled", nothing an attacker can start
 * from. `.strip()` is zod's default and is load-bearing here rather than incidental: a server that
 * over-shares cannot widen this contract by sending more fields.
 */
export const NodeSummarySchema = z.object({
  id: z.string(),
  label: z.string(),
  /** Null until the node enrolls — v47 mints the row, enrollment fills these in (ADR 331 §1). */
  enrolled_at: z.number().int().nullable(),
  revoked_at: z.number().int().nullable(),
  last_seen_at: z.number().int().nullable(),
  credential_prefix: z.string().nullable(),
});
export type NodeSummary = z.infer<typeof NodeSummarySchema>;

export const NodeListSchema = z.object({ nodes: z.array(NodeSummarySchema) });
export type NodeList = z.infer<typeof NodeListSchema>;

/**
 * `POST /node/enroll` — the local half. The CLI does not call the hub itself: this machine's daemon
 * holds the v47 node row whose id must be presented and is what will hold the credential, so it
 * makes the call and writes `~/.musterd/node.json`. Letting the CLI write that file behind the
 * daemon would put two processes on one piece of machine-local state.
 */
export const NodeEnrollRequestSchema = z.object({
  /** Parsed as a URL because a secret gets posted at it — a typo should fail here, not at the wire. */
  hub_url: z.string().url(),
  code: z.string().min(1),
  team: z.string().min(1),
});
export type NodeEnrollRequest = z.infer<typeof NodeEnrollRequestSchema>;
