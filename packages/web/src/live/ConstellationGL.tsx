import type { Envelope, MemberSummary } from '@musterd/protocol';
import { useEffect, useMemo, useRef } from 'react';
import type { ConstellationHandle, GLData } from './constellation-scene';
import { memberColor } from './format';

/** Roster + stream → the scene's data shape (nodes + directed-exchange edges, latest = active). */
function computeData(roster: MemberSummary[], envelopes: Envelope[]): GLData {
  const names = new Set(roster.map((m) => m.name));
  const nodes = roster.map((m) => {
    const kind = (m.kind === 'human' ? 'human' : 'agent') as 'human' | 'agent';
    return {
      name: m.name,
      kind,
      online: m.presence !== 'offline',
      working: m.activity === 'working',
      label: m.state ?? null,
      color: memberColor(m.name, kind),
    };
  });
  const set = new Map<string, { from: string; to: string }>();
  let last: { from: string; to: string } | null = null;
  for (const e of envelopes) {
    if (e.to.kind !== 'member') continue;
    const to = e.to.name;
    if (!names.has(e.from) || !names.has(to)) continue;
    set.set([e.from, to].sort().join('::'), { from: e.from, to });
    last = { from: e.from, to };
  }
  const activeKey = last ? [last.from, last.to].sort().join('::') : null;
  const edges = [...set.entries()].map(([key, v]) => ({ ...v, active: key === activeKey }));
  return { nodes, edges };
}

const GREEN = '#5cd49a';
/** Act → the colour its pulse/ripple travels in (mirrors the stream's act tones). */
function toneColor(act: string): string {
  switch (act) {
    case 'request_help':
      return '#f2c83e';
    case 'accept':
    case 'resolve':
      return GREEN;
    case 'decline':
      return '#f3776a';
    case 'wait':
      return '#88a9cf';
    default:
      return '#ffd49a';
  }
}

/**
 * The ambient half of the split-canvas, as a three.js scene: members are glowing 3D nodes, directed
 * exchanges are curved arcs, the active arc carries a comet. three.js is dynamically imported (kept out
 * of SSR); a projected HTML overlay carries crisp labels. prefers-reduced-motion renders a static frame.
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
  const handleRef = useRef<ConstellationHandle | null>(null);
  const emittedRef = useRef<Set<string>>(new Set());

  const data = useMemo(() => computeData(roster, envelopes), [roster, envelopes]);
  const dataRef = useRef(data);
  dataRef.current = data;

  useEffect(() => {
    const host = hostRef.current;
    const labelHost = labelRef.current;
    if (!host || !labelHost) return;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    let disposed = false;
    import('./constellation-scene')
      .then(({ mountConstellation }) => {
        if (disposed || !host || !labelHost) return;
        const handle = mountConstellation(host, labelHost, reduced);
        handle.update(dataRef.current);
        handleRef.current = handle;
      })
      .catch(() => {
        /* WebGL unavailable — the dusk gradient + labels stand in. */
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

  // Fire a scene event for each newly *live*-arrived message: directed → a comet along its arc; a
  // team broadcast → a ripple from the sender; a resolve → a green pulse + a settle at the recipient.
  // Backfilled history never appears in liveIds, so it doesn't replay on load.
  useEffect(() => {
    const h = handleRef.current;
    if (!h) return;
    for (const e of envelopes) {
      if (!liveIds.has(e.id) || emittedRef.current.has(e.id)) continue;
      emittedRef.current.add(e.id);
      const color = toneColor(e.act);
      if (e.to.kind === 'member') {
        if (e.act === 'resolve') h.emit({ kind: 'settle', from: e.from, to: e.to.name, color });
        else h.emit({ kind: 'pulse', from: e.from, to: e.to.name, color });
      } else {
        h.emit({ kind: 'ripple', from: e.from, color });
      }
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
