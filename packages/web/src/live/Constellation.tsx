import type { Envelope, MemberSummary } from '@musterd/protocol';
import { useMemo, useRef, useState } from 'react';
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
    const r = 208 + (i % 2 === 0 ? 22 : -26);
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

// Deterministic starfield (no Math.random at module scope; stable across renders).
const STARS = Array.from({ length: 46 }, (_, i) => {
  const a = Math.sin(i * 12.9898) * 43758.5453;
  const b = Math.sin(i * 78.233) * 12543.231;
  return {
    x: ((a - Math.floor(a)) * VW) | 0,
    y: ((b - Math.floor(b)) * VH) | 0,
    r: 0.5 + ((i * 7) % 3) * 0.35,
    o: 0.1 + ((i * 13) % 5) * 0.04,
    tw: 4 + ((i * 5) % 6),
    td: (i % 7) * 0.6,
  };
});

/**
 * The ambient half of the split-canvas: members as breathing nodes, their directed exchanges as arcs.
 * The most recent directed message lights its arc and sends a comet pulse along it. Layered parallax
 * (stars/arcs/nodes move at different depths on pointer) gives the observatory its sense of space;
 * hovering a node lifts it and its connections and recedes the rest.
 */
export function Constellation({
  roster,
  envelopes,
}: {
  roster: MemberSummary[];
  envelopes: Envelope[];
}) {
  const pos = useMemo(() => layout(roster.map((m) => m.name)), [roster]);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<string | null>(null);

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

  const onMove = (e: React.MouseEvent) => {
    const el = wrapRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    el.style.setProperty('--px', String((e.clientX - r.left) / r.width - 0.5));
    el.style.setProperty('--py', String((e.clientY - r.top) / r.height - 0.5));
  };
  const onLeave = () => {
    const el = wrapRef.current;
    if (el) {
      el.style.setProperty('--px', '0');
      el.style.setProperty('--py', '0');
    }
    setHover(null);
  };

  const agents = roster.filter((m) => m.kind === 'agent').length;
  const humans = roster.filter((m) => m.kind === 'human').length;

  return (
    <section className="lc-constellation" ref={wrapRef} onMouseMove={onMove} onMouseLeave={onLeave}>
      <svg
        className="lc-constellation__svg"
        viewBox={`0 0 ${VW} ${VH}`}
        preserveAspectRatio="xMidYMid meet"
      >
        <defs>
          <radialGradient id="lc-core-agent" cx="38%" cy="34%" r="75%">
            <stop offset="0%" stopColor="#6eead2" />
            <stop offset="55%" stopColor="#1fc0a4" />
            <stop offset="100%" stopColor="#0e8a74" />
          </radialGradient>
          <radialGradient id="lc-core-human" cx="38%" cy="34%" r="75%">
            <stop offset="0%" stopColor="#ffb1c5" />
            <stop offset="55%" stopColor="#f0688f" />
            <stop offset="100%" stopColor="#c23f63" />
          </radialGradient>
          <linearGradient id="lc-arc-dim" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stopColor="#ffeccd" stopOpacity="0" />
            <stop offset="50%" stopColor="#ffeccd" stopOpacity="0.18" />
            <stop offset="100%" stopColor="#ffeccd" stopOpacity="0" />
          </linearGradient>
          <linearGradient id="lc-arc-hot" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stopColor="#e1ad01" stopOpacity="0.15" />
            <stop offset="50%" stopColor="#efc94c" stopOpacity="0.95" />
            <stop offset="100%" stopColor="#e1ad01" stopOpacity="0.15" />
          </linearGradient>
        </defs>

        {/* starfield (deepest parallax layer) */}
        <g className="lc-stars">
          {STARS.map((s, i) => (
            <circle
              key={i}
              className="lc-star"
              cx={s.x}
              cy={s.y}
              r={s.r}
              style={
                {
                  '--o': s.o,
                  '--tw': `${s.tw}s`,
                  '--td': `${s.td}s`,
                } as React.CSSProperties
              }
            />
          ))}
        </g>

        {/* arcs + the comet pulse */}
        <g className={`lc-arcs${hover ? ' is-hovering' : ''}`}>
          {edges.map((ed) => {
            const a = pos.get(ed.from)!;
            const b = pos.get(ed.to)!;
            const key = [ed.from, ed.to].sort().join('::');
            const isActive = key === activeKey;
            const lit = hover === ed.from || hover === ed.to;
            return (
              <path
                key={key}
                className={`lc-arc${isActive ? ' lc-arc--active' : ''}${lit ? ' is-lit' : ''}`}
                d={arcPath(a, b, isActive ? 34 : 26)}
              />
            );
          })}
          {activePathStr && (
            <circle className="lc-pulse" r={4.5}>
              <animateMotion dur="2.6s" repeatCount="indefinite" path={activePathStr} />
            </circle>
          )}
        </g>

        {/* nodes */}
        <g className={`lc-nodes${hover ? ' is-hovering' : ''}`}>
          {roster.map((m) => {
            const p = pos.get(m.name);
            if (!p) return null;
            const online = m.presence !== 'offline';
            const working = m.activity === 'working';
            const hot = hover === m.name;
            return (
              <g
                key={m.name}
                className={`lc-node lc-node--${m.kind} ${online ? 'is-online' : 'is-offline'}${working ? ' is-working' : ''}${hot ? ' is-hot' : ''}`}
                transform={`translate(${p.x} ${p.y})`}
                onMouseEnter={() => setHover(m.name)}
              >
                {online && <circle className="lc-node__halo" r={26} />}
                {working && <circle className="lc-node__ring" r={25} />}
                <circle className="lc-node__core" r={17} />
                <circle className="lc-node__rim" r={17} />
                <text className="lc-node__initial" textAnchor="middle" dy="0.34em">
                  {initial(m.name)}
                </text>
                <text className="lc-node__name" textAnchor="middle" y={38}>
                  {m.name}
                </text>
                {working && m.state && (
                  <text className="lc-node__label" textAnchor="middle" y={53}>
                    {m.state}
                  </text>
                )}
              </g>
            );
          })}
        </g>
      </svg>
      <p className="lc-constellation__caption">
        {agents} agent{agents === 1 ? '' : 's'} · {humans} human{humans === 1 ? '' : 's'}
      </p>
    </section>
  );
}
