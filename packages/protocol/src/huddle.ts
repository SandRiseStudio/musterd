import { z } from 'zod';

/**
 * A huddle is a thread (ADR 378). The opening act carries `meta.huddle`; the envelope's own id is
 * the huddle id; every turn is an ordinary act with `thread` set to it; the closing `resolve`
 * carries `meta.anchor_ref` — where the durable output landed, or `none` with the reason in the
 * body.
 *
 * Everything here is additive meta on existing verbs (ADR 103, ADR 145 §4): no new act, no wire
 * version bump. `budget` is a DECLARATION readers display by counting the thread's rows — the
 * daemon stores no clock and enforces nothing (ADR 131 §7, ADR 147, ADR 179).
 */
export const HUDDLE_TOPIC_KINDS = ['goal', 'lane', 'design'] as const;
export type HuddleTopicKind = (typeof HUDDLE_TOPIC_KINDS)[number];

export const HuddleBudgetSchema = z
  .object({
    /** turns the participants declared they would spend; readers count thread rows against it */
    turns: z.number().int().positive().optional(),
    /** epoch ms the participants declared as the end; readers compare, nobody sweeps */
    until: z.number().int().nonnegative().optional(),
  })
  .strict();

export const HuddleMetaSchema = z
  .object({
    topic: z.object({ kind: z.enum(HUDDLE_TOPIC_KINDS), id: z.string().min(1) }).strict(),
    /** the room in the whiteboard service (ADR 330) — a URL, never a socket the daemon holds */
    room: z.string().url(),
    /** where the durable output will land: a repo path, a PR, or a lane ref */
    anchor: z.string().min(1),
    budget: HuddleBudgetSchema.optional(),
  })
  .strict();
export type HuddleMeta = z.infer<typeof HuddleMetaSchema>;

/** The closing `resolve`'s pointer: a non-empty ref, or the literal `none` (reason in the body). */
export const AnchorRefSchema = z.string().min(1);

/** The board name a huddle's room takes in the whiteboard service — derived from the huddle id. */
export function huddleBoardName(huddleId: string): string {
  return `huddle-${huddleId.toLowerCase()}`;
}
