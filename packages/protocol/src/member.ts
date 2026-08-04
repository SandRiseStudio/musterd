import { z } from 'zod';
import {
  ActivitySchema,
  LifecycleSchema,
  MemberKindSchema,
  PresenceStatusSchema,
  ProvenanceSchema,
  SurfaceSchema,
} from './acts.js';
import { AccountStatusSchema, CapabilitiesSchema } from './capabilities.js';
import { OfflineReasonSchema } from './offline.js';
import { PostureSchema } from './posture.js';
import { WorkingHoursSchema, type WorkingHours } from './working-hours.js';

/**
 * The self-set availability axis (SPEC A.6 Axis 2) — explicit, **never inferred**. `away_until(ts)`
 * is encoded as `{ status: 'away', until: <ms epoch> }`. The localhost down-payment (ADR 044) stores
 * and exposes this; `off_hours` / full schedule enforcement is roadmap.
 */
export const AvailabilityStatusSchema = z.enum(['available', 'away', 'dnd', 'off_hours']);
export type AvailabilityStatus = z.infer<typeof AvailabilityStatusSchema>;

export const AvailabilitySchema = z.object({
  status: AvailabilityStatusSchema,
  /** For `away_until`: when the member expects to be back (ms epoch). Only meaningful with `away`. */
  until: z.number().int().positive().nullish(),
});
export type Availability = z.infer<typeof AvailabilitySchema>;

/** A durable identity in a Team. Never a session. Mirrors the `members` table (minus token_hash). */
export const MemberSchema = z.object({
  id: z.string(),
  team: z.string(),
  name: z.string(),
  kind: MemberKindSchema,
  role: z.string().default(''),
  /** Every role this seat holds (ADR 227 multi-role); `role` stays the display label (first entry).
   *  Defaulted for back-compat — an older daemon omits it and a single-role seat reads as `[role]`
   *  via the display field. Empty ⇒ the roleless generalist. */
  roles: z.array(z.string()).default([]),
  lifecycle: LifecycleSchema.default('forever'),
  lifecycle_until: z.number().int().nullish(),
  availability: AvailabilitySchema.nullish(),
  /** Optional recurring schedule; a Member value replaces the Team default (ADR 206). */
  working_hours: WorkingHoursSchema.nullish(),
  /** Account status — Axis 1 (ADR 070). Optional for back-compat; the server always resolves it. */
  account_status: AccountStatusSchema.optional(),
  /** Effective capabilities (ADR 070). Optional for back-compat; the server always resolves it. */
  capabilities: CapabilitiesSchema.optional(),
  created_at: z.number().int(),
});
export type Member = z.infer<typeof MemberSchema>;
export type { WorkingHours };

/** One active attachment of a Member to a Surface. */
export const PresenceSchema = z.object({
  surface: SurfaceSchema,
  status: PresenceStatusSchema,
  last_seen_at: z.number().int(),
  /** Why this attachment exists (musterd/0.2). Recorded at attach; null on pre-0.2 rows. */
  provenance: ProvenanceSchema.nullish(),
  /** The "where" label captured at attach (folder, qualified by branch/subpath). */
  workspace: z.string().nullish(),
  /** Driver co-presence (musterd/0.2; ADR 021): the human steering this agent's session, when one
   * is. Lets the roster name the co-present human instead of showing them offline; null otherwise. */
  driver: z.string().nullish(),
  /** Harness-attested model id for this occupancy (ADR 101). Attested, never verified; null/absent
   *  when the adapter doesn't attest — rendered as `unknown`, never blocks. */
  model: z.string().nullish(),
  /** Client-attested build ref for this occupancy's dist (ADR 135) — the git SHA (optionally
   *  `-dirty`) the client's own `dist/build.json` stamp carries. Null/absent for unstamped or older
   *  clients. Now an operator-detail (tooltip) only: the visible roster skew signal is `epoch`, not this. */
  build: z.string().nullish(),
  /** Client-attested feature epoch for this occupancy (ADR 148) — the monotonic capability counter its
   *  dist was built against. Null/absent for older clients. The roster renders a calm "behind" hint only
   *  when this is known *and* lower than the daemon's epoch — i.e. the seat genuinely lacks later features,
   *  never on benign build drift. */
  epoch: z.number().int().nonnegative().nullish(),
});
export type Presence = z.infer<typeof PresenceSchema>;

/**
 * The decision-grade "is this seat busy right now" read (2026-08-03 quiescence design; ADR 215) —
 * split from `activity` on purpose, because the two answer different questions with different
 * failure modes. `activity` is a *display* fact ("has this live seat self-reported a task?",
 * ADR 010/140) and for agents it is sticky: one status_update reads `working` until the seat goes
 * offline. A wrong display is cosmetic. Quiescence is what machines decide from — when a daemon
 * bounce is least disruptive, whether a supposedly-idle seat is actually mid-something before
 * spending a wake — and a wrong answer there interrupts someone mid-turn or spends money badly.
 *
 * Derived at read time from the newest *audited action* (tool call, send, lane op), never stored.
 * `unknown` is honest and load-bearing: no audited action inside the lookback window is not
 * "quiet", it is unknowable — the ADR 169/189 absent-vs-unknown discipline. Every consumer must
 * treat `unknown` as "degrade to behaving as if this signal did not exist", never as license to act.
 *
 * Thresholds live in the CONSUMER: the wire carries `quiet_for_ms` and the busy/quiet line is drawn
 * by whoever reads it (autorefresh's quiet-floor, wake's spend guard). One server-side threshold
 * would recreate the one-size-fits-nobody problem `activity` has. `state` is the courtesy label at
 * a documented default line — a reader with its own line recomputes from `quiet_for_ms`, which is
 * always the authority.
 *
 * `source` is the capture-tier seam: `audit` (universal, works for hook-less harnesses like Codex)
 * now; `harness` (turn-boundary hooks, ground truth for "mid-turn") pre-registered for later — it
 * slots in by overriding the audit tier per seat without changing this shape.
 */
export const QuiescenceSchema = z.object({
  state: z.enum(['busy', 'quiet', 'unknown']),
  /** Milliseconds since the newest audited action; null iff `state` is `unknown`. */
  quiet_for_ms: z.number().int().nullable(),
  source: z.enum(['audit', 'harness']),
});
export type Quiescence = z.infer<typeof QuiescenceSchema>;

/** A Member plus a summary of where (if anywhere) they are currently present — used by roster/status. */
export const MemberSummarySchema = MemberSchema.extend({
  presence: PresenceStatusSchema,
  presences: z.array(PresenceSchema).default([]),
  /** Coarse roster activity (musterd/0.2). Optional for back-compat; the server always sets it. */
  activity: ActivitySchema.optional(),
  /** Self-reported task summary backing `working`, from the latest `status_update`. */
  state: z.string().nullish(),
  /** When `state` was last refreshed (ms epoch); drives staleness in the roster. */
  last_status_at: z.number().int().nullish(),
  /**
   * Composed roster posture (ADR 138) — `working | idle | away | offline`. Resolved server-side from
   * activity ∩ availability; the chip renders this token (no client synonym). Optional for back-compat;
   * the server always sets it.
   */
  posture: PostureSchema.optional(),
  /**
   * Why the seat is offline (ADR 141). Set only when not live; omitted/`null` while present.
   * Optional for back-compat; the server always sets it when offline.
   */
  offline_reason: OfflineReasonSchema.nullish(),
  /**
   * True when the seat is *held within its reclaim-grace window* (ADR 010) — a **reservation**, not
   * live presence. The seat still reads `presence: 'offline'` (grace is hidden from display, ADR 010),
   * but it may be reconnecting, so the clobber guard (ADR 066/105) treats it as occupied. Optional for
   * back-compat; the server always sets it.
   */
  reclaimable: z.boolean().optional(),
  /**
   * True when the seat is enrolled in harness residency (ADR 131) — offline is not unreachable: a
   * directed act can wake it, so the roster reads `offline · wakeable`. An enrollment fact (set
   * whether or not the seat is currently offline); renderers apply it to the offline label.
   * Optional for back-compat; the server always sets it.
   */
  wakeable: z.boolean().optional(),
  /**
   * When the seat last attested a capturable harness session (ADR 131 §5) — the resumable badge's
   * input (inc 5, finding b). A TIMESTAMP, not a boolean, deliberately: captures age past the
   * harness's ~30d GC horizon, so renderers apply freshness instead of trusting a stale `true`.
   * Null/absent: never captured, or not enrolled. Optional for back-compat.
   */
  resumable_at: z.number().int().nullish(),
  /**
   * The decision-grade busy read (ADR 219) — see {@link QuiescenceSchema}. Beside `wakeable`
   * on purpose: together they answer "can I reach this seat, and would reaching it interrupt
   * anything?" Optional and additive in both directions — an older daemon omits it and every
   * consumer behaves exactly as it did before the field existed, which is also what `unknown`
   * means. Deliberately NOT wired into `activity`, `posture`, or any rendering: a seat may read
   * `working` from a status_update while quiescence reads `quiet`, and that is correct, not a
   * conflict — they answer different questions.
   */
  quiescence: QuiescenceSchema.optional(),
});
export type MemberSummary = z.infer<typeof MemberSummarySchema>;
