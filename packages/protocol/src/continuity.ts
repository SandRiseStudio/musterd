import { z } from 'zod';

/**
 * The local continuity registry (ADR 210) — the host's proof that a captured transcript IS the
 * dialogue a wake is answering.
 *
 * The daemon knows an Act's thread but deliberately never receives a harness session id or
 * transcript path (ADR 131 §5), so recency alone cannot establish that causal link. This registry
 * closes that gap **entirely on the host**: it lives in the gitignored 0600
 * `.musterd/continuity.json` beside `binding.json`, and is never sent to the daemon, telemetry, the
 * audit log, `workspace.json`, or a prompt. Nothing here is a wire type — the `continuity.test.ts`
 * custody tests assert that the wake order and wake report cannot name these fields.
 *
 * It holds MANY bindings on purpose: one Member is not one session (`AGENTS.md` hard rule 7), so a
 * seat may carry several threads across several harness sessions at once.
 */
export const ContinuityBindingSchema = z
  .object({
    /** The Act thread this session is the dialogue for — the join key the daemon also knows. */
    thread_id: z.string().min(1).max(120),
    /** Harness class (`claude-code`, …), matching the residency enrollment vocabulary. */
    harness: z.string().min(1).max(40),
    /** The harness session id (`claude --resume <id>`). Local-only, never crosses the wire. */
    session_id: z.string().min(1).max(120),
    /** Absolute transcript path as the harness reported it. Local-only; absent ⇒ unusable. */
    transcript_path: z.string().optional(),
    /** When this thread was bound to this session. */
    bound_at: z.number().int(),
    /** When the underlying session capture was taken (`binding.session.started_at`). */
    captured_at: z.number().int(),
  })
  .strict();

export type ContinuityBinding = z.infer<typeof ContinuityBindingSchema>;

/**
 * `.strict()` throughout: a hand-edited or foreign registry is rejected rather than partially
 * trusted. A file that fails to parse is discarded and rebuilt, never repaired in place — the
 * registry is a cache, so losing it costs a fresh wake and nothing more.
 */
export const ContinuityRegistrySchema = z
  .object({
    version: z.literal(1),
    /** The team this registry belongs to. A mismatch is discarded, never adopted (ADR 143). */
    team: z.string().min(1).max(120),
    /** The seat this registry belongs to. A mismatch is discarded, never adopted (ADR 143). */
    seat: z.string().min(1).max(120),
    bindings: z.array(ContinuityBindingSchema).max(64),
  })
  .strict();

export type ContinuityRegistry = z.infer<typeof ContinuityRegistrySchema>;

/** The four facts that must all agree before a resume may even be considered. */
export interface ContinuityQuery {
  team: string;
  seat: string;
  thread_id: string;
  harness: string;
}

/**
 * Exact match on all four of team, seat, thread, and harness — or nothing.
 *
 * There is deliberately no most-recent fallback and no fuzzy match: a near-miss means the host
 * cannot prove causality, and the correct answer to "cannot prove" is a fresh wake, which is always
 * valid. Every relaxation of this function would reintroduce exactly the server-side guess that
 * ADR 210 exists to replace.
 */
export function matchBinding(
  registry: ContinuityRegistry,
  query: ContinuityQuery,
): ContinuityBinding | null {
  if (registry.team !== query.team || registry.seat !== query.seat) return null;
  return (
    registry.bindings.find((b) => b.thread_id === query.thread_id && b.harness === query.harness) ??
    null
  );
}

export interface PruneOptions {
  now: number;
  /** Bindings older than this are dropped — a stale capture is a costly resume, not a useful one. */
  maxAgeMs: number;
  /** Injected so this stays pure: the host owns all filesystem access. */
  transcriptExists: (path: string) => boolean;
  /** Threads that have resolved — their dialogue is over, so their binding is dead weight. */
  resolvedThreads: ReadonlySet<string>;
}

/**
 * Drop every binding the host could not act on anyway: missing or unnamed transcript, resolved
 * thread, or past the age horizon. Pruning is not an optimization — an unusable binding that
 * survives is a resume attempt that will fail and cost a fallback.
 */
export function pruneRegistry(
  registry: ContinuityRegistry,
  { now, maxAgeMs, transcriptExists, resolvedThreads }: PruneOptions,
): ContinuityRegistry {
  return {
    ...registry,
    bindings: registry.bindings.filter((b) => {
      if (b.transcript_path === undefined) return false;
      if (!transcriptExists(b.transcript_path)) return false;
      if (resolvedThreads.has(b.thread_id)) return false;
      return now - b.bound_at <= maxAgeMs;
    }),
  };
}
