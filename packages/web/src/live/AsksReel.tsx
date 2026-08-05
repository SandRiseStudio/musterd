import { useEffect, useMemo, useState } from 'react';
import type { Envelope, LaneBoard, MemberSummary } from '@musterd/protocol';
import { askTierHolds } from '@musterd/protocol';
import {
  askIsLoud,
  byUrgency,
  deriveAsks,
  deriveReviewQueue,
  reelItems,
  SPECIES_VERB,
  type AskView,
  type ReviewView,
} from './asks';
import { initial, kindOf, memberColor } from './format';
import { reelIndex } from './reel';

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
  const asks = useMemo(() => deriveAsks(envelopes), [envelopes]);
  const loud = asks.filter((a) => askIsLoud(a.state)).sort((a, b) => byUrgency(a, b));
  const deferred = asks.filter((a) => a.state === 'deferred');
  const settled = asks.length - loud.length - deferred.length;
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

  // One clock drives both the rotation and the countdowns. It ticks only while something is loud —
  // idle cost is paid by every viewer, forever (packages/web/AGENTS.md), and a stream runs for hours.
  const [mountedAt] = useState(() => Date.now());
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (loud.length === 0) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [loud.length]);

  // Null only when the timeline holds no asks at all — same rule as /live's strip. With everything
  // settled, /live shows a quiet "nothing waiting" row rather than vanishing, and the stream keeps
  // that: the counts are office chrome, and a bar that blinks out whenever the last ask closes
  // reads as breakage on a video.
  if (asks.length === 0 && reviews.length === 0) return null;

  const shown = cards.length > 0 ? cards[reelIndex(cards.length, now - mountedAt)]! : null;
  const shownId = shown ? (shown.ask?.env.id ?? shown.review!.lane.id) : null;
  const idx = new Map(roster.map((m) => [m.name, m]));

  return (
    <section
      className={`bc-reel${loud.length > 0 ? ' bc-reel--loud' : ''}`}
      aria-label="asks and approvals"
    >
      {/* The eyebrow row — the same shape as the floor card's "ON THE FLOOR" head: mono label,
          counts pushed right, the amber hairline underneath. The card announces WHAT it is here so
          the ask line below can be nothing but the ask. */}
      <header className="bc-reel__head">
        <BellIcon />
        <span className="bc-reel__label">Asks &amp; approvals</span>
        <span className="bc-reel__spacer" />
        {loud.length > 0 && <span className="bc-reel__meta">{loud.length} waiting</span>}
        {reviews.length > 0 && <span className="bc-reel__meta">{reviews.length} in review</span>}
        {deferred.length > 0 && <span className="bc-reel__meta">{deferred.length} deciding</span>}
        {settled > 0 && <span className="bc-reel__meta bc-reel__meta--dim">{settled} settled</span>}
        {shown !== null && cards.length > 1 && (
          <span className="bc-reel__dots" aria-hidden="true">
            {cards.map((c) => {
              const id = c.ask?.env.id ?? c.review!.lane.id;
              return <i key={id} className={id === shownId ? 'is-on' : undefined} />;
            })}
          </span>
        )}
      </header>
      {shown === null ? (
        <div className="bc-reel__row bc-reel__row--quiet">nothing waiting</div>
      ) : shown.kind === 'ask' ? (
        <ShownAsk shown={shown.ask!} idx={idx} now={now} />
      ) : (
        <ShownReview shown={shown.review!} idx={idx} />
      )}
    </section>
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
  return (
    // Keyed on the envelope id so React remounts on rotation and the entry animation replays —
    // without it the text swaps in place and the change is easy to miss on a stream.
    <div className="bc-reel__row" key={shown.env.id}>
      <span
        className="bc-reel__who"
        style={{ background: memberColor(shown.env.from, kindOf(shown.env.from, idx)) }}
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
        style={{ background: memberColor(owner, kindOf(owner, idx)) }}
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
