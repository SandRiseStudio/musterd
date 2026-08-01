import type { LaneBoard, MemberSummary } from '@musterd/protocol';
import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ESCAPE_SCOPES, shouldDismiss, zoomTransform } from './boardOverlayMath';
import type { LiveConfig } from './client';
import { useBoardData } from './useBoardData';

/**
 * The work board, lazy — kept out of /live's eager graph (ADR 151: heavy, occasional code gets a
 * lazy chunk, never the entry). `preloadBoard` is fired from the wall hotspot's first hover/focus,
 * so by the time anyone clicks, the chunk is usually already here.
 */
const LazyBoard = lazy(() => import('./Board').then((m) => ({ default: m.Board })));
export function preloadBoard(): void {
  void import('./Board');
}

/** How long the close transition holds the DOM before unmounting (matches the CSS duration). */
const CLOSE_MS = 260;

/**
 * The office's work board, opened from the wall — the app's first true modal. Clicking the agile
 * board on the wall hands us its viewport rect, and the panel *grows out of that rect* into the
 * room (`zoomTransform`), then shrinks back into the wall on close: the object you reached for is
 * the thing in your hands. Reduced motion swaps the zoom for a plain fade.
 *
 * Data-wise this is the same board as `/board`: the same `useBoardData` half (optimistic echo fold,
 * write gate, status line) over the same `base` the route already fetched for the reel — nothing is
 * fetched twice, and a write made here shows up everywhere the lane board does. Goals view is
 * deliberately absent (nick, 2026-07-31: reevaluating goals) — columns only.
 */
export function BoardOverlay({
  cfg,
  roster,
  base,
  origin,
  focusLane = null,
  onClose,
}: {
  cfg: LiveConfig | null;
  roster: MemberSummary[];
  base: LaneBoard | null;
  /** The wall hotspot's viewport rect — the zoom's origin and its destination on close. Null when
   * the board was opened by a deep link rather than a click: there is no object to grow out of. */
  origin: DOMRect | null;
  /** A lane to arrive focused on (`/live?lane=<id>`) — Board pins, rings and scrolls to it. */
  focusLane?: string | null;
  onClose: () => void;
}) {
  const { board, me, busyId, note, doCreate, doPatch } = useBoardData(cfg, roster, base);
  const [composing, setComposing] = useState(false);
  const [closing, setClosing] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const closeTimer = useRef<number | null>(null);

  const reduced =
    typeof window !== 'undefined' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // Mount folded onto the wall (transform to the origin rect, opacity 0), then flip to identity on
  // the next frame — the panel grows out of the board. Reduced motion mounts in place and fades.
  useLayoutEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;
    if (origin && !reduced) {
      panel.style.transform = zoomTransform(origin, panel.getBoundingClientRect());
    }
    const raf = requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        panel.style.transform = '';
        rootRef.current?.classList.add('is-in');
        panel.focus({ preventScroll: true });
      }),
    );
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-only: origin is fixed per open
  }, []);

  /** Reverse the zoom, then unmount. Focus restore is the route's job — it owns the `inert` page
   * and captured the opener before inert blurred it (an inert subtree can't hold focus, so reading
   * `document.activeElement` here would only ever see <body>). */
  const close = useCallback(() => {
    if (closing) return;
    setClosing(true);
    const panel = panelRef.current;
    rootRef.current?.classList.remove('is-in');
    if (panel && origin && !reduced) {
      panel.style.transform = zoomTransform(origin, panel.getBoundingClientRect());
    }
    closeTimer.current = window.setTimeout(onClose, CLOSE_MS);
  }, [closing, origin, reduced, onClose]);

  useEffect(
    () => () => {
      if (closeTimer.current != null) window.clearTimeout(closeTimer.current);
    },
    [],
  );

  // Escape closes — unless it was born inside chrome that owns its own Escape (compose / picker),
  // which closes itself on the same keypress. Document-level so it works wherever focus wandered.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const scoped = e.target instanceof Element && e.target.closest(ESCAPE_SCOPES) != null;
      if (shouldDismiss(e, scoped)) close();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [close]);

  return (
    // eslint-disable-next-line jsx-a11y/no-static-element-interactions -- backdrop dismissal; Escape is the keyboard path (document listener above)
    <div
      ref={rootRef}
      className="lc-boardoverlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close(); // the scrim itself, never a child
      }}
    >
      <div
        ref={panelRef}
        className="lc-boardoverlay__panel"
        role="dialog"
        aria-modal="true"
        aria-label={`Work board — ${cfg?.team ?? 'team'}`}
        tabIndex={-1}
      >
        <header className="lc-boardoverlay__bar">
          <span className="lc-boardoverlay__title">
            work board <span className="lc-boardoverlay__team">· {cfg?.team ?? ''}</span>
          </span>
          <span
            className={`lc-board__note${note ? ` lc-board__note--${note.tone}` : ''} lc-boardoverlay__note`}
            aria-live="polite"
          >
            {note?.text ?? ''}
          </span>
          {me && (
            <button className="lc-board__new" onClick={() => setComposing(true)} disabled={composing}>
              + New lane
            </button>
          )}
          <button className="lc-boardoverlay__close" onClick={close} aria-label="Close the board">
            ×
          </button>
        </header>
        <div className="lc-board__main lc-boardoverlay__main">
          {board == null ? (
            <p className="lc-col__empty">Opening the board…</p>
          ) : (
            <Suspense fallback={<div className="lc-boardoverlay__loading" aria-hidden="true" />}>
              <LazyBoard
                lanes={board.lanes}
                warnings={board.warnings}
                view="columns"
                goals={[]}
                roster={roster}
                me={me}
                busyId={busyId}
                composing={composing}
                onComposeClose={() => setComposing(false)}
                onCreate={doCreate}
                onPatch={doPatch}
                focusLane={focusLane}
              />
            </Suspense>
          )}
        </div>
      </div>
    </div>
  );
}
