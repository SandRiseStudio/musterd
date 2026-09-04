import {
  ASK_TIER_DEFAULTS,
  askTierHolds,
  AskSpeciesSchema,
  AskTierSchema,
  isAwaitingAcceptance,
  type AskSpecies,
  type AskTier,
  type Envelope,
  type Lane,
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
 * - `lapsed` — a below-top-tier clock ran out and NOTHING was ever recorded (see `applyTierClock`).
 *   The only state here the timeline cannot produce: it comes from the clock, not from an envelope.
 */
export type AskState =
  | 'open'
  | 'held'
  | 'stranded'
  | 'deferred'
  | 'accepted'
  | 'declined'
  | 'risk_accepted'
  | 'resolved'
  | 'lapsed';

export interface AskView {
  env: Envelope;
  species: AskSpecies;
  tier: AskTier;
  /**
   * Who the ask was ROUTED to — the addressed member, or null for a team/broadcast ask. This existed
   * on the envelope all along and the derivation dropped it, which is how the strip came to render an
   * agent-routed acceptance ask under "waiting on a human" copy with a "Sign in as nick" button
   * (lane 01KZ9GFHZ9): a reader concluded nick held ten asks the ledger had routed to gptbot. ADR 149
   * predates ADR 191's agent-routed review asks; the recipient is no longer implicit.
   */
  to: string | null;
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

/**
 * Apply the tier clock to a timeline-derived list — the second half of an ask's state, and the half
 * `deriveAsks` cannot know.
 *
 * **The defect this retires** (nick, 2026-09-01: "most of the acts on the act bar say timed out —
 * if they are timed out, should we even show them?"). An ask leaves `open` only when a LATER
 * envelope references it, and the ADR 147 §4 no-answer envelope (`status_update` +
 * `meta.ask_outcome`) is the asking agent's honour system. Agents mostly do not send it. Measured on
 * the live DB, 2026-09-01, over the last 1,000 envelopes (a 138-hour window): 41 asks, **14 of them
 * never reached a terminal state**, every one hours-to-days past a deadline measured in minutes. All
 * fourteen sat in the rail as `open`, in danger red, under Approve and Deny buttons.
 *
 * **Why silence is not one fact.** The tier already says what a missing answer MEANS (ADR 147 §4):
 * the top tier holds, every tier below it proceeds and records the risk. So an elapsed clock reads
 * two opposite ways, and the rail was shouting both in the same words:
 *
 * - **holding tier** → `held`. The agent stopped; nothing moves until a human answers. Still the
 *   loudest thing on the page — this changes only where the state comes from, not what it does.
 * - **below top** → `lapsed`. The contract fired days ago and the work went on without you. Not
 *   loud, not answerable, not in the tab-title count, not in the stream rotation.
 *
 * **What it may and may not claim.** This reads the tier CONTRACT, never the agent's act. It knows
 * the ask stopped blocking; it does not know what was decided, and no surface built on it may say
 * approved. A recorded `risk_accepted` is a different and better fact — one the agent actually
 * asserted — and this never overwrites it, or any other evidence: only a still-`open` ask moves.
 *
 * **Why it is separate from `deriveAsks`.** That derivation is pure over the envelope timeline and
 * memoised on it. A clock-dependent state computed inside it would be stale exactly when it starts
 * mattering — the 1s tick re-renders the strip but does not re-run the memo. So callers hold the
 * clock and apply it at read time, which is also what lets the tests pin `now`.
 */
export function applyTierClock(asks: AskView[], now: number = Date.now()): AskView[] {
  return asks.map((ask) => {
    if (ask.state !== 'open' || ask.deadline > now) return ask;
    return { ...ask, state: askTierHolds(ask.tier) ? 'held' : 'lapsed' };
  });
}

/**
 * How much of the tier clock is left, 0..1 — the arc the rail draws round the asker's avatar. `null`
 * when there is no running clock to draw: answered, deferred, lapsed. Held (blocking, past its
 * deadline) and open-but-over both read 0: the ring is empty, and the surface says so in danger.
 *
 * Pure and here, beside `applyTierClock`, for the same reason that one is: the strip's memo does
 * not see the tick, so the fraction is computed at read time from the `now` the caller holds.
 */
export function clockFraction(ask: AskView, now: number): number | null {
  if (ask.state === 'held') return 0;
  if (ask.state !== 'open') return null;
  const total = ask.deadline - ask.env.ts;
  if (total <= 0) return 0;
  return Math.min(1, Math.max(0, (ask.deadline - now) / total));
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
        to: env.to.kind === 'member' ? env.to.name : null,
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

/**
 * Whose attention an ask is actually waiting on, seen from this browser:
 * - `you`   — routed to the signed-in seat. The only bucket the answer buttons belong to.
 * - `human` — routed to a human who is not you. Someone's, just not yours.
 * - `agent` — routed to an agent seat (ADR 191 review asks are most of the timeline now). Watchable,
 *             never "sign in to answer" — that invitation on an agent's ask is how the strip lied.
 * - `team`  — addressed to nobody in particular; anyone answerable may take it.
 */
export type AskAudience = 'you' | 'human' | 'agent' | 'team';

export interface AudienceContext {
  /** The seat this browser is signed in as (or would sign in as); null/undefined when observing. */
  you?: string | null;
  /** Names of the roster's human members — how `human` and `agent` are told apart. */
  humans: Set<string>;
}

/**
 * How many open asks THIS browser could actually answer — the tab title's number.
 *
 * `you` + `team` count: an ask routed to you is yours, and the team pool is genuinely takeable by
 * whoever signs in. An agent-routed review never counts, which is the lie lane 01KZ9GFHZ9 retired.
 *
 * The `ctx.you` guard is ryder's review note on #687: with no identity at all — a watch-link viewer
 * who has never signed in — every team-pool ask still scored, so the tab read "(3 asks)" at someone
 * who cannot answer a single one of them. A browser one click from an identity still counts (the
 * title is the nudge); a browser that is nobody counts nothing.
 */
export function answerableCount(asks: AskView[], ctx: AudienceContext): number {
  if (!ctx.you) return 0;
  return asks.filter((a) => {
    // Loudness is checked HERE and not left to the caller. The strip already passes its `loud` list,
    // so this looks redundant — but the count is a claim about what is waiting on the reader, and a
    // lapsed ask (`applyTierClock`) is the exact shape that gets past an audience-only filter while
    // being unanswerable by anyone. One caller remembering is not the same as the rule holding.
    if (!askIsLoud(a.state)) return false;
    const audience = askAudience(a, ctx);
    return audience === 'you' || audience === 'team';
  }).length;
}

export function askAudience(ask: AskView, ctx: AudienceContext): AskAudience {
  if (ask.to == null) return 'team';
  if (ctx.you != null && ask.to === ctx.you) return 'you';
  return ctx.humans.has(ask.to) ? 'human' : 'agent';
}

/**
 * One lane sitting in acceptance, and who it waits on (nick, 2026-08-05: "visibility into all lanes
 * awaiting acceptance and who it's waiting on", at a glance beside the asks).
 */
export interface ReviewView {
  lane: Lane;
  /** The acceptor the daemon routed the review ask to — null when no open routed ask is found
   *  (renders as "unrouted"; the honest read, never a guess). */
  waitingOn: string | null;
}

/**
 * Lanes in acceptance (both state spellings, ADR 192/169), longest-waiting first, each joined to its
 * routed acceptance ask by `meta.lane_review.lane` — the id the daemon stamps on every ADR 191 review
 * ask. Joining by id rather than title-matching is the point: titles are prose and get edited. A later
 * re-route supersedes, and an answered ask stops naming its acceptor (the lane then reads unrouted
 * until the daemon routes again or resolves it).
 */
export function deriveReviewQueue(lanes: Lane[], asks: AskView[]): ReviewView[] {
  // Newest routed, still-open review ask per lane id (deriveAsks returns newest first).
  const acceptorByLane = new Map<string, string | null>();
  for (const ask of asks) {
    const ref = (ask.env.meta?.['lane_review'] as { lane?: unknown } | undefined)?.lane;
    if (typeof ref !== 'string' || acceptorByLane.has(ref)) continue;
    acceptorByLane.set(ref, askIsLoud(ask.state) ? ask.to : null);
  }
  return lanes
    .filter((l) => isAwaitingAcceptance(l.state))
    .sort((a, b) => a.updated_at - b.updated_at)
    .map((lane) => ({ lane, waitingOn: acceptorByLane.get(lane.id) ?? null }));
}

/**
 * The ask vocabulary, owned here rather than by either surface.
 *
 * `AsksStrip` (/live) and `AsksReel` (/broadcast) are deliberately separate components — one is
 * ~460 lines of answerability, the other is stream chrome with no input, and they cannot share a
 * stylesheet because the 1080p stage encodes to 720p. That split is still right. What was NOT right
 * is that each kept its own copy of these strings: when the recipient bug was fixed on /live
 * (2026-08-05), the identical wrong copy went on being broadcast to Twitch for two hours, because
 * fixing one file could not fix the other. Derivation was shared; vocabulary was not, and vocabulary
 * is where the lie lived. Both now read from here.
 *
 * `SPECIES_VERB` is third person and is the DEFAULT — the addressed-to-you voice must be earned by
 * knowing the ask is yours. A stream has no "you" at all, so it never uses the second-person map.
 */
export const SPECIES_VERB = {
  consult: 'asks for a view',
  escalate: 'escalated',
  approve: 'needs approval',
} as const;

/** The second-person voice — only for an ask routed to the reader (`askAudience` === 'you'). */
export const SPECIES_VERB_YOU = {
  consult: 'asks what you think',
  escalate: 'escalated to you',
  approve: 'needs your approval',
} as const;

/** One slot in the stream's rotation: an ask, or a lane sitting in acceptance. */
export interface ReelItem {
  kind: 'ask' | 'review';
  ask?: AskView;
  review?: ReviewView;
}

/**
 * What `/broadcast` rotates through (nick, 2026-08-05: "can a viewer see the acceptances waiting on
 * other members?").
 *
 * On `/live` the review queue can live in a sheet, because a reader can open it. A stream viewer has
 * no cursor, so anything not in the rotation is invisible — which is why the queue is folded in here
 * rather than rendered as a second panel nobody would ever see all of.
 *
 * A lane whose acceptance ask is still open is DROPPED from the review half: it is already rotating
 * as that ask, and showing both would double-count one piece of waiting. What remains is the case a
 * viewer otherwise never sees — a lane still in acceptance whose ask was answered, timed out, or was
 * never routed.
 */
export function reelItems(asks: AskView[], reviews: ReviewView[]): ReelItem[] {
  const loudLanes = new Set(
    asks
      .filter((a) => askIsLoud(a.state))
      .map((a) => (a.env.meta?.['lane_review'] as { lane?: unknown } | undefined)?.lane)
      .filter((l): l is string => typeof l === 'string'),
  );
  return [
    ...asks.filter((a) => askIsLoud(a.state) || a.state === 'deferred').map((ask) => ({ kind: 'ask' as const, ask })),
    ...reviews.filter((r) => !loudLanes.has(r.lane.id)).map((review) => ({ kind: 'review' as const, review })),
  ];
}

const TIER_WEIGHT = { blocking: 0, standard: 1, advisory: 2 } as const;

const AUDIENCE_WEIGHT = { you: 0, team: 1, human: 2, agent: 3 } as const;

/**
 * The rail's order once the recipient exists: what is YOURS first, then the team pool you could take,
 * then other people's, then the agents' — and within each bucket, the untouched ADR 149 urgency order.
 * An agent's blocking ask never outranks your standard one: however hot its clock, it is not this
 * reader's clock.
 */
export function byAudienceThenUrgency(ctx: AudienceContext, now: number = Date.now()) {
  return (a: AskView, b: AskView): number => {
    const wa = AUDIENCE_WEIGHT[askAudience(a, ctx)];
    const wb = AUDIENCE_WEIGHT[askAudience(b, ctx)];
    if (wa !== wb) return wa - wb;
    return byUrgency(a, b, now);
  };
}

/**
 * Which open ask matters most — the order the rail leads with and the sheet lists in.
 *
 * A stopped teammate outranks a ticking clock: nothing is moving until a human answers. But "the
 * clock ran out" is not the same as "stopped" — only a holding tier holds (ADR 147 §4). A standard
 * ask that times out means the agent *proceeded*, which is the tier working as designed; ranking it
 * above a blocking ask that still has time would put a decision already made ahead of one waiting to
 * be. So: actually-stuck first, then tier, then the clock, soonest first.
 */
export function byUrgency(a: AskView, b: AskView, now: number = Date.now()): number {
  const stuck = (x: AskView) =>
    x.state === 'held' || (x.deadline <= now && askTierHolds(x.tier)) ? 0 : 1;
  if (stuck(a) !== stuck(b)) return stuck(a) - stuck(b);
  if (TIER_WEIGHT[a.tier] !== TIER_WEIGHT[b.tier]) return TIER_WEIGHT[a.tier] - TIER_WEIGHT[b.tier];
  return a.deadline - b.deadline;
}
