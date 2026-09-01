import { z } from 'zod';
import { EnvelopeSchema } from './envelope.js';

/**
 * The daemon↔hub sync surface (ADR 325), increment 3b-i of the federation build.
 *
 * The replicated event is the ENVELOPE plus its origin stamp — deliberately not a parallel message
 * shape. `Envelope` already names its sender by seat name and its team by slug, which is exactly
 * what crossing a machine boundary requires: `messages.from_member` is a daemon-private id (ADR 325
 * keeps `id`/`token_hash` private and replicates roster identity through git instead), so shipping
 * one would dangle on the receiver or, worse, resolve to a different seat that happens to hold that
 * id there.
 *
 * Composing `EnvelopeSchema` rather than restating its fields keeps the act vocabulary, the `meta`
 * rules and the slug regex in ONE place. A restatement would drift from the local path, and the
 * drift would look exactly like "this act is replicable but unvalidated".
 */

/** One replicated event: an envelope, and the origin that minted it. */
export const SyncEventSchema = z.object({
  envelope: EnvelopeSchema,
  /** The `nodes` row id that minted this event — a principal the hub authenticated (ADR 328 §1). */
  origin_node: z.string().min(1),
  /**
   * Positive, not merely non-negative: `next_seq` holds the NEXT value to assign and starts at 1
   * (ADR 331 §Decision 2), so seq 0 never exists on any origin. Admitting it would invite a reader
   * to treat 0 as "unset", and a gap check to compare against a value no origin ever wrote.
   */
  origin_seq: z.number().int().positive(),
  /**
   * How the sending session was animated (ADR 131 §4). It travels because it is an attested fact
   * about the event — the reason ADRs 101/158 stamp attestation per-event at insert is precisely
   * that it survives replication.
   *
   * `created_at` deliberately does NOT travel. It is local receipt time, and shipping the origin's
   * would assert a falsehood about when this machine learned of the event; the receiver stamps its
   * own. Nothing enforces that absence beyond this note and zod's default strip — which is the
   * point of saying it here.
   */
  from_provenance: z.string().nullable(),
});
export type SyncEvent = z.infer<typeof SyncEventSchema>;

/**
 * One push is bounded. The route is authenticated by `msnode_`, but a credential-holding machine
 * that has fallen behind is the ordinary case, not the adversarial one — an unbounded batch would
 * let a legitimate catch-up allocate arbitrarily on the hub.
 */
export const SYNC_PUSH_MAX_BATCH = 500;

export const SyncPushRequestSchema = z.object({
  events: z.array(SyncEventSchema).max(SYNC_PUSH_MAX_BATCH),
});
export type SyncPushRequest = z.infer<typeof SyncPushRequestSchema>;

/**
 * `hub_seq_high` lets a pusher watch the canonical order advance without a second round trip — the
 * lag number ADR 325 §Observability promised (`hub_head − daemon_cursor`), computable at the push.
 */
export const SyncPushResponseSchema = z.object({
  accepted: z.number().int().nonnegative(),
  hub_seq_high: z.number().int().nonnegative(),
});
export type SyncPushResponse = z.infer<typeof SyncPushResponseSchema>;

/**
 * The pull side (3b-ii). `SyncEvent`'s shape, with `hub_seq` beside it because the puller's cursor
 * IS a hub_seq — the team's canonical order, assigned at ingest (ADR 335 §3).
 *
 * One deliberate loosening: `envelope.act` is a string here, not the `Act` enum. The push side
 * validates the act on ingest against the HUB's build, but the log outlives builds — a hub rolled
 * back, or a puller behind the hub, meets an act it cannot name. Classifying that is the FOLD's job
 * (its `unknown_act` stop: "upgrade this daemon", retried each tick, valid prefix applied). With the
 * enum here, the hub's own response re-parse refused the page and answered 500 to every puller,
 * which the puller logged as `sync_pull_failed` — indistinguishable from offline — and applied
 * nothing, not even the prefix before the poisoned event (dolly, #1155 review F1). The wire carries
 * what the log holds; the reader decides what it can apply.
 */
export const SyncPullEventSchema = SyncEventSchema.extend({
  envelope: EnvelopeSchema.innerType().extend({ act: z.string().min(1) }),
  hub_seq: z.number().int().positive(),
});
export type SyncPullEvent = z.infer<typeof SyncPullEventSchema>;

/** Same bound as push, for the same reason: a legitimate catch-up must not allocate unboundedly. */
export const SYNC_PULL_MAX_BATCH = SYNC_PUSH_MAX_BATCH;

export const SyncPullResponseSchema = z.object({
  events: z.array(SyncPullEventSchema).max(SYNC_PULL_MAX_BATCH),
  /** The hub's head, so a puller can compute lag (`hub_head − cursor`) without a second call. */
  hub_seq_high: z.number().int().nonnegative(),
});
export type SyncPullResponse = z.infer<typeof SyncPullResponseSchema>;
