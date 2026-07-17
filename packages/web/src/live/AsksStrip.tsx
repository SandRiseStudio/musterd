import { useEffect, useMemo, useState } from 'react';
import type { Envelope, MemberSummary } from '@musterd/protocol';
import { askTierHolds } from '@musterd/protocol';
import { askIsLoud, deriveAsks, type AskView } from './asks';
import { sendAct, type LiveConfig } from './client';
import { initial, memberColor, kindOf } from './format';
import { scrollToMessage } from './Stream';

/**
 * The asks & approvals strip (ADR 149) — the loud, above-the-fold home of the to-human ask stream
 * (ADR 147) on /live. Pure derivation over the timeline the page already holds; renders nothing until
 * an ask exists, one quiet line when none are open, and unmissable cards while any ask is open or held.
 *
 * Answerable exactly when the connected seat is a real roster member (the "Advanced — connect as a
 * specific seat" sign-in): **accept**, **decline**, and the ADR 147 §5 "deciding — check back in ⟨1h⟩"
 * deferral, each an ordinary envelope through `POST /messages`. The auto-provisioned observer is
 * read-only by construction (ADR 063, hidden from the roster), so a watch-link viewer sees the strip
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

  const asks = useMemo(
    () => deriveAsks([...envelopes, ...localAnswers]),
    [envelopes, localAnswers],
  );
  const loud = asks.filter((a) => askIsLoud(a.state));
  const deferred = asks.filter((a) => a.state === 'deferred');
  const closed = asks.length - loud.length - deferred.length;

  // A 1s tick while any clock is running, so the countdowns are honest.
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
    document.title = loud.length > 0 ? `(${loud.length} ask${loud.length > 1 ? 's' : ''}) ${base}` : base;
    return () => {
      document.title = base;
    };
  }, [loud.length]);

  if (asks.length === 0) return null;

  // Answerable iff the connected seat is a real member (observers are hidden from the roster).
  const canAnswer = roster.some((m) => m.name === cfg.as);

  const answer = async (ask: AskView, kind: 'accept' | 'decline' | 'deciding') => {
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
  };

  const cards = [...loud, ...deferred];
  return (
    <section className={`lc-asks${loud.length > 0 ? ' lc-asks--loud' : ''}`} aria-label="asks and approvals">
      <div className="lc-asks__head">
        <BellIcon />
        <span className="lc-asks__title">asks &amp; approvals</span>
        {loud.length > 0 ? (
          <span className="lc-asks__count">{loud.length} waiting on a human</span>
        ) : (
          <span className="lc-asks__quiet">none open</span>
        )}
        {deferred.length > 0 && <span className="lc-asks__meta">{deferred.length} deciding</span>}
        {closed > 0 && <span className="lc-asks__meta">{closed} settled</span>}
        <span className="lc-asks__spacer" />
        <a className="lc-asks__link" href="/approvals" title="Seat-claim approvals (admin)">
          seat approvals →
        </a>
      </div>
      {error && <div className="lc-asks__error">{error}</div>}
      {cards.length > 0 && (
        <div className="lc-asks__cards">
          {cards.map((ask) => (
            <AskCard
              key={ask.env.id}
              ask={ask}
              roster={roster}
              canAnswer={canAnswer}
              busy={busy === ask.env.id}
              onAnswer={(kind) => void answer(ask, kind)}
            />
          ))}
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
  roster,
  canAnswer,
  busy,
  onAnswer,
}: {
  ask: AskView;
  roster: MemberSummary[];
  canAnswer: boolean;
  busy: boolean;
  onAnswer: (kind: 'accept' | 'decline' | 'deciding') => void;
}) {
  const idx = new Map(roster.map((m) => [m.name, m]));
  const from = ask.env.from;
  const kind = kindOf(from, idx);
  const open = askIsLoud(ask.state);
  return (
    <article className={`lc-ask lc-ask--${ask.state}`}>
      <div className="lc-ask__head">
        <span className="lc-chip__avatar" style={{ background: memberColor(from, kind) }}>
          {initial(from)}
        </span>
        <span className="lc-ask__verb">
          <b>{from}</b> {SPECIES_VERB[ask.species]}
        </span>
        <span className={`lc-ask__tier lc-ask__tier--${ask.tier}`}>{ask.tier}</span>
        <AskClock ask={ask} />
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
      {open && canAnswer && (
        <div className="lc-ask__actions">
          <button type="button" disabled={busy} className="lc-ask__btn lc-ask__btn--accept" onClick={() => onAnswer('accept')}>
            accept
          </button>
          <button type="button" disabled={busy} className="lc-ask__btn lc-ask__btn--decline" onClick={() => onAnswer('decline')}>
            decline
          </button>
          <button type="button" disabled={busy} className="lc-ask__btn" onClick={() => onAnswer('deciding')}>
            deciding — check back in 1h
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
  if (ask.state === 'held') return <span className="lc-ask__clock lc-ask__clock--over">timed out — agent holding</span>;
  if (ask.state !== 'open') return null;
  const left = ask.deadline - Date.now();
  if (left <= 0) {
    return (
      <span className="lc-ask__clock lc-ask__clock--over">
        {askTierHolds(ask.tier) ? 'timed out — agent holding' : 'timed out'}
      </span>
    );
  }
  const m = Math.floor(left / 60_000);
  const s = Math.floor((left % 60_000) / 1000);
  return (
    <span className="lc-ask__clock">
      {m}:{String(s).padStart(2, '0')} left
    </span>
  );
}

function BellIcon() {
  return (
    <svg className="lc-asks__bell" viewBox="0 0 12 12" aria-hidden="true">
      <path d="M6 1.8a2.9 2.9 0 0 1 2.9 2.9v1.9l1 1.6H2.1l1-1.6V4.7A2.9 2.9 0 0 1 6 1.8zM4.9 9.6a1.15 1.15 0 0 0 2.2 0" />
    </svg>
  );
}
