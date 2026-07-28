import type { LaneBoard, OpenLane, UpdateLane } from '@musterd/protocol';
import { createFileRoute } from '@tanstack/react-router';
import { useCallback, useEffect, useState } from 'react';
import { Board } from '../live/Board';
import {
  MemberSignInFields,
  MemberSignInToggle,
  type AdvancedState,
} from '../live/MemberSignIn';
import {
  acquireObserver,
  createLane,
  forgetObserver,
  updateLane,
  type LiveConfig,
} from '../live/client';
import { applyLaneEcho } from '../live/boardWrite';
import { initial, kindOf, memberColor } from '../live/format';
import { useLiveStream } from '../live/useLiveStream';
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
  const [team, setTeam] = useState('');
  const [advanced, setAdvanced] = useState<AdvancedState>({ open: false, as: '', token: '' });
  const [cfg, setCfg] = useState<LiveConfig | null>(null);
  const [isMember, setIsMember] = useState(false);
  const [provisioning, setProvisioning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The one polite status line for write outcomes ("lane opened", "handed to izzo", errors).
  const [note, setNote] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [composing, setComposing] = useState(false);

  const disconnect = useCallback((message?: string) => {
    setCfg(null);
    setIsMember(false);
    setComposing(false);
    setNote(null);
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isMember, disconnect]);

  const { envelopes, roster } = useLiveStream(cfg, { onCredentialInvalid });
  const base = useWorkingOn(cfg, envelopes);

  // Optimistic overlay: our own writes fold in from the daemon's echo (the firehose skips the sender,
  // so the echo is the only copy we see). Any fresh base fetch is daemon truth and supersedes it.
  const [optimistic, setOptimistic] = useState<LaneBoard | null>(null);
  useEffect(() => setOptimistic(null), [base]);
  const board = optimistic ?? base;

  // The write gate, verbatim from AsksStrip (ADR 149): the auto-provisioned observer is hidden from
  // the roster, so membership is exactly "connected as a real seat".
  const me = cfg != null && roster.some((m) => m.name === cfg.as) ? cfg.as : null;

  const connect = useCallback(
    async (slug: string, member?: { as: string; token: string }) => {
      setError(null);
      setNote(null);
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

  // Hydrate from the URL (`/board?team=<slug>`) — with a remembered member credential when one exists
  // — else restore the last team into the form field. Client-only so it never runs during prerender.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const urlTeam = new URLSearchParams(window.location.search).get('team');
    if (urlTeam) {
      void connect(urlTeam, loadMember(urlTeam) ?? undefined);
    } else {
      const last = window.localStorage.getItem(TEAM_KEY) ?? '';
      setTeam(last);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const doCreate = useCallback(
    async (input: OpenLane): Promise<boolean> => {
      if (!cfg) return false;
      setBusyId('compose');
      setNote(null);
      try {
        const result = await createLane(cfg, input);
        setOptimistic((prev) => applyLaneEcho(prev ?? base ?? { lanes: [], warnings: [] }, result));
        setNote({ tone: 'ok', text: `lane opened — "${result.lane.title}"` });
        return true;
      } catch (e) {
        setNote({ tone: 'err', text: e instanceof Error ? e.message : String(e) });
        return false;
      } finally {
        setBusyId(null);
      }
    },
    [cfg, base],
  );

  const doPatch = useCallback(
    async (id: string, patch: UpdateLane): Promise<boolean> => {
      if (!cfg) return false;
      setBusyId(id);
      setNote(null);
      try {
        const result = await updateLane(cfg, id, patch);
        setOptimistic((prev) => applyLaneEcho(prev ?? base ?? { lanes: [], warnings: [] }, result));
        setNote({ tone: 'ok', text: noteFor(patch, result.lane.title, cfg.as) });
        return true;
      } catch (e) {
        setNote({ tone: 'err', text: e instanceof Error ? e.message : String(e) });
        return false;
      } finally {
        setBusyId(null);
      }
    },
    [cfg, base],
  );

  const connected = cfg != null;

  return (
    <main className="lc">
      <header className="lc__topbar">
        <MusterdWord />
        <span className="lc__team">/ {connected ? `${cfg.team} · board` : 'board'}</span>
        <span className="lc__spacer" />
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
              <input
                type="text"
                value={team}
                placeholder="ritual"
                autoFocus
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
          <p className={`lc-board__note${note ? ` lc-board__note--${note.tone}` : ''}`} aria-live="polite">
            {note?.text ?? ''}
          </p>
          {board == null ? (
            <p className="lc-col__empty">Opening the board…</p>
          ) : (
            <Board
              lanes={board.lanes}
              warnings={board.warnings}
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
      )}
    </main>
  );
}

/** The status line's phrasing per verb — same vocabulary as the pills, in the room's voice. */
function noteFor(patch: UpdateLane, title: string, meName: string): string {
  if (patch.owner_seat === meName) return `claimed — "${title}"`;
  if (patch.owner_seat) return `handed to ${patch.owner_seat} — they'll see it`;
  switch (patch.state) {
    case 'active':
      return `in flight — "${title}"`;
    case 'blocked':
      return `marked stuck — "${title}"`;
    case 'done':
      return `done — "${title}" shipped`;
    case 'abandoned':
      return 'let it go.';
    default:
      return 'updated';
  }
}
