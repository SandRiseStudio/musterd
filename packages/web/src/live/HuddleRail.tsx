import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import type { Envelope, HuddleView, MemberSummary } from '@musterd/protocol';
import { deriveHuddles } from '@musterd/protocol/wire';
import { huddleBudget, openHuddles, type HuddleBudgetView } from './huddles';
import { initial, kindOf, hueOf, memberAvatar } from './format';

/**
 * The huddle rail (ADR 378 increment 2) — several seats on one topic, shown as one row each.
 *
 * Pure derivation over the timeline the office already holds: a huddle is a thread, so there is
 * nothing to fetch and no room state to hold. Renders nothing until a huddle is open, and renders
 * **nothing but a link** for the room itself — the page never opens a socket to the whiteboard
 * (ADR 378, "the room is a view, not a venue").
 *
 * **It never enforces.** The budget is displayed and counted; going over changes the words and
 * nothing else. Nothing here closes a huddle, hides one, or greys it out — an over-budget huddle
 * stays on the rail saying it is over, which is the honest surface of a team that said six turns
 * and took nine. A page that quietly dropped it would be enforcing a rule the daemon refuses to.
 */
export function HuddleRail({
  envelopes,
  roster,
  now: nowProp,
  roomLink = true,
}: {
  envelopes: Envelope[];
  roster: MemberSummary[];
  /** Fixed clock (tests, and any caller that owns the tick). Absent → the rail keeps its own. */
  now?: number;
  /** `/live` links out to the whiteboard room; a stream drops the link nobody can click. */
  roomLink?: boolean;
}) {
  const [ticked, setTicked] = useState(() => Date.now());
  const now = nowProp ?? ticked;

  // The fold is pure over the timeline and re-runs only when the timeline changes. `me` decides
  // nothing here — the rail shows the team's rooms, not this viewer's.
  const open = useMemo(() => openHuddles(deriveHuddles(envelopes, '')), [envelopes]);

  // Idle cost is paid by every viewer forever (packages/web/AGENTS.md), and /broadcast runs for
  // hours — so the clock runs ONLY when something on screen actually moves with it: a declared
  // `until` counting down. Turn counts change with the timeline, not with time.
  const counting = nowProp === undefined && open.some((h) => h.budget?.until !== undefined);
  useEffect(() => {
    if (!counting) return;
    const id = setInterval(() => setTicked(Date.now()), 30_000);
    return () => clearInterval(id);
  }, [counting]);

  if (open.length === 0) return null;
  const idx = new Map(roster.map((m) => [m.name, m]));

  return (
    <section className="lc-huddles" aria-label="huddles">
      {open.map((h) => (
        <Huddle key={h.id} h={h} idx={idx} now={now} roomLink={roomLink} />
      ))}
    </section>
  );
}

function Huddle({
  h,
  idx,
  now,
  roomLink,
}: {
  h: HuddleView;
  idx: Map<string, MemberSummary>;
  now: number;
  roomLink: boolean;
}) {
  const budget = huddleBudget(h, now);
  // Named at the root and still silent — an invitation outstanding, which is a different fact from
  // an empty room and worth its own words.
  const silent = h.named.filter((n) => !h.spoke.includes(n));
  return (
    <article className={`lc-huddle${budget.phase === 'spent' ? ' is-spent' : ''}`}>
      {/* Two lines, not one. The one-line version (measured on the fixture room, 2026-09-04) had to
          truncate the opening line to "t…" and the anchor to "d." at the rail's real width — six
          competing items on a row that is only as wide as the office. What the huddle IS goes on
          top; who is in it and where its output lands go underneath. */}
      <div className="lc-huddle__head">
        <span className="lc-huddle__topic">{h.topic}</span>
        <span className="lc-huddle__line">{h.body}</span>
        <span className="lc-huddle__count">{turnCount(budget)}</span>
        {roomLink && h.room && (
          <a className="lc-huddle__room" href={h.room} target="_blank" rel="noreferrer">
            room
          </a>
        )}
      </div>
      <div className="lc-huddle__meta">
        <span className="lc-huddle__seats">
          {h.spoke.map((name) => (
            <i
              key={name}
              className="lc-huddle__seat"
              title={name}
              style={
                {
                  '--lc-huddle-hue': memberAvatar(name, kindOf(name, idx), hueOf(name, idx)),
                } as CSSProperties
              }
            >
              {initial(name)}
            </i>
          ))}
          <span className="lc-huddle__who">{h.spoke.join(', ')}</span>
        </span>
        {silent.length > 0 && (
          <span className="lc-huddle__silent">{silent.join(', ')} yet to speak</span>
        )}
        <span className="lc-huddle__anchor" title="where this huddle's output lands">
          {h.anchor}
        </span>
      </div>
    </article>
  );
}

/** The turn count as words. Over is said, not hidden — and never rounded back to the declaration. */
function turnCount(b: HuddleBudgetView): string {
  const turns = b.turnsDeclared === undefined ? `${b.turnsUsed} turns` : `${b.turnsUsed} of ${b.turnsDeclared} turns`;
  if (b.overTurns) return `${turns} — over`;
  if (b.overTime) return `${turns} — over the declared end`;
  return turns;
}
