import type { LaneBoard, MemberSummary } from '@musterd/protocol';
import { createFileRoute, useRouter } from '@tanstack/react-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Board } from '../live/Board';
import {
  MemberSignInFields,
  MemberSignInToggle,
  type AdvancedState,
} from '../live/MemberSignIn';
import {
  acquireObserver,
  forgetObserver,
  redeemSignin,
  type LiveConfig,
} from '../live/client';
import {
  forgetMemberIdentity,
  loadMemberIdentity,
  saveMemberIdentity,
} from '../live/memberIdentity';
import { filterLanes, UNOWNED } from '../live/boardWrite';
import { goalFilter, resolveBoardView } from '../live/goalGrid';
import { useBoardData } from '../live/useBoardData';
import { kindOf, memberColor, memberAvatar } from '../live/format';
import { InsightRail } from '../live/InsightRail';
import { useLiveStream } from '../live/useLiveStream';
import { useReport } from '../live/useReport';
import { useWorkingOn } from '../live/useWorkingOn';
import liveCss from '../live/Live.css?url';
import brandCss from '../brand/brand.css?url';
import { MusterdWord } from '../brand/MusterdWord';

export const Route = createFileRoute('/board')({
  head: () => ({
    meta: [{ title: 'musterd — work board' }],
    links: [
      { rel: 'stylesheet', href: liveCss },
      { rel: 'stylesheet', href: brandCss },
    ],
  }),
  component: BoardPage,
});

const TEAM_KEY = 'musterd.board.team';
const VIEW_KEY = 'musterd.board.view';
const RAIL_KEY = 'musterd.board.rail';

/**
 * The work board (ADR 104). Read side: a kanban over `GET /lanes`, live via the firehose — one fetch,
 * then a re-fetch only when a lane act arrives (the useWorkingOn pattern; no polling). Write side
 * (item 5): sign in as a real seat (the shared /live advanced flow) and the board becomes writable —
 * create/claim/advance/handoff/resolve, member-authed, optimistic on the daemon's echo. The default
 * observer path stays exactly what it was: a hidden read-only seat, no account, no controls.
 */
function BoardPage() {
  const router = useRouter();
  const [team, setTeam] = useState('');
  const [advanced, setAdvanced] = useState<AdvancedState>({ open: false, as: '', token: '' });
  const [cfg, setCfg] = useState<LiveConfig | null>(null);
  const [isMember, setIsMember] = useState(false);
  const [provisioning, setProvisioning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [composing, setComposing] = useState(false);

  const disconnect = useCallback((message?: string) => {
    setCfg(null);
    setIsMember(false);
    setComposing(false);
    if (message) setError(message);
  }, []);

  // A member credential the daemon rejects is a dead end to explain, not silently retry; a stale
  // *observer* self-heals by dropping the cached seat and provisioning a fresh one.
  const onCredentialInvalid = useCallback(() => {
    setCfg((current) => {
      if (!current) return current;
      if (isMember) {
        forgetMemberIdentity(current.team);
        disconnect('That credential was rejected — sign in again.');
        return null;
      }
      forgetObserver(current.team);
      void acquireObserver(current.team).then(setCfg, (e: unknown) =>
        disconnect(e instanceof Error ? e.message : String(e)),
      );
      return null;
    });
  }, [isMember, disconnect]);

  const { envelopes, roster } = useLiveStream(cfg, { onCredentialInvalid });
  const base = useWorkingOn(cfg, envelopes);
  const report = useReport(cfg, envelopes);

  // The board's data half — optimistic writes, the write gate, the status line — shared with the
  // office overlay on /live (which supplies its own `base`).
  const { board, me, busyId, note, doCreate, doPatch } = useBoardData(cfg, roster, base);

  // View + rail preferences — sticky per browser, read once on mount (client-only).
  // `stored` may be the legacy 'goals' value; `resolveBoardView` maps it, and — when nothing is
  // stored — defaults to the grid exactly when the team has unshipped goals. Because the resolve
  // runs per render over the live report, the default settles itself when the report arrives.
  const [storedView, setStoredView] = useState<string | null>(null);
  const [chosenView, setChosenView] = useState<'grid' | 'columns' | null>(null);
  const [railCollapsed, setRailCollapsed] = useState(false);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    setStoredView(window.localStorage.getItem(VIEW_KEY));
    if (window.localStorage.getItem(RAIL_KEY) === 'collapsed') setRailCollapsed(true);
  }, []);
  const unshippedGoals = report?.goals.filter((g) => g.status !== 'shipped').length ?? 0;
  const view = chosenView ?? resolveBoardView(storedView, unshippedGoals);
  const pickView = (v: 'grid' | 'columns') => {
    setChosenView(v);
    window.localStorage.setItem(VIEW_KEY, v);
  };

  // Drill-in (goals-front-door design): a grid card click filters the columns to that goal's lanes
  // (null = the goal-less pool; undefined = no filter). Reflected into `?goal=` for deep links.
  const [goalFocus, setGoalFocus] = useState<string | null | undefined>(undefined);
  const openGoal = (goalId: string | null) => {
    setGoalFocus(goalId);
    pickView('columns');
    if (typeof window !== 'undefined') {
      const url = new URL(window.location.href);
      url.searchParams.set('goal', goalId ?? 'none');
      window.history.replaceState(null, '', url);
    }
  };
  const closeGoal = () => {
    setGoalFocus(undefined);
    if (typeof window !== 'undefined') {
      const url = new URL(window.location.href);
      url.searchParams.delete('goal');
      window.history.replaceState(null, '', url);
    }
  };
  const collapseRail = (c: boolean) => {
    setRailCollapsed(c);
    window.localStorage.setItem(RAIL_KEY, c ? 'collapsed' : 'open');
  };

  // The acceptance deep link's subject (`?lane=<id>`) — read from the URL on mount, below.
  const [focusLane, setFocusLane] = useState<string | null>(null);

  // The member filter — a lens over the same lanes, session-scoped, empty = everyone.
  const [ownerFilter, setOwnerFilter] = useState<ReadonlySet<string>>(new Set());
  const toggleOwner = (key: string) =>
    setOwnerFilter((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  // Memoised because the focus effect below depends on it: a fresh array every render would re-run
  // that effect every render, and it can call setState.
  const shownLanes = useMemo(
    () => (board ? filterLanes(board.lanes, ownerFilter) : []),
    [board, ownerFilter],
  );

  // A deep link means "show me this lane", so an owner filter left over from earlier in the session
  // must not be the reason it isn't on screen. Clearing beats fighting: the filter is a lens the
  // reader can re-apply in one click, and a link that silently lands on a board without its own
  // subject is the failure this lane exists to prevent.
  useEffect(() => {
    if (focusLane && ownerFilter.size > 0 && !shownLanes.some((l) => l.id === focusLane)) {
      setOwnerFilter(new Set());
    }
  }, [focusLane, ownerFilter, shownLanes]);

  // The link named a lane this board does not have (stale id, wrong team, already-abandoned lane).
  // Say so plainly — a deep link that quietly degrades to the whole board leaves the reader hunting
  // for something that was never here.
  const focusMissing =
    focusLane != null && board != null && !board.lanes.some((l) => l.id === focusLane);

  const connect = useCallback(
    async (slug: string, member?: { as: string; token: string }) => {
      setError(null);
      setTeam(slug);
      window.localStorage.setItem(TEAM_KEY, slug);
      if (member) {
        saveMemberIdentity(slug, member);
        setIsMember(true);
        setCfg({ team: slug, as: member.as, token: member.token });
        return;
      }
      setIsMember(false);
      setProvisioning(true);
      try {
        setCfg(await acquireObserver(slug));
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setProvisioning(false);
      }
    },
    [],
  );

  const submit = () => {
    const slug = team.trim();
    if (!slug) return;
    const memberIn =
      advanced.open && advanced.as.trim() && advanced.token.trim()
        ? { as: advanced.as.trim(), token: advanced.token.trim() }
        : undefined;
    void connect(slug, memberIn);
  };

  const signOut = () => {
    if (cfg) forgetMemberIdentity(cfg.team);
    setAdvanced({ open: false, as: '', token: '' });
    disconnect();
  };

  // Hydrate from the URL. Three shapes, in order of authority:
  //   `#s=<nonce>`  — `musterd board` walked us here (ADR 170): redeem the one-shot nonce for the
  //                   member identity it stands for. The fragment is stripped BEFORE the redeem
  //                   resolves, so a slow answer never leaves it sitting in the address bar.
  //   `?team=<slug>` — the plain board, signed in from a remembered credential when we have one.
  //   nothing        — restore the last team into the form field.
  //
  // `?lane=<id>` rides alongside any of the three (ADR 200 §3, the acceptance deep link): it names
  // the one lane the reader was sent to look at. It is read here and kept in the address bar — the
  // link is meant to be shareable and to survive a reload — and it survives the nonce strip above
  // because that rebuilds the URL as pathname + SEARCH, dropping only the fragment.
  // Client-only so none of it runs during prerender.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const urlTeam = new URLSearchParams(window.location.search).get('team');
    setFocusLane(new URLSearchParams(window.location.search).get('lane'));
    const goalParam = new URLSearchParams(window.location.search).get('goal');
    if (goalParam !== null) {
      setGoalFocus(goalParam === 'none' ? null : goalParam);
      setChosenView('columns');
    }
    const nonce = new URLSearchParams(window.location.hash.replace(/^#/, '')).get('s');
    if (urlTeam && nonce) {
      const clean = `${window.location.pathname}${window.location.search}`;
      // Strip through the ROUTER's history, not `window.history.replaceState`. The raw call cleans
      // the address bar but leaves the router's own location — captured at hydration, hash included —
      // stale; on the SUCCESS path the post-connect render settles the router, which re-syncs its
      // location and puts the spent nonce back in the bar (izzo's find, ADR 174 acceptance run,
      // lane 01KYN5G4Y5). Replacing via the router updates both copies, so there is nothing left to
      // resurrect. Still before the redeem is even sent, per the ADR's guarantee.
      router.history.replace(clean);
      setProvisioning(true);
      void redeemSignin(urlTeam, nonce)
        .then(({ as, credential }) => connect(urlTeam, { as, token: credential }))
        .catch((e: unknown) => {
          // An expired or already-opened link is ordinary, not exceptional: say so in the daemon's
          // own words and drop into the normal form rather than dead-ending on a blank board.
          setTeam(urlTeam);
          setError(e instanceof Error ? e.message : String(e));
        })
        .finally(() => setProvisioning(false));
      return;
    }
    if (urlTeam) {
      void connect(urlTeam, loadMemberIdentity(urlTeam) ?? undefined);
    } else {
      const last = window.localStorage.getItem(TEAM_KEY) ?? '';
      setTeam(last);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const connected = cfg != null;

  return (
    <main className="lc">
      <header className="lc__topbar">
        <MusterdWord />
        <span className="lc__team">/ {connected ? `${cfg.team} · board` : 'board'}</span>
        <span className="lc__spacer" />
        {connected && (
          <div className="lc-board__views" role="group" aria-label="Board view">
            <button
              className={`lc-board__view${view === 'grid' ? ' lc-board__view--on' : ''}`}
              aria-pressed={view === 'grid'}
              onClick={() => {
                closeGoal();
                pickView('grid');
              }}
            >
              goals
            </button>
            <button
              className={`lc-board__view${view === 'columns' ? ' lc-board__view--on' : ''}`}
              aria-pressed={view === 'columns'}
              onClick={() => pickView('columns')}
            >
              columns
            </button>
          </div>
        )}
        {me && (
          <>
            <span className="lc__identity" title="You're in the room.">
              <span
                className="lc-card__avatar"
                style={{
                  background: memberAvatar(me, kindOf(me, new Map(roster.map((m) => [m.name, m])))),
                }}
                aria-hidden="true"
              />
              {me}
            </span>
            <button className="lc__identity-out" onClick={signOut}>
              sign out
            </button>
            <button
              className="lc-board__new"
              onClick={() => setComposing(true)}
              disabled={composing}
            >
              + New lane
            </button>
          </>
        )}
      </header>

      {!connected ? (
        <div className="lc-form">
          <div className="lc-form__card">
            <h1 className="lc-form__title">Work board</h1>
            <p className="lc-form__sub">
              The team&apos;s lanes as a board — backlog, claimed, in progress, blocked, done. Watch as
              a hidden observer, no account — or sign in as yourself and the board is yours to work.
            </p>
            <label className="lc-form__field">
              <span>Team</span>
              {/* No autoFocus — same reasoning as /live's connect form: this is the first thing on
                  the page, and stealing focus on load skips the copy above that explains what
                  watching versus signing in actually does to your identity on the board. */}
              <input
                type="text"
                value={team}
                placeholder="ritual"
                onChange={(e) => setTeam(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && submit()}
              />
            </label>
            <MemberSignInFields
              advanced={advanced}
              onAdvanced={setAdvanced}
              seatLabel="Connect as (seat)"
            />
            {error && <p className="lc-form__error">{error}</p>}
            <button
              className="lc-form__connect"
              disabled={!team.trim() || provisioning}
              onClick={submit}
            >
              {provisioning && <span className="lc-spinner" aria-hidden="true" />}
              {provisioning ? 'Loading…' : advanced.open ? 'Sign in' : 'View board'}
            </button>
            <MemberSignInToggle
              advanced={advanced}
              onAdvanced={setAdvanced}
              openLabel="Sign in as yourself — the room will know you're here"
              closeLabel="Just watch instead"
            />
          </div>
        </div>
      ) : (
        <div className="lc__canvas lc__canvas--board">
          <div className="lc-board__main">
            <p
              className={`lc-board__note${note ? ` lc-board__note--${note.tone}` : ''}`}
              aria-live="polite"
            >
              {note?.text ?? ''}
            </p>
            {focusMissing && (
              <p className="lc-board__note lc-board__note--err" role="status">
                That lane isn&apos;t on this board — it may have been abandoned, or the link may be
                for another team. Here&apos;s everything else.
              </p>
            )}
            {board != null && (
              <FilterStrip
                roster={roster}
                lanes={board.lanes}
                selected={ownerFilter}
                onToggle={toggleOwner}
                onClear={() => setOwnerFilter(new Set())}
              />
            )}
            {board == null ? (
              <p className="lc-col__empty">Opening the board…</p>
            ) : (
              <>
                {view === 'columns' && goalFocus !== undefined && (
                  <button className="lc-board__view lc-board__goalback" onClick={() => {
                    closeGoal();
                    pickView('grid');
                  }}>
                    ← goals · showing {goalFocus === null ? 'lanes on no goal' : goalFocus}
                  </button>
                )}
                <Board
                lanes={view === 'columns' ? goalFilter(shownLanes, goalFocus) : shownLanes}
                warnings={board.warnings}
                view={view}
                onOpenGoal={openGoal}
                goals={report?.goals ?? []}
                roster={roster}
                me={me}
                busyId={busyId}
                composing={composing}
                onComposeClose={() => setComposing(false)}
                onCreate={doCreate}
                onPatch={doPatch}
                focusLane={focusLane}
                />
              </>
            )}
          </div>
          <InsightRail
            report={report}
            rosterIdx={new Map(roster.map((m) => [m.name, m]))}
            collapsed={railCollapsed}
            onCollapsed={collapseRail}
          />
        </div>
      )}
    </main>
  );
}

/**
 * The member filter chips (polish pass) — one chip per rostered teammate plus the ownerless backlog,
 * multi-select, a lens never a gate. Each chip carries the member's identity color (jade band agents,
 * rose band humans) and a live count of the lanes they're carrying; selecting glows the chip in that
 * same color, so a filtered board reads as "whose desk am I looking at."
 */
function FilterStrip({
  roster,
  lanes,
  selected,
  onToggle,
  onClear,
}: {
  roster: MemberSummary[];
  lanes: LaneBoard['lanes'];
  selected: ReadonlySet<string>;
  onToggle: (key: string) => void;
  onClear: () => void;
}) {
  const rosterIdx = new Map(roster.map((m) => [m.name, m]));
  const live = (owner: string | null) =>
    lanes.filter((l) => l.owner_seat === owner && l.state !== 'done' && l.state !== 'abandoned')
      .length;
  const unownedCount = live(null);
  return (
    <div className="lc-board__filters" role="group" aria-label="Filter lanes by owner">
      {roster.map((m) => {
        const on = selected.has(m.name);
        const color = memberColor(m.name, kindOf(m.name, rosterIdx));
        const n = live(m.name);
        return (
          <button
            key={m.name}
            className={`lc-filter${on ? ' lc-filter--on' : ''}`}
            aria-pressed={on}
            style={on ? { boxShadow: `0 0 0 1.5px ${color}` } : undefined}
            onClick={() => onToggle(m.name)}
          >
            <span className="lc-card__avatar" style={{ background: color }} aria-hidden="true" />
            {m.name}
            {n > 0 && <span className="lc-filter__n">{n}</span>}
          </button>
        );
      })}
      <button
        className={`lc-filter lc-filter--unowned${selected.has(UNOWNED) ? ' lc-filter--on' : ''}`}
        aria-pressed={selected.has(UNOWNED)}
        onClick={() => onToggle(UNOWNED)}
      >
        unowned
        {unownedCount > 0 && <span className="lc-filter__n">{unownedCount}</span>}
      </button>
      {selected.size > 0 && (
        <button className="lc-card__abandon" onClick={onClear}>
          everyone
        </button>
      )}
    </div>
  );
}
