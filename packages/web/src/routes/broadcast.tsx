import { createFileRoute } from '@tanstack/react-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import broadcastCss from '../live/Broadcast.css?url';
import liveCss from '../live/Live.css?url';
import brandCss from '../brand/brand.css?url';
import { OfficeScene } from '../live/OfficeScene';
import { acquireObserver, forgetObserver, type LiveConfig } from '../live/client';
import type { OfficeHandle } from '../live/office-scene';
import { useLiveStream } from '../live/useLiveStream';

export const Route = createFileRoute('/broadcast')({
  head: () => ({
    meta: [{ title: 'musterd — broadcast' }],
    links: [
      { rel: 'stylesheet', href: liveCss },
      { rel: 'stylesheet', href: brandCss },
      { rel: 'stylesheet', href: broadcastCss },
    ],
  }),
  component: BroadcastPage,
});

/** The capture stage, in CSS pixels. DPR is pinned to 1 in broadcast mode, so this is also the exact
 * pixel size of the canvas backing store — a 1920×1080 OBS browser source captures 1:1. */
const STAGE_W = 1920;
const STAGE_H = 1080;

/** Hooks a capturer (or a headless check) probes — see ADR 157 "Observability & Evaluation". */
interface BroadcastWindow {
  __office?: OfficeHandle | null;
  __broadcastReady?: boolean;
}

/**
 * **Broadcast mode** (ADR 157) — the office as a stream source.
 *
 * `/broadcast?team=<slug>` renders the animated office and nothing else: a fixed 1920×1080 stage, no
 * panels, no controls, no connect form, and a minimal overlay (team name + LIVE pill). OBS points a
 * Browser source straight at this URL, so there is no window capture and no compositor round-trip —
 * the failure mode that melted the laptop the first time round.
 *
 * Two properties this route holds by construction rather than by care:
 *
 * - **Presence-safe.** It only ever takes the observer path (`acquireObserver`). There is no
 *   advanced-seat branch here at all, so streaming can never attach a *human* presence row and put a
 *   phantom person on the roster (ADR 155).
 * - **Perf-contract-safe.** It is a separate lazy route, so the "loops stop when unseen" rule that
 *   every /live viewer relies on is untouched — the always-animate carve-out reaches only pages a
 *   human deliberately opened to stream from (packages/web/AGENTS.md, ADR 151).
 */
function BroadcastPage() {
  const [cfg, setCfg] = useState<LiveConfig | null>(null);
  const [team, setTeam] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [scale, setScale] = useState(1);

  // A stream has no operator to click "reconnect": if the observer credential goes stale (daemon reset,
  // 24h observer TTL — ADR 064), drop it and mint a fresh one. `recovering` is a one-at-a-time guard,
  // not a give-up counter — an unattended capture should keep trying rather than dead-end on screen.
  const recovering = useRef(false);
  const recoverObserver = useCallback(() => {
    const slug = cfg?.team;
    if (!slug || recovering.current) return;
    recovering.current = true;
    forgetObserver(slug);
    void (async () => {
      try {
        setCfg(await acquireObserver(slug));
        setError(null);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        recovering.current = false;
      }
    })();
  }, [cfg?.team]);

  const { envelopes, roster, status, liveIds } = useLiveStream(cfg, {
    onCredentialInvalid: recoverObserver,
  });

  // Connect from the URL only — no form, no localStorage team memory. A stream source is launched by a
  // URL (an OBS source, a headless capturer), so the URL is the whole configuration.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const slug = new URLSearchParams(window.location.search).get('team')?.trim();
    if (!slug) return;
    setTeam(slug);
    void (async () => {
      try {
        setCfg(await acquireObserver(slug));
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    })();
  }, []);

  // Fit the fixed stage into whatever window we were opened at. `transform: scale()` doesn't change
  // `clientWidth`, so the scene still lays out — and renders — at exactly 1920×1080 however small the
  // preview window is. At a 1920×1080 browser source this is a no-op scale of 1.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const fit = () =>
      setScale(Math.min(window.innerWidth / STAGE_W, window.innerHeight / STAGE_H, 1));
    fit();
    window.addEventListener('resize', fit);
    return () => window.removeEventListener('resize', fit);
  }, []);

  // Health hooks for a capturer: `__office` is the live scene handle, `__broadcastReady` flips true once
  // the firehose is actually connected — "the page loaded" and "the page is streaming a real team" are
  // different things, and only the second is safe to start encoding on.
  const onSceneReady = useCallback((handle: OfficeHandle | null) => {
    (window as unknown as BroadcastWindow).__office = handle;
  }, []);
  useEffect(() => {
    (window as unknown as BroadcastWindow).__broadcastReady = status === 'live';
  }, [status]);

  return (
    <main className="bc">
      <div className="bc__stage lc" style={{ transform: `scale(${scale})` }}>
        {team && (
          <OfficeScene
            teamName={team}
            roster={roster}
            envelopes={envelopes}
            liveIds={liveIds}
            broadcast
            onReady={onSceneReady}
          />
        )}
        <BroadcastOverlay team={team} live={status === 'live'} error={error} />
      </div>
    </main>
  );
}

/**
 * The minimal on-stream chrome: team name and a LIVE pill, bottom-left, never interactive. Deliberately
 * plain — a designed overlay (ticker, act captions, brand frame) is a follow-up lane, and shipping a
 * half-designed one now would only be something to undo.
 */
function BroadcastOverlay({
  team,
  live,
  error,
}: {
  team: string | null;
  live: boolean;
  error: string | null;
}) {
  return (
    <div className="bc__overlay" aria-hidden="true">
      <span className={`bc__pill${live ? ' bc__pill--live' : ''}`}>
        <i className="bc__dot" />
        {live ? 'LIVE' : 'CONNECTING'}
      </span>
      <span className="bc__team">{team ?? 'no team — add ?team=<slug>'}</span>
      {error && <span className="bc__error">{error}</span>}
    </div>
  );
}
