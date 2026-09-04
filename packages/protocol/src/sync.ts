import { z } from 'zod';
import { AuditEntrySchema } from './audit.js';
import { PolicyOverrideSchema } from './credentials.js';
import { EnvelopeSchema } from './envelope.js';
import { UpdateLaneSchema } from './lanes.js';

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

/**
 * One replicated LEDGER event (ADR 365): a best-effort audit verb that crosses the wire verbatim
 * and is projected into nothing — the ledger IS the projection. The lane event's shape under its
 * own tag, drawn from the same allocator, so a node's sequence stays dense across four kinds.
 *
 * Why a fourth tag rather than widening the lane filter: a stamped row whose action the fold has
 * never learned to project stops the fold at `unknown_lane_event`, and these verbs are exactly the
 * ones no projector exists for. The tag is the reader's licence to append without projecting.
 *
 * A ledger event carries no decision. The fold appends it to `audit` and nothing else; every
 * deciding reader of these verbs stays scoped to rows this machine minted (ADR 365 §3).
 */
export const SyncLedgerEventSchema = SyncLaneEventSchema.extend({ kind: z.literal('ledger') });
export type SyncLedgerEvent = z.infer<typeof SyncLedgerEventSchema>;

/**
 * One replicated POLICY event (residence-2 census gap 1, 2026-09-03): the `policy.change` audit row
 * the HUB writes when an admin sets team policy. Its own tag, in the lane event's shape under
 * its own tag — same allocator, same composed `AuditEntrySchema`.
 *
 * Policy is hub-authoritative (ADR 325 residence 1): a joiner never mints one of these. Its own
 * `POST /policy` forwards to the hub (the `/sync/lane` pattern, ADR 361), the hub decides and
 * stamps, and this event is how every other machine learns. The row's `detail` is the STORED sparse
 * override (ADR 185) verbatim — never the effective policy, which would bake this build's defaults
 * into every peer's row and kill the schema default there, the #530 failure the sparse row exists
 * to prevent.
 */
export const SyncPolicyEventSchema = SyncLaneEventSchema.extend({ kind: z.literal('policy') });
export type SyncPolicyEvent = z.infer<typeof SyncPolicyEventSchema>;

/**
 * One replicated CONTINUITY event (residence-2 census gap 2, 2026-09-03): the `continuity.*` audit
 * row a daemon writes when a seat saves or clears its memory, or advances its inbox cursor. The
 * fifth kind, in the lane event's shape under its own tag.
 *
 * Unlike `policy`, these are SEAT facts and any daemon mints them — the seat saves its note on the
 * machine it is working from. So residence binding applies here exactly as it does to messages and
 * lanes: a node may stamp continuity only for the seats resident on it, which is what makes ADR 358's
 * two-machine human the case worth testing.
 */
export const SyncContinuityEventSchema = SyncLaneEventSchema.extend({
  kind: z.literal('continuity'),
});
export type SyncContinuityEvent = z.infer<typeof SyncContinuityEventSchema>;

/**
 * One replicated RECORD event (ADR 371, residence-2 census gap 3): a `record.*` audit row whose
 * projection is an additive or append-only table and decides nothing — the sixth kind, in the lane
 * event's shape under its own tag. Three verbs: `record.tool_calls` (an adapter flush, folded into
 * `tool_call_stats` under the ORIGIN's hour bucket), `record.seed_thread` (a seed-thread entry,
 * keyed by `relay_id` and the member's NAME because `seeds.id` and `members.id` are daemon-private)
 * and `record.incident_report` (a pool row the HUB wrote — the pool is the hub's, ADR 371 §2, and
 * a joiner-minted one is refused at ingest exactly as a policy event is).
 *
 * The first two are seat facts and residence-bound like continuity; the third is hub-minted and
 * never passes ingest at all. Unlike the ledger kind, an unknown verb here STOPS the fold — a
 * record projects into a table, so a verb this build cannot project would be a row nothing reads.
 */
export const SyncRecordEventSchema = SyncLaneEventSchema.extend({ kind: z.literal('record') });
export type SyncRecordEvent = z.infer<typeof SyncRecordEventSchema>;

/** Any replicated kind. A plain `z.union`, not discriminated, because the message tag is optional. */
export const SyncEventSchema = z.union([
  SyncLaneEventSchema,
  SyncPresenceEventSchema,
  SyncLedgerEventSchema,
  SyncPolicyEventSchema,
  SyncContinuityEventSchema,
  SyncRecordEventSchema,
  SyncMessageEventSchema,
]);
export type SyncEvent = z.infer<typeof SyncEventSchema>;

/** The id the hub keys `sync_log` on: the envelope's for a message, the audit row's for every other kind. */
export function syncEventId(event: SyncEvent): string {
  return isAuditKind(event) ? event.event.id : event.envelope.id;
}

/** The kinds whose payload is an audit row, as opposed to the message's envelope. */
export function isAuditKind<T extends { kind?: string | undefined }>(
  event: T,
): event is T & { kind: 'lane' | 'presence' | 'ledger' | 'policy' | 'continuity' | 'record' } {
  return (
    event.kind === 'lane' ||
    event.kind === 'presence' ||
    event.kind === 'ledger' ||
    event.kind === 'policy' ||
    event.kind === 'continuity' ||
    event.kind === 'record'
  );
}

/** The team slug the event claims, for the hub's "pushed into the team it names" check. */
export function syncEventTeam(event: SyncEvent): string {
  return isAuditKind(event) ? event.team : event.envelope.team;
}

/**
 * The seat the event speaks AS — the residence check's subject (ADR 328 §4 at ingest, every kind):
 * the envelope's sender for a message, the audit row's actor for a lane or presence transition.
 * Null when the row has no seat behind it (a system-authored lane release, say); the hub then has
 * nothing to bind and nothing to refuse.
 */
export function syncEventActor(event: SyncEvent): string | null {
  if (isAuditKind(event)) return event.event.actor ?? null;
  return event.envelope.from;
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

export const SyncPullLedgerEventSchema = SyncLedgerEventSchema.extend({
  hub_seq: z.number().int().positive(),
});
export type SyncPullLedgerEvent = z.infer<typeof SyncPullLedgerEventSchema>;
export const SyncPullPolicyEventSchema = SyncPolicyEventSchema.extend({
  hub_seq: z.number().int().positive(),
});
export type SyncPullPolicyEvent = z.infer<typeof SyncPullPolicyEventSchema>;

export const SyncPullContinuityEventSchema = SyncContinuityEventSchema.extend({
  hub_seq: z.number().int().positive(),
});
export type SyncPullContinuityEvent = z.infer<typeof SyncPullContinuityEventSchema>;

export const SyncPullRecordEventSchema = SyncRecordEventSchema.extend({
  hub_seq: z.number().int().positive(),
});
export type SyncPullRecordEvent = z.infer<typeof SyncPullRecordEventSchema>;

export const SyncPullEventSchema = z.union([
  SyncPullLaneEventSchema,
  SyncPullPresenceEventSchema,
  SyncPullLedgerEventSchema,
  SyncPullPolicyEventSchema,
  SyncPullContinuityEventSchema,
  SyncPullRecordEventSchema,
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
 * Federation residence 1, every ownership/state edge (ADR 361): the generalisation of the claim.
 * A joiner forwards ANY lane patch that carries `owner_seat` or `state` — a claim, a release
 * (`state: open`), a handoff, a submit, a terminal close — with its read as `expect`, and the hub
 * runs the same policy and the same guarded CAS against ITS row. `patch` is the whole
 * `UpdateLane` body so one write lands one row; handler-level fields (`acceptor`,
 * `handoff_note`) ride along and the hub's store ignores them — the origin runs the post-effects.
 */
export const SyncLanePatchRequestSchema = z.object({
  lane: z.string().min(1),
  seat: z.string().min(1),
  patch: UpdateLaneSchema,
  expect: z.object({
    owner_seat: z.string().nullable(),
    state: z.string().min(1),
  }),
});
export type SyncLanePatchRequest = z.infer<typeof SyncLanePatchRequestSchema>;

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

/**
 * The joiner→hub policy forward (residence-2 census gap 1): the sparse override an admin chose on
 * the joiner, and the seat that chose it. The hub re-authorizes the actor against its OWN roster —
 * a node credential proves the machine, never that the person behind the request is an admin there.
 * `policy` carries replace semantics all the way through (ADR 185): what the wire omits is unset.
 */
export const SyncPolicyRequestSchema = z.object({
  actor: z.string().min(1),
  policy: PolicyOverrideSchema,
});
export type SyncPolicyRequest = z.infer<typeof SyncPolicyRequestSchema>;

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
  /**
   * The smallest lane id this log holds a `lane.opened` for — where its lane history begins. A
   * puller uses it to tell a transition for a lane that predates replication (skippable: no birth
   * exists anywhere) from one whose birth is merely missing (a hole, which must still block).
   * Defaults to `null` so an older hub's page still parses; a puller then blocks on both, exactly
   * as it did before this field existed.
   */
  lane_genesis: z.string().nullable().default(null),
});
export type SyncPullResponse = z.infer<typeof SyncPullResponseSchema>;
