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
  // Bounded, not merely non-empty (ryder, 2026-08-27). This route is unauthenticated by design, so
  // an unbounded `label` lets any caller write megabytes into `nodes` and the audit ledger on a
  // REFUSED enrollment — the refusal path is the one an attacker can drive at will. A node id is a
  // ULID (26 chars); the ceiling is loose enough for a foreign id scheme and tight enough to be
  // uninteresting as a write primitive.
  code: z.string().min(1).max(256),
  node_id: z.string().min(1).max(128),
  label: z.string().min(1).max(200),
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

/**
 * A joiner whose push the hub refuses on residence (ADR 360): every event after the refused one is
 * stuck behind it, and the seat named is the one who can clear it. Local to the refused machine
 * (ADR 325 residence 3) — it describes THIS daemon's conversation with its hub.
 */
export const SyncWedgeSchema = z.object({
  /** The seat the refused event spoke as. */
  seat: z.string(),
  /** The node the hub says that seat lives on — label and id. */
  bound_to: z.string(),
  bound_node_id: z.string(),
  /** This machine's node id — what a `musterd node trust` from `bound_to` must name. */
  node_id: z.string(),
  kind: z.enum(['message', 'lane', 'presence']),
  /** When the hub first refused this seat, ms epoch. */
  since: z.number().int(),
});
export type SyncWedge = z.infer<typeof SyncWedgeSchema>;

/** One wording for every surface that shows a wedge — the roster, the inbox, `node list`. */
export function describeSyncWedge(w: SyncWedge, now: number = Date.now()): string {
  const mins = Math.max(0, Math.round((now - w.since) / 60_000));
  const ago = mins < 1 ? 'just now' : mins < 60 ? `${mins}m` : `${Math.round(mins / 60)}h`;
  return (
    `⚠ this machine's sync is wedged: the hub refuses its push because seat "${w.seat}" is bound ` +
    `to "${w.bound_to}" (a ${w.kind} event, since ${ago}). Nothing this machine writes reaches the ` +
    `team until it clears. Fix: from a session on "${w.bound_to}", run ` +
    `\`musterd node trust ${w.node_id}\` (ADR 358) — or an admin runs ` +
    `\`musterd node unbind ${w.seat}\` and the next act as ${w.seat} binds it here.`
  );
}

export const NodeListSchema = z.object({
  nodes: z.array(NodeSummarySchema),
  /** Present on a joiner whose push is refused; absent or null otherwise. Additive. */
  push: z.object({ wedged: SyncWedgeSchema.nullable() }).optional(),
});
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
