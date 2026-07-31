import { createFileRoute } from '@tanstack/react-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import broadcastCss from '../live/Broadcast.css?url';
import liveCss from '../live/Live.css?url';
import brandCss from '../brand/brand.css?url';
import { OfficeScene } from '../live/OfficeScene';
import { acquireObserver, forgetObserver, type LiveConfig } from '../live/client';
import type { OfficeHandle } from '../live/office-scene';
import { useLiveStream } from '../live/useLiveStream';
import { useWorkingOn } from '../live/useWorkingOn';
import { roomEntries } from '../live/workingOn';

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
 * pixel size of the canvas backing store — a browser source at the stage size captures 1:1.
 *
 * `?h=720` shrinks the stage itself (16:9, so 1280×720) rather than CSS-scaling a 1080p render:
 * a transform leaves the backing store at 1920×1080 and the room paying full raster cost, which is
 * exactly the serial-thread cost the 720p arm exists to remove (hosting spec, run D). Two rungs
 * only — this is a capture contract, not a slider. */
const STAGE_HEIGHTS = [720, 1080] as const;
function stageSize(): { w: number; h: number } {
  const raw =
    typeof window === 'undefined' ? null : new URLSearchParams(window.location.search).get('h');
  const h = STAGE_HEIGHTS.find((s) => s === Number(raw)) ?? 1080;
  return { w: (h * 16) / 9, h };
}

/** Encode fps from `?fps=` — the office coalesces draws to this rate. Defaults to 30 (ADR 157). */
function captureFpsFromUrl(): number {
  const raw =
    typeof window === 'undefined' ? null : new URLSearchParams(window.location.search).get('fps');
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 && n <= 60 ? n : 30;
}

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
  // Read once per page load — a stream source's URL is its whole configuration, and it never
  // changes under a running capture.
  const [stage] = useState(stageSize);
  const [captureFps] = useState(captureFpsFromUrl);

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

  // The overlay's reel: everyone in the room and what they are on. Uncapped — the stream's chyron
  // cycles one at a time, so the roster costs dwell time rather than stage area.
  const board = useWorkingOn(cfg, envelopes);
  const entries = roomEntries(roster, board);

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
  // `clientWidth`, so the scene still lays out — and renders — at exactly the stage size however
  // small the preview window is. At a matching browser source this is a no-op scale of 1.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const fit = () =>
      setScale(Math.min(window.innerWidth / stage.w, window.innerHeight / stage.h, 1));
    fit();
    window.addEventListener('resize', fit);
    return () => window.removeEventListener('resize', fit);
  }, [stage]);

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
      <div
        className="bc__stage lc"
        style={{ width: stage.w, height: stage.h, transform: `scale(${scale})` }}
      >
        {team && (
          <OfficeScene
            teamName={team}
            roster={roster}
            envelopes={envelopes}
            liveIds={liveIds}
            entries={entries}
            board={board}
            status={status}
            broadcast
            captureFps={captureFps}
            workCues="stack"
            onReady={onSceneReady}
          />
        )}
        {/* Operator diagnostics, not stream chrome: the two states where there is no office to look
            at. A misconfigured OBS source must say so rather than show an empty black stage. */}
        {(!team || error) && (
          <p className="bc__note">{team ? error : 'no team — add ?team=<slug> to the URL'}</p>
        )}
      </div>
    </main>
  );
}
