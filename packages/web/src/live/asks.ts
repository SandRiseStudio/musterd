import {
  ASK_TIER_DEFAULTS,
  AskSpeciesSchema,
  AskTierSchema,
  type AskSpecies,
  type AskTier,
  type Envelope,
} from '@musterd/protocol';

/**
 * The asks strip's pure derivation (ADR 149): fold the envelope timeline the /live page already holds
 * (backfill + `team-all` firehose, ADR 061) into per-ask views. No endpoint, no polling — the message
 * log is the substrate, exactly as the ADR 147 lifecycle audit reads it server-side.
 */

/**
 * Where an ask stands, from the timeline alone:
 * - `open` — unanswered; the tier clock (deadline) is running. LOUD.
 * - `held` — the top-tier timeout elapsed and the agent is holding, not proceeding (ADR 147 §4).
 *   Still LOUD: a held ask is *more* waiting-on-you, not less.
 * - `deferred` — a human replied "deciding — check back in ⟨until⟩" (`wait` + ask_ref, §5). Calm.
 * - `accepted` / `declined` — a human answered (`accept`/`decline` referencing the ask). Closed.
 * - `risk_accepted` — the below-top timeout elapsed and the agent proceeded, recording the risk (§4).
 *   Closed, but flagged: proceeding-without-the-human is the outcome the record watches for.
 * - `stranded` — the top-tier timeout elapsed with NO reachable unblocker (ADR 153): the agent released
 *   its lane (WIP on the branch) and stopped, never proceeding. Closed, but flagged: a strand is the
 *   honest surface of "this team is missing a reachable admin for a decision it needs."
 * - `resolved` — the ask's thread was resolved without an explicit answer act. Closed.
 */
export type AskState =
  | 'open'
  | 'held'
  | 'stranded'
  | 'deferred'
  | 'accepted'
  | 'declined'
  | 'risk_accepted'
  | 'resolved';

export interface AskView {
  env: Envelope;
  species: AskSpecies;
  tier: AskTier;
  /** When the tier clock elapses: `ts + ASK_TIER_DEFAULTS[tier].timeout_ms` — the same protocol
   *  constant the asking agent's clock reads, so the surface and the agent agree on the deadline. */
  deadline: number;
  state: AskState;
  /** Who closed/deferred it (accept/decline/wait sender), when someone did. */
  answeredBy?: string;
  /** The "deciding — check back in ⟨until⟩" horizon, when deferred. */
  until?: string;
}

/** True when the ask still wants attention on sight — the strip's "loud" predicate. */
export function askIsLoud(state: AskState): boolean {
  return state === 'open' || state === 'held';
}

/** Does this envelope reference the given ask (as answer, deferral, or outcome)? */
function refs(env: Envelope, askId: string, askThread: string | null | undefined): boolean {
  const meta = env.meta ?? {};
  if (meta['in_reply_to'] === askId || meta['ask_ref'] === askId) return true;
  // A thread-scoped close (resolve) counts when the ask roots the thread.
  return env.thread != null && (env.thread === askId || env.thread === askThread);
}

/**
 * Derive every ask in the timeline, newest first. Later lifecycle events supersede earlier ones per
 * ask, except that nothing reopens a human answer (`accepted`/`declined` are terminal — an agent's
 * later `risk_accepted` against an already-answered ask would be a protocol violation, not a state).
 */
export function deriveAsks(envelopes: Envelope[]): AskView[] {
  const byTs = [...envelopes].sort((a, b) => a.ts - b.ts || a.id.localeCompare(b.id));
  const asks = new Map<string, AskView>();
  const seen = new Set<string>();
  for (const env of byTs) {
    if (seen.has(env.id)) continue;
    seen.add(env.id);
    if (env.act === 'ask') {
      const species = AskSpeciesSchema.safeParse(env.meta?.['species']);
      const tier = AskTierSchema.safeParse(env.meta?.['tier']);
      if (!species.success || !tier.success) continue; // not a well-formed ask; the stream still shows it
      asks.set(env.id, {
        env,
        species: species.data,
        tier: tier.data,
        deadline: env.ts + ASK_TIER_DEFAULTS[tier.data].timeout_ms,
        state: 'open',
      });
      continue;
    }
    for (const ask of asks.values()) {
      if (!refs(env, ask.env.id, ask.env.thread)) continue;
      const terminal = ask.state === 'accepted' || ask.state === 'declined';
      if (terminal) continue;
      if (env.act === 'accept') {
        ask.state = 'accepted';
        ask.answeredBy = env.from;
      } else if (env.act === 'decline') {
        ask.state = 'declined';
        ask.answeredBy = env.from;
      } else if (env.act === 'wait' && typeof env.meta?.['ask_ref'] === 'string') {
        ask.state = 'deferred';
        ask.answeredBy = env.from;
        if (typeof env.meta['until'] === 'string') ask.until = env.meta['until'];
      } else if (env.meta?.['ask_outcome'] === 'held') {
        ask.state = 'held';
      } else if (env.meta?.['ask_outcome'] === 'risk_accepted') {
        ask.state = 'risk_accepted';
      } else if (env.meta?.['ask_outcome'] === 'stranded') {
        ask.state = 'stranded';
      } else if (env.act === 'resolve') {
        ask.state = 'resolved';
        ask.answeredBy = env.from;
      }
    }
  }
  return [...asks.values()].reverse();
}
