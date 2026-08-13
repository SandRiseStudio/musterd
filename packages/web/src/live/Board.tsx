import type {
  Goal,
  Lane,
  LaneState,
  LaneWarning,
  MemberSummary,
  OpenLane,
  UpdateLane,
} from '@musterd/protocol';
import { useEffect, useMemo, useRef, useState, type MutableRefObject } from 'react';
import {
  capColumn,
  centerScroll,
  handoffPatch,
  laneActions,
  laneStates,
  movedLanes,
  NO_MOVES,
  type LaneAction,
  type MovedLanes,
} from './boardWrite';
import { kindOf, memberAvatar } from './format';
import { GoalGrid } from './GoalGridView';

/**
 * The work board (ADR 104): the team's lanes as a kanban, one column per lane state. Lane state *is*
 * the column — the board renders what the daemon derives (no stored columns, never a second store).
 * Since item 5 the board is **writable for a signed-in member**: create/claim/advance/handoff/resolve
 * are thin calls onto the daemon's own lane verbs, gated on real roster membership (`me`). The
 * observer view renders exactly the read-only board it always did. `abandoned` lanes are dropped from
 * the board (not a column); everything else maps 1:1.
 */
const COLUMNS: ReadonlyArray<{ key: LaneState; label: string; tone: string }> = [
  { key: 'open', label: 'Backlog', tone: 'neutral' },
  { key: 'claimed', label: 'Claimed', tone: 'lane' },
  { key: 'active', label: 'In progress', tone: 'lane' },
  { key: 'blocked', label: 'Blocked', tone: 'danger' },
  { key: 'awaiting_acceptance', label: 'Awaiting acceptance', tone: 'lane' },
  { key: 'done', label: 'Done', tone: 'success' },
];

/** Column DOM caps (perf contract — no unbounded lists). Done grows forever, so it caps tighter. */
const COLUMN_CAP = 30;
const DONE_CAP = 10;

/** Office-voice empty states — each column gets its own line, in the room's register. */
const EMPTY_COPY: Partial<Record<LaneState, string>> = {
  open: 'Nothing waiting. Quiet desk.',
  claimed: "No one's picked anything up.",
  active: 'Nothing in flight.',
  blocked: 'Nothing stuck. Good sign.',
  awaiting_acceptance: 'Nothing awaiting acceptance.',
  ready_for_review: 'Nothing awaiting acceptance.',
  done: 'Nothing shipped yet — soon.',
  abandoned: '', // no column
};

const ACTION_LABEL: Record<LaneAction['kind'], string> = {
  claim: 'claim',
  start: 'start',
  block: 'stuck',
  unblock: 'unstick',
  handoff: 'hand off',
  ready: 'submit',
  done: 'done',
  confirm: 'accept',
  sendback: 'reject',
  abandon: 'let it go',
};

/** Compact relative age (`3m`, `2h`, `4d`) from a ms-epoch ts — how long a card has sat where it is. */
function ago(ts: number): string {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

export interface BoardProps {
  lanes: Lane[];
  warnings: LaneWarning[];
  /** Goals grid (the front door, goals-front-door design) ⇄ columns (by lane state). */
  view: 'columns' | 'grid';
  /** Declared Goals with derived status — the grid's mission cards. Empty = grid renders nothing. */
  goals: Goal[];
  /** Drill into a goal's lanes (null = the goal-less pool). Absent = cards still render, inert. */
  onOpenGoal?: (goalId: string | null) => void;
  /** Team roster — identity colors (jade agent / rose human) and the handoff seat picker. */
  roster: MemberSummary[];
  /** The signed-in member's seat name, or null for the read-only observer view. */
  me: string | null;
  /** Lane id (or 'compose') with a write in flight — its controls disable while the daemon answers. */
  busyId: string | null;
  /** The "+ New lane" compose card is open (state lives in the route; the topbar button flips it). */
  composing: boolean;
  onComposeClose: () => void;
  /** Create a lane; resolves true on success (the route folds the echo + reports errors). */
  onCreate: (input: OpenLane) => Promise<boolean>;
  /** Patch a lane (claim / advance / handoff / resolve). */
  onPatch: (id: string, patch: UpdateLane) => Promise<boolean>;
  /**
   * A lane someone was sent here to look at (`/board?lane=<id>`, the acceptance deep link). It is
   * pinned past its column's cap, ringed, and scrolled to. Null/absent = the ordinary board.
   */
  focusLane?: string | null;
}

export function Board({
  lanes,
  warnings,
  view,
  goals,
  onOpenGoal,
  roster,
  me,
  busyId,
  composing,
  onComposeClose,
  onCreate,
  onPatch,
  focusLane = null,
}: BoardProps) {
  // Lanes carrying a live warning (unmet dependency / surface overlap) — advisory, warn-never-block.
  const warned = useMemo(() => new Map(warnings.map((w) => [w.subject, w.detail])), [warnings]);
  const rosterIdx = useMemo(() => new Map(roster.map((m) => [m.name, m])), [roster]);
  const byState = useMemo(() => {
    const m = new Map<LaneState, Lane[]>(COLUMNS.map((c) => [c.key, []]));
    for (const lane of lanes) {
      // ADR 192: legacy ready_for_review rows fold into the awaiting_acceptance column.
      const key = lane.state === 'ready_for_review' ? 'awaiting_acceptance' : lane.state;
      m.get(key)?.push(lane); // abandoned has no column → excluded
    }
    return m;
  }, [lanes]);

  // Which cards just *moved* (state changed / newly appeared) — they land with motion; a card that
  // reaches Done gets the warm flourish. First render is handled by the entrance stagger instead.
  // Adjusting state during render — the pattern React sanctions for "what changed since last time",
  // and the reason this no longer reads a ref mid-render. `states` is memoised on `lanes`, so the
  // comparison flips exactly once per change and then converges; React re-runs this component before
  // committing, so the stale `moved` below is never painted. The diff itself is a pure, tested
  // function in boardWrite.
  const states = useMemo(() => laneStates(lanes), [lanes]);
  const [seen, setSeen] = useState<ReadonlyMap<string, LaneState> | null>(null);
  const [moved, setMoved] = useState<MovedLanes>(NO_MOVES);
  if (states !== seen) {
    setMoved(seen ? movedLanes(seen, lanes) : NO_MOVES);
    setSeen(states);
  }
  const { landed, flourished } = moved;

  // First-load entrance: a short stagger across the first few cards, then never again.
  const [entering, setEntering] = useState(true);
  useEffect(() => {
    const t = window.setTimeout(() => setEntering(false), 900);
    return () => window.clearTimeout(t);
  }, []);

  // Per-column "…and K more" expansion — session-scoped, resets on reconnect.
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  // The deep link's arrival: bring the named lane into view.
  //
  // Gated on `entering` rather than a timer, and that gate is the whole correctness of this. The
  // entrance stagger animates cards into place for 900ms; a scroll computed while they are still
  // moving reads mid-animation geometry and lands somewhere else entirely — measured: the card
  // finished below the fold AND clipped behind the insight rail, with the horizontal scroller
  // barely moved (18px of an available 440). Waiting for the board to settle puts it dead centre.
  // The card is usually there before the stagger ends anyway, so nothing is perceptibly slower.
  const pin = useMemo(
    () => (focusLane ? (l: Lane) => l.id === focusLane : undefined),
    [focusLane],
  );
  const focusRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!focusLane || entering) return;
    const el = focusRef.current;
    if (!el) return;
    // Aimed by arithmetic (`centerScroll`), not by `scrollIntoView`. The board scrolls both axes in
    // one container whose content height changes as lanes stream in, and the browser's own
    // bring-into-view heuristics were measured landing this card above the fold and clipped behind
    // the insight rail. Offsets are accumulated up to the scroller because a card's `offsetParent`
    // is its column, not the scrollport.
    //
    // `hidden` decides the manner, and it is not a test artifact: deep links are routinely opened in
    // a background tab (cmd-click, or a CLI handing the URL to a browser), where a smooth scroll's
    // animation never runs — so when nobody is watching, jump, and be in the right place by the time
    // they look. Glide only for an eye that can follow it, and only where motion is welcome.
    const scroller = el.closest<HTMLElement>('.lc-board__main');
    if (!scroller) return;

    /** Aim once. Returns false when the page cannot be measured yet, so the caller can try later. */
    const aim = (): boolean => {
      // A scroller with no measurable box is the trap this whole function exists around: a hidden or
      // not-yet-laid-out page reports clientWidth 0, and centring against 0 resolves to "as far as
      // this thing goes" — measured, that slammed the board to its bottom-right corner with the card
      // nowhere on screen. Refusing to aim while blind is the fix; `visibilitychange` below covers
      // the case that made us blind, which is a deep link opened in a background tab.
      if (scroller.clientWidth === 0 || scroller.clientHeight === 0) return false;
      let x = 0;
      let y = 0;
      for (
        let n: HTMLElement | null = el;
        n && n !== scroller;
        n = n.offsetParent as HTMLElement | null
      ) {
        x += n.offsetLeft;
        y += n.offsetTop;
      }
      scroller.scrollTo({
        left: centerScroll(x, el.offsetWidth, scroller.clientWidth, scroller.scrollWidth),
        top: centerScroll(y, el.offsetHeight, scroller.clientHeight, scroller.scrollHeight),
        // Glide only for an eye that can follow it: a hidden tab never runs the animation, so it
        // would sit un-scrolled until shown. Jump, and be in place by the time they look.
        behavior:
          document.hidden || window.matchMedia('(prefers-reduced-motion: reduce)').matches
            ? 'auto'
            : 'smooth',
      });
      return true;
    };

    // Now, and once more after the entrance settles and the first live refetch has had its say —
    // the second pass is a no-op when nothing moved. Plus one on becoming visible, for the link
    // that was opened into a background tab and could not be aimed until now.
    const timers = [0, 400].map((d) => window.setTimeout(aim, d));
    const onShow = (): void => {
      if (!document.hidden) aim();
    };
    document.addEventListener('visibilitychange', onShow);
    return () => {
      timers.forEach(window.clearTimeout);
      document.removeEventListener('visibilitychange', onShow);
    };
  }, [focusLane, lanes, entering]);

  let cardIndex = 0;
  const renderCard = (lane: Lane) => {
    const i = cardIndex++;
    const focused = lane.id === focusLane;
    return (
      <LaneCard
        key={lane.id}
        lane={lane}
        warnDetail={warned.get(lane.id) ?? null}
        rosterIdx={rosterIdx}
        me={me}
        busy={busyId === lane.id}
        landed={landed.has(lane.id)}
        flourish={flourished.has(lane.id)}
        enterDelay={entering ? Math.min(i, 9) * 60 : null}
        onPatch={onPatch}
        focused={focused}
        cardRef={focused ? focusRef : null}
      />
    );
  };

  if (view === 'grid') {
    return (
      <div className="lc-board lc-board--grid">
        {composing && (
          <div className="lc-band lc-band--compose">
            <ComposeCard busy={busyId === 'compose'} onClose={onComposeClose} onCreate={onCreate} />
          </div>
        )}
        <GoalGrid
          lanes={lanes.filter((l) => l.state !== 'abandoned')}
          goals={goals}
          warnings={warnings}
          roster={roster}
          onOpenGoal={onOpenGoal ?? (() => undefined)}
        />
      </div>
    );
  }

  return (
    <div className="lc-board">
      {COLUMNS.map((col) => {
        const items = byState.get(col.key) ?? [];
        const cap = col.key === 'done' ? DONE_CAP : COLUMN_CAP;
        const { shown, hidden } = capColumn(items, cap, expanded.has(col.key), pin);
        const composeHere = composing && col.key === 'open';
        return (
          <section
            key={col.key}
            className={`lc-col lc-col--${col.tone}`}
            aria-label={`${col.label} — ${items.length} ${items.length === 1 ? 'lane' : 'lanes'}`}
          >
            <header className="lc-col__head">
              <span className="lc-col__label">{col.label}</span>
              <span className="lc-col__count">{items.length}</span>
            </header>
            <div className="lc-col__cards">
              {composeHere && (
                <ComposeCard
                  busy={busyId === 'compose'}
                  onClose={onComposeClose}
                  onCreate={onCreate}
                />
              )}
              {items.length === 0 && !composeHere ? (
                <p className="lc-col__empty">
                  {col.key === 'open' && me ? 'Nothing waiting — open a lane.' : EMPTY_COPY[col.key]}
                </p>
              ) : (
                shown.map(renderCard)
              )}
              {hidden > 0 && (
                <button
                  className="lc-col__more"
                  onClick={() => setExpanded((s) => new Set(s).add(col.key))}
                >
                  …and {hidden} more
                </button>
              )}
            </div>
          </section>
        );
      })}
    </div>
  );
}

function LaneCard({
  lane,
  warnDetail,
  rosterIdx,
  me,
  busy,
  landed,
  flourish,
  enterDelay,
  onPatch,
  focused = false,
  cardRef = null,
}: {
  lane: Lane;
  warnDetail: string | null;
  rosterIdx: Map<string, MemberSummary>;
  me: string | null;
  busy: boolean;
  landed: boolean;
  flourish: boolean;
  enterDelay: number | null;
  onPatch: (id: string, patch: UpdateLane) => Promise<boolean>;
  /** This is the lane the deep link named — ringed, and announced to assistive tech. */
  focused?: boolean;
  cardRef?: MutableRefObject<HTMLElement | null> | null;
}) {
  // Done cards age from resolved_at; live cards from claimed_at (how long in flight), else created.
  const stamp =
    lane.state === 'done' ? (lane.resolved_at ?? lane.updated_at) : (lane.claimed_at ?? lane.updated_at);
  const ownerKind = lane.owner_seat ? kindOf(lane.owner_seat, rosterIdx) : 'agent';
  // "Waiting on a human" made ambient: a human-owned blocked card breathes softly in rose.
  const breathe = lane.state === 'blocked' && lane.owner_seat != null && ownerKind === 'human';
  const actions = laneActions(lane, me);
  const [picking, setPicking] = useState(false);
  const abandonAction = actions.find((a) => a.kind === 'abandon');
  const pills = actions.filter((a) => a.kind !== 'abandon');

  const classes = [
    'lc-card',
    warnDetail != null && 'lc-card--warned',
    me != null && lane.owner_seat === me && 'lc-card--mine',
    breathe && 'lc-card--breathe',
    flourish ? 'lc-card--flourish' : landed ? 'lc-card--landed' : null,
    enterDelay != null && 'lc-card--enter',
    focused && 'lc-card--focused',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <article
      ref={cardRef}
      className={classes}
      // The deep link points at this card; say so rather than relying on the ring alone, which a
      // screen reader cannot see and a colour-blind reader may not distinguish.
      {...(focused ? { 'aria-current': 'true' as const } : {})}
      style={enterDelay != null ? { animationDelay: `${enterDelay}ms` } : undefined}
    >
      <p className="lc-card__title">{lane.title}</p>
      <div className="lc-card__meta">
        {lane.owner_seat && (
          <span className="lc-card__owner">
            {/* A dot, not a monogram. The seat's name is written immediately to its right, so the
                initial was duplicated text — and at 16px it was white on the identity fill, which
                no single ink clears across that hue band (white scores 1.61–3.90 over it,
                near-black 4.42–10.73; the purple seat fails both poles). Dropping the glyph removes
                the unreadable text rather than hiding it from the sweep. Retuning the band to one
                luminance is the other fix and belongs with the palette, not here. */}
            <span
              className="lc-card__avatar"
              style={{ background: memberAvatar(lane.owner_seat, ownerKind) }}
              aria-hidden="true"
            />
            {lane.owner_seat}
          </span>
        )}
        {lane.goal_id && <span className="lc-card__chip lc-card__chip--goal">{lane.goal_id}</span>}
        {lane.state === 'done' && lane.verified === true && (
          <span className="lc-card__chip lc-card__chip--verified" title="Accepted by a counterpart">
            ✓ accepted
          </span>
        )}
        {lane.state === 'done' && lane.verified === false && (
          <span
            className="lc-card__chip lc-card__chip--unverified"
            title="Self-closed — no counterpart acceptance"
          >
            unconfirmed
          </span>
        )}
        {lane.branch && <span className="lc-card__chip lc-card__chip--branch">{lane.branch}</span>}
      </div>
      {lane.state === 'blocked' && lane.detail && (
        <p className="lc-card__detail">{lane.detail}</p>
      )}
      {actions.length > 0 && !picking && (
        <div className="lc-card__actions">
          {pills.map((a) =>
            a.kind === 'handoff' ? (
              <button
                key={a.kind}
                className="lc-ask__btn lc-card__act lc-card__act--handoff"
                disabled={busy}
                onClick={() => setPicking(true)}
              >
                {ACTION_LABEL[a.kind]}
              </button>
            ) : (
              <button
                key={a.kind}
                className={`lc-ask__btn lc-card__act lc-card__act--${a.kind}`}
                disabled={busy}
                onClick={() => void onPatch(lane.id, a.patch)}
              >
                {ACTION_LABEL[a.kind]}
              </button>
            ),
          )}
          {abandonAction && (
            <button
              className="lc-card__abandon"
              disabled={busy}
              onClick={() => void onPatch(lane.id, abandonAction.patch)}
            >
              {ACTION_LABEL.abandon}
            </button>
          )}
        </div>
      )}
      {picking && (
        <SeatPicker
          me={me!}
          rosterIdx={rosterIdx}
          busy={busy}
          onPick={(seat) => {
            void onPatch(lane.id, handoffPatch(seat)).then((ok) => {
              if (ok) setPicking(false);
            });
          }}
          onCancel={() => setPicking(false)}
        />
      )}
      <div className="lc-card__foot">
        {warnDetail != null && (
          <span className="lc-card__warn" title={warnDetail} aria-label={`Lane warning: ${warnDetail}`}>
            ⚠ flag
          </span>
        )}
        <time className="lc-card__age">{ago(stamp)}</time>
      </div>
    </article>
  );
}

/** The inline hand-off seat picker — the actions row slides aside; pick a teammate, or step back. */
function SeatPicker({
  me,
  rosterIdx,
  busy,
  onPick,
  onCancel,
}: {
  me: string;
  rosterIdx: Map<string, MemberSummary>;
  busy: boolean;
  onPick: (seat: string) => void;
  onCancel: () => void;
}) {
  const others = [...rosterIdx.values()].filter((m) => m.name !== me);
  return (
    // Escape dismisses the picker. The rule guards against click handlers that turn a plain div
    // into an invisible control a keyboard cannot reach — the opposite of what this is. This ADDS a
    // keyboard path to a group whose buttons are already focusable, and removing it would take away
    // the only way out that does not require finding Cancel by tab.
    // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions
    <div
      className="lc-card__picker"
      role="group"
      aria-label="Hand off to"
      onKeyDown={(e) => e.key === 'Escape' && onCancel()}
    >
      <span className="lc-card__picker-label">to:</span>
      {others.map((m) => (
        <button
          key={m.name}
          className="lc-ask__btn lc-card__seat"
          disabled={busy}
          onClick={() => onPick(m.name)}
        >
          <span
            className="lc-card__avatar"
            style={{ background: memberAvatar(m.name, m.kind === 'human' ? 'human' : 'agent') }}
            aria-hidden="true"
          />
          {m.name}
        </button>
      ))}
      {others.length === 0 && <span className="lc-card__picker-label">no one else is here</span>}
      <button className="lc-card__abandon" onClick={onCancel} aria-label="Cancel hand-off">
        ✕
      </button>
    </div>
  );
}

/** The "New lane" moment: a ghost card that materializes atop Backlog and becomes the real thing. */
function ComposeCard({
  busy,
  onClose,
  onCreate,
}: {
  busy: boolean;
  onClose: () => void;
  onCreate: (input: OpenLane) => Promise<boolean>;
}) {
  const [title, setTitle] = useState('');
  const [claim, setClaim] = useState(true);
  const [more, setMore] = useState(false);
  const [goal, setGoal] = useState('');
  const [branch, setBranch] = useState('');

  const submit = () => {
    const t = title.trim();
    if (!t || busy) return;
    const input: OpenLane = { title: t, claim };
    if (goal.trim()) input.goal_id = goal.trim();
    if (branch.trim()) input.branch = branch.trim();
    void onCreate(input).then((ok) => {
      if (ok) onClose();
    });
  };

  return (
    // Escape abandons the composer — same rationale as the picker above: a keyboard escape hatch
    // added to an element whose contents are already focusable, not a fake control.
    // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions
    <form
      className="lc-card lc-card--compose"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      onKeyDown={(e) => e.key === 'Escape' && onClose()}
    >
      {/* autoFocus is CORRECT here and the rule is wrong about this case. This composer does not
          exist until you open it, and when a new composer appears in response to your action, focus
          belongs inside it — that is what a dialog is supposed to do, and leaving focus behind on
          the button that opened it is the actual accessibility failure. The rule cannot tell
          on-open from on-page-load; the two connect forms, which ARE on-page-load, had theirs
          removed in this same change. */}
      {/* eslint-disable jsx-a11y/no-autofocus -- see the note above: focus belongs in a composer
          the user just opened. */}
      <input
        className="lc-card__compose-title"
        type="text"
        value={title}
        placeholder="What needs doing?"
        autoFocus
        onChange={(e) => setTitle(e.target.value)}
      />
      {/* eslint-enable jsx-a11y/no-autofocus */}
      <label className="lc-card__compose-claim">
        <input type="checkbox" checked={claim} onChange={(e) => setClaim(e.target.checked)} />
        <span>and it&apos;s mine</span>
      </label>
      {more && (
        <div className="lc-card__compose-more">
          <input
            type="text"
            value={goal}
            placeholder="goal id (optional)"
            onChange={(e) => setGoal(e.target.value)}
          />
          <input
            type="text"
            value={branch}
            placeholder="branch (optional)"
            onChange={(e) => setBranch(e.target.value)}
          />
        </div>
      )}
      <div className="lc-card__actions lc-card__actions--compose">
        <button type="submit" className="lc-ask__btn lc-card__act lc-card__act--claim" disabled={!title.trim() || busy}>
          {busy ? 'opening…' : 'open lane'}
        </button>
        {!more && (
          <button type="button" className="lc-card__abandon" onClick={() => setMore(true)}>
            more
          </button>
        )}
        <button type="button" className="lc-card__abandon" onClick={onClose}>
          cancel
        </button>
      </div>
    </form>
  );
}
