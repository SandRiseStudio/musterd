import type { Envelope, MemberSummary } from '@musterd/protocol';
import { Fragment, type ReactElement, useEffect, useRef, useState } from 'react';
import {
  actLabel,
  actTone,
  clock,
  dayKey,
  dayLabel,
  initial,
  kindOf,
  memberColor,
  recipientName,
  recipientScope,
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
  // Index by id so a reply (meta.in_reply_to) can render a quote of the exact message it answers.
  const byId = new Map(envelopes.map((e) => [e.id, e]));

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
              <Row env={e} idx={idx} byId={byId} now={isNow} animate={liveIds.has(e.id)} />
            </Fragment>
          );
        })}
      </div>
    </section>
  );
}

/** Scroll the original message into view (and flash it) when a reply's quote is clicked. */
function scrollToMessage(id: string) {
  if (typeof document === 'undefined') return;
  const el = document.getElementById(`lc-msg-${id}`);
  if (!el) return;
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  el.classList.remove('lc-row--flash');
  // reflow so the animation can re-trigger on a repeat click
  void el.offsetWidth;
  el.classList.add('lc-row--flash');
}

function Row({
  env,
  idx,
  byId,
  now,
  animate,
}: {
  env: Envelope;
  idx: Map<string, MemberSummary>;
  byId: Map<string, Envelope>;
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
  const scope = recipientScope(env.to);
  const toName = recipientName(env.to);
  const threaded = env.thread != null;
  // The exact message this one replies to (ADR 025 reply_to / --reply-to → meta.in_reply_to).
  const replyToId = typeof env.meta?.['in_reply_to'] === 'string' ? env.meta['in_reply_to'] : null;
  const parent = replyToId ? byId.get(replyToId) : undefined;

  const body = (
    <div
      id={`lc-msg-${env.id}`}
      className={`lc-row lc-row--enter lc-row--${scope}${now ? ' lc-row--now' : ''}${settle ? ' lc-row--settle' : ''}`}
      data-tone={tone}
    >
      <div className="lc-row__head">
        <time className="lc-row__ts">{clock(env.ts)}</time>
        <span className={`lc-chip lc-chip--${kind}`}>
          <span className="lc-chip__avatar" style={{ background: memberColor(env.from, kind) }}>
            {initial(env.from)}
          </span>
          <span className="lc-chip__name">{env.from}</span>
        </span>
        <span className={`lc-badge lc-badge--${tone}`}>
          <ActIcon act={env.act} />
          {actLabel(env.act)}
        </span>
        <Recipient scope={scope} name={toName} idx={idx} />
      </div>
      {parent && (
        <button
          type="button"
          className="lc-quote"
          onClick={() => scrollToMessage(parent.id)}
          title="Jump to the message this replies to"
        >
          <span
            className="lc-quote__bar"
            style={{ background: memberColor(parent.from, kindOf(parent.from, idx)) }}
          />
          <span className="lc-quote__who">{parent.from}</span>
          <span className="lc-quote__text">{parent.body || `(${parent.act})`}</span>
        </button>
      )}
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
 * The audience pill — the at-a-glance answer to "who was this for". A **direct** (1:1) message shows
 * the recipient's own avatar dot + name (like an iMessage to-field); **team** and **broadcast** get a
 * group / megaphone glyph. Pairs with the `lc-row--direct` row accent so 1:1s stand apart from team
 * traffic without reading the text.
 */
function Recipient({
  scope,
  name,
  idx,
}: {
  scope: ReturnType<typeof recipientScope>;
  name: string | null;
  idx: Map<string, MemberSummary>;
}) {
  if (scope === 'direct' && name) {
    return (
      <span className="lc-to lc-to--direct">
        <ToArrow />
        <span
          className="lc-to__dot"
          style={{ background: memberColor(name, kindOf(name, idx)) }}
        />
        <span className="lc-to__name">{name}</span>
      </span>
    );
  }
  if (scope === 'team') {
    return (
      <span className="lc-to lc-to--team">
        <GroupIcon />
        team
      </span>
    );
  }
  return (
    <span className="lc-to lc-to--all">
      <BroadcastIcon />
      all
    </span>
  );
}

/* ── inline glyphs (12px, stroke = currentColor) ─────────────────────────────────────────────── */

function ToArrow() {
  return (
    <svg className="lc-i" viewBox="0 0 12 12" aria-hidden="true">
      <path d="M2 6h7M6.5 3 9.5 6l-3 3" />
    </svg>
  );
}
function GroupIcon() {
  return (
    <svg className="lc-i" viewBox="0 0 12 12" aria-hidden="true">
      <circle cx="4.3" cy="4" r="1.7" />
      <circle cx="8.4" cy="4.6" r="1.3" />
      <path d="M1.5 10c0-1.8 1.3-3 2.8-3s2.8 1.2 2.8 3M8 7.2c1.2.1 2.5.9 2.5 2.8" />
    </svg>
  );
}
function BroadcastIcon() {
  return (
    <svg className="lc-i" viewBox="0 0 12 12" aria-hidden="true">
      <path d="M3 7 8.5 4v6L3 7H2.2A.7.7 0 0 1 1.5 6.3v-.6A.7.7 0 0 1 2.2 5H3zM10 4.5a3 3 0 0 1 0 3" />
    </svg>
  );
}

/** One glyph per act, so message / status / handoff / etc. each read at a glance, not by colour alone. */
function ActIcon({ act }: { act: string }) {
  return (
    <svg className="lc-i" viewBox="0 0 12 12" aria-hidden="true">
      {ACT_GLYPH[act] ?? ACT_GLYPH['message']}
    </svg>
  );
}

const ACT_GLYPH: Record<string, ReactElement> = {
  message: <path d="M1.8 3.2h8.4v5H5l-2.4 2V8.2H1.8z" />,
  status_update: <path d="M1.5 6h2l1.3-3 1.8 6 1.3-3h2.6" />,
  request_help: <path d="M4.4 4.4a1.6 1.6 0 1 1 2.3 1.5c-.6.3-.9.6-.9 1.3M6 9.2v.01" />,
  handoff: <path d="M2 6h5M5.5 3.5 8 6l-2.5 2.5M8.6 2.5h1.4v7H8.6" />,
  accept: <path d="M2.5 6.4 5 8.8l4.5-5" />,
  decline: <path d="m3.2 3.2 5.6 5.6M8.8 3.2 3.2 8.8" />,
  wait: <path d="M4.3 3v6M7.7 3v6" />,
  resolve: <path d="m1.6 6.3 2 2 3.4-4M6 8.3l3.4-4" />,
  end: <rect x="3.3" y="3.3" width="5.4" height="5.4" rx="1" />,
};

/**
 * Reveal `text` one character at a time — a gentle, gradual typewriter. The per-character interval is
 * length-adaptive (clamped 22–60ms) so short lines aren't instant and long ones don't crawl, but it's
 * always 1 char per step so the reveal stays smooth. Honors prefers-reduced-motion (shows full text).
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
    // aim for ~total*45ms reading time, clamped to a comfortable per-char pace
    const tickMs = Math.min(60, Math.max(22, Math.round(2000 / Math.max(total, 1))));
    let i = 0;
    setN(0);
    const h = setInterval(() => {
      i += 1;
      setN(i);
      if (i >= total) clearInterval(h);
    }, tickMs);
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
