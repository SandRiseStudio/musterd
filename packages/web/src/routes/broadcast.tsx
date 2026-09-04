import { createFileRoute } from '@tanstack/react-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import broadcastCss from '../live/Broadcast.css?url';
import liveCss from '../live/Live.css?url';
import brandCss from '../brand/brand.css?url';
import { AsksReel } from '../live/AsksReel';
import { OfficeScene } from '../live/OfficeScene';
import { acquireObserver, forgetObserver, type LiveConfig } from '../live/client';
import { firehoseSound, roomTone } from '../live/sound';
import type { OfficeHandle } from '../live/office-scene';
import { useLiveStream } from '../live/useLiveStream';
import { justShipped } from '../live/buildSync';
import { officeRoom } from '../live/officeRoom';
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

/** What the server renders, and therefore what the client's FIRST render must be. See `stageSize`. */
export const DEFAULT_STAGE = { w: 1920, h: 1080 } as const;

/**
 * The stage for a `?h=` query — pure, and deliberately NOT read during render.
 *
 * This route is server-rendered and the server has no URL query to read, so a stage derived from the
 * URL at first render disagrees with the markup the server already wrote. React does not patch
 * mismatched attributes when it hydrates — it adopts the server's DOM — and nothing re-renders this
 * element afterwards, so the wrong size would stick for the life of the page while the component's own
 * state said otherwise. The office sizes its canvas off the host element, not off React state, so the
 * cost of that is a 1080p room painted into a 720p frame: clipped, and silent.
 *
 * Hence: render `DEFAULT_STAGE`, then apply this in a mount effect, which is an ordinary re-render and
 * gets patched.
 */
export function stageSize(search: string): { w: number; h: number } {
  const raw = new URLSearchParams(search).get('h');
  const h = STAGE_HEIGHTS.find((s) => s === Number(raw));
  return h ? { w: (h * 16) / 9, h } : { ...DEFAULT_STAGE };
}

/** Encode fps from `?fps=` — the office coalesces draws to this rate. Defaults to 30 (ADR 157). */
function captureFpsFromUrl(): number {
  const raw =
    typeof window === 'undefined' ? null : new URLSearchParams(window.location.search).get('fps');
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 && n <= 60 ? n : 30;
}

/**
 * Where a viewer of the stream can find the team — a fact asserted on a public surface, so it is
 * written per team rather than derived (`<slug>@musterd.io` would claim a mailbox for every team
 * that ever streams). The address appears only where one exists; a team without a mailbox shows
 * nothing here, and the mark below the corner carries musterd.io for everyone.
 */
/**
 * The corner block: what this stream is, where to find us, and — only when it is true — that a
 * build just landed.
 *
 * The first cut said all of it, always: one 900px-wide pill reading "live from the workshop — the
 * feed may blink while we ship", parked over the floor for the whole broadcast (nick, 2026-09-03:
 * "the banner about the stream refreshing looks horrible"). Two faults, and the visual one is
 * downstream of the other. A pill that wide is not a pill, it is a bar with rounded ends, and it is
 * that wide because it is carrying a *sentence*. The sentence is there because the corner was
 * explaining, at all times, an event that happens occasionally — a permanent apology for an
 * intermittent blink. Nothing about the styling could fix a persistent notice about a rare thing.
 *
 * So the notice moves to where it is true. `justShipped()` reads the exact fact: this pageview is
 * the result of build-sync landing a new bundle, seconds ago. At rest the corner is a mark, not a
 * message — a live dot and three words. When a build lands, the mark says so for a beat, and then
 * it is a mark again. That is the same information, delivered at the moment a viewer is actually
 * asking the question ("did it just break?"), and it costs the floor nothing the rest of the time.
 *
 * The long form stays on the chip's title for anyone reading the DOM, and as the copy of record.
 *
 * The address is a fact asserted on a public surface, so it is named per team rather than derived
 * (`<slug>@musterd.io` would claim a mailbox for every team that ever streams). Pure, so the render
 * test can hold all of it.
 *
 * The corner used to say `musterd.io` here too, beside the team address — the product's name twice
 * in one 44%-wide column, once as a domain and once again as the wordmark two rows down (nick,
 * 2026-09-04). The domain moved INTO the mark, where it costs no extra row and where a viewer with
 * no address bar was already looking; this line is now only ever the one thing it was for.
 */
export const WORKSHOP_NOTICE = {
  /** At rest: what this is. Three words, because the corner is a mark and not a caption. "Workshop"
   * is a third noun for one referent (room / workshop / stream) and is in no glossary — kept on
   * sloane's own recommendation, because it violates no Not entry and carries the show's premise in
   * three words. The airtight alternatives, if it ever needs to be: "live from the team"
   * (canonical, duller) or "musterd, building musterd" (self-explaining). */
  chip: 'live from the workshop',
  /** The beat after a build lands — past tense, and it names the blink the viewer just saw. */
  shipped: 'just shipped — that was the blink',
  /**
   * The copy of record — the one string here a stranger might quote, so it says Team the way the
   * brand says Team. The first cut said "the people in this room", and "room" is in brand.md §5's
   * Not column for Team: enforced vocabulary (ADR 296), not a preference. Two sentences rather than
   * one long one, per §4 — the premise, then the consequence. sloane's spec, verbatim.
   */
  full: 'This team is building musterd while you watch. Every deploy can restart the stream for a moment, and it comes back on its own.',
};

/** How long the "just shipped" beat holds before easing back to the resting mark. Long enough to
 * read twice at a glance across a room, short enough that it is a moment and not a second banner. */
export const SHIPPED_MS = 9000;

export function broadcastCorner(team: string | null, shipped = false) {
  return (
    <>
      <span
        className={`bc__notice${shipped ? ' bc__notice--shipped' : ''}`}
        title={WORKSHOP_NOTICE.full}
      >
        <span className="bc__pulse" aria-hidden="true" />
        <span className="bc__notice-text">
          {shipped ? WORKSHOP_NOTICE.shipped : WORKSHOP_NOTICE.chip}
        </span>
      </span>
      {team === 'revive' && <span className="bc__contact">revive@musterd.io</span>}
    </>
  );
}

/**
 * The corner's one piece of state: whether a build landed into this pageview. The fact is about how
 * the page got here, so it cannot become true later — `justShipped()` is decided once for the whole
 * pageview and the marker behind it is already spent, which is why a plain reload of this tab later
 * shows the resting mark. All this hook adds is the beat's length. Never true in dev or under test —
 * there is no baked build id there, and no publisher.
 */
export function useJustShipped(): boolean {
  const [shipped, setShipped] = useState(false);
  useEffect(() => {
    if (!justShipped()) return;
    setShipped(true);
    const timer = setTimeout(() => setShipped(false), SHIPPED_MS);
    return () => clearTimeout(timer);
  }, []);
  return shipped;
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
  // Whether a build landed into this pageview — the corner's "just shipped" beat (see above).
  const shipped = useJustShipped();
  // Read once per page load — a stream source's URL is its whole configuration, and it never
  // changes under a running capture.
  const [stage, setStage] = useState<{ w: number; h: number }>(DEFAULT_STAGE);
  // The URL's stage rung, applied after hydration so React patches the element rather than inheriting
  // the server's. Runs once: a capture never changes rung mid-stream.
  useEffect(() => {
    setStage(stageSize(window.location.search));
  }, []);
  const [captureFps] = useState(captureFpsFromUrl);

  // Sound on, unless the URL says otherwise. Both engines default OFF and normally need a click;
  // a capture box never gets one, which is what `--autoplay-policy=no-user-gesture-required` and
  // `enableForBroadcast` between them solve (ADR 228). Neither call persists — a stream must not
  // rewrite the preferences a human set on this machine.
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get('audio') === '0') return;
    firehoseSound.enableForBroadcast();
    roomTone.enableForBroadcast();
  }, []);

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

  const stream = useLiveStream(cfg, {
    onCredentialInvalid: recoverObserver,
  });
  const { envelopes, roster, status } = stream;

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
            {...officeRoom(team, stream, { entries, board })}
            broadcast
            captureFps={captureFps}
            workCues="stack"
            topSlot={<AsksReel envelopes={envelopes} roster={roster} board={board} />}
            cornerSlot={broadcastCorner(team, shipped)}
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
