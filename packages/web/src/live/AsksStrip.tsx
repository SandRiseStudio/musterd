import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Envelope, MemberSummary } from '@musterd/protocol';
import { askTierHolds } from '@musterd/protocol';
import { askIsLoud, byUrgency, deriveAsks, type AskView } from './asks';
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
}: {
  envelopes: Envelope[];
  roster: MemberSummary[];
  cfg: LiveConfig;
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
  const loud = asks.filter((a) => askIsLoud(a.state)).sort((a, b) => byUrgency(a, b));
  const deferred = asks.filter((a) => a.state === 'deferred');
  const closed = asks.length - loud.length - deferred.length;
  const cards = [...loud, ...deferred];
  // The one the rail answers inline, and the one the sheet puts first: see `byUrgency`.
  const lead = loud[0] ?? deferred[0];

  // A 1s tick while any clock is running, so the countdowns are honest. Stops when nothing is loud —
  // idle cost is paid by every viewer, forever (packages/web/AGENTS.md).
  const [, setTick] = useState(0);
  useEffect(() => {
    if (loud.length === 0) return;
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, [loud.length]);

  // Waiting-on-you count in the tab title — loud even when the tab isn't front.
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const base = document.title.replace(/^\(\d+ asks?\) /, '');
    document.title =
      loud.length > 0 ? `(${loud.length} ask${loud.length > 1 ? 's' : ''}) ${base}` : base;
    return () => {
      document.title = base;
    };
  }, [loud.length]);

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

  // Answerable iff the connected seat is a real member (observers are hidden from the roster).
  const canAnswer = roster.some((m) => m.name === cfg.as);

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

  if (asks.length === 0) return null;

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
              <span className="lc-asks__verb">{SPECIES_VERB[lead.species]}</span>
              {lead.env.body && <span className="lc-asks__gist">{lead.env.body}</span>}
            </button>
            <span className={`lc-ask__tier lc-asks__tier lc-ask__tier--${lead.tier}`}>
              {lead.tier}
            </span>
            <AskClock ask={lead} />
            {askIsLoud(lead.state) && canAnswer && (
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
          </>
        ) : (
          <span className="lc-asks__lead lc-asks__lead--quiet">
            <b>asks &amp; approvals</b>
            <span className="lc-asks__verb">nothing waiting on a human</span>
          </span>
        )}

        <span className="lc-asks__spacer" />

        {deferred.length > 0 && <span className="lc-asks__meta">{deferred.length} deciding</span>}
        {closed > 0 && <span className="lc-asks__meta">{closed} settled</span>}

        {cards.length > 0 && (
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
      </div>

      {error && <div className="lc-asks__error">{error}</div>}

      {/* Closed, the sheet is inert: no tab stops into a layer the reader cannot see. */}
      {cards.length > 0 && (
        <div className="lc-asks__sheet" data-open={open || undefined} inert={!open}>
          <div className="lc-asks__cards">
            {cards.map((ask, i) => (
              <AskCard
                key={ask.env.id}
                ask={ask}
                idx={idx}
                canAnswer={canAnswer}
                busy={busy === ask.env.id}
                onAnswer={(kind) => void answer(ask, kind)}
                style={{ '--i': i } as React.CSSProperties}
              />
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

const SPECIES_VERB = {
  consult: 'asks what you think',
  escalate: 'escalated to you',
  approve: 'needs your approval',
} as const;


function AskCard({
  ask,
  idx,
  canAnswer,
  busy,
  onAnswer,
  style,
}: {
  ask: AskView;
  idx: Map<string, MemberSummary>;
  canAnswer: boolean;
  busy: boolean;
  onAnswer: (kind: 'accept' | 'decline' | 'deciding') => void;
  style?: React.CSSProperties;
}) {
  const from = ask.env.from;
  const kind = kindOf(from, idx);
  const open = askIsLoud(ask.state);
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
            <b>{from}</b> {SPECIES_VERB[ask.species]}
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
