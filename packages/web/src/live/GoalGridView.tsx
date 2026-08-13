import type { Goal, Lane, LaneWarning, MemberSummary } from '@musterd/protocol';
import { useMemo } from 'react';
import { buildGoalGrid, type GoalCardModel, type RunwayDot, type ShippedGoal } from './goalGrid';
import { initial, kindOf, memberAvatar } from './format';
import './GoalGrid.css';

/**
 * The goals-grid front door (goals-front-door design): mission cards, one per unshipped Goal, each
 * with a runway of its lanes rolling backlog → working → review → shipped. Pure render of
 * {@link buildGoalGrid}'s model — no logic of its own, so the layout stays testable under the
 * node-only vitest. Read-only by nature: a card is a drill-in button, never a write affordance.
 */

const CHIP_CLASS: Record<GoalCardModel['chip'], string> = {
  queued: 'gg-chip--soon',
  'just started': 'gg-chip--soon',
  'in flight': 'gg-chip--live',
  shipped: 'gg-chip--live',
  lanes: 'gg-chip--ghost',
};

/** Compact relative age (`3m`, `2h`, `4d`) from a ms-epoch ts. */
function ago(now: number, ts: number): string {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

export function GoalGrid({
  lanes,
  goals,
  warnings,
  roster,
  onOpenGoal,
}: {
  lanes: Lane[];
  goals: Goal[];
  /** The board's live warnings — the grid reads `stale_acceptance` to show review debt. */
  warnings: LaneWarning[];
  roster: MemberSummary[];
  onOpenGoal: (goalId: string | null) => void;
}) {
  const now = Date.now();
  const model = useMemo(
    () => buildGoalGrid(lanes, goals, now, warnings),
    [lanes, goals, now, warnings],
  );
  const rosterIdx = useMemo(() => new Map(roster.map((m) => [m.name, m])), [roster]);

  const team = lanes[0]?.team ?? goals[0]?.id ?? '';
  const inFlight = model.cards.filter((c) => c.id !== null).length;
  const seatsAtWork = new Set(
    lanes
      .filter((l) => l.state === 'claimed' || l.state === 'active')
      .map((l) => l.owner_seat)
      .filter((s): s is string => s !== null),
  ).size;

  return (
    <div className="gg-stage">
      <header className="gg-hdr">
        <div>
          <h2 className="gg-title">
            What&apos;s being <em>worked on</em>
          </h2>
          <p className="gg-sub">
            {team ? `${team} team · ` : ''}
            {inFlight} goal{inFlight === 1 ? '' : 's'} in flight · {seatsAtWork} seat
            {seatsAtWork === 1 ? '' : 's'} at work · updated live
          </p>
        </div>
        {model.pulse && (
          <p className="gg-pulse">
            <span className="gg-pulse__dot" aria-hidden="true" />
            <span>
              shipped <b>{model.pulse.title}</b> · {ago(now, model.pulse.at)} ago
            </span>
          </p>
        )}
      </header>

      <div className="gg-grid">
        {model.cards.map((card) => (
          <GoalCard
            key={card.id ?? '∅'}
            card={card}
            now={now}
            rosterIdx={rosterIdx}
            onOpen={() => onOpenGoal(card.id)}
          />
        ))}
      </div>

      {model.shippedShelf.length > 0 && (
        <footer className="gg-shelf" aria-label="Shipped goals">
          <p className="gg-shelf__head">
            <span className="gg-shelf__flag" aria-hidden="true">
              🏁
            </span>
            <span className="gg-shelf__label">shipped — and what changed</span>
          </p>
          <ul className="gg-shelf__list">
            {model.shippedShelf.map((g) => (
              <li key={g.id}>
                <ShelfSlip goal={g} onOpen={() => onOpenGoal(g.id)} />
              </li>
            ))}
          </ul>
        </footer>
      )}
    </div>
  );
}

/**
 * A shipped goal on the shelf (value-layer design). With an outcome note it reads settled — the
 * evidence in the team's own words. Without one it reads *unfinished* rather than clean: shipping
 * without saying what changed is the ADR 256 failure one step later in the lifecycle, so the slip
 * keeps a torn edge and asks the question until someone answers it.
 */
function ShelfSlip({ goal, onOpen }: { goal: ShippedGoal; onOpen: () => void }) {
  const { outcome } = goal;
  return (
    <button
      className={`gg-slip${outcome ? '' : ' gg-slip--owed'}`}
      onClick={onOpen}
      aria-label={
        outcome
          ? `${goal.title} — shipped. ${outcome.text} (noted by ${outcome.by}). Open its lanes`
          : `${goal.title} — shipped, but no outcome note yet. Open its lanes`
      }
    >
      <span className="gg-slip__title">{goal.title}</span>
      {outcome ? (
        <span className="gg-slip__outcome">
          {outcome.text}
          <span className="gg-slip__by"> — {outcome.by}</span>
        </span>
      ) : (
        <span className="gg-slip__owed">…what changed?</span>
      )}
    </button>
  );
}

function GoalCard({
  card,
  now,
  rosterIdx,
  onOpen,
}: {
  card: GoalCardModel;
  now: number;
  rosterIdx: Map<string, MemberSummary>;
  onOpen: () => void;
}) {
  const counts: string[] = [`${card.counts.total} lane${card.counts.total === 1 ? '' : 's'}`];
  if (card.counts.done > 0) counts.push(`${card.counts.done} shipped`);
  if (card.counts.review > 0) counts.push(`${card.counts.review} in review`);
  const debt =
    card.counts.stale > 0
      ? `${card.counts.stale} need${card.counts.stale === 1 ? 's' : ''} eyes`
      : null;
  return (
    <button
      className={`gg-card${card.id === null ? ' gg-card--loose' : ''}`}
      onClick={onOpen}
      aria-label={`${card.title} — ${card.counts.total} ${card.counts.total === 1 ? 'lane' : 'lanes'}${
        card.staleNote ? `; review debt: ${card.staleNote}` : ''
      }; open its lanes`}
    >
      <span className="gg-peek" aria-hidden="true">
        peek inside →
      </span>
      <span className="gg-trow">
        <span className="gg-card__title">{card.title}</span>
        <span className={`gg-chip ${CHIP_CLASS[card.chip]}`}>
          {card.chip === 'lanes'
            ? `${card.counts.total} lane${card.counts.total === 1 ? '' : 's'}`
            : card.declared
              ? card.chip
              : 'declare me'}
        </span>
      </span>
      {card.story && <span className="gg-card__story">{card.story}</span>}
      {card.outcome && (
        <span className="gg-card__outcome">
          <span className="gg-card__ev" aria-hidden="true">
            ⇒
          </span>
          {card.outcome.text}
        </span>
      )}
      <Runway dots={card.dots} overflow={card.overflow} rosterIdx={rosterIdx} />
      <span className="gg-foot">
        <span className="gg-foot__count">
          {counts.join(' · ')}
          {card.counts.blocked > 0 && (
            <>
              {' · '}
              <span className="gg-foot__stuck">
                {card.counts.blocked} stuck
              </span>
            </>
          )}
          {debt && (
            <>
              {' · '}
              {/* The daemon's own sentence carries the hours — we never recompute the age. */}
              <span className="gg-foot__owed" title={card.staleNote ?? undefined}>
                ⏳ {debt}
              </span>
            </>
          )}
        </span>
        {card.lastMoved ? (
          <span className="gg-foot__tick">
            ⚡ <b>{card.lastMoved.title}</b> · {ago(now, card.lastMoved.at)}
          </span>
        ) : card.id === null ? (
          <span className="gg-foot__tick">🏷️ link them to a goal</span>
        ) : null}
      </span>
    </button>
  );
}

function Runway({
  dots,
  overflow,
  rosterIdx,
}: {
  dots: RunwayDot[];
  overflow: number;
  rosterIdx: Map<string, MemberSummary>;
}) {
  return (
    <span className="gg-runway" aria-hidden="true">
      <span className="gg-runway__track" />
      <span className="gg-zmark" style={{ left: '25%' }} />
      <span className="gg-zmark" style={{ left: '50%' }} />
      <span className="gg-zmark" style={{ left: '75%' }} />
      <span className="gg-zone" style={{ left: 0 }}>
        backlog
      </span>
      <span className="gg-zone" style={{ left: '26%' }}>
        working
      </span>
      <span className="gg-zone" style={{ left: '51%' }}>
        review
      </span>
      <span className="gg-zone" style={{ right: 0 }}>
        shipped&nbsp;🏁
      </span>
      {dots.map((d) =>
        d.kind === 'rider' && d.owner ? (
          <span key={d.lane} className="gg-rider" style={{ left: `${d.x}%` }}>
            <span
              className="gg-rider__av"
              style={{ background: memberAvatar(d.owner, kindOf(d.owner, rosterIdx)) }}
            >
              {initial(d.owner)}
            </span>
          </span>
        ) : (
          <span
            key={d.lane}
            style={{ left: `${d.x}%` }}
            className={`gg-dot gg-dot--${d.tone}${d.stale ? ' gg-dot--stale' : ''}`}
          >
            {d.latest && <span className="gg-landed">✨</span>}
          </span>
        ),
      )}
      {overflow > 0 && <span className="gg-runway__more">+{overflow}</span>}
    </span>
  );
}
