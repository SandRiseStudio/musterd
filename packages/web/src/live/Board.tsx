import type {
  Goal,
  Lane,
  LaneState,
  LaneWarning,
  MemberSummary,
  OpenLane,
  UpdateLane,
} from '@musterd/protocol';
import { useEffect, useMemo, useRef, useState } from 'react';
import { capColumn, groupByGoal, handoffPatch, laneActions, type LaneAction } from './boardWrite';
import { initial, kindOf, memberColor } from './format';

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
  { key: 'ready_for_review', label: 'In review', tone: 'lane' },
  { key: 'done', label: 'Done', tone: 'success' },
];

/** Column DOM caps (perf contract — no unbounded lists). Done grows forever, so it caps tighter. */
const COLUMN_CAP = 30;
const DONE_CAP = 10;

/** Office-voice empty states — each column gets its own line, in the room's register. */
const EMPTY_COPY: Record<LaneState, string> = {
  open: 'Nothing waiting. Quiet desk.',
  claimed: "No one's picked anything up.",
  active: 'Nothing in flight.',
  blocked: 'Nothing stuck. Good sign.',
  paused: 'Nothing on hold.',
  ready_for_review: 'Nothing awaiting eyes.',
  done: 'Nothing shipped yet — soon.',
  abandoned: '', // no column
};

const ACTION_LABEL: Record<LaneAction['kind'], string> = {
  claim: 'claim',
  start: 'start',
  block: 'stuck',
  unblock: 'unstick',
  handoff: 'hand off',
  ready: 'ready',
  done: 'done',
  confirm: 'confirm',
  sendback: 'send back',
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
  /** Columns (by lane state, the default) ⇄ goals (swimlane bands from the report's Goal list). */
  view: 'columns' | 'goals';
  /** Declared Goals with derived status — the swimlane bands (Inc B). Empty = "no goal" band only. */
  goals: Goal[];
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
}

export function Board({
  lanes,
  warnings,
  view,
  goals,
  roster,
  me,
  busyId,
  composing,
  onComposeClose,
  onCreate,
  onPatch,
}: BoardProps) {
  // Lanes carrying a live warning (unmet dependency / surface overlap) — advisory, warn-never-block.
  const warned = useMemo(() => new Map(warnings.map((w) => [w.subject, w.detail])), [warnings]);
  const rosterIdx = useMemo(() => new Map(roster.map((m) => [m.name, m])), [roster]);
  const byState = useMemo(() => {
    const m = new Map<LaneState, Lane[]>(COLUMNS.map((c) => [c.key, []]));
    for (const lane of lanes) m.get(lane.state)?.push(lane); // abandoned has no column → excluded
    return m;
  }, [lanes]);

  // Which cards just *moved* (state changed / newly appeared) — they land with motion; a card that
  // reaches Done gets the warm flourish. First render is handled by the entrance stagger instead.
  const prevStates = useRef<Map<string, LaneState> | null>(null);
  const { landed, flourished } = useMemo(() => {
    const prev = prevStates.current;
    const landed = new Set<string>();
    const flourished = new Set<string>();
    if (prev) {
      for (const lane of lanes) {
        const was = prev.get(lane.id);
        if (was === lane.state) continue;
        landed.add(lane.id);
        // The warm flourish fires on a CONFIRMED close only (ADR 169, miley's call): a counterpart
        // said "this is what I wanted". A self-close lands like any other move — no celebration for
        // an unverified close, and no beat at all on merely reaching ready_for_review.
        if (lane.state === 'done' && was !== undefined && lane.verified === true)
          flourished.add(lane.id);
      }
    }
    return { landed, flourished };
  }, [lanes]);
  useEffect(() => {
    prevStates.current = new Map(lanes.map((l) => [l.id, l.state]));
  }, [lanes]);

  // First-load entrance: a short stagger across the first few cards, then never again.
  const [entering, setEntering] = useState(true);
  useEffect(() => {
    const t = window.setTimeout(() => setEntering(false), 900);
    return () => window.clearTimeout(t);
  }, []);

  // Per-column "…and K more" expansion — session-scoped, resets on reconnect.
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  let cardIndex = 0;
  const renderCard = (lane: Lane) => {
    const i = cardIndex++;
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
      />
    );
  };

  if (view === 'goals') {
    const rows = groupByGoal(lanes.filter((l) => l.state !== 'abandoned'), goals);
    return (
      <div className="lc-board lc-board--goals">
        {composing && (
          <div className="lc-band lc-band--compose">
            <ComposeCard busy={busyId === 'compose'} onClose={onComposeClose} onCreate={onCreate} />
          </div>
        )}
        {rows.length === 0 && !composing && (
          <p className="lc-col__empty">No goals declared, nothing in flight. A blank page.</p>
        )}
        {rows.map((row) => (
          <section
            key={row.id ?? '∅'}
            className="lc-band"
            aria-label={`${row.title} — ${row.lanes.length} ${row.lanes.length === 1 ? 'lane' : 'lanes'}`}
          >
            <header className="lc-band__head">
              <span className="lc-band__title">{row.title}</span>
              {row.status && (
                <span className={`lc-band__status lc-band__status--${row.status}`}>{row.status}</span>
              )}
              <span className="lc-col__count">{row.lanes.length}</span>
            </header>
            {row.lanes.length === 0 ? (
              <p className="lc-col__empty">Declared, untouched. It waits.</p>
            ) : (
              <div className="lc-band__grid">
                {COLUMNS.map((col) => {
                  const items = row.lanes.filter((l) => l.state === col.key);
                  if (items.length === 0) return null;
                  const key = `${row.id ?? '∅'}:${col.key}`;
                  const { shown, hidden } = capColumn(
                    items,
                    col.key === 'done' ? DONE_CAP : COLUMN_CAP,
                    expanded.has(key),
                  );
                  return (
                    <div key={col.key} className={`lc-col lc-col--${col.tone}`}>
                      <header className="lc-col__head">
                        <span className="lc-col__label">{col.label}</span>
                        <span className="lc-col__count">{items.length}</span>
                      </header>
                      <div className="lc-col__cards">
                        {shown.map(renderCard)}
                        {hidden > 0 && (
                          <button
                            className="lc-col__more"
                            onClick={() => setExpanded((s) => new Set(s).add(key))}
                          >
                            …and {hidden} more
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </section>
        ))}
      </div>
    );
  }

  return (
    <div className="lc-board">
      {COLUMNS.map((col) => {
        const items = byState.get(col.key) ?? [];
        const cap = col.key === 'done' ? DONE_CAP : COLUMN_CAP;
        const { shown, hidden } = capColumn(items, cap, expanded.has(col.key));
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
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <article
      className={classes}
      style={enterDelay != null ? { animationDelay: `${enterDelay}ms` } : undefined}
    >
      <p className="lc-card__title">{lane.title}</p>
      <div className="lc-card__meta">
        {lane.owner_seat && (
          <span className="lc-card__owner">
            <span
              className="lc-card__avatar"
              style={{ background: memberColor(lane.owner_seat, ownerKind) }}
            >
              {initial(lane.owner_seat)}
            </span>
            {lane.owner_seat}
          </span>
        )}
        {lane.goal_id && <span className="lc-card__chip lc-card__chip--goal">{lane.goal_id}</span>}
        {lane.state === 'done' && lane.verified === true && (
          <span className="lc-card__chip lc-card__chip--verified" title="Confirmed by a counterpart">
            ✓ confirmed
          </span>
        )}
        {lane.state === 'done' && lane.verified === false && (
          <span className="lc-card__chip lc-card__chip--unverified" title="Self-closed — no counterpart confirm">
            unverified
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
            style={{ background: memberColor(m.name, m.kind === 'human' ? 'human' : 'agent') }}
            aria-hidden="true"
          >
            {initial(m.name)}
          </span>
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
    <form
      className="lc-card lc-card--compose"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      onKeyDown={(e) => e.key === 'Escape' && onClose()}
    >
      <input
        className="lc-card__compose-title"
        type="text"
        value={title}
        placeholder="What needs doing?"
        autoFocus
        onChange={(e) => setTitle(e.target.value)}
      />
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
