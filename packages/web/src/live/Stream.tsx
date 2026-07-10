import type { Envelope, MemberSummary } from '@musterd/protocol';
import { Fragment, type ReactElement, useEffect, useRef, useState } from 'react';
import {
  actLabel,
  actTone,
  clock,
  dayKey,
  dayLabel,
  goalEvent,
  initial,
  kindOf,
  laneEvent,
  laneEventDetail,
  type LaneEventDetail,
  memberColor,
  recipientName,
  recipientScope,
  richLength,
  richTokens,
  rosterIndex,
  type RichToken,
} from './format';
import { CollapseButton, PanelRail } from './PanelChrome';

/**
 * The legible half of the split-canvas: the team's act stream. Rows arrive newest-last; the last row
 * is the warm "now" live edge. Threaded replies (anything carrying `thread`) indent under a spine.
 * Live-arrived messages type out; the view sticks to the bottom while you're already there.
 */
export function Stream({
  envelopes,
  roster,
  liveIds,
  collapsed = false,
  onCollapse,
}: {
  envelopes: Envelope[];
  roster: MemberSummary[];
  liveIds: Set<string>;
  collapsed?: boolean;
  onCollapse?: () => void;
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
    <section
      className={`lc-stream${collapsed ? ' is-collapsed' : ''}`}
      ref={scrollRef}
      onScroll={onScroll}
    >
      {collapsed && onCollapse && (
        <PanelRail
          side="right"
          label="Stream"
          hint={envelopes.length ? String(envelopes.length) : undefined}
          onExpand={onCollapse}
        />
      )}
      <header className="lc-stream__head">
        <span className="lc-stream__title">TEAM STREAM</span>
        <span className="lc-stream__live">· live</span>
        <span className="lc-stream__spacer" />
        {onCollapse && <CollapseButton side="right" label="the stream" onClick={onCollapse} />}
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

/** Scroll a message into view (and flash it) — used by reply quotes here and by the office's
 * speech-bubble click-through (an act bubble over a character's head navigates to its stream row). */
export function scrollToMessage(id: string) {
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
  // A lane open/resolve/handoff rides as `act: 'message'` + structured meta (ADR 083 §4) — recover the
  // sub-type so the badge/glyph read as "lane open" etc. instead of a generic "message".
  const lane = laneEvent(env);
  // A lane transition or Goal declaration rides as `message` + structured meta — recover the intended
  // sub-type + its human parts so the row renders a rich work item instead of the composed body dump.
  const goal = lane ? null : goalEvent(env);
  const structured = lane ? laneEventDetail(env) : goal;
  const effAct = lane ?? (goal ? 'goal' : env.act);
  const tone = actTone(effAct);
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
          <ActIcon act={effAct} />
          {actLabel(effAct)}
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
          <span className="lc-quote__text">{summaryLine(parent)}</span>
        </button>
      )}
      {structured ? (
        <WorkItem detail={structured} />
      ) : (
        env.body &&
        (doType ? (
          <RichTypewriter tokens={richTokens(env.body)} className="lc-row__body" />
        ) : (
          <p className="lc-row__body">
            <RichText tokens={richTokens(env.body)} />
          </p>
        ))
      )}
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
  lane_open: <path d="M2 2.6h5.2v6.8H2zM8.5 4 10.5 6l-2 2" />,
  lane_claim: <path d="M2 2.6h5.2v6.8H2zM10 3v4M8 5l2 2 2-2" />,
  lane_state: <path d="M2 2.6h5.2v6.8H2zM9 2.4v7M9 2.6h2.4l-.9 1.3.9 1.3H9" />,
  lane_resolve: <path d="M2 2.6h5.2v6.8H2zm1.1 4 1.6 1.6L7.3 5" />,
  lane_handoff: <path d="M2 6h5M5.5 3.5 8 6l-2.5 2.5M8.6 2.5h1.4v7H8.6" />,
  // A declared Goal (ADR 084) — a flag planted on the plan: the umbrella its lanes advance toward.
  goal: <path d="M3 10.5V2M3 2.4h6l-1.3 2 1.3 2H3" />,
  // Steering trio (ADR 103): steer = a redirecting arrow (change of course); challenge = a raised
  // pennant (an objection to justify); defer = a skip-forward chevron (push later on the plan).
  steer: <path d="M2.7 9.6V6.2C2.7 4.7 3.9 4 5.2 4h3.8M6.9 2.1 9.2 4.2 6.9 6.3" />,
  challenge: <path d="M3.4 2v8M3.4 2.6h5.2L7.3 4.4l1.3 1.8H3.4" />,
  defer: <path d="M2.7 3.2 5.5 6l-2.8 2.8M6.1 3.2 8.9 6l-2.8 2.8" />,
};

/**
 * A lane transition / Goal declaration rendered as a **work item** — the title standing on its own
 * (quoted, in the row's tone) with small pills for whichever of state / branch / project applies. The
 * badge overhead already says what happened (`lane claim`, `lane done`, `goal`); this carries only the
 * *subject*, so nothing the badge said is repeated and the raw lane id never appears.
 */
function WorkItem({ detail }: { detail: LaneEventDetail }) {
  const pills: Array<{ key: string; text: string; mono?: boolean }> = [];
  if (detail.state) pills.push({ key: 'state', text: detail.state });
  if (detail.project) pills.push({ key: 'project', text: detail.project });
  if (detail.branch) pills.push({ key: 'branch', text: detail.branch, mono: true });
  return (
    <div className="lc-work">
      {detail.title && <span className="lc-work__title">{detail.title}</span>}
      {pills.map((p) => (
        <span key={p.key} className={`lc-work__pill${p.mono ? ' lc-work__pill--mono' : ''}`}>
          {p.text}
        </span>
      ))}
    </div>
  );
}

/** A clean one-line summary for a reply quote — the structured title if any, else the body with its
 * composed `[lane]`/`[goal]` tag stripped. Never the raw dump. */
function summaryLine(env: Envelope): string {
  const detail = laneEventDetail(env) ?? goalEvent(env);
  if (detail?.title) return detail.title;
  return env.body.replace(/^\[(?:lane|goal)\]\s+/, '') || `(${env.act})`;
}

/** Render a tokenized body richly. With `reveal` set (the typewriter), only that many visible
 * characters are shown, trailing a caret — tokens past the cut are dropped, the one straddling it is
 * sliced. Without it, the whole stream renders. */
function RichText({ tokens, reveal }: { tokens: RichToken[]; reveal?: number }) {
  const limited = reveal != null;
  let left = reveal ?? Infinity;
  const out: ReactElement[] = [];
  for (let i = 0; i < tokens.length && left > 0; i++) {
    const t = tokens[i]!;
    const text = limited && t.text.length > left ? t.text.slice(0, left) : t.text;
    left -= t.text.length;
    out.push(<RichSpan key={i} token={t} text={text} />);
  }
  const typing = limited && (reveal ?? 0) < richLength(tokens);
  return (
    <>
      {out}
      {typing && <span className="lc-caret" aria-hidden="true" />}
    </>
  );
}

function RichSpan({ token, text }: { token: RichToken; text: string }) {
  switch (token.kind) {
    case 'strong':
      return <strong className="lc-rt-b">{text}</strong>;
    case 'code':
      return <code className="lc-rt-code">{text}</code>;
    case 'ref':
      return <span className="lc-rt-ref">{text}</span>;
    case 'id':
      return (
        <code className="lc-rt-id" title={token.title}>
          {text}
        </code>
      );
    default:
      return <>{text}</>;
  }
}

/**
 * Reveal a rich body one character at a time — the same gentle, length-adaptive typewriter as before
 * (clamped 22–60ms/char), now driving a token stream so `**emphasis**`, code, refs and ids keep their
 * formatting as they type in. Honors prefers-reduced-motion (shows the full body at once).
 */
function RichTypewriter({ tokens, className }: { tokens: RichToken[]; className?: string }) {
  const total = richLength(tokens);
  const [n, setN] = useState(0);
  useEffect(() => {
    if (
      typeof window !== 'undefined' &&
      window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    ) {
      setN(total);
      return;
    }
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
  }, [total]);

  return (
    <p className={className}>
      <RichText tokens={tokens} reveal={n} />
    </p>
  );
}
