import type { Lane, LaneWarning } from '@musterd/protocol';
import { createFileRoute } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { Board } from '../live/Board';
import {
  acquireObserver,
  fetchLaneBoard,
  forgetObserver,
  isStaleCredential,
  type LiveConfig,
} from '../live/client';
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

/**
 * The work board (ADR 104 increment 1): a read-only kanban of the team's lanes. Auto-provisions the same
 * hidden observer seat `/live` uses (member-authed, no account) and reads `GET /lanes` — a plain
 * fetch-and-refresh view; live-tail is a later increment.
 */
function BoardPage() {
  const [team, setTeam] = useState('');
  const [cfg, setCfg] = useState<LiveConfig | null>(null);
  const [lanes, setLanes] = useState<Lane[]>([]);
  const [warnings, setWarnings] = useState<LaneWarning[]>([]);
  const [status, setStatus] = useState<'idle' | 'loading' | 'loaded' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);

  const load = async (c: LiveConfig): Promise<void> => {
    const board = await fetchLaneBoard(c);
    setLanes(board.lanes);
    setWarnings(board.warnings);
    setCfg(c);
    setStatus('loaded');
  };

  const connect = async (explicit?: string) => {
    const slug = (explicit ?? team).trim();
    if (!slug) return;
    setTeam(slug);
    window.localStorage.setItem(TEAM_KEY, slug);
    setStatus('loading');
    setError(null);
    try {
      let c = await acquireObserver(slug);
      try {
        await load(c);
      } catch (e) {
        // Cached observer wiped (daemon reset / TTL expiry) — drop it and provision a fresh one once.
        if (!isStaleCredential(e)) throw e;
        forgetObserver(slug);
        c = await acquireObserver(slug);
        await load(c);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStatus('error');
    }
  };

  const refresh = async () => {
    if (!cfg) return;
    setStatus('loading');
    try {
      await load(cfg);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStatus('error');
    }
  };

  // Hydrate from the URL (`/board?team=<slug>`), else restore the last team into the form field. A
  // client-only effect (not a useState initializer) so it never runs during SSR/prerender and reliably
  // fires on hydration — mirrors `/live`.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const urlTeam = new URLSearchParams(window.location.search).get('team');
    if (urlTeam) void connect(urlTeam);
    else setTeam(window.localStorage.getItem(TEAM_KEY) ?? '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const connected = cfg != null && status !== 'error';

  return (
    <main className="lc">
      <header className="lc__topbar">
        <MusterdWord />
        <span className="lc__team">/ {connected ? `${cfg!.team} · board` : 'board'}</span>
        <span className="lc__spacer" />
        {connected && (
          <button
            className="lc-audit__refresh"
            onClick={() => void refresh()}
            disabled={status === 'loading'}
          >
            Refresh
          </button>
        )}
      </header>

      {!connected ? (
        <div className="lc-form">
          <div className="lc-form__card">
            <h1 className="lc-form__title">Work board</h1>
            <p className="lc-form__sub">
              The team&apos;s lanes as a board — backlog, claimed, in progress, blocked, done. A
              read-only view over what the daemon derives (ADR 104); connects as a hidden observer, no
              account.
            </p>
            <label className="lc-form__field">
              <span>Team</span>
              <input
                type="text"
                value={team}
                placeholder="ritual"
                onChange={(e) => setTeam(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && void connect()}
              />
            </label>
            {error && <p className="lc-form__error">{error}</p>}
            <button
              className="lc-form__connect"
              disabled={!team.trim() || status === 'loading'}
              onClick={() => void connect()}
            >
              {status === 'loading' && <span className="lc-spinner" aria-hidden="true" />}
              {status === 'loading' ? 'Loading…' : 'View board'}
            </button>
          </div>
        </div>
      ) : (
        <div className="lc__canvas lc__canvas--board">
          <Board lanes={lanes} warnings={warnings} />
        </div>
      )}
    </main>
  );
}
