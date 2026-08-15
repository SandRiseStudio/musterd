/**
 * What an un-threaded `accept` / `decline` is answering (ADR 067's convenience, bounded).
 *
 * ADR 067 let a seat answer without naming a target: pointing at the one open request is not a
 * guess, and closing the loop in one call is worth having. The convenience is deliberate and it
 * stays — including with several plain requests open, because answering the wrong `request_help`
 * is recoverable. Answering the wrong LANE is not: since ADR 202 an accept CLOSES what it binds to.
 *
 * WHAT WENT WRONG, and why the rule now lives in one place. The refusal existed twice — in the MCP
 * adapter and in the CLI — tested in neither, and both copies asked a question one step off:
 *
 *     if (isLaneReviewAsk(target) && open.length > 1)   // target = open[0], the NEWEST
 *
 * That fires only when the unrecoverable candidate happens to be the newest thing in the inbox. Any
 * plain ask arriving afterwards turns the guard off, and the verdict binds to the newcomer while the
 * acceptance ask it belonged to sits open one row down. Measured 2026-08-15 clearing a five-lane
 * queue: four accepts landed on guardian `daemon_down` asks; two of those had the correct acceptance
 * ask open and passed it over; none of the four lanes left `awaiting_acceptance`. Four outage
 * reports now read as answered by reviews of unrelated pull requests.
 *
 * So the trigger is the PRESENCE of an unrecoverable candidate anywhere in the open set, not the
 * position of one. A first draft of this fix refused on ambiguity as such — the adapter's own tests
 * caught it, which is the reason this rule is now exercised rather than merely asserted.
 */

/** The slice of an envelope this decision reads. Structural, so both surfaces can pass their own. */
export interface AutoTargetable {
  id: string;
  act: string;
  from: string;
  ts: number;
  meta?: unknown;
}

export type AutoTargetResult =
  /** Exactly one open ask — bind to it, as ADR 067 intends. */
  | { kind: 'target'; target: AutoTargetable }
  /** Ambiguous — the caller must name one, and the message lists them ready to paste. */
  | { kind: 'refuse'; message: string }
  /** Nothing open to answer at all. */
  | { kind: 'none'; message: string };

/** How many candidates a refusal lists before it stops being readable. */
const MAX_LISTED = 6;

/**
 * How a surface spells "name the target". The RULE is shared; the wording is not — each package
 * keeps its own error convention, so the MCP adapter says `reply_to:<id>` and the CLI says
 * `--reply-to <id>`. Passing this in is what let the two copies of the rule become one without
 * making either surface speak the other's language.
 */
export interface ReplyToStyle {
  /** Render the copy-pasteable reference to one candidate. */
  ref: (id: string) => string;
  /** Where a seat goes to see the queue for itself. */
  discover: string;
}

const MCP_STYLE: ReplyToStyle = {
  ref: (id) => `reply_to:${id}`,
  discover: 'see team_inbox_check',
};

export const CLI_REPLY_TO_STYLE: ReplyToStyle = {
  ref: (id) => `--reply-to ${id}`,
  discover: 'see musterd inbox --json',
};

function laneOf(m: AutoTargetable): string | undefined {
  const meta = m.meta as { lane_review?: { lane?: string } } | null | undefined;
  return typeof meta?.lane_review?.lane === 'string' ? meta.lane_review.lane : undefined;
}

/**
 * Decide what an un-threaded verdict answers.
 *
 * @param open Open, answerable asks for this member, NEWEST FIRST (the order both callers build).
 * @param act  The verdict being sent — named in the refusal so the message reads as instruction.
 */
export function chooseAutoTarget(
  open: AutoTargetable[],
  act: string,
  style: ReplyToStyle = MCP_STYLE,
): AutoTargetResult {
  const first = open[0];
  if (!first) {
    return {
      kind: 'none',
      message: `no open request to ${act} — name one with ${style.ref('<id>')} (${style.discover})`,
    };
  }

  // One candidate is not a guess: ADR 067's case, and it stays.
  if (open.length === 1) return { kind: 'target', target: first };

  // ADR 067 convenience survives for plain request_help/handoff, deliberately: answering the wrong
  // call for help is recoverable, and answering the wrong lane is not (since ADR 202 an accept
  // CLOSES what it binds to). So the trigger is the presence of an unrecoverable candidate ANYWHERE
  // in the open set — not, as before, whether the newest one happens to be it.
  if (!open.some((m) => laneOf(m) !== undefined)) return { kind: 'target', target: first };

  const lines = open
    .slice(0, MAX_LISTED)
    .map((m) => {
      const lane = laneOf(m);
      return `  ${style.ref(m.id)}  ${m.act} from ${m.from}${lane ? ` — lane ${lane}` : ''}`;
    })
    .join('\n');

  return {
    kind: 'refuse',
    // The count is deliberately the TOTAL, not the number listed: a seat that sees six lines and a
    // total of twenty knows the list is a window, and a seat that sees six and a total of six knows
    // it is the whole queue. Printing only the window is how a deep queue looks shallow.
    message:
      `${open.length} open asks — name the one you are answering, so this ${act} lands on what ` +
      `you actually reviewed:\n${lines}`,
  };
}
