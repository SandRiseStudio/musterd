import { z } from 'zod';
import { ProvenanceSchema, SurfaceSchema } from './acts.js';
import { MemberSchema } from './member.js';
import { PROTOCOL_VERSION } from './version.js';

/**
 * The v0.3 `claim` WS handshake (SPEC A.3) — the governed, off-localhost successor to the live
 * `hello` frame. Replaces `hello` at the P3 hard cutover (ADR 069 decision 2; ADR 075/078): the auth
 * unit changes from *per-member token = identity* to **agent key** (authenticates a harness) **+ an
 * admin-issued grant** (authorizes occupying a seat). These schemas are the shared wire contract
 * June's P3.1 substrate + Cleo's P3.2 WS handshake import; they land first (ADR 078) so the server +
 * CLI surfaces build against a stable frame shape.
 *
 * Design notes surfaced for review in ADR 078:
 * - `v` pins to the current `PROTOCOL_VERSION` (additive frame types need no version bump to ship the
 *   schemas; the breaking handshake swap is the cutover's job, not the schema's).
 * - `seat` on `occupied` is the existing `MemberSchema` (P1 already carries `account_status` +
 *   `capabilities`). A dedicated `SeatSchema` with `occupied_by`/`activity`/`charter` is reserved for
 *   when those fields finalize; `charter` rides top-level on `occupied` here per SPEC A.3.
 * - `RefusedCode` is a WS-frame enum (SPEC A.8) — a superset of the HTTP `ErrorCode` that adds the
 *   account-state names `disabled`/`banned` (HTTP maps those to `forbidden` 403 per A.2). `forbidden`
 *   + `not_found` are reused; `claim_conflict` + `expired_grant` are new (also added to HTTP `ErrorCode`).
 */

/** The seat a claim targets: a named seat, the next open seat in a role pool, or an observer attach
 *  (SPEC A.3). A plain union — the variants carry different keys, so no single discriminator. */
export const ClaimTargetSchema = z.union([
  z.object({ seat: z.string() }),
  z.object({ role: z.string() }),
  z.object({ observe: z.literal(true) }),
]);
export type ClaimTarget = z.infer<typeof ClaimTargetSchema>;

/** The `refused` frame's reason code (SPEC A.8). `claim_conflict` = seat occupied; `expired_grant` =
 *  the presented grant is past its lifetime; `disabled`/`banned` surface the target seat's account
 *  state; `forbidden` = bad key / not allowed to observe / not admin; `not_found` = no such seat/role. */
export const REFUSED_CODES = [
  'claim_conflict',
  'forbidden',
  'not_found',
  'disabled',
  'banned',
  'expired_grant',
] as const;
export const RefusedCodeSchema = z.enum(REFUSED_CODES);
export type RefusedCode = (typeof REFUSED_CODES)[number];

/**
 * `claim` (client → server) — authenticate with the team agent key (or a human credential) and ask to
 * occupy a seat. A present `grant` authorizes occupancy; an omitted `grant` opens a claim request to
 * the admins (A.5). `key` is a secret — hashed at rest, never logged, never in `--json`.
 */
export const ClaimFrame = z.object({
  type: z.literal('claim'),
  v: z.literal(PROTOCOL_VERSION),
  team: z.string(),
  /** Agent join key (harness) or human credential (SPEC A.2). */
  key: z.string(),
  target: ClaimTargetSchema,
  /** Pre-issued grant token; omit → the server opens a claim request (A.5, default path). */
  grant: z.string().optional(),
  surface: SurfaceSchema,
  /**
   * The claiming session's workspace identity (ADR 068). Scopes agent single-active: a same-workspace
   * re-claim (e.g. a Claude Code health-check MCP probe, a transient autojoin spawn) does NOT supersede
   * the live seat — it would otherwise flap it every ~90s — while a different-workspace claim still
   * newest-wins (ADR 017). Optional for back-compat; the MCP/CLI clients already send it on the wire.
   */
  workspace: z.string().optional(),
  /** How this session was provisioned (ADR 014) + the human driving it (ADR 021) — presence metadata
   *  the live `hello` carried; surfaced on the roster. The client already sends both; recorded at OCCUPY. */
  provenance: ProvenanceSchema.optional(),
  driver: z.string().optional(),
  /**
   * Harness-attested model id for this occupancy (ADR 101). Attested, never verified — only the
   * harness knows which model sits in the seat; the durable seat stays model-agnostic (ADR 087), the
   * *occupancy* carries the model. Omitted → `unknown` (thin harnesses / old adapters; legal, never
   * blocks). Re-attestation rides a fresh claim/heartbeat from the same workspace (a `/model`
   * switch is real); the audit log keeps the switch history (`occupancy.model_attested`).
   */
  model: z.string().max(120).optional(),
});
export type ClaimFrame = z.infer<typeof ClaimFrame>;

/** The memory envelope delivered on occupy (ADR 093): headline + age + size, never the body — the
 *  body travels only over an explicit read (GET /teams/:slug/memory). `.strict()` so a body can
 *  never silently ride the occupied frame. */
export const MemoryEnvelopeSchema = z
  .object({
    headline: z.string().min(1).max(120),
    saved_at: z.number().int(),
    size_bytes: z.number().int().nonnegative(),
  })
  .strict();
export type MemoryEnvelope = z.infer<typeof MemoryEnvelopeSchema>;

/** `occupied` (server → client) — the claim succeeded; this session holds the seat. `charter` is
 *  identity metadata the server serves but never enforces; `memory` is the seat-scoped continuity
 *  envelope (ADR 093) — headline + age, or null when the seat has saved nothing. The body is fetched
 *  on demand (GET /teams/:slug/memory); it never rides this frame. */
export const OccupiedFrame = z.object({
  type: z.literal('occupied'),
  seat: MemberSchema,
  presence_id: z.string(),
  server_time: z.number().int(),
  charter: z.string().optional(),
  // A reusable `msgr_` resume token delivered when a seat is first approved (ADR 087). The session
  // persists it into `binding.grant` and re-presents it on reconnect to occupy without an approval —
  // the server refreshes its TTL on each clean occupy. Only set on the first-issue (approve) path.
  grant: z.string().optional(),
  memory: MemoryEnvelopeSchema.nullable(),
});
export type OccupiedFrame = z.infer<typeof OccupiedFrame>;

/** `refused` (server → client) — the claim was denied. `claimable` lists seats the caller may take
 *  instead; `hint` is the ready-to-paste next step (SPEC A.3, the ADR 055 no-dead-end rule). */
export const RefusedFrame = z.object({
  type: z.literal('refused'),
  code: RefusedCodeSchema,
  message: z.string(),
  claimable: z.array(z.string()).default([]),
  hint: z.string(),
});
export type RefusedFrame = z.infer<typeof RefusedFrame>;

/** `pending` (server → client) — no grant; the server opened a claim request (A.5) routed to admins.
 *  The WS stays open and the server **pushes** the terminal `occupied`/`refused` frame when an admin
 *  decides (spec-gap 3, ADR 069 — no client polling). */
export const PendingFrame = z.object({
  type: z.literal('pending'),
  request_id: z.string(),
  message: z.string(),
});
export type PendingFrame = z.infer<typeof PendingFrame>;
