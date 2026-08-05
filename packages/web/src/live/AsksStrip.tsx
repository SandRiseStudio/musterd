import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Envelope, LaneBoard, MemberSummary } from '@musterd/protocol';
import { askTierHolds } from '@musterd/protocol';
import {
  askAudience,
  askIsLoud,
  byAudienceThenUrgency,
  deriveAsks,
  deriveReviewQueue,
  SPECIES_VERB,
  SPECIES_VERB_YOU,
  type AskView,
  type AudienceContext,
} from './asks';
import { sendAct, type LiveConfig } from './client';
import { initial, memberColor, kindOf } from './format';
import { scrollToMessage } from './Stream';

/**
 * The asks & approvals rail (ADR 149) — the above-the-fold home of the to-human ask stream (ADR 147)
 * on /live. Pure derivation over the timeline the page already holds; renders nothing until an ask
 * exists.
 *
 * **It costs the canvas one line, always.** The rail is a single row: who is waiting, what they
 * want, the tier clock, and accept/decline for the most urgent one — answerable without opening
 * anything. Everything else lives in a sheet that floats *over* the canvas, so expanding never
 * reflows the office/roster/stream. Same footprint at every tier: a blocking ask does not earn extra
 * room, it earns a hotter colour, a faster pulse, and a clock that has already run out.
 *
 * Answerable exactly when the connected seat is a real roster member (the "Advanced — connect as a
 * specific seat" sign-in): **accept**, **decline**, and the ADR 147 §5 "deciding — check back in ⟨1h⟩"
 * deferral, each an ordinary envelope through `POST /messages`. The auto-provisioned observer is
 * read-only by construction (ADR 063, hidden from the roster), so a watch-link viewer sees the rail
 * without buttons.
 */
export function AsksStrip({
  envelopes,
  roster,
  cfg,
  watchLink = false,
  localIdentity = null,
  onSignIn,
  onSignOut,
  board = null,
  onOpenLane,
}: {
  envelopes: Envelope[];
  roster: MemberSummary[];
  cfg: LiveConfig;
  /** Arrived by watch link — the team handed this viewer a read-only view deliberately (ADR 063). */
  watchLink?: boolean;
  /** The seat this machine can sign in as with one click, when the daemon says it has one. */
  localIdentity?: string | null;
  onSignIn?: () => void;
  onSignOut?: () => void;
  /** The lane board the page already holds (useWorkingOn) — feeds the review queue; null renders none. */
  board?: LaneBoard | null;
  /** Open the room's board overlay on a lane — the review queue's click-through. */
  onOpenLane?: (laneId: string) => void;
}) {
  // Answers this browser just sent: the firehose deliberately skips the sender, so the POST ack is the
  // only copy this client sees — fold it into the derivation so the card settles immediately.
  const [localAnswers, setLocalAnswers] = useState<Envelope[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLElement | null>(null);

  const asks = useMemo(
    () => deriveAsks([...envelopes, ...localAnswers]),
    [envelopes, localAnswers],
  );
  // Answerable iff the connected seat is a real member (observers are hidden from the roster).
  const canAnswer = roster.some((m) => m.name === cfg.as);
  /**
   * Who "you" are for audience purposes (lane 01KZ9GFHZ9): the signed-in seat, else the seat one
   * click would make you. Routing is judged against that identity — an ask routed to an AGENT must
   * never render under "sign in to answer" copy, which is exactly how this strip told a reader that
   * ten agent-routed asks were nick's.
   */
  const ctx: AudienceContext = useMemo(
    () => ({
      you: canAnswer ? cfg.as : localIdentity,
      humans: new Set(roster.filter((m) => m.kind === 'human').map((m) => m.name)),
    }),
    [canAnswer, cfg.as, localIdentity, roster],
  );
  const loud = asks.filter((a) => askIsLoud(a.state)).sort(byAudienceThenUrgency(ctx));
  const deferred = asks.filter((a) => a.state === 'deferred');
  const closed = asks.length - loud.length - deferred.length;
  const cards = [...loud, ...deferred];
  // The one the rail answers inline, and the one the sheet puts first: yours first, then urgency.
  const lead = loud[0] ?? deferred[0];
  const leadAudience = lead ? askAudience(lead, ctx) : null;
  // Yours-or-anyone's: the only audiences whose asks this browser should be invited to answer.
  const leadIsOurs = leadAudience === 'you' || leadAudience === 'team';
  const yoursCount = loud.filter((a) => {
    const aud = askAudience(a, ctx);
    return aud === 'you' || aud === 'team';
  }).length;

  // The review queue (nick, 2026-08-05): every lane in acceptance and who it waits on, at a glance.
  const reviews = useMemo(
    () => (board ? deriveReviewQueue(board.lanes, asks) : []),
    [board, asks],
  );

  // A 1s tick while any clock is running, so the countdowns are honest. Stops when nothing is loud —
  // idle cost is paid by every viewer, forever (packages/web/AGENTS.md).
  const [, setTick] = useState(0);
  useEffect(() => {
    if (loud.length === 0) return;
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, [loud.length]);

  // Waiting-on-YOU count in the tab title — loud even when the tab isn't front. Counts only asks
  // this browser's identity could answer (yours + team-pool): titling the tab "(10 asks)" for ten
  // agent-routed reviews is the lie this lane exists to retire.
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const base = document.title.replace(/^\(\d+ asks?\) /, '');
    document.title =
      yoursCount > 0 ? `(${yoursCount} ask${yoursCount > 1 ? 's' : ''}) ${base}` : base;
    return () => {
      document.title = base;
    };
  }, [yoursCount]);

  // Dismissal: Escape, and a click anywhere outside. Both are what a floating layer owes the reader —
  // it covers the canvas, so it must be as easy to put away as it was to open.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDown);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onDown);
    };
  }, [open]);

  /**
   * What the action slot holds when you cannot answer (ADR 222). Before this, it held nothing: the
   * buttons were absent and the silence unexplained, so a read-only rail was pixel-identical to an
   * answerable one with nothing open.
   *
   * - `offer` — the daemon confirmed an identity on THIS machine; one click and you are yourself.
   * - `paste` — off-machine, or no CLI identity here. The one-click route correctly refuses off
   *   this machine (it returns a credential), so the honest fallback is the credential form, which
   *   does work over the network.
   * - `none`  — a watch link. The team gave this viewer a read-only view on purpose; inviting them
   *   to sign in would be a nag aimed at someone with no seat to sign into.
   */
  const wayIn: 'offer' | 'paste' | 'none' = watchLink ? 'none' : localIdentity ? 'offer' : 'paste';

  const answer = useCallback(
    async (ask: AskView, kind: 'accept' | 'decline' | 'deciding') => {
      setBusy(ask.env.id);
      setError(null);
      try {
        const to = { kind: 'member', name: ask.env.from } as const;
        const thread = ask.env.thread ?? ask.env.id;
        const ack =
          kind === 'deciding'
            ? await sendAct(cfg, {
                act: 'wait',
                to,
                thread,
                body: 'deciding — check back in 1h',
                meta: { ask_ref: ask.env.id, until: '1h' },
              })
            : await sendAct(cfg, {
                act: kind,
                to,
                thread,
                meta: { in_reply_to: ask.env.id },
              });
        setLocalAnswers((prev) => [...prev, ack]);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(null);
      }
    },
    [cfg],
  );

  if (asks.length === 0 && reviews.length === 0) return null;

  const idx = new Map(roster.map((m) => [m.name, m]));
  const rest = cards.length - (lead ? 1 : 0);

  return (
    <section
      ref={rootRef}
      className={`lc-asks${loud.length > 0 ? ' lc-asks--loud' : ''}${open ? ' is-open' : ''}`}
      aria-label="asks and approvals"
    >
      <div className="lc-asks__rail">
        <BellIcon />

        {lead ? (
          <>
            <span
              className="lc-chip__avatar lc-asks__who"
              style={{ background: memberColor(lead.env.from, kindOf(lead.env.from, idx)) }}
              aria-hidden="true"
            >
              {initial(lead.env.from)}
            </span>
            <button
              type="button"
              className="lc-asks__lead"
              onClick={() => scrollToMessage(lead.env.id)}
              title="Jump to this ask in the stream"
            >
              <b>{lead.env.from}</b>
              <span className="lc-asks__verb">
                {leadAudience === 'you' ? SPECIES_VERB_YOU[lead.species] : SPECIES_VERB[lead.species]}
              </span>
              {/* Routed elsewhere: name the actual acceptor, so nobody reads an agent's queue as
                  their own (lane 01KZ9GFHZ9 — the strip's wrong-acceptor bug was exactly this). */}
              {!leadIsOurs && lead.to && (
                <span className="lc-asks__routed">→ {lead.to}</span>
              )}
              {lead.env.body && <span className="lc-asks__gist">{lead.env.body}</span>}
            </button>
            <span className={`lc-ask__tier lc-asks__tier lc-ask__tier--${lead.tier}`}>
              {lead.tier}
            </span>
            <AskClock ask={lead} />
            {askIsLoud(lead.state) && canAnswer && leadIsOurs && (
              <span className="lc-asks__quick">
                <button
                  type="button"
                  disabled={busy === lead.env.id}
                  className="lc-ask__btn lc-ask__btn--accept"
                  onClick={() => void answer(lead, 'accept')}
                  title={`approve — ${lead.env.from}`}
                >
                  <CheckIcon />
                  Approve
                </button>
                <button
                  type="button"
                  disabled={busy === lead.env.id}
                  className="lc-ask__btn lc-ask__btn--decline"
                  onClick={() => void answer(lead, 'decline')}
                  title={`deny — ${lead.env.from}`}
                >
                  <CrossIcon />
                  Deny
                </button>
              </span>
            )}
            {/* The way in sits exactly where the answer will sit, so one click swaps this for
                Approve/Deny in place and the rail never moves (ADR 222). Only offered when the ask
                is actually answerable BY that identity — "Sign in as nick" on gptbot's review queue
                was this strip's founding lie. */}
            {askIsLoud(lead.state) && !canAnswer && leadIsOurs && wayIn === 'offer' && (
              <button
                type="button"
                className="lc-ask__btn lc-asks__signin"
                onClick={onSignIn}
                title={`sign in as ${localIdentity} on this machine`}
              >
                Sign in as {localIdentity} to answer
              </button>
            )}
            {askIsLoud(lead.state) && !canAnswer && leadIsOurs && wayIn === 'paste' && (
              <button
                type="button"
                className="lc-ask__btn lc-asks__link lc-asks__signin--ghost"
                onClick={onSignIn}
                title="sign in with your seat credential to answer asks"
              >
                sign in with a credential →
              </button>
            )}
          </>
        ) : (
          <span className="lc-asks__lead lc-asks__lead--quiet">
            <b>asks &amp; approvals</b>
            <span className="lc-asks__verb">nothing waiting on a human</span>
          </span>
        )}

        <span className="lc-asks__spacer" />

        {reviews.length > 0 && <span className="lc-asks__meta">{reviews.length} in review</span>}
        {deferred.length > 0 && <span className="lc-asks__meta">{deferred.length} deciding</span>}
        {closed > 0 && <span className="lc-asks__meta">{closed} settled</span>}

        {(cards.length > 0 || reviews.length > 0) && (
          <button
            type="button"
            className="lc-ask__btn lc-asks__more"
            aria-expanded={open}
            onClick={() => setOpen((v) => !v)}
          >
            {rest > 0 && <span className="lc-asks__restcount">+{rest}</span>}
            <span className="lc-asks__morelabel">
              {open ? 'close' : rest > 0 ? 'see all' : 'details'}
            </span>
            <ChevronIcon />
          </button>
        )}
        <a className="lc-asks__link" href="/approvals" title="Seat-claim approvals (admin)">
          seat approvals →
        </a>

        {/* Who you are about to answer as (ADR 222). Not decoration: with several teams on one
            machine you may be a different person on each, and approving as the wrong identity is
            unrecoverable — so the connected seat is never implicit. It is also the way back out,
            the escape a cached seat never had.
            Only rendered when you CAN answer. The chip answers "who would I be answering as?", and
            where you cannot answer there is no such question — the sign-in button beside it already
            names who you would become. Inside the office panel the rail is ~470px, and rendering
            both spends ~60px it does not have. */}
        {canAnswer && (
          <button
            type="button"
            className="lc-ask__btn lc-asks__me"
            onClick={onSignOut}
            title={`signed in as ${cfg.as} on ${cfg.team} — watch as an observer instead`}
          >
            {cfg.as} · {cfg.team}
          </button>
        )}
      </div>

      {error && <div className="lc-asks__error">{error}</div>}

      {/* Closed, the sheet is inert: no tab stops into a layer the reader cannot see. */}
      {(cards.length > 0 || reviews.length > 0) && (
        <div className="lc-asks__sheet" data-open={open || undefined} inert={!open}>
          <div className="lc-asks__cards">
            {cards.map((ask, i) => {
              const aud = askAudience(ask, ctx);
              return (
                <AskCard
                  key={ask.env.id}
                  ask={ask}
                  idx={idx}
                  canAnswer={canAnswer && (aud === 'you' || aud === 'team')}
                  audience={aud}
                  busy={busy === ask.env.id}
                  onAnswer={(kind) => void answer(ask, kind)}
                  style={{ '--i': i } as React.CSSProperties}
                />
              );
            })}
          </div>
          {/* The review queue (nick, 2026-08-05): every lane sitting in acceptance and who it waits
              on — visibility the board overlay had a click too deep. Read-only here: acceptance is
              the acceptor's act, so each row is a way IN (opens the board on that lane), never a
              button that answers on someone else's behalf. */}
          {reviews.length > 0 && (
            <div className="lc-asks__reviews">
              <h3 className="lc-asks__reviews-title">
                In review — {reviews.length} lane{reviews.length === 1 ? '' : 's'} awaiting acceptance
              </h3>
              {reviews.map((r) => (
                <button
                  key={r.lane.id}
                  type="button"
                  className="lc-asks__review"
                  onClick={() => onOpenLane?.(r.lane.id)}
                  title="Open this lane on the board"
                >
                  <span
                    className="lc-chip__avatar"
                    style={{
                      background: memberColor(
                        r.lane.owner_seat ?? '?',
                        kindOf(r.lane.owner_seat ?? '?', idx),
                      ),
                    }}
                    aria-hidden="true"
                  >
                    {initial(r.lane.owner_seat ?? '?')}
                  </span>
                  <span className="lc-asks__review-title">{r.lane.title}</span>
                  <span className="lc-asks__review-who">
                    {r.waitingOn ? (
                      <>
                        waiting on <b>{r.waitingOn}</b>
                      </>
                    ) : (
                      'unrouted'
                    )}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </section>
  );
}



function AskCard({
  ask,
  idx,
  canAnswer,
  audience,
  busy,
  onAnswer,
  style,
}: {
  ask: AskView;
  idx: Map<string, MemberSummary>;
  /** Already audience-gated by the caller: true only when this browser may answer THIS ask. */
  canAnswer: boolean;
  audience: 'you' | 'human' | 'agent' | 'team';
  busy: boolean;
  onAnswer: (kind: 'accept' | 'decline' | 'deciding') => void;
  style?: React.CSSProperties;
}) {
  const from = ask.env.from;
  const kind = kindOf(from, idx);
  const open = askIsLoud(ask.state);
  const ours = audience === 'you' || audience === 'team';
  return (
    <article className={`lc-ask lc-ask--${ask.state}`} style={style}>
      {/* Left column: who + what, stacked. The clock and the actions get their own columns so that
          down a list of twenty, every clock and every button lands on the same vertical line. */}
      <div className="lc-ask__main">
        <div className="lc-ask__head">
          <span className="lc-chip__avatar" style={{ background: memberColor(from, kind) }}>
            {initial(from)}
          </span>
          <span className="lc-ask__verb">
            <b>{from}</b> {audience === 'you' ? SPECIES_VERB_YOU[ask.species] : SPECIES_VERB[ask.species]}
            {!ours && ask.to && <span className="lc-asks__routed"> → {ask.to}</span>}
          </span>
          <span className={`lc-ask__tier lc-ask__tier--${ask.tier}`}>{ask.tier}</span>
        </div>
        {ask.env.body && (
          <button
            type="button"
            className="lc-ask__body"
            onClick={() => scrollToMessage(ask.env.id)}
            title="Jump to this ask in the stream"
          >
            {ask.env.body}
          </button>
        )}
      </div>
      <AskClock ask={ask} />
      {open && canAnswer && (
        <div className="lc-ask__actions">
          <button
            type="button"
            disabled={busy}
            className="lc-ask__btn lc-ask__btn--accept"
            onClick={() => onAnswer('accept')}
          >
            <CheckIcon />
            Approve
          </button>
          <button
            type="button"
            disabled={busy}
            className="lc-ask__btn lc-ask__btn--decline"
            onClick={() => onAnswer('decline')}
          >
            <CrossIcon />
            Deny
          </button>
          <button
            type="button"
            disabled={busy}
            className="lc-ask__btn lc-ask__btn--later"
            onClick={() => onAnswer('deciding')}
            title="Tell them you are deciding — the clock stops, they check back in an hour"
          >
            Deciding — 1h
          </button>
        </div>
      )}
      {ask.state === 'deferred' && (
        <div className="lc-ask__note">
          {ask.answeredBy} is deciding{ask.until ? ` — check back in ${ask.until}` : ''}
        </div>
      )}
    </article>
  );
}

/** The tier clock: time left until the agent invokes its no-answer policy, or what elapsing meant. */
function AskClock({ ask }: { ask: AskView }) {
  if (ask.state === 'held') return <Elapsed holding />;
  if (ask.state !== 'open') return null;
  const left = ask.deadline - Date.now();
  if (left <= 0) return <Elapsed holding={askTierHolds(ask.tier)} />;
  const m = Math.floor(left / 60_000);
  const s = Math.floor((left % 60_000) / 1000);
  return (
    <span className="lc-ask__clock">
      {m}:{String(s).padStart(2, '0')} left
    </span>
  );
}

/**
 * The clock, after it has run out. "agent holding" is the part that matters and the part that costs
 * width, so it is dropped on a phone rather than truncated — a clock reading "timed out" in danger
 * red on a blocking ask has already told you the agent stopped, and the row below spells it out.
 */
function Elapsed({ holding }: { holding: boolean }) {
  return (
    <span className="lc-ask__clock lc-ask__clock--over">
      timed out
      {holding && <span className="lc-ask__holding"> — agent holding</span>}
    </span>
  );
}

function CheckIcon() {
  return (
    <svg className="lc-ask__glyph" viewBox="0 0 12 12" aria-hidden="true">
      <path d="M2.6 6.3 4.9 8.6 9.4 3.7" />
    </svg>
  );
}

function CrossIcon() {
  return (
    <svg className="lc-ask__glyph" viewBox="0 0 12 12" aria-hidden="true">
      <path d="M3.4 3.4 8.6 8.6M8.6 3.4 3.4 8.6" />
    </svg>
  );
}

function BellIcon() {
  return (
    <svg className="lc-asks__bell" viewBox="0 0 12 12" aria-hidden="true">
      <path d="M6 1.8a2.9 2.9 0 0 1 2.9 2.9v1.9l1 1.6H2.1l1-1.6V4.7A2.9 2.9 0 0 1 6 1.8zM4.9 9.6a1.15 1.15 0 0 0 2.2 0" />
    </svg>
  );
}



function ChevronIcon() {
  return (
    <svg className="lc-asks__chev" viewBox="0 0 12 12" aria-hidden="true">
      <path d="M3.4 4.7 6 7.3l2.6-2.6" />
    </svg>
  );
}
