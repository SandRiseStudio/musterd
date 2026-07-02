import type { Envelope, MemberSummary } from '@musterd/protocol';
import { useEffect, useMemo, useRef } from 'react';
import { actTone, memberColor } from './format';
import type { OfficeData, OfficeHandle } from './office-scene';
import { actToEvent } from './office-scene/mapping';

/** Roster → the office's node data (presence/activity drives who's in the room + their state). */
function computeData(roster: MemberSummary[]): OfficeData {
  return {
    nodes: roster.map((m) => {
      const kind = m.kind === 'human' ? 'human' : 'agent';
      return {
        name: m.name,
        kind,
        presence: m.presence,
        activity: m.activity ?? (m.presence === 'offline' ? 'offline' : 'online'),
        state: m.state ?? null,
        color: memberColor(m.name, kind),
        role: m.role,
      };
    }),
  };
}

/**
 * The live isometric office: every teammate sits at a desk (presence decides who's in the room and
 * whether they're working / idle / away), and each act plays as a cue over the floor. A drop-in for the
 * old three.js constellation — same panel, same props, same mount/dispose seam. The scene is dynamically
 * imported (kept out of SSR); prefers-reduced-motion draws a static frame. Name labels are HTML overlay.
 */
export function ConstellationGL({
  roster,
  envelopes,
  liveIds,
}: {
  roster: MemberSummary[];
  envelopes: Envelope[];
  liveIds: Set<string>;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const labelRef = useRef<HTMLDivElement>(null);
  const handleRef = useRef<OfficeHandle | null>(null);
  const emittedRef = useRef<Set<string>>(new Set());

  const data = useMemo(() => computeData(roster), [roster]);
  const dataRef = useRef(data);
  dataRef.current = data;

  useEffect(() => {
    const host = hostRef.current;
    const labelHost = labelRef.current;
    if (!host || !labelHost) return;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    let disposed = false;
    import('./office-scene')
      .then(({ mountOffice }) => {
        if (disposed || !host || !labelHost) return;
        const handle = mountOffice(host, labelHost, reduced);
        handle.update(dataRef.current);
        handleRef.current = handle;
      })
      .catch(() => {
        /* canvas unavailable — the warm gradient + labels stand in. */
      });
    return () => {
      disposed = true;
      handleRef.current?.dispose();
      handleRef.current = null;
    };
  }, []);

  useEffect(() => {
    handleRef.current?.update(data);
  }, [data]);

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
      // Any act with a body also speaks it over the sender's head (typed out, then fades) — the office's
      // legible counterpart to the stream. Independent of the choreography cue; both can play for one act.
      if (e.body && e.body.trim()) h.emit({ kind: 'speech', who: e.from, text: e.body, tone: actTone(e.act) });
    }
  }, [envelopes, liveIds]);

  const agents = roster.filter((m) => m.kind === 'agent').length;
  const humans = roster.filter((m) => m.kind === 'human').length;

  return (
    <section className="lc-constellation">
      <div className="lc-gl-canvas" ref={hostRef} aria-hidden="true" />
      <div className="lc-gl-labels" ref={labelRef} aria-hidden="true" />
      <p className="lc-constellation__caption">
        {agents} agent{agents === 1 ? '' : 's'} · {humans} human{humans === 1 ? '' : 's'}
      </p>
    </section>
  );
}
