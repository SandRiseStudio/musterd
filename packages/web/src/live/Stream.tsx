import type { Envelope, MemberSummary } from '@musterd/protocol';
import { Fragment, useEffect, useRef, useState } from 'react';
import {
  actTone,
  clock,
  dayKey,
  dayLabel,
  initial,
  kindOf,
  recipientLabel,
  rosterIndex,
} from './format';

/**
 * The legible half of the split-canvas: the team's act stream. Rows arrive newest-last; the last row
 * is the warm "now" live edge. Threaded replies (anything carrying `thread`) indent under a spine.
 * Live-arrived messages type out; the view sticks to the bottom while you're already there.
 */
export function Stream({
  envelopes,
  roster,
  liveIds,
}: {
  envelopes: Envelope[];
  roster: MemberSummary[];
  liveIds: Set<string>;
}) {
  const idx = rosterIndex(roster);
  const lastId = envelopes.length ? envelopes[envelopes.length - 1]!.id : null;

  const scrollRef = useRef<HTMLElement>(null);
  const rowsRef = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);

  // Follow the bottom as content grows (new rows AND text typing out) — but only while the reader is
  // already near the bottom, so scrolling up to read history is never yanked back down.
  useEffect(() => {
    const el = scrollRef.current;
    const rows = rowsRef.current;
    if (!el || !rows || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => {
      if (atBottom.current) el.scrollTop = el.scrollHeight;
    });
    ro.observe(rows);
    return () => ro.disconnect();
  }, []);

  const onScroll = () => {
    const el = scrollRef.current;
    if (el) atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  return (
    <section className="lc-stream" ref={scrollRef} onScroll={onScroll}>
      <header className="lc-stream__head">
        <span className="lc-stream__title">TEAM STREAM</span>
        <span className="lc-stream__live">· live</span>
      </header>
      <div className="lc-stream__rows" ref={rowsRef}>
        {envelopes.length === 0 && (
          <p className="lc-empty">
            <strong>Listening.</strong>
            Every message on the team will stream here the moment it&apos;s sent — requests, handoffs,
            status, and resolutions, live.
          </p>
        )}
        {envelopes.map((e, i) => {
          const isNow = e.id === lastId;
          const prev = i > 0 ? envelopes[i - 1]! : null;
          const newDay = !prev || dayKey(e.ts) !== dayKey(prev.ts);
          return (
            <Fragment key={e.id}>
              {newDay && (
                <div className="lc-day">
                  <span className="lc-day__label">{dayLabel(e.ts)}</span>
                  <span className="lc-day__line" />
                </div>
              )}
              {isNow && envelopes.length > 1 && !newDay && (
                <div className="lc-now">
                  <span className="lc-now__dot" />
                  <span className="lc-now__label">now</span>
                  <span className="lc-now__line" />
                </div>
              )}
              <Row env={e} idx={idx} now={isNow} animate={liveIds.has(e.id)} />
            </Fragment>
          );
        })}
      </div>
    </section>
  );
}

function Row({
  env,
  idx,
  now,
  animate,
}: {
  env: Envelope;
  idx: Map<string, MemberSummary>;
  now: boolean;
  animate: boolean;
}) {
  // Freeze the typewriter decision at mount: a backfilled row never types, a live row types once even
  // if props later change.
  const [doType] = useState(animate);
  // A resolve that arrives live "settles": a one-time green brighten → calm, synchronized with the
  // constellation's resolve pulse + ripple. Frozen at mount so it fires once.
  const [settle] = useState(animate && env.act === 'resolve');
  const tone = actTone(env.act);
  const kind = kindOf(env.from, idx);
  const recipient = recipientLabel(env.to);
  const threaded = env.thread != null;
  const body = (
    <div
      className={`lc-row lc-row--enter${now ? ' lc-row--now' : ''}${settle ? ' lc-row--settle' : ''}`}
      data-tone={tone}
    >
      <div className="lc-row__head">
        <time className="lc-row__ts">{clock(env.ts)}</time>
        <span className={`lc-chip lc-chip--${kind}`}>
          <span className="lc-chip__avatar">{initial(env.from)}</span>
          <span className="lc-chip__name">{env.from}</span>
        </span>
        <span className={`lc-badge lc-badge--${tone}`}>{env.act}</span>
        {recipient && <span className="lc-row__to">{recipient}</span>}
      </div>
      {env.body &&
        (doType ? (
          <Typewriter text={env.body} className="lc-row__body" />
        ) : (
          <p className="lc-row__body">{env.body}</p>
        ))}
    </div>
  );
  if (!threaded) return body;
  return (
    <div className="lc-thread">
      <span className={`lc-thread__spine lc-thread__spine--${tone}`} />
      {body}
    </div>
  );
}

/**
 * Reveal `text` character-by-character, smooth but length-adaptive (capped ~1.1s) so long messages
 * don't drag. Honors prefers-reduced-motion by showing the full text at once.
 */
function Typewriter({ text, className }: { text: string; className?: string }) {
  const [n, setN] = useState(0);
  useEffect(() => {
    if (
      typeof window !== 'undefined' &&
      window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    ) {
      setN(text.length);
      return;
    }
    const total = text.length;
    const tick = 24; // ms per step — slower step = more gradual reveal
    const durationMs = Math.min(1700, Math.max(360, total * 32));
    const perTick = Math.max(1, Math.ceil(total / (durationMs / tick)));
    let i = 0;
    setN(0);
    const h = setInterval(() => {
      i = Math.min(total, i + perTick);
      setN(i);
      if (i >= total) clearInterval(h);
    }, tick);
    return () => clearInterval(h);
  }, [text]);

  const typing = n < text.length;
  return (
    <p className={className}>
      {text.slice(0, n)}
      {typing && <span className="lc-caret" aria-hidden="true" />}
    </p>
  );
}
