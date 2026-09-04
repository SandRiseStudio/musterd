import { z } from 'zod';
import { ActSchema, type Act } from './acts.js';
import { AskSpeciesSchema, AskTierSchema, AskOutcomeSchema } from './ask.js';
import { AnchorRefSchema, HuddleMetaSchema } from './huddle.js';
import { BlockedBySchema } from './incident.js';
import { PROTOCOL_VERSION } from './version.js';

/** Recipient of an envelope: a specific member, the whole team, or broadcast. */
export const RecipientSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('member'), name: z.string().min(1) }),
  z.object({ kind: z.literal('team') }),
  z.object({ kind: z.literal('broadcast') }),
]);
export type Recipient = z.infer<typeof RecipientSchema>;

const TEAM_SLUG = /^[a-z0-9-]{1,32}$/;

/**
 * ADR 211 §1: what ends a deferral. A condition, never a clock — ADR 179's doctrine is that the
 * daemon runs no clocks on anyone's behalf, so there is deliberately no `{ at: <timestamp> }` arm
 * and a duration string is rejected here (that is the DECIDING wait's shape, ADR 147 §5).
 *
 * `{ lane }` raises on the next lane-state act for that lane; `{ reply: true }` raises on the next
 * act from someone else on the deferred act's own thread. `.strict()` on both arms is load-bearing:
 * it is what rejects `{ lane, reply }` and any future field smuggled in beside them.
 */
export const DeferUntilSchema = z.union([
  z.object({ lane: z.string().min(1) }).strict(),
  z.object({ reply: z.literal(true) }).strict(),
]);
export type DeferUntil = z.infer<typeof DeferUntilSchema>;

/**
 * ADR 254: the eligible set — 2–`MAX_ELIGIBLE` named seats, **any one of whom discharges the act**.
 *
 * Four is the cap for two reasons, and the second is the load-bearing one. Above four, a named set
 * is `@team` with extra steps and the sender should be made to say so. But the cap also bounds the
 * escalation tail a later increment walks: at a 5-minute hold, four seats is ~20 minutes and at most
 * four `wake_cost` charges. Uncapped, both the latency and the spend of a serial walk are unbounded.
 */
export const MAX_ELIGIBLE = 4;

/**
 * Acts that may carry an eligible set. Deliberately narrow: a `handoff` to two seats is incoherent
 * (two owners is zero owners), and accept/decline/defer/steer are structurally single-target. That
 * restriction is what earns a single global "first answer wins" rule instead of a per-act table.
 */
export const ELIGIBLE_ACTS: ReadonlySet<Act> = new Set<Act>([
  'message',
  'request_help',
  'challenge',
]);

/**
 * The eligible set on an envelope's meta, or `null` when there isn't one (or it is malformed).
 *
 * The single reader of the shape — server, MCP, and CLI all come through here, so no package can
 * interpret `meta.eligible` differently from the schema that validated it. A mixed-type array
 * returns `null` rather than a filtered list: silently dropping a name would mean silently dropping
 * an obligation.
 */
export function eligibleOf(meta: Record<string, unknown> | null | undefined): string[] | null {
  const v = meta?.['eligible'];
  if (!Array.isArray(v) || !v.every((n) => typeof n === 'string')) return null;
  return v as string[];
}

/**
 * The on-wire message. `actMetaRules` enforces per-act meta requirements
 * (accept/decline must reference what they answer). Imported identically by
 * server, CLI, and MCP so validation never diverges.
 */
export const EnvelopeSchema = z
  .object({
    id: z.string().min(1),
    v: z.literal(PROTOCOL_VERSION),
    team: z.string().regex(TEAM_SLUG, 'team must be a slug [a-z0-9-], 1..32'),
    from: z.string().min(1),
    to: RecipientSchema,
    act: ActSchema,
    body: z.string().default(''),
    thread: z.string().min(1).nullish(),
    meta: z.record(z.unknown()).nullish(),
    ts: z.number().int().nonnegative(),
    /**
     * When the daemon that served this envelope first held it — `messages.created_at`, the receipt
     * clock. `ts` is the origin's clock and travels unchanged through federation (ADR 335), so it is
     * not the order a reader's cursor walks; this is. Set on the read side only (inbox, history,
     * live delivery); a client never sends it, and an older daemon omits it, in which case a client
     * falls back to `ts` — the pre-fix comparison, correct whenever nothing arrived out of order.
     */
    received_at: z.number().int().nonnegative().optional(),
  })
  .superRefine(actMetaRules);

export type Envelope = z.infer<typeof EnvelopeSchema>;

/** Shape of `meta` per act, enforced on top of the base envelope. */
export function actMetaRules(
  env: {
    act: z.infer<typeof ActSchema>;
    thread?: string | null | undefined;
    meta?: Record<string, unknown> | null | undefined;
  },
  ctx: z.RefinementCtx,
): void {
  const meta = env.meta ?? {};
  if (env.act === 'accept' || env.act === 'decline') {
    const replyTo = meta['in_reply_to'];
    if (typeof replyTo !== 'string' || replyTo.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['meta', 'in_reply_to'],
        message: `act "${env.act}" requires meta.in_reply_to (the message id it answers)`,
      });
    }
  }
  // Urgency breakthrough (SPEC A.6a, ADR 044): `meta.urgent: true` is the scarce flag that pierces an
  // away/dnd recipient's hold. It MUST carry a non-empty `meta.urgent_reason` so the cost is legible
  // (and, in the v0.3 governed model, auditable). An additive optional meta pair — no version bump.
  // The `can_flag_urgent` capability that gates *who* may set it is the named v0.3 seam, not built here.
  if (meta['urgent'] === true) {
    const reason = meta['urgent_reason'];
    if (typeof reason !== 'string' || reason.trim().length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['meta', 'urgent_reason'],
        message: 'meta.urgent requires a non-empty meta.urgent_reason',
      });
    }
  }
  // Stated confidence (ADR 294 decision 5, amended 2026-09-02): `meta.confidence` is an OPTIONAL
  // probability in (0, 1] that the act's claim holds, on any act. It is a field on the claim, not on
  // musterd — a PR body or a foreign harness's log may carry the same number — and the act is only one
  // carrier. Absent is absent: never defaulted to 1.0, never required (an omission that read as certainty
  // would make omission the cheapest hedge, the exact gaming ADR 294 §Problem 3 designs against). A
  // malformed value is refused here rather than carried into the ledger as a number nobody can score.
  if ('confidence' in meta && meta['confidence'] !== undefined) {
    const c = meta['confidence'];
    if (typeof c !== 'number' || !Number.isFinite(c) || c <= 0 || c > 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['meta', 'confidence'],
        message:
          'meta.confidence must be a number in (0, 1] — the probability the claim holds; omit it rather than guess',
      });
    }
  }
  // `defer` (ADR 103) is a plan mutation on the Goal spine: it MUST name the Goal it moves via a
  // non-empty `meta.goal_id`. Since ADR 257 it has one meaning — shelve the Goal (`wave: 'later'`).
  // A pre-257 `meta.wave: <n>` still parses, but reorders nothing; the numeric rank is retired.
  if (env.act === 'defer') {
    const goalId = meta['goal_id'];
    if (typeof goalId !== 'string' || goalId.trim().length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['meta', 'goal_id'],
        message: 'act "defer" requires meta.goal_id (the Goal it reorders/defers)',
      });
    }
  }
  // `ask` (ADR 147) is the to-human stream act: it MUST carry a valid `meta.species` (which of the three
  // kinds of directed-to-human traffic) and `meta.tier` (which derives the timeout + no-answer policy the
  // agent runs). Both are closed enums so a surface can't send an ask the no-answer machinery can't tier.
  if (env.act === 'ask') {
    if (!AskSpeciesSchema.safeParse(meta['species']).success) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['meta', 'species'],
        message: 'act "ask" requires meta.species (consult | escalate | approve)',
      });
    }
    if (!AskTierSchema.safeParse(meta['tier']).success) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['meta', 'tier'],
        message: 'act "ask" requires meta.tier (advisory | standard | blocking)',
      });
    }
  }
  // `insight` (ADR 327) is the team-memory act: a finding saved so the whole team can find it. It
  // MUST carry a non-empty `meta.headline` (≤120 chars — the commit-subject discipline ADR 093
  // chose); MAY carry `meta.tags` (≤8 non-empty strings) and `meta.repo` (a slug naming the repo
  // the finding is bound to). The finding text rides the envelope body; its ≤2048-byte cap is
  // server-enforced at save time, like seat memory's blob cap (ADR 093), not wire-schema.
  if (env.act === 'insight') {
    const headline = meta['headline'];
    if (typeof headline !== 'string' || headline.trim().length === 0 || headline.length > 120) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['meta', 'headline'],
        message: 'act "insight" requires meta.headline (1..120 chars)',
      });
    }
    if (meta['tags'] !== undefined) {
      const tags = meta['tags'];
      const ok =
        Array.isArray(tags) &&
        tags.length <= 8 &&
        tags.every((t) => typeof t === 'string' && t.trim().length > 0);
      if (!ok) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['meta', 'tags'],
          message: 'meta.tags must be at most 8 non-empty strings',
        });
      }
    }
    if (meta['repo'] !== undefined) {
      const repo = meta['repo'];
      if (typeof repo !== 'string' || repo.trim().length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['meta', 'repo'],
          message: 'meta.repo must be a non-empty slug when present',
        });
      }
    }
  }
  // ADR 254: the eligible set. **Shape only.** `actMetaRules` receives `{act, thread, meta}` — no
  // `from`, no roster handle — so "these seats exist, none has left, none is an observer, and none is
  // the sender" is necessarily a server-side check in `routeEnvelope`. Two-layer by structure, not by
  // preference. Validated whenever the key appears, so acts without one stay unaffected.
  if (meta['eligible'] !== undefined) {
    const names = eligibleOf(meta);
    const issue = (message: string) =>
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['meta', 'eligible'], message });
    if (!names) {
      issue('meta.eligible must be an array of seat names');
    } else if (!ELIGIBLE_ACTS.has(env.act)) {
      issue(
        `act "${env.act}" cannot carry meta.eligible (only ${[...ELIGIBLE_ACTS].join(', ')}) — ` +
          'an act with one owner cannot have several',
      );
    } else if (names.some((n) => n.trim().length === 0)) {
      issue('meta.eligible must not contain an empty name');
    } else if (names.length < 2) {
      issue('meta.eligible needs at least 2 seats — to reach one seat, name it in `to`');
    } else if (names.length > MAX_ELIGIBLE) {
      issue(`meta.eligible allows at most ${MAX_ELIGIBLE} seats — to reach more, use @team`);
    } else if (new Set(names).size !== names.length) {
      issue('meta.eligible must not name the same seat twice');
    }
  }
  // Incident convergence (spec 2026-08-14 §1): a shared-blocker report rides `status_update` as
  // `meta.blocked_by` — no new act. Shape only here (clustering and dedup are server-side, in
  // routeEnvelope's hook); validated whenever the key appears, so acts without one stay unaffected.
  if (meta['blocked_by'] !== undefined) {
    if (!BlockedBySchema.safeParse(meta['blocked_by']).success) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['meta', 'blocked_by'],
        message: 'blocked_by must be { gate: string, ref?, sig? } with a non-empty gate',
      });
    }
  }
  // The no-answer resolution (ADR 147 §4) rides `status_update` rather than a new act: when `meta.ask_outcome`
  // is present it MUST name the ask it resolves (`meta.ask_ref`) and be a valid outcome, and a `risk_accepted`
  // MUST record what was risked and what the agent did — that pair IS the auditable risk-acceptance, so it is
  // never optional. (Validated whenever the field appears, so ordinary status_updates stay unaffected.)
  if (meta['ask_outcome'] !== undefined) {
    if (!AskOutcomeSchema.safeParse(meta['ask_outcome']).success) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['meta', 'ask_outcome'],
        message: 'meta.ask_outcome must be "held", "risk_accepted", or "stranded"',
      });
    }
    const askRef = meta['ask_ref'];
    if (typeof askRef !== 'string' || askRef.trim().length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['meta', 'ask_ref'],
        message: 'meta.ask_outcome requires meta.ask_ref (the id of the ask it resolves)',
      });
    }
    if (meta['ask_outcome'] === 'risk_accepted') {
      const risk = meta['risk'];
      const approach = meta['chosen_approach'];
      if (typeof risk !== 'string' || risk.trim().length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['meta', 'risk'],
          message: 'a risk_accepted outcome requires a non-empty meta.risk',
        });
      }
      if (typeof approach !== 'string' || approach.trim().length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['meta', 'chosen_approach'],
          message: 'a risk_accepted outcome requires a non-empty meta.chosen_approach',
        });
      }
    }
  }
  // The human "deciding — check back in ⟨dur⟩" reply (ADR 147 §5) rides `wait`: when a `wait` names an ask
  // (`meta.ask_ref`), it MUST carry `meta.until` (a duration like "1h", or "indefinite") — the clock the
  // waiting agent extends to. A bare `wait` (no ask_ref) is the ordinary "paused" act, unaffected.
  if (env.act === 'wait' && meta['ask_ref'] !== undefined && meta['defer_ref'] === undefined) {
    const until = meta['until'];
    if (typeof until !== 'string' || until.trim().length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['meta', 'until'],
        message: 'a "deciding" wait (meta.ask_ref) requires meta.until (e.g. "1h" or "indefinite")',
      });
    }
  }
  // The recipient's "not now, bring this back when ⟨cond⟩" (ADR 211 §1) also rides `wait` rather than
  // a thirteenth act — ADR 145 §4 spends surfaces before verbs. When a `wait` names the act it
  // postpones (`meta.defer_ref`), it MUST carry a well-formed `meta.until` CONDITION.
  //
  // `wait` therefore has three shapes, keyed by which meta field is present: bare (paused), `ask_ref`
  // (deciding), `defer_ref` (deferring). The two annotated shapes both spell their target `until` but
  // mean different types — a duration string vs a condition object — so an envelope carrying both is
  // rejected outright rather than resolved by precedence. Ambiguity here would be silent and durable.
  if (env.act === 'wait' && meta['defer_ref'] !== undefined) {
    const ref = meta['defer_ref'];
    if (typeof ref !== 'string' || ref.trim().length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['meta', 'defer_ref'],
        message: 'meta.defer_ref must be the id of the act being deferred',
      });
    }
    if (meta['ask_ref'] !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['meta', 'defer_ref'],
        message: 'a wait is either deciding (meta.ask_ref) or deferring (meta.defer_ref), not both',
      });
    }
    if (!DeferUntilSchema.safeParse(meta['until']).success) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['meta', 'until'],
        message:
          'a deferring wait (meta.defer_ref) requires meta.until — { lane: "<lane_id>" } or { reply: true }',
      });
    }
  }
  // `resolve` is thread-terminal: it MUST name the thread it closes (ADR 025). The thread id is the
  // root message's id — a no-thread root is closed by passing its own id as `thread`.
  if (env.act === 'resolve') {
    if (typeof env.thread !== 'string' || env.thread.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['thread'],
        message: 'act "resolve" requires thread (the id of the thread it closes)',
      });
    }
  }
  // A huddle is a thread (ADR 378): `meta.huddle` opens one and lives on the ROOT only — a turn
  // that repeats it is malformed, and a root cannot already be in a thread. Optional, additive,
  // refused when malformed; the daemon reads nothing out of it.
  if (meta['huddle'] !== undefined) {
    const parsed = HuddleMetaSchema.safeParse(meta['huddle']);
    if (!parsed.success) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['meta', 'huddle'],
        message: `meta.huddle is malformed: ${parsed.error.issues.map((i) => i.path.join('.') + ' ' + i.message).join('; ')}`,
      });
    } else if (typeof env.thread === 'string' && env.thread.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['meta', 'huddle'],
        message:
          'meta.huddle opens a huddle and belongs on the root act only — a turn in a thread must not carry it',
      });
    } else if (env.act !== 'message' && env.act !== 'request_help') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['meta', 'huddle'],
        message: 'meta.huddle opens a huddle on a "message" or "request_help" act',
      });
    }
  }
  // The closing `resolve` names where the anchor landed (ADR 378 §6): a ref, or `none` with the
  // reason in the body. Optional — a resolve that is not a huddle's carries none.
  if (meta['anchor_ref'] !== undefined) {
    if (env.act !== 'resolve') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['meta', 'anchor_ref'],
        message: 'meta.anchor_ref rides the closing "resolve" only',
      });
    } else if (!AnchorRefSchema.safeParse(meta['anchor_ref']).success) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['meta', 'anchor_ref'],
        message:
          'meta.anchor_ref must be a non-empty string (a repo path, PR, lane ref, or "none")',
      });
    }
  }
}

/**
 * Build a well-formed envelope, filling id/v/ts defaults. The caller supplies
 * the identity-bound fields. The result is validated and returns the parsed
 * envelope (throws ZodError on invalid input).
 */
/**
 * Where an envelope sits in the order a read cursor walks: the serving daemon's receipt clock
 * (`received_at`), falling back to the origin's `ts` when the daemon predates the field. Compare
 * THIS against `cursor.last_read_ts`, never `ts` on its own — `ts` is the sender's clock and travels
 * unchanged through federation, so an event can arrive after a seat last read while stamped before.
 */
export function envelopePosition(env: Pick<Envelope, 'ts' | 'received_at'>): number {
  return env.received_at ?? env.ts;
}

export function makeEnvelope(input: {
  id: string;
  team: string;
  from: string;
  to: Recipient;
  act: z.infer<typeof ActSchema>;
  body?: string;
  thread?: string | null;
  meta?: Record<string, unknown> | null;
  ts?: number;
}): Envelope {
  return EnvelopeSchema.parse({
    id: input.id,
    v: PROTOCOL_VERSION,
    team: input.team,
    from: input.from,
    to: input.to,
    act: input.act,
    body: input.body ?? '',
    thread: input.thread ?? null,
    meta: input.meta ?? null,
    ts: input.ts ?? Date.now(),
  });
}
