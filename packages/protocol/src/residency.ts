import { z } from 'zod';
import { MemoryEnvelopeSchema } from './claim-handshake.js';
import { WAKEABILITIES } from './model.js';

/**
 * Harness residency (ADR 131, increment 2) — the wake-ledger wire shapes. A seat *enrolls* into
 * residency (opt-in, admin-authorized); the daemon then derives wake-due work for it while it is
 * offline and hands short-TTL **wake leases** to the per-host actuator (`musterd host`, increment 3).
 * The daemon side is pure store+transport: it orders wakes, it never spawns anything.
 */

/** The two wake lanes (ADR 131 §3): interrupt-class acts wake immediately; ordinary unanswered
 *  directed acts wake on a cooldown window. */
export const WAKE_LANES = ['immediate', 'batched'] as const;
export type WakeLane = (typeof WAKE_LANES)[number];
export const WakeLaneSchema = z.enum(WAKE_LANES);

/**
 * Wake policy — the ADR 131 §3 knobs (increment 5). Team defaults live on `teams.policy`
 * (`PolicySchema.residency`); a per-seat enrollment override is a **sparse** partial stored in
 * `residency.policy`, so later team-default changes flow through unset keys. Defaults are defined
 * here and nowhere else — the server derives every rate gate from the parsed schema.
 *
 * There is deliberately no `lane: off`: an enrollment that can never wake is a contradiction (the
 * standing grant and the roster's `wakeable` badge would lie). "Stop waking this seat" is
 * `residency off` (the kill switch); "pause this machine" is stopping the actuator.
 */
export const ResidencyPolicySchema = z.object({
  /** Which wake lanes are live for the seat: both (launch default), or one. */
  lane: z.enum(['both', 'interrupt', 'batched']).default('both'),
  /** Batched-lane cooldown between wakes (1min–24h). */
  cooldown_ms: z.number().int().min(60_000).max(86_400_000).default(1_800_000),
  /** Wakes per seat per hour, both lanes. */
  hourly_cap: z.number().int().min(1).max(20).default(2),
  /** Attempts per act before a terminal `residency.wake_exhausted`. */
  attempt_cap: z.number().int().min(1).max(10).default(3),
  /** `reply-only` scopes the woken session to the musterd tools; `seat-policy` defers to the
   *  workspace's own settings. Neither ever widens permissions (ADR 131 §6). */
  tool_policy: z.enum(['reply-only', 'seat-policy']).default('reply-only'),
  /** Watchdog timeout for the wake run — the one universally enforceable bound. The actuator's
   *  local `--timeout` flag stays the ceiling; policy can only tighten it. */
  timeout_ms: z.number().int().min(30_000).max(3_600_000).default(300_000),
  /** Turn cap, applied where the backend supports it. */
  max_turns: z.number().int().min(1).max(200).optional(),
  /** Spend *report* bound: wakes whose attested cost exceeds it are flagged `over_budget` in the
   *  report. No backend can kill a run mid-flight on dollars — enforcement stays with
   *  cooldown/caps/watchdog (owner call, 2026-07-14). */
  budget_usd: z.number().positive().max(100).optional(),
  /** Resume hygiene bound: transcripts past this roll over to a fresh session (64KiB–256MiB).
   *  Default 256KiB — a *cost* crossover, recalibrated against the wake ledger on 2026-07-29 (see
   *  ADR 131 "Observability & Evaluation"). The previous 10MiB counted lives, not dollars, and sat
   *  ~23x past the point where resume stops being the cheap option. */
  transcript_max_bytes: z.number().int().min(65_536).max(268_435_456).default(262_144),
  /** ADR 209 rollout gate. Off preserves the legacy resume ladder for ordinary inbox wakes; when
   * enabled, those wakes receive portable context and intentionally start fresh. Typed handoffs,
   * reviews, and work-orders are portable regardless of this cohort flag. */
  portable_inbox_replies: z.boolean().default(false),
  /**
   * Board-triggered work-order trust (ADR 179 / ADR 191 / ADR 199). At `manual` (launch default)
   * the seat is never a work-order wake *target* — bit-identical to pre-179. `auto` opts the seat
   * into review / dispatch (and later merge) when the matching team `loops.*` switch is also on.
   * Inbox reply wakes (immediate/batched) are unchanged by this knob.
   */
  flow: z.enum(['manual', 'auto']).default('manual'),
  /**
   * ADR 214 (ADR 211 increment 2). When a Member defers an act (`wait` + `meta.defer_ref`) it stops being a
   * wake reason — they said "not now". When its condition later fires the act becomes pending
   * again; this knob decides whether that also makes it wake-eligible. Off (launch default) means a
   * raised deferral waits in the inbox for the seat to come back on its own.
   *
   * Deliberately NOT `flow`/`loops.*`: those gate board-triggered WORK-ORDER wakes and say so — a
   * raised deferral is an ordinary inbox act. ADR 211 §4 assumed otherwise; ADR 214 corrects it.
   * This mirrors `portable_inbox_replies` instead, the other ADR-rollout gate on the inbox path.
   *
   * A raised act always takes the **batched** lane, never the interrupt line, even when the
   * original act was urgent: the Member already chose to put it down, so its return must not jump
   * the queue their deferral took it out of.
   */
  raised_deferral_wakes: z.boolean().default(false),
  /** Watchdog for work-order wakes only (ADR 191 / 199) — a coding session, not a reply. Default
   *  30m. Work-orders do not clamp below this on the host (ADR 199); reply wakes still honor the
   *  operator `--timeout` ceiling. */
  work_timeout_ms: z.number().int().min(60_000).max(3_600_000).default(1_800_000),
});
export type ResidencyPolicy = z.infer<typeof ResidencyPolicySchema>;

/** A per-seat enrollment override: same knobs, all optional — only explicitly-set keys stick. */
export const ResidencyPolicyOverrideSchema = ResidencyPolicySchema.partial();
export type ResidencyPolicyOverride = z.infer<typeof ResidencyPolicyOverrideSchema>;

/** A seat's residency enrollment (public shape — the standing grant travels once, never here). */
export const ResidencySchema = z.object({
  id: z.string(),
  team: z.string(),
  seat: z.string(),
  /** Harness class (`claude-code`, `codex`, …) — an open string: new harnesses are backends, not
   *  protocol bumps (ADR 131 §7). */
  harness: z.string(),
  /** The one enrolled host for this seat (last-enrolled-wins, audited) — the machine whose
   *  `musterd host` is the actuator. The daemon never learns workspace paths, only the host name. */
  host: z.string(),
  /** The standing resume grant issued at enrollment (id only; revoking it is the kill switch). */
  grant_id: z.string().nullable(),
  /** Who authorized the enrollment (ADR 127 actor≠authorizer). */
  authorized_by: z.string().nullable(),
  /** When the seat last attested a capturable session (ADR 131 §5, increment 4) — the resumable
   *  attestation is harness-class-only, so this timestamp is ALL the daemon learns about sessions:
   *  never an id, never a transcript path. Null until the first `musterd session start` push. */
  resumable_at: z.number().int().nullable(),
  /** The seat's sparse policy override (increment 5) — null when the team defaults govern whole. */
  policy: ResidencyPolicyOverrideSchema.nullish(),
  created_at: z.number().int(),
  updated_at: z.number().int(),
});
export type Residency = z.infer<typeof ResidencySchema>;

/** Body of `POST /teams/:slug/residency/enroll` (admin-authorized; `musterd residency on`). */
export const EnrollResidencyBodySchema = z.object({
  seat: z.string(),
  harness: z.string().min(1).max(40),
  host: z.string().min(1).max(120),
  /** Per-seat knob override. Absent = preserve any existing override (a drift-fixing re-enroll
   *  must not nuke tuning); present = replace wholesale; `{}` = clear back to team defaults. */
  policy: ResidencyPolicyOverrideSchema.optional(),
});
export type EnrollResidencyBody = z.infer<typeof EnrollResidencyBodySchema>;

/** Response of enroll: the enrollment + the standing grant token, shown **once** — the CLI writes
 *  it into the seat's `binding.grant` so woken sessions occupy via the seat's own credential. */
export const EnrollResidencyResponseSchema = z.object({
  residency: ResidencySchema,
  grant: z.string(),
  /** True when the seat had a live session at enroll time — that session occupies via the grant
   *  this enroll just superseded, and the new grant/policy only govern from its next wake/claim. */
  seat_live: z.boolean().optional(),
});
export type EnrollResidencyResponse = z.infer<typeof EnrollResidencyResponseSchema>;

/** Body of `POST /teams/:slug/residency/revoke` (`musterd residency off` — the kill switch). */
export const RevokeResidencyBodySchema = z.object({
  seat: z.string(),
});
export type RevokeResidencyBody = z.infer<typeof RevokeResidencyBodySchema>;

/**
 * Body of `POST /teams/:slug/residency/session` — the resumable attestation (ADR 131 §5,
 * increment 4), pushed by `musterd session start|end --stdin` from the SessionStart/SessionEnd
 * hooks. Harness CLASS only, by construction: this schema has no field for a session id or a
 * transcript path, so they cannot cross the wire. Agent-key authenticated (the hook holds only the
 * workspace binding), presence-neutral (ADR 057 — capture must never flip the roster) and never
 * claiming (ADR 108 — a hook must never displace the live occupant).
 */
export const SessionAttestationBodySchema = z.object({
  seat: z.string(),
  harness: z.string().min(1).max(40),
  event: z.enum(['start', 'end']),
});
export type SessionAttestationBody = z.infer<typeof SessionAttestationBodySchema>;

/** Response of the session attestation push: `enrolled` says whether a residency row recorded it. */
export const SessionAttestationResponseSchema = z.object({
  ok: z.boolean(),
  enrolled: z.boolean(),
});
export type SessionAttestationResponse = z.infer<typeof SessionAttestationResponseSchema>;

/** Response of `GET /teams/:slug/residency` — the team's enrollments. */
export const ResidencyListResponseSchema = z.object({
  residency: z.array(ResidencySchema),
  /** The team's wake-policy defaults (fully defaulted), so `residency status` can render the
   *  effective policy and star the seat-overridden knobs. Optional for back-compat. */
  policy_defaults: ResidencyPolicySchema.optional(),
});
export type ResidencyListResponse = z.infer<typeof ResidencyListResponseSchema>;

/** Body of `POST /teams/:slug/residency/wake-leases` — the host's poll, authenticated with the
 *  team agent key (the host is harness-side infrastructure, not a seat; ADR 131 §1). */
export const WakeLeasesBodySchema = z.object({
  host: z.string().min(1).max(120),
});
export type WakeLeasesBody = z.infer<typeof WakeLeasesBodySchema>;

/**
 * One wake order (ADR 131 §4): the daemon derived a due wake, inserted a lease, and hands the host
 * what to actuate. Structured fields only — **no message bodies ever cross here** (ADR 088/128);
 * the woken session reads its inbox through the same governed tools as any session.
 */
/** How a wake was derived (ADR 191 / 199). Inbox lanes stay `immediate`/`batched`; board-triggered
 *  review and dispatch wakes are `work_order`. Optional on the wire for older hosts. */
export const WAKE_DERIVATIONS = ['immediate', 'batched', 'work_order'] as const;
export type WakeDerivation = (typeof WAKE_DERIVATIONS)[number];
export const WakeDerivationSchema = z.enum(WAKE_DERIVATIONS);

/** ADR 209: whether durable, fetchable context is enough, or active dialogue is required. */
export const CONTINUITY_REQUIREMENTS = ['portable', 'transcript_required'] as const;
export type ContinuityRequirement = (typeof CONTINUITY_REQUIREMENTS)[number];
export const ContinuityRequirementSchema = z.enum(CONTINUITY_REQUIREMENTS);

/** The daemon's intended host delivery path. The host reports its actual outcome separately. */
export const WAKE_DELIVERIES = ['fresh', 'resume'] as const;
export type WakeDelivery = (typeof WAKE_DELIVERIES)[number];
export const WakeDeliverySchema = z.enum(WAKE_DELIVERIES);

/** The host-observed outcome, including a resume that fell through to a fresh occupant. */
export const WAKE_DELIVERY_OUTCOMES = ['fresh', 'resumed', 'fresh_fallback'] as const;
export type WakeDeliveryOutcome = (typeof WAKE_DELIVERY_OUTCOMES)[number];
export const WakeDeliveryOutcomeSchema = z.enum(WAKE_DELIVERY_OUTCOMES);

export const WAKE_CONTEXT_KINDS = ['reply', 'handoff', 'review', 'work_order'] as const;
export type WakeContextKind = (typeof WAKE_CONTEXT_KINDS)[number];
export const WakeContextKindSchema = z.enum(WAKE_CONTEXT_KINDS);

export const WAKE_CONTEXT_ACTIONS = ['reply', 'review', 'continue_lane', 'begin_lane'] as const;
export type WakeContextAction = (typeof WAKE_CONTEXT_ACTIONS)[number];
export const WakeContextActionSchema = z.enum(WAKE_CONTEXT_ACTIONS);

export const WAKE_CONTEXT_FETCHES = [
  'inbox_thread',
  'lane_detail',
  'seat_memory',
  'git_artifact',
] as const;
export type WakeContextFetch = (typeof WAKE_CONTEXT_FETCHES)[number];
export const WakeContextFetchSchema = z.enum(WAKE_CONTEXT_FETCHES);

/** Recipient request for the bounded context index; exactly one canonical target is required. */
export const WakeContextRequestSchema = z
  .object({ act_id: z.string().min(1).optional(), lane_id: z.string().min(1).optional() })
  .strict()
  .superRefine((value, ctx) => {
    if ((value.act_id === undefined) === (value.lane_id === undefined)) {
      ctx.addIssue({
        code: 'custom',
        message: 'exactly one of act_id or lane_id is required',
        path: ['act_id'],
      });
    }
  });
export type WakeContextRequest = z.infer<typeof WakeContextRequestSchema>;

/** The server-derived, body-free context index (ADR 209). */
export const WakeContextPacketSchema = z
  .object({
    version: z.literal(1),
    wake: z
      .object({
        kind: WakeContextKindSchema,
        act_id: z.string().min(1).optional(),
        lane_id: z.string().min(1).optional(),
      })
      .strict(),
    objective: z.object({ action: WakeContextActionSchema }).strict(),
    state: z
      .object({
        lane: z
          .object({
            id: z.string().min(1),
            state: z.string().min(1),
            owner_seat: z.string().min(1).nullable(),
            branch: z.string().min(1).optional(),
          })
          .strict()
          .optional(),
        thread: z
          .object({
            id: z.string().min(1),
            participant_count: z.number().int().nonnegative(),
            unread_count: z.number().int().nonnegative(),
            latest_act: z.string().min(1).optional(),
          })
          .strict()
          .optional(),
        memory: MemoryEnvelopeSchema.optional(),
      })
      .strict(),
    fetch: z.array(WakeContextFetchSchema),
    delivery: z
      .object({ requirement: ContinuityRequirementSchema, intended: WakeDeliverySchema })
      .strict(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const wantsAct = value.wake.kind !== 'work_order';
    if (wantsAct && value.wake.act_id === undefined) {
      ctx.addIssue({
        code: 'custom',
        message: 'act_id required outside work_order',
        path: ['wake', 'act_id'],
      });
    }
    if (!wantsAct && value.wake.lane_id === undefined) {
      ctx.addIssue({
        code: 'custom',
        message: 'lane_id required on work_order',
        path: ['wake', 'lane_id'],
      });
    }
  });
export type WakeContextPacket = z.infer<typeof WakeContextPacketSchema>;

export const WakeContextResponseSchema = z.object({ context: WakeContextPacketSchema }).strict();
export type WakeContextResponse = z.infer<typeof WakeContextResponseSchema>;

/**
 * One wake order. Inbox / review wakes carry a triggering act. Dispatch **continuation**
 * work-orders (ADR 199) have no act — `act_id`/`act`/`sender` are omitted and `lane_id` is
 * required when `derivation === 'work_order'` without an act.
 */
export const WakeOrderSchema = z
  .object({
    lease_id: z.string(),
    seat: z.string(),
    /** The message id of the directed act that made this wake due. Absent on board continuation. */
    act_id: z.string().optional(),
    /** The act enum of the triggering act (never its body). Absent on board continuation. */
    act: z.string().optional(),
    /** Delimited sender name. Absent on board continuation (the board is the work order). */
    sender: z.string().optional(),
    lane: WakeLaneSchema,
    /** The daemon-composed one-line spawn prompt (structured fields only, ADR 088 §4). */
    composed_line: z.string(),
    /** Lease expiry (ms epoch, ~120s): report before this or the wake re-becomes due. */
    expires_at: z.number().int(),
    /** Effective tool policy for the run (increment 5). Absent (older daemon) ⇒ reply-only. */
    tool_policy: z.enum(['reply-only', 'seat-policy']).optional(),
    /** Effective run bounds. For reply wakes, `timeout_ms` only tightens the host `--timeout`
     *  ceiling; work-orders (ADR 199) use this value without that clamp. */
    bounds: z
      .object({
        timeout_ms: z.number().int(),
        max_turns: z.number().int().optional(),
        budget_usd: z.number().optional(),
      })
      .optional(),
    /** Effective resume-hygiene bound for this seat (increment 5). Absent ⇒ backend default. */
    transcript_max_bytes: z.number().int().optional(),
    /** ADR 209: portable (fresh) is default; transcript_required is a narrow reply-only exception. */
    continuity_requirement: ContinuityRequirementSchema.optional(),
    /** ADR 209: daemon intent; host reports the observed delivery separately. */
    intended_delivery: WakeDeliverySchema.optional(),
    /** Why this wake was derived (ADR 191). Absent ⇒ treat as the `lane` value (older daemons). */
    derivation: WakeDerivationSchema.optional(),
    /** Lane id on a work-order wake (ADR 179 injection bar — id only, never a title). */
    lane_id: z.string().optional(),
  })
  .superRefine((o, ctx) => {
    const boardContinuation =
      o.derivation === 'work_order' && o.lane_id !== undefined && o.act_id === undefined;
    if (boardContinuation) return;
    if (o.act_id === undefined) {
      ctx.addIssue({
        code: 'custom',
        message: 'act_id required unless board work_order',
        path: ['act_id'],
      });
    }
    if (o.act === undefined) {
      ctx.addIssue({
        code: 'custom',
        message: 'act required unless board work_order',
        path: ['act'],
      });
    }
    if (o.sender === undefined) {
      ctx.addIssue({
        code: 'custom',
        message: 'sender required unless board work_order',
        path: ['sender'],
      });
    }
    if (o.derivation === 'work_order' && o.lane_id === undefined) {
      ctx.addIssue({
        code: 'custom',
        message: 'lane_id required on work_order wakes',
        path: ['lane_id'],
      });
    }
  });
export type WakeOrder = z.infer<typeof WakeOrderSchema>;

/** Response of the wake-leases poll. */
export const WakeLeasesResponseSchema = z.object({
  orders: z.array(WakeOrderSchema),
});
export type WakeLeasesResponse = z.infer<typeof WakeLeasesResponseSchema>;

/**
 * Body of `POST /teams/:slug/residency/wake-report` — the host's `WakeOutcome`, minus anything the
 * daemon must never learn: no session ids, no transcript paths (ADR 131 §5 — the resumable
 * attestation is harness-class only; ids stay in the workspace `binding.session`).
 */
export const WakeReportBodySchema = z.object({
  lease_id: z.string(),
  /** Did the woken session occupy the seat (verified from the roster, never from stdout)? */
  occupied: z.boolean(),
  /** Did it answer the triggering act (the ADR 090 ledger's `answered`)? Often unknown at report. */
  answered: z.boolean().optional(),
  /** Fresh spawn or resumed session (the fresh-first doctrine's outcome axis). */
  session: z.enum(['fresh', 'resumed']).optional(),
  /** ADR 209: actual delivery, distinguishing an initial fresh spawn from a failed-resume fallback. */
  delivery_outcome: WakeDeliveryOutcomeSchema.optional(),
  /** Local transcript size examined by the host; no path or content crosses the boundary. */
  transcript_bytes: z.number().int().nonnegative().optional(),
  /** Local capture age examined by the host; no session identifier crosses the boundary. */
  transcript_age_ms: z.number().int().nonnegative().optional(),
  /** True ⇒ the host skipped this wake because a live local session already holds the workspace
   *  (the local-session guard — roster-offline ≠ workspace-idle). Settles the lease, audits
   *  `residency.wake_deferred`, and consumes NO attempt/cooldown/hourly budget: a working human
   *  must never exhaust the act. `occupied` is false on a deferral. */
  deferred: z.boolean().optional(),
  /** Attested spend for the wake run, when the backend surfaces it. The primary report rarely has
   *  it (verification concludes long before the run exits, where cost is printed) — a woken run's
   *  cost usually arrives on a SUPPLEMENTARY report for the already-settled lease, which the
   *  daemon records as a `residency.wake_cost` audit row (increment 5). */
  cost_usd: z.number().nonnegative().optional(),
  /** Wall-clock of the settled run (harness-reported), riding the same supplementary report. */
  duration_ms: z.number().nonnegative().optional(),
  /** Failure summary for a not-occupied outcome (watchdog timeout, spawn error) — host-composed,
   *  never model output. */
  reason: z.string().max(200).optional(),
  /** Typed wakeability axis (ADR 189) — same enum as `WakeCandidate.wakeability`, so audits can
   *  query "how many wakes failed because the workspace is gone" without parsing prose. Optional
   *  for back-compat with hosts that have not yet upgraded. */
  wakeability: z.enum(WAKEABILITIES).optional(),
});
export type WakeReportBody = z.infer<typeof WakeReportBodySchema>;
