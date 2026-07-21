import { z } from 'zod';
import { ActSchema } from './acts.js';
import { AskSpeciesSchema, AskTierSchema, AskOutcomeSchema } from './ask.js';
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
  // `defer` (ADR 103) is a plan mutation on the Goal spine: it MUST name the Goal it moves via a
  // non-empty `meta.goal_id`. The optional `meta.wave` carries the target position — absent or
  // "later" defers (sorts last), a number reorders — mirroring the Goal `wave` field `nextGoal` reads.
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
  if (env.act === 'wait' && meta['ask_ref'] !== undefined) {
    const until = meta['until'];
    if (typeof until !== 'string' || until.trim().length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['meta', 'until'],
        message: 'a "deciding" wait (meta.ask_ref) requires meta.until (e.g. "1h" or "indefinite")',
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
}

/**
 * Build a well-formed envelope, filling id/v/ts defaults. The caller supplies
 * the identity-bound fields. The result is validated and returns the parsed
 * envelope (throws ZodError on invalid input).
 */
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
