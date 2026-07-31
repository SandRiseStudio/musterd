import type { LaneBoard, MemberSummary } from '@musterd/protocol';
import { createFileRoute, useRouter } from '@tanstack/react-router';
import { useCallback, useEffect, useState } from 'react';
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
import { filterLanes, UNOWNED } from '../live/boardWrite';
import { useBoardData } from '../live/useBoardData';
import { initial, kindOf, memberColor } from '../live/format';
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
/** Signed-in member credential per team, so a human doesn't re-paste `mscr_` every visit (item 5). */
const MEMBER_KEY = (team: string) => `musterd.board.member.v1.${team}`;

function loadMember(team: string): { as: string; token: string } | null {
  try {
    const raw = window.localStorage.getItem(MEMBER_KEY(team));
    if (!raw) return null;
    const v = JSON.parse(raw) as { as?: unknown; token?: unknown };
    return typeof v.as === 'string' && typeof v.token === 'string'
      ? { as: v.as, token: v.token }
      : null;
  } catch {
    return null;
  }
}

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
        window.localStorage.removeItem(MEMBER_KEY(current.team));
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
  const [view, setView] = useState<'columns' | 'goals'>('columns');
  const [railCollapsed, setRailCollapsed] = useState(false);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (window.localStorage.getItem(VIEW_KEY) === 'goals') setView('goals');
    if (window.localStorage.getItem(RAIL_KEY) === 'collapsed') setRailCollapsed(true);
  }, []);
  const pickView = (v: 'columns' | 'goals') => {
    setView(v);
    window.localStorage.setItem(VIEW_KEY, v);
  };
  const collapseRail = (c: boolean) => {
    setRailCollapsed(c);
    window.localStorage.setItem(RAIL_KEY, c ? 'collapsed' : 'open');
  };

  // The member filter — a lens over the same lanes, session-scoped, empty = everyone.
  const [ownerFilter, setOwnerFilter] = useState<ReadonlySet<string>>(new Set());
  const toggleOwner = (key: string) =>
    setOwnerFilter((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  const shownLanes = board ? filterLanes(board.lanes, ownerFilter) : [];

  const connect = useCallback(
    async (slug: string, member?: { as: string; token: string }) => {
      setError(null);
      setTeam(slug);
      window.localStorage.setItem(TEAM_KEY, slug);
      if (member) {
        window.localStorage.setItem(MEMBER_KEY(slug), JSON.stringify(member));
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
    if (cfg) window.localStorage.removeItem(MEMBER_KEY(cfg.team));
    setAdvanced({ open: false, as: '', token: '' });
    disconnect();
  };

  // Hydrate from the URL. Three shapes, in order of authority:
  //   `#s=<nonce>`  — `musterd board` walked us here (ADR 170): redeem the one-shot nonce for the
  //                   member identity it stands for. The fragment is stripped BEFORE the redeem
  //                   resolves, so a slow answer never leaves it sitting in the address bar.
  //   `?team=<slug>` — the plain board, signed in from a remembered credential when we have one.
  //   nothing        — restore the last team into the form field.
  // Client-only so none of it runs during prerender.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const urlTeam = new URLSearchParams(window.location.search).get('team');
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
      void connect(urlTeam, loadMember(urlTeam) ?? undefined);
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
              className={`lc-board__view${view === 'columns' ? ' lc-board__view--on' : ''}`}
              aria-pressed={view === 'columns'}
              onClick={() => pickView('columns')}
            >
              columns
            </button>
            <button
              className={`lc-board__view${view === 'goals' ? ' lc-board__view--on' : ''}`}
              aria-pressed={view === 'goals'}
              onClick={() => pickView('goals')}
            >
              goals
            </button>
          </div>
        )}
        {me && (
          <>
            <span className="lc__identity" title="You're in the room.">
              <span
                className="lc-card__avatar"
                style={{
                  background: memberColor(me, kindOf(me, new Map(roster.map((m) => [m.name, m])))),
                }}
                aria-hidden="true"
              >
                {initial(me)}
              </span>
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
              <Board
                lanes={shownLanes}
                warnings={board.warnings}
                view={view}
                goals={report?.goals ?? []}
                roster={roster}
                me={me}
                busyId={busyId}
                composing={composing}
                onComposeClose={() => setComposing(false)}
                onCreate={doCreate}
                onPatch={doPatch}
              />
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
            <span className="lc-card__avatar" style={{ background: color }} aria-hidden="true">
              {initial(m.name)}
            </span>
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
