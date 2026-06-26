import type { Envelope, MemberSummary } from '@musterd/protocol';
import { useMemo } from 'react';
import { initial } from './format';

interface Pt {
  x: number;
  y: number;
}

const VW = 560;
const VH = 800;

/** Deterministic, calm ring layout — seeded by index so nodes don't reshuffle as data arrives. */
function layout(names: string[]): Map<string, Pt> {
  const cx = VW / 2;
  const cy = VH / 2;
  const n = Math.max(names.length, 1);
  const m = new Map<string, Pt>();
  names.forEach((name, i) => {
    if (n === 1) {
      m.set(name, { x: cx, y: cy });
      return;
    }
    const angle = (i / n) * Math.PI * 2 - Math.PI / 2;
    const r = 210 + (i % 2 === 0 ? 22 : -26);
    m.set(name, { x: cx + r * Math.cos(angle), y: cy + r * Math.sin(angle) * 0.92 });
  });
  return m;
}

/** A quadratic arc between two points, bowed perpendicular to the chord. */
function arcPath(a: Pt, b: Pt, bow = 30): string {
  const mx = (a.x + b.x) / 2;
  const my = (a.y + b.y) / 2;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  const cxp = mx + (-dy / len) * bow;
  const cyp = my + (dx / len) * bow;
  return `M ${a.x} ${a.y} Q ${cxp} ${cyp} ${b.x} ${b.y}`;
}

/**
 * The ambient half of the split-canvas: members as breathing nodes, their directed exchanges as arcs.
 * The most recent directed message lights its arc and sends a comet pulse along it — communication is
 * the brightest thing on the canvas.
 */
export function Constellation({
  roster,
  envelopes,
}: {
  roster: MemberSummary[];
  envelopes: Envelope[];
}) {
  const pos = useMemo(() => layout(roster.map((m) => m.name)), [roster]);

  // Directed edges (member→member) seen in the stream; the last one is "active".
  const { edges, active } = useMemo(() => {
    const set = new Map<string, { from: string; to: string }>();
    let last: { from: string; to: string } | null = null;
    for (const e of envelopes) {
      if (e.to.kind !== 'member') continue;
      const to = e.to.name;
      if (!pos.has(e.from) || !pos.has(to)) continue;
      const key = [e.from, to].sort().join('::');
      set.set(key, { from: e.from, to });
      last = { from: e.from, to };
    }
    return { edges: [...set.values()], active: last };
  }, [envelopes, pos]);

  const activeKey = active ? [active.from, active.to].sort().join('::') : null;
  const activePathStr =
    active && pos.has(active.from) && pos.has(active.to)
      ? arcPath(pos.get(active.from)!, pos.get(active.to)!, 34)
      : null;

  return (
    <section className="lc-constellation">
      <svg className="lc-constellation__svg" viewBox={`0 0 ${VW} ${VH}`} preserveAspectRatio="xMidYMid meet">
        {/* arcs */}
        {edges.map((ed) => {
          const a = pos.get(ed.from)!;
          const b = pos.get(ed.to)!;
          const key = [ed.from, ed.to].sort().join('::');
          const isActive = key === activeKey;
          return (
            <path
              key={key}
              className={`lc-arc${isActive ? ' lc-arc--active' : ''}`}
              d={arcPath(a, b, isActive ? 34 : 26)}
            />
          );
        })}

        {/* comet pulse on the active arc */}
        {activePathStr && (
          <circle className="lc-pulse" r={5}>
            <animateMotion dur="2.4s" repeatCount="indefinite" path={activePathStr} />
          </circle>
        )}

        {/* nodes */}
        {roster.map((m) => {
          const p = pos.get(m.name);
          if (!p) return null;
          const online = m.presence !== 'offline';
          const working = m.activity === 'working';
          return (
            <g
              key={m.name}
              className={`lc-node lc-node--${m.kind} ${online ? 'is-online' : 'is-offline'}${working ? ' is-working' : ''}`}
              transform={`translate(${p.x} ${p.y})`}
            >
              {online && <circle className="lc-node__glow" r={26} />}
              {working && <circle className="lc-node__ring" r={25} />}
              <circle className="lc-node__core" r={18} />
              <text className="lc-node__initial" textAnchor="middle" dy="0.34em">
                {initial(m.name)}
              </text>
              <text className="lc-node__name" textAnchor="middle" y={40}>
                {m.name}
              </text>
              {working && m.state && (
                <text className="lc-node__label" textAnchor="middle" y={56}>
                  {m.state}
                </text>
              )}
            </g>
          );
        })}
      </svg>
      <p className="lc-constellation__caption">
        {roster.filter((m) => m.kind === 'agent').length} agents ·{' '}
        {roster.filter((m) => m.kind === 'human').length} human
      </p>
    </section>
  );
}
