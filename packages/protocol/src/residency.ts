import { z } from 'zod';

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
   *  Default 10MiB ≈ 60 wake lives at the measured ~108KiB/life. */
  transcript_max_bytes: z.number().int().min(65_536).max(268_435_456).default(10_485_760),
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
export const WakeOrderSchema = z.object({
  lease_id: z.string(),
  seat: z.string(),
  /** The message id of the directed act that made this wake due. */
  act_id: z.string(),
  /** The act enum of the triggering act (never its body). */
  act: z.string(),
  /** Delimited sender name — identity is always present so the model can weigh the source. */
  sender: z.string(),
  lane: WakeLaneSchema,
  /** The daemon-composed one-line spawn prompt (structured fields only, ADR 088 §4). */
  composed_line: z.string(),
  /** Lease expiry (ms epoch, ~120s): report before this or the wake re-becomes due. */
  expires_at: z.number().int(),
  /** Effective tool policy for the run (increment 5). Absent (older daemon) ⇒ reply-only. */
  tool_policy: z.enum(['reply-only', 'seat-policy']).optional(),
  /** Effective run bounds. `timeout_ms` can only tighten the actuator's local `--timeout` ceiling;
   *  `max_turns`/`budget_usd` apply where the backend supports them. */
  bounds: z
    .object({
      timeout_ms: z.number().int(),
      max_turns: z.number().int().optional(),
      budget_usd: z.number().optional(),
    })
    .optional(),
  /** Effective resume-hygiene bound for this seat (increment 5). Absent ⇒ backend default. */
  transcript_max_bytes: z.number().int().optional(),
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
});
export type WakeReportBody = z.infer<typeof WakeReportBodySchema>;
