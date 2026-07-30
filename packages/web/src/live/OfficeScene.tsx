import type { Envelope, MemberSummary } from '@musterd/protocol';
import { useEffect, useMemo, useRef, type ReactNode } from 'react';
import { MusterdWord } from '../brand/MusterdWord';
import { actLabel, actTone, memberColor, memberPosture } from './format';
import type { OfficeData, OfficeHandle } from './office-scene';
import { actToEvent } from './office-scene/mapping';
import { CollapseButton, PanelRail } from './PanelChrome';
import type { ConnStatus } from './client';
import { OfficeOverlay } from './OfficeOverlay';
import { WorkStack } from './WorkStack';
import { presentCount, type RoomEntry } from './workingOn';

/**
 * Roster → the office's node data. `posture` is resolved here with `memberPosture` — the *same* call the
 * roster rail's chip makes — so the floor and the rail read one value: a member the rail calls `idle` is
 * on the couch with an amber dot, never at a desk with a green one.
 *
 * Surface/model/work fields feed the floating nameplates (presence-chrome design, 2026-07-30).
 */
function computeData(teamName: string, roster: MemberSummary[], entries: RoomEntry[]): OfficeData {
  const byName = new Map(entries.map((e) => [e.name, e]));
  return {
    teamName,
    nodes: roster.map((m) => {
      const kind = m.kind === 'human' ? 'human' : 'agent';
      const live =
        m.presences?.find((p) => p.status === 'online' || p.status === 'away') ?? m.presences?.[0];
      const entry = byName.get(m.name);
      return {
        name: m.name,
        kind,
        presence: m.presence,
        activity: m.activity ?? (m.presence === 'offline' ? 'offline' : 'idle'),
        posture: memberPosture(m),
        state: m.state ?? null,
        color: memberColor(m.name, kind),
        role: m.role,
        surface: live?.surface ?? null,
        model: live?.model ?? null,
        workTitle: entry?.title ?? null,
        workSource: entry?.source ?? null,
        laneState: entry?.laneState ?? null,
        moreLanes: entry?.moreLanes ?? 0,
      };
    }),
  };
}

/**
 * The live isometric office: every teammate sits at a desk (presence decides who's in the room and
 * whether they're working / idle / away), and each act plays as a cue over the floor. The scene is
 * dynamically imported (kept out of SSR); prefers-reduced-motion draws a static frame. Name labels are
 * HTML overlay.
 */
export function OfficeScene({
  teamName,
  roster,
  envelopes,
  liveIds,
  collapsed = false,
  onCollapse,
  onActClick,
  broadcast = false,
  entries = [],
  status = 'idle',
  onReady,
  topSlot,
  bandSlot,
  /** Hybrid nameplate work cues vs in-panel WorkStack (`stack`) vs neither. Default none on the
   *  plate — work lives in WorkStack on `/live` (nick, 2026-07-30). */
  workCues = 'none',
}: {
  teamName: string;
  roster: MemberSummary[];
  envelopes: Envelope[];
  liveIds: Set<string>;
  collapsed?: boolean;
  onCollapse?: () => void;
  /** Speech-bubble click-through: called with the act's envelope id (the route scrolls the stream). */
  onActClick?: (id: string) => void;
  /** Broadcast mode (ADR 157) — only `/broadcast` sets it: the scene is a stream source, so it keeps
   * animating unseen, pins DPR to 1, and ignores reduced-motion (the viewer of a stream is not the
   * person whose OS preference this is). */
  broadcast?: boolean;
  /** The overlay's reel — everyone in the room and what they are on, already derived by the route
   * (see `roomEntries`). */
  entries?: RoomEntry[];
  /** Connection state, for the overlay's honest LIVE/CONNECTING signal. */
  status?: ConnStatus;
  /** Handed the scene handle once it mounts (and `null` on teardown) — the broadcast route publishes it
   * as `window.__office` so a capturer can probe the scene. */
  onReady?: (handle: OfficeHandle | null) => void;
  /** Interactive chrome floated over the TOP of the room — `/live` seats the asks & approvals rail
   * here (nick's call: the office frames its own asks; the page above the panels stays quiet).
   * `/broadcast` passes nothing: a stream cannot answer an ask. */
  topSlot?: ReactNode;
  /**
   * Chrome seated in a strip BENEATH the room rather than floated over it — `/live` puts WorkStack
   * here when `workCues === 'stack'`. The band is sized to its content and the room keeps every
   * remaining pixel. `/broadcast` passes nothing and stays full-bleed.
   */
  bandSlot?: ReactNode;
  workCues?: 'hybrid' | 'stack' | 'none';
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const labelRef = useRef<HTMLDivElement>(null);
  const handleRef = useRef<OfficeHandle | null>(null);
  const emittedRef = useRef<Set<string>>(new Set());

  const data = useMemo(() => computeData(teamName, roster, entries), [teamName, roster, entries]);
  // Latest-value refs for the mount effect below, which subscribes ONCE and must not re-run when a
  // prop identity changes (re-running it would tear down and rebuild the whole canvas scene).
  //
  // Written in an effect rather than during render: a render must be pure, and React may render a
  // component and throw the result away. This effect is declared BEFORE the mount effect on purpose
  // — effects run in declaration order, so the refs are populated by the time the scene mounts and
  // reads them.
  const dataRef = useRef(data);
  const onActClickRef = useRef(onActClick);
  const onReadyRef = useRef(onReady);
  const collapsedRef = useRef(collapsed);
  useEffect(() => {
    dataRef.current = data;
    onActClickRef.current = onActClick;
    onReadyRef.current = onReady;
    collapsedRef.current = collapsed;
  });

  useEffect(() => {
    const host = hostRef.current;
    const labelHost = labelRef.current;
    if (!host || !labelHost) return;
    // Reduced-motion is a *viewer's* preference, and a broadcast page has no viewer — honouring it on
    // the capture machine would ship a frozen room to everyone watching the stream (and would drop the
    // Tier-A ambient CSS layer with it). Stream sources render in full motion, always.
    const reduced = broadcast
      ? false
      : window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    let disposed = false;
    import('./office-scene')
      .then(({ mountOffice }) => {
        if (disposed || !host || !labelHost) return;
        const handle = mountOffice(host, labelHost, reduced, {
          onActClick: (id) => onActClickRef.current?.(id),
          broadcast,
          interactiveLabels: !broadcast,
          showWorkCues: workCues === 'hybrid',
        });
        handle.update(dataRef.current);
        handle.setSuspended(collapsedRef.current); // mounted while collapsed → start parked
        handleRef.current = handle;
        onReadyRef.current?.(handle);
      })
      .catch(() => {
        /* canvas unavailable — the warm gradient + labels stand in. */
      });
    return () => {
      disposed = true;
      handleRef.current?.dispose();
      handleRef.current = null;
      onReadyRef.current?.(null);
    };
  }, [broadcast, workCues]);

  useEffect(() => {
    handleRef.current?.update(data);
  }, [data]);

  // Collapsed panel (opacity 0, still mounted) → park the render loop; expanding resumes with one
  // fresh synchronous frame, so the reopen stays instant. Measured before this: a collapsed office
  // kept the full-scene ambient repaint running at ~18fps for pixels nobody could see.
  useEffect(() => {
    handleRef.current?.setSuspended(collapsed);
  }, [collapsed]);

  // Play a cue for each newly *live*-arrived act (backfilled history never appears in liveIds, so it
  // doesn't replay on load). The act→choreography mapping lives in office-scene/mapping.
  useEffect(() => {
    const h = handleRef.current;
    if (!h) return;
    for (const e of envelopes) {
      if (!liveIds.has(e.id) || emittedRef.current.has(e.id)) continue;
      emittedRef.current.add(e.id);
      const ev = actToEvent(e);
      if (ev) h.emit(ev);
      // EVERY act also speaks over the sender's head (typed out, lingers, then fades) — the office's
      // legible counterpart to the stream. Body-less acts (accept/decline/wait/resolve…) speak their act
      // label so nothing on the team passes invisibly. The envelope id makes the bubble a click-through
      // to the same act in the stream panel.
      const text = e.body && e.body.trim() ? e.body : actLabel(e.act);
      h.emit({ kind: 'speech', who: e.from, text, tone: actTone(e.act), id: e.id, act: e.act });
    }
  }, [envelopes, liveIds]);

  const agents = roster.filter((m) => m.kind === 'agent').length;
  const humans = roster.filter((m) => m.kind === 'human').length;

  return (
    <section className={`lc-office${collapsed ? ' is-collapsed' : ''}`}>
      {/* The room's box. Everything below that must line up with canvas pixels — the plates, the
          ambient overlay, the speech bubbles, the floated chrome — is positioned against the stage,
          so framing the office moves the whole scene as one piece. */}
      <div className="lc-office__stage">
        {/* Canvas stays mounted while collapsed (state survives, re-expanding is instant) but the
            render loop is SUSPENDED via setSuspended — no draw cost behind an invisible panel. */}
        <div className="lc-gl-canvas" ref={hostRef} aria-hidden="true" />
        <div className="lc-gl-labels" ref={labelRef} aria-hidden="true" />
        {/* The office's own chrome, identical on /live and /broadcast by construction — the whole point
            of the shared component. Collapsed, the panel is a rail with nowhere to put it. */}
        {!collapsed && broadcast && (
          <OfficeOverlay
            teamName={teamName}
            present={presentCount(roster)}
            entries={entries}
            status={status}
            interactive={false}
          />
        )}
        {/* Work card floats over the room (bottom of the stage) — not a band under it. */}
        {!collapsed && workCues === 'stack' && (
          <div className="lc-office__work">
            <WorkStack entries={entries} />
          </div>
        )}
        {/* The asks rail floats over the top of the room the way the reel floats over the bottom. */}
        {!collapsed && topSlot && <div className="lc-office__asks">{topSlot}</div>}
        {/* The product's mark on the room itself — for every frame that leaves this app (a clip, a
            screenshot, the stream), quiet enough to live under everything. The overlay card carries
            the TEAM's name; this corner carries the product's. */}
        {!collapsed && (
          <div className="lc-office__mark" aria-hidden="true">
            <MusterdWord className="lc-office__mark-lockup" chipSize={15} />
          </div>
        )}
      </div>
      {!collapsed && bandSlot && <div className="lc-office__band">{bandSlot}</div>}
      {onCollapse && (
        <div className="lc-office__collapse">
          <CollapseButton side="left" label="the office" onClick={onCollapse} />
        </div>
      )}
      {collapsed && onCollapse && (
        <PanelRail
          side="left"
          label="Office"
          hint={String(agents + humans)}
          onExpand={onCollapse}
        />
      )}
    </section>
  );
}
