import { z } from 'zod';
import { AuditEntrySchema } from './audit.js';
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

/**
 * One replicated MESSAGE event: an envelope, and the origin that minted it. `kind` is optional and
 * defaults to the message so that every event a 3b-ii build ever staged parses unchanged — the
 * lane kind below is the second, and it is the tagged one.
 */
export const SyncMessageEventSchema = z.object({
  kind: z.literal('message').optional(),
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
export type SyncMessageEvent = z.infer<typeof SyncMessageEventSchema>;

/**
 * One replicated LANE event (lane-replication spec §"The wire, decided"): a `lane.*` audit row —
 * the transition itself, written by the store inside the lane write's transaction — and the origin
 * that minted it. It draws `origin_seq` from the SAME allocator as messages (ADR 335 §8), so one
 * node's sequence is dense across both kinds and the hub's gap check holds unchanged.
 *
 * `AuditEntrySchema` is composed, not restated, for the reason ADR 335 §1 gives the envelope: the
 * receiver runs exactly the validation the sender's own daemon ran. `event.action` stays the open
 * string it has always been (ADR 074); the FOLD decides which verbs it can apply, and blocks on one
 * it cannot name rather than storing a transition it cannot project.
 *
 * `team` is the slug, checked by the hub against the authenticated node's team exactly as the
 * message envelope's `team` is. `event.ts` travels: it is the origin's clock, and the projected
 * lane's timestamps are the origin's facts about when it moved.
 */
export const SyncLaneEventSchema = z.object({
  kind: z.literal('lane'),
  team: z.string().min(1),
  event: AuditEntrySchema,
  origin_node: z.string().min(1),
  origin_seq: z.number().int().positive(),
});
export type SyncLaneEvent = z.infer<typeof SyncLaneEventSchema>;

/**
 * One replicated PRESENCE event (presence-replication spec 2026-09-02): a `presence.*` audit row —
 * attached, detached, reattested — the session transition, written where the presence row changed.
 * The lane event's shape under its own tag: same allocator, same composed `AuditEntrySchema`, and
 * the fold decides what it can project. Heartbeats never ride this wire.
 */
export const SyncPresenceEventSchema = SyncLaneEventSchema.extend({ kind: z.literal('presence') });
export type SyncPresenceEvent = z.infer<typeof SyncPresenceEventSchema>;

/** Any replicated kind. A plain `z.union`, not discriminated, because the message tag is optional. */
export const SyncEventSchema = z.union([
  SyncLaneEventSchema,
  SyncPresenceEventSchema,
  SyncMessageEventSchema,
]);
export type SyncEvent = z.infer<typeof SyncEventSchema>;

/** The id the hub keys `sync_log` on: the envelope's for a message, the audit row's for a lane or presence. */
export function syncEventId(event: SyncEvent): string {
  return event.kind === 'lane' || event.kind === 'presence' ? event.event.id : event.envelope.id;
}

/** The team slug the event claims, for the hub's "pushed into the team it names" check. */
export function syncEventTeam(event: SyncEvent): string {
  return event.kind === 'lane' || event.kind === 'presence' ? event.team : event.envelope.team;
}

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
export const SyncPullMessageEventSchema = SyncMessageEventSchema.extend({
  envelope: EnvelopeSchema.innerType().extend({ act: z.string().min(1) }),
  hub_seq: z.number().int().positive(),
});
export type SyncPullMessageEvent = z.infer<typeof SyncPullMessageEventSchema>;

export const SyncPullLaneEventSchema = SyncLaneEventSchema.extend({
  hub_seq: z.number().int().positive(),
});
export type SyncPullLaneEvent = z.infer<typeof SyncPullLaneEventSchema>;

export const SyncPullPresenceEventSchema = SyncPresenceEventSchema.extend({
  hub_seq: z.number().int().positive(),
});
export type SyncPullPresenceEvent = z.infer<typeof SyncPullPresenceEventSchema>;

export const SyncPullEventSchema = z.union([
  SyncPullLaneEventSchema,
  SyncPullPresenceEventSchema,
  SyncPullMessageEventSchema,
]);
export type SyncPullEvent = z.infer<typeof SyncPullEventSchema>;

/** Same bound as push, for the same reason: a legitimate catch-up must not allocate unboundedly. */
export const SYNC_PULL_MAX_BATCH = SYNC_PUSH_MAX_BATCH;

/**
 * Federation 3c: the hub-authoritative claim (ADR 325 §Authority split, residence 1). An enrolled
 * joiner does not decide a self-claim locally; it asks the hub, which runs the guarded CAS against
 * ITS row and writes the `lane.claimed` event from its own allocator — so the decision reaches
 * every machine, the joiner included, through the ordinary fold. `expect` is the joiner's read at
 * decision time, the same expectation the local PATCH carries (`LaneExpectation`): the hub refuses
 * if the lane has moved, naming the holder, instead of overwriting.
 *
 * Authenticated by the machine credential (`msnode_`); `seat` names the claimant on the shared
 * roster (ADR 058), never a daemon-private member id.
 */
export const SyncClaimRequestSchema = z.object({
  lane: z.string().min(1),
  seat: z.string().min(1),
  expect: z.object({
    owner_seat: z.string().nullable(),
    state: z.string().min(1),
  }),
});
export type SyncClaimRequest = z.infer<typeof SyncClaimRequestSchema>;

/**
 * A refused claim carries WHO holds the lane beside the error envelope, the way a sync gap carries
 * `expected_seq`: the caller can act on a name (ask for a handoff) where it cannot act on a
 * sentence. `holder` is null when the refusal is about state, not ownership.
 */
export const SyncClaimRefusalSchema = z.object({
  error: z.object({ code: z.literal('conflict'), message: z.string() }),
  holder: z.string().nullable(),
  state: z.string(),
});
export type SyncClaimRefusal = z.infer<typeof SyncClaimRefusalSchema>;

/**
 * ADR 328 §4, enforced: the seat is bound to another node. 403 with the bound node beside the
 * envelope, the way a claim refusal carries `holder` — the caller can act on a machine name (claim
 * from there, or ask an admin to unbind) where it cannot act on a sentence. Relayed verbatim by
 * a joiner to its caller.
 */
export const SeatBoundElsewhereRefusalSchema = z.object({
  error: z.object({ code: z.literal('bound_elsewhere'), message: z.string() }),
  node_id: z.string().min(1),
  node_label: z.string(),
});
export type SeatBoundElsewhereRefusal = z.infer<typeof SeatBoundElsewhereRefusalSchema>;

/**
 * ADR 358: the explicit trust act, forwarded by a joiner to the hub the way a claim is. The
 * authenticated node is the SPEAKER and must already be in `seat`'s set; `node_id` is the machine
 * being added. The hub answers `{ seat, node_id, already }`.
 */
export const SyncTrustRequestSchema = z.object({
  seat: z.string().min(1),
  node_id: z.string().min(1),
});
export type SyncTrustRequest = z.infer<typeof SyncTrustRequestSchema>;

export const SeatNodeTrustedSchema = z.object({
  seat: z.string().min(1),
  node_id: z.string().min(1),
  /** True when the node was already in the set — the act was idempotent, nothing was written. */
  already: z.boolean(),
});
export type SeatNodeTrusted = z.infer<typeof SeatNodeTrustedSchema>;

export const SyncPullResponseSchema = z.object({
  events: z.array(SyncPullEventSchema).max(SYNC_PULL_MAX_BATCH),
  /** The hub's head, so a puller can compute lag (`hub_head − cursor`) without a second call. */
  hub_seq_high: z.number().int().nonnegative(),
  /**
   * Every node of the team with the hub's liveness stamp (presence replication §3). A remote
   * presence row is live while its node is; this is how a joiner learns that. Defaults to empty
   * so an older hub's page still parses — every remote row then reads not-live, the conservative
   * answer.
   */
  nodes: z
    .array(
      z.object({
        id: z.string().min(1),
        label: z.string(),
        last_seen_at: z.number().int().nullable(),
      }),
    )
    .default([]),
});
export type SyncPullResponse = z.infer<typeof SyncPullResponseSchema>;
