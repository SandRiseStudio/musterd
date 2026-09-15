import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import type { Envelope, LaneBoard, MemberSummary } from '@musterd/protocol';
import { askTierHolds } from '@musterd/protocol/wire';
import {
  applyTierClock,
  askIsLoud,
  byUrgency,
  clockFraction,
  deriveAsks,
  deriveReviewQueue,
  reelItems,
  SPECIES_VERB,
  type AskView,
  type ReviewView,
} from './asks';
import { acceptanceCapacity, initial, kindOf, memberAvatar, memberColor, hueOf } from './format';
import { reelIndex, reelTicks } from './reel';

/**
 * The asks rail as stream chrome (ADR 228) — what `AsksStrip` is to `/live`, minus every part that
 * takes input.
 *
 * **Why a separate component rather than a `broadcast` prop on `AsksStrip`.** Two reasons, and the
 * second is the one that settles it. `AsksStrip` is ~460 lines of *answerability* — `sendAct`,
 * sign-in offers, an Escape/click-outside sheet, `document.title` — and threading a mode through all
 * of it would couple a stream chyron to a form. And the two have genuinely different legibility
 * constraints: the 1080p stage is encoded at 720p, so `/live`'s 11.5px rail lands near 7.7px before
 * Twitch's encoder ever sees it. One stylesheet cannot serve both. What they *do* share is the
 * derivation, and that already lives in `asks.ts` as pure functions — which is the real seam.
 *
 * Nobody watching can click "see all", so the rail rotates instead: one ask at a time, by urgency.
 */
export function AsksReel({
  envelopes,
  roster,
  board = null,
}: {
  envelopes: Envelope[];
  roster: MemberSummary[];
  /** The lane board the page already holds — feeds the review queue into the rotation. */
  board?: LaneBoard | null;
}) {
  // One clock drives the rotation, the countdowns, and which side of its tier contract an
  // unanswered ask fell on — declared first because the derivation now reads it.
  const [mountedAt] = useState(() => Date.now());
  const [now, setNow] = useState(() => Date.now());

  const derived = useMemo(() => deriveAsks(envelopes), [envelopes]);
  /**
   * A stream has no cursor, so anything the reel rotates is the whole of what a viewer can ever see —
   * which makes rotating dead cards worse here than on /live, not better. An ask past a below-top
   * tier deadline was answered by the contract days ago (`applyTierClock`); it leaves the rotation
   * and is counted, dimmed, as `elapsed`.
   */
  const asks = useMemo(() => applyTierClock(derived, now), [derived, now]);
  const loud = asks.filter((a) => askIsLoud(a.state)).sort((a, b) => byUrgency(a, b, now));
  const deferred = asks.filter((a) => a.state === 'deferred');
  const lapsed = asks.filter((a) => a.state === 'lapsed');
  const settled = asks.length - loud.length - deferred.length - lapsed.length;
  const reviews = useMemo(
    () => (board ? deriveReviewQueue(board.lanes, asks) : []),
    [board, asks],
  );
  const cards = useMemo(
    () => reelItems([...loud, ...deferred], reviews),
    // The sorted arrays are rebuilt every render; their CONTENT is what matters to the rotation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [asks, reviews],
  );

  // The tick. Idle cost is paid by every viewer, forever (packages/web/AGENTS.md), and a stream runs
  // for hours — so it runs only when something on screen actually changes with time: a countdown
  // (`loud`), or a rotation with more than one card to turn. Both halves matter, and why the second
  // one is not implied by the first is written out on `reelTicks`.
  //
  // Computed HERE, in render, rather than inside the effect: it makes the condition a pure function
  // this suite can hold (effects never run under `react-dom/server`), and it makes the dependency
  // exactly the thing the effect branches on — the interval is now torn down and rebuilt only when
  // the answer actually flips, not on every change of loud count.
  const ticks = reelTicks(loud.length, cards.length);
  useEffect(() => {
    if (!ticks) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [ticks]);

  // Null only when the timeline holds no asks at all — same rule as /live's strip. With everything
  // settled, /live shows a quiet "nothing waiting" row rather than vanishing, and the stream keeps
  // that: the counts are office chrome, and a bar that blinks out whenever the last ask closes
  // reads as breakage on a video.
  if (asks.length === 0 && reviews.length === 0) return null;

  const shown = cards.length > 0 ? cards[reelIndex(cards.length, now - mountedAt)]! : null;
  const shownId = shown ? (shown.ask?.env.id ?? shown.review!.lane.id) : null;
  const idx = new Map(roster.map((m) => [m.name, m]));
  // Why nearly every row above reads "→ gptbot" (nick, watching the stream, 2026-08-05). Without
  // this the reel repeats one name until it looks like a preference; it is a capacity failure, and
  // a viewer should be able to see that from the picture alone.
  const capacity = acceptanceCapacity(roster);
  // The reel wears the shown seat's colour, rim and bell, as /live's strip wears its lead's — see
  // the note there. A review row colours by the lane's owner: the person whose work is waiting.
  const who = shown ? (shown.ask?.env.from ?? shown.review!.lane.owner_seat ?? null) : null;
  const whoStyle = who
    ? ({ '--lc-asks-hue': memberColor(who, kindOf(who, idx), hueOf(who, idx)) } as CSSProperties)
    : undefined;

  return (
    <section
      className={`bc-reel${loud.length > 0 ? ' bc-reel--loud' : ''}${who ? ' has-lead' : ''}`}
      style={whoStyle}
      aria-label="asks and approvals"
    >
      {/* One line, /live's rail shape (nick, 2026-08-19: the eyebrow-header version spent two rows
          of stage on what /live says in one). The bell is the announcement, the rotating slot is the
          content, and the counts + rotation dots hold the right edge — nothing stacks. */}
      <div className="bc-reel__line">
        <BellIcon />
        {shown === null ? (
          <div className="bc-reel__row bc-reel__row--quiet">
            <b>asks &amp; approvals</b>
            <span className="bc-reel__verb">nothing waiting</span>
          </div>
        ) : shown.kind === 'ask' ? (
          <ShownAsk shown={shown.ask!} idx={idx} now={now} />
        ) : (
          <ShownReview shown={shown.review!} idx={idx} />
        )}
        <ReelCounts
          waiting={loud.length}
          inReview={reviews.length}
          deciding={deferred.length}
          elapsed={lapsed.length}
          settled={settled}
        />
        {shown !== null && cards.length > 1 && (
          <span className="bc-reel__dots" aria-hidden="true">
            {cards.map((c) => {
              const id = c.ask?.env.id ?? c.review!.lane.id;
              return <i key={id} className={id === shownId ? 'is-on' : undefined} />;
            })}
          </span>
        )}
      </div>
      {capacity.degraded && (
        <div className="bc-reel__ladder">
          No live acceptor
          {capacity.models.length === 1 ? ` — every agent on ${capacity.models[0]}` : ''}. Reviews
          are waiting on a wake.
        </div>
      )}
    </section>
  );
}

/**
 * The tally on the right edge — what is owed, and what is already answered.
 *
 * It shipped as five spans in one voice: `13px` mono at `--lc-paper-dim`, with `elapsed` and
 * `settled` at 0.6 opacity and nothing else separating them (nick, 2026-09-04: "there are a lot of
 * counts/text at the end that all look visually the same"). Five equal greys is not a summary, it
 * is a run of text a viewer has to *read* — and this bar is watched from across a room, through a
 * 720p encode, by someone who will never click it.
 *
 * Three changes, in the order they matter.
 *
 * **The number leads.** In every one of these the digit is the content and the word is its label,
 * but they were the same size and weight, so neither won. The count is now a heavier, larger
 * tabular figure and the label is small and quiet beside it. That alone makes the row scannable
 * without changing a single value.
 *
 * **Two clusters, not five items.** `waiting`, `in review` and `deciding` are things this team
 * still owes; `elapsed` and `settled` are history. They are split by a hairline, so the eye lands
 * on "is anything owed?" before it reads a single word. They are deliberately NOT merged into one
 * "done" — an elapsed ask timed out unanswered and a settled one was answered, and collapsing a
 * miss into a success is exactly the kind of tidy lie a summary row invites.
 *
 * **Colour carries the state**, because colour is what survives the encode when weight does not. A
 * pip per count: accent for what is waiting, ink for the two middle states, `--lc-warn` for elapsed
 * (a fill — text amber is `--lc-warn-ink`, per packages/web/AGENTS.md) and a hollow ring for
 * settled. Pure decoration, so every pip is `aria-hidden` and the text still reads on its own.
 *
 * Zero counts stay absent rather than showing `0`: a stream is watched, not audited, and five zeroes
 * is the same wall of grey in a different disguise.
 */
function ReelCounts({
  waiting,
  inReview,
  deciding,
  elapsed,
  settled,
}: {
  waiting: number;
  inReview: number;
  deciding: number;
  elapsed: number;
  settled: number;
}) {
  // The state key drives the pip's colour; the label is what a viewer reads. They are separate
  // because the shortest honest label is not always a good class name, and vice versa — "in review"
  // is two words and `is-in review` is not a selector.
  const owed: Tally[] = [
    { state: 'waiting', label: 'waiting', n: waiting },
    { state: 'review', label: 'in review', n: inReview },
    { state: 'deciding', label: 'deciding', n: deciding },
  ];
  const past: Tally[] = [
    { state: 'elapsed', label: 'elapsed', n: elapsed },
    { state: 'settled', label: 'settled', n: settled },
  ];
  const live = owed.filter((t) => t.n > 0);
  const done = past.filter((t) => t.n > 0);
  if (live.length === 0 && done.length === 0) return null;
  return (
    <span className="bc-reel__counts">
      {live.map((t) => (
        <Count key={t.state} {...t} />
      ))}
      {/* Only where both sides exist — a rule with nothing on one side of it is a stray mark. */}
      {live.length > 0 && done.length > 0 && (
        <i className="bc-reel__counts-split" aria-hidden="true" />
      )}
      {done.map((t) => (
        <Count key={t.state} {...t} past />
      ))}
    </span>
  );
}

interface Tally {
  state: string;
  label: string;
  n: number;
}

function Count({ state, label, n, past = false }: Tally & { past?: boolean }) {
  return (
    <span className={`bc-reel__meta is-${state}${past ? ' is-past' : ''}`}>
      <i className="bc-reel__pip" aria-hidden="true" />
      <b>{n}</b>
      <em>{label}</em>
    </span>
  );
}

/** The rotating slot: who wants what, how urgent, how long left. */
function ShownAsk({
  shown,
  idx,
  now,
}: {
  shown: AskView;
  idx: Map<string, MemberSummary>;
  now: number;
}) {
  // The tier clock as an arc round the avatar, off the same `now` the text clock reads.
  const frac = clockFraction(shown, now);
  return (
    // Keyed on the envelope id so React remounts on rotation and the entry animation replays —
    // without it the text swaps in place and the change is easy to miss on a stream.
    <div className="bc-reel__row" key={shown.env.id}>
      <span
        className={`bc-reel__who${frac === null ? '' : frac > 0 ? ' is-timed' : ' is-over'}`}
        style={
          {
            background: memberAvatar(shown.env.from, kindOf(shown.env.from, idx), hueOf(shown.env.from, idx)),
            '--lc-ask-frac': frac ?? 0,
          } as CSSProperties
        }
        aria-hidden="true"
      >
        {initial(shown.env.from)}
      </span>
      <span className="bc-reel__lead">
        <b>{shown.env.from}</b>
        <span className="bc-reel__verb">{SPECIES_VERB[shown.species]}</span>
        {/* Who has to answer it. On a stream this is the whole question a viewer is asking — "is
            this team stuck, and on whom?" — and without it the row reads as a demand on nobody
            (nick, 2026-08-05). Directly above the review rows, which answer the same question for
            lanes, so the two halves of "what is waiting" read in one voice. */}
        {shown.to && <span className="bc-reel__routed-inline">→ {shown.to}</span>}
        {shown.env.body && <span className="bc-reel__gist">{shown.env.body}</span>}
      </span>
      <span className={`bc-reel__tier bc-reel__tier--${shown.tier}`}>{shown.tier}</span>
      <ReelClock ask={shown} now={now} />
    </div>
  );
}

/** A lane sitting in acceptance: whose work it is, what it is, and who has to say yes. */
function ShownReview({ shown, idx }: { shown: ReviewView; idx: Map<string, MemberSummary> }) {
  const owner = shown.lane.owner_seat ?? '?';
  return (
    <div className="bc-reel__row" key={shown.lane.id}>
      <span
        className="bc-reel__who"
        style={{ background: memberAvatar(owner, kindOf(owner, idx), hueOf(owner, idx)) }}
        aria-hidden="true"
      >
        {initial(owner)}
      </span>
      <span className="bc-reel__lead">
        <b>{owner}</b>
        <span className="bc-reel__verb">in review</span>
        <span className="bc-reel__gist">{shown.lane.title}</span>
      </span>
      <span className="bc-reel__routed">
        {shown.waitingOn ? `waiting on ${shown.waitingOn}` : 'unrouted'}
      </span>
    </div>
  );
}

/** The tier clock. Same semantics as /live's, reading the caller's `now` so one interval drives all. */
function ReelClock({ ask, now }: { ask: AskView; now: number }) {
  if (ask.state === 'held') return <Elapsed holding />;
  if (ask.state !== 'open') return null;
  const left = ask.deadline - now;
  if (left <= 0) return <Elapsed holding={askTierHolds(ask.tier)} />;
  const m = Math.floor(left / 60_000);
  const s = Math.floor((left % 60_000) / 1000);
  return (
    <span className="bc-reel__clock">
      {m}:{String(s).padStart(2, '0')} left
    </span>
  );
}

function Elapsed({ holding }: { holding: boolean }) {
  return (
    <span className="bc-reel__clock bc-reel__clock--over">
      timed out{holding && <span className="bc-reel__holding"> — agent holding</span>}
    </span>
  );
}

function BellIcon() {
  return (
    <svg className="bc-reel__bell" viewBox="0 0 12 12" aria-hidden="true">
      <path d="M6 1.8a2.9 2.9 0 0 1 2.9 2.9v1.9l1 1.6H2.1l1-1.6V4.7A2.9 2.9 0 0 1 6 1.8zM4.9 9.6a1.15 1.15 0 0 0 2.2 0" />
    </svg>
  );
}
