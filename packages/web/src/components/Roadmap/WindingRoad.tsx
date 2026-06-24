import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import {
  CATEGORY_META,
  ROADMAP,
  STATUS_META,
  STATUS_ORDER,
  WAVE_META,
  waveRank,
  type RoadmapItem,
  type Status,
} from '../../content/roadmap.data';

const ACTIVE: Status = 'near-term';
const STEP = 0.85; // winding frequency per node

type Stop =
  | { kind: 'head'; key: string; status: Status; count: number; active: boolean }
  | { kind: 'node'; key: string; status: Status; item: RoadmapItem };

interface Point {
  x: number;
  y: number;
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const ampFor = (w: number) => (w >= 1000 ? 0.42 : w >= 760 ? 0.34 : 0.04);

// useLayoutEffect on the client, useEffect on the server (avoids the SSR warning).
const useIsoLayoutEffect = typeof window !== 'undefined' ? useLayoutEffect : useEffect;

// Smooth Catmull-Rom spline → cubic bezier path through the measured points.
function smoothPath(pts: Point[]): string {
  if (pts.length < 2) return '';
  const p = pts;
  let d = `M ${p[0]!.x.toFixed(1)} ${p[0]!.y.toFixed(1)}`;
  for (let i = 0; i < p.length - 1; i++) {
    const p0 = p[i - 1] ?? p[i]!;
    const p1 = p[i]!;
    const p2 = p[i + 1]!;
    const p3 = p[i + 2] ?? p2;
    const c1x = p1.x + (p2.x - p0.x) / 6;
    const c1y = p1.y + (p2.y - p0.y) / 6;
    const c2x = p2.x - (p3.x - p1.x) / 6;
    const c2y = p2.y - (p3.y - p1.y) / 6;
    d += ` C ${c1x.toFixed(1)} ${c1y.toFixed(1)}, ${c2x.toFixed(1)} ${c2y.toFixed(1)}, ${p2.x.toFixed(1)} ${p2.y.toFixed(1)}`;
  }
  return d;
}

export function WindingRoad() {
  const stops = useMemo<Stop[]>(() => {
    const out: Stop[] = [];
    for (const status of STATUS_ORDER) {
      // Within a status, the road follows build order (wave); stable sort keeps array order per wave.
      const items = ROADMAP.filter((i) => i.status === status).sort((a, b) => waveRank(a) - waveRank(b));
      out.push({ kind: 'head', key: `head-${status}`, status, count: items.length, active: status === ACTIVE });
      for (const item of items) out.push({ kind: 'node', key: item.id, status, item });
    }
    return out;
  }, []);

  // node id → stop index (for dependency edges)
  const idToIndex = useMemo(() => {
    const m = new Map<string, number>();
    stops.forEach((s, i) => {
      if (s.kind === 'node') m.set(s.item.id, i);
    });
    return m;
  }, [stops]);

  const [amp, setAmp] = useState(0.32);
  const xFracs = useMemo(() => {
    let node = 0;
    return stops.map((s) => {
      if (s.kind === 'head') return 0.5;
      // offset phase so the very first node isn't centered under the station
      const x = 0.5 + amp * Math.sin(node * STEP + 0.9);
      node += 1;
      return x;
    });
  }, [stops, amp]);

  const containerRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const basePathRef = useRef<SVGPathElement>(null);
  const drawPathRef = useRef<SVGPathElement>(null);
  const markerRef = useRef<SVGGElement>(null);
  const dotEls = useRef<(HTMLElement | null)[]>([]);
  const centers = useRef<Point[]>([]);
  const lenRef = useRef(0);

  const [dims, setDims] = useState({ w: 0, h: 0 });
  const [pathD, setPathD] = useState('');
  const [edges, setEdges] = useState<{ key: string; d: string; status: Status }[]>([]);

  const measure = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;
    const cRect = container.getBoundingClientRect();

    const pts: Point[] = dotEls.current.map((el) => {
      if (!el) return { x: cRect.width / 2, y: 0 };
      const r = el.getBoundingClientRect();
      return { x: r.left - cRect.left + r.width / 2, y: r.top - cRect.top + r.height / 2 };
    });
    centers.current = pts;
    setDims({ w: container.offsetWidth, h: container.offsetHeight });
    setPathD(smoothPath(pts));

    // dependency edges: from the dependency's dot → the dependent's dot
    const e: { key: string; d: string; status: Status }[] = [];
    stops.forEach((s, i) => {
      if (s.kind !== 'node' || !s.item.dependsOn) return;
      const to = pts[i];
      if (!to) return;
      for (const depId of s.item.dependsOn) {
        const fi = idToIndex.get(depId);
        if (fi === undefined) continue;
        const from = pts[fi];
        if (!from) continue;
        const mx = (from.x + to.x) / 2;
        const bow = (Math.abs(to.y - from.y) > 0 ? 1 : 0) * (i % 2 === 0 ? 70 : -70);
        e.push({
          key: `${depId}->${s.item.id}`,
          d: `M ${from.x.toFixed(1)} ${from.y.toFixed(1)} Q ${(mx + bow).toFixed(1)} ${((from.y + to.y) / 2).toFixed(1)} ${to.x.toFixed(1)} ${to.y.toFixed(1)}`,
          status: s.status,
        });
      }
    });
    setEdges(e);
  }, [stops, idToIndex]);

  // re-measure on mount and whenever the amplitude (hence layout) changes
  useIsoLayoutEffect(() => {
    measure();
  }, [measure, amp]);

  // amplitude + measurement on resize / font load
  useEffect(() => {
    const handler = () => {
      const w = containerRef.current?.offsetWidth ?? 0;
      setAmp(ampFor(w));
      measure();
    };
    handler();
    const ro = new ResizeObserver(handler);
    if (containerRef.current) ro.observe(containerRef.current);
    window.addEventListener('resize', handler);
    if (typeof document !== 'undefined' && 'fonts' in document) {
      document.fonts.ready.then(handler).catch(() => {});
    }
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', handler);
    };
  }, [measure]);

  // draw-on-scroll + traveling marker + node lighting
  useEffect(() => {
    const draw = drawPathRef.current;
    const container = containerRef.current;
    if (!draw || !container) return;

    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const len = draw.getTotalLength();
    lenRef.current = len;
    draw.style.strokeDasharray = `${len}`;

    const setPassed = (progress: number, markerY: number) => {
      dotEls.current.forEach((el, i) => {
        if (!el) return;
        const c = centers.current[i];
        el.dataset.passed = c && c.y <= markerY + 4 ? 'true' : 'false';
      });
      void progress;
    };

    if (reduced) {
      draw.style.strokeDashoffset = '0';
      if (markerRef.current) markerRef.current.style.opacity = '0';
      dotEls.current.forEach((el) => el && (el.dataset.passed = 'true'));
      return;
    }

    draw.style.strokeDashoffset = `${len}`;
    let raf = 0;
    let queued = false;
    const update = () => {
      queued = false;
      const rect = container.getBoundingClientRect();
      const vh = window.innerHeight;
      const progress = clamp01((vh * 0.58 - rect.top) / Math.max(rect.height, 1));
      draw.style.strokeDashoffset = `${len * (1 - progress)}`;
      const marker = markerRef.current;
      if (marker) {
        if (progress > 0.001 && progress < 0.999) {
          const pt = draw.getPointAtLength(progress * len);
          marker.style.transform = `translate(${pt.x}px, ${pt.y}px)`;
          marker.style.opacity = '1';
          setPassed(progress, pt.y);
        } else {
          marker.style.opacity = '0';
          setPassed(progress, progress >= 0.999 ? Number.POSITIVE_INFINITY : -1);
        }
      }
    };
    const onScroll = () => {
      if (queued) return;
      queued = true;
      raf = requestAnimationFrame(update);
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    update();
    return () => {
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
      cancelAnimationFrame(raf);
    };
  }, [pathD]);

  return (
    <div className="road" ref={containerRef}>
      <svg
        className="road__svg"
        ref={svgRef}
        width={dims.w || undefined}
        height={dims.h || undefined}
        viewBox={dims.w ? `0 0 ${dims.w} ${dims.h}` : undefined}
        preserveAspectRatio="none"
        aria-hidden="true"
      >
        <defs>
          <filter id="road-glow" x="-40%" y="-40%" width="180%" height="180%">
            <feGaussianBlur stdDeviation="3" result="b" />
            <feMerge>
              <feMergeNode in="b" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>

        {/* dependency edges */}
        {edges.map((e) => (
          <path key={e.key} className="road__edge" data-status={e.status} d={e.d} />
        ))}

        {/* the road: faint base + bright drawn overlay */}
        <path className="road__base" ref={basePathRef} d={pathD} />
        <path className="road__draw" ref={drawPathRef} d={pathD} filter="url(#road-glow)" />

        {/* traveling marker */}
        <g className="road__marker" ref={markerRef}>
          <circle r="11" className="road__marker-halo" />
          <circle r="4.5" className="road__marker-core" />
        </g>
      </svg>

      <div className="road__stops">
        {stops.map((s, i) =>
          s.kind === 'head' ? (
            <HeadStop
              key={s.key}
              stop={s}
              x={xFracs[i] ?? 0.5}
              dotRef={(el) => {
                dotEls.current[i] = el;
              }}
            />
          ) : (
            <NodeStop
              key={s.key}
              stop={s}
              x={xFracs[i] ?? 0.5}
              dotRef={(el) => {
                dotEls.current[i] = el;
              }}
            />
          ),
        )}
      </div>
    </div>
  );
}

function HeadStop({ stop, x, dotRef }: { stop: Extract<Stop, { kind: 'head' }>; x: number; dotRef: (el: HTMLElement | null) => void }) {
  const meta = STATUS_META[stop.status];
  return (
    <div className="road__stop road__stop--head" data-status={stop.status} style={{ '--x': x } as CSSProperties}>
      <div className="phasehead">
        <span className="road__dot road__dot--station" data-status={stop.status} ref={dotRef} aria-hidden="true" />
        {stop.active ? <span className="phasehead__here mono">you are here</span> : null}
        <h3 className="phasehead__label">{meta.label}</h3>
        <p className="phasehead__tone">{meta.tone}</p>
        <span className="phasehead__count mono" aria-hidden="true">
          {String(stop.count).padStart(2, '0')}
        </span>
      </div>
    </div>
  );
}

function NodeStop({ stop, x, dotRef }: { stop: Extract<Stop, { kind: 'node' }>; x: number; dotRef: (el: HTMLElement | null) => void }) {
  const { item } = stop;
  const cat = CATEGORY_META[item.category];
  return (
    <div className="road__stop road__stop--node" data-status={item.status} style={{ '--x': x } as CSSProperties}>
      <article
        className="card"
        data-status={item.status}
        data-category={item.category}
        style={{ '--cat': cat.color } as CSSProperties}
      >
        <span className="road__dot" data-status={item.status} ref={dotRef} aria-hidden="true" />
        <span className="card__meta">
          <span className="card__category mono">{CATEGORY_META[item.category].label}</span>
          {item.wave ? (
            <span className="card__wave mono" data-wave={String(item.wave)} title={WAVE_META[item.wave].tone}>
              {WAVE_META[item.wave].label}
            </span>
          ) : null}
        </span>
        <h4 className="card__title">{item.title}</h4>
        <p className="card__blurb">{item.blurb}</p>
        {item.refs?.length ? (
          <div className="card__refs">
            {item.refs.map((r) => (
              <a key={r.label} className="card__ref mono" href={r.href} target="_blank" rel="noreferrer">
                {r.label}
              </a>
            ))}
          </div>
        ) : null}
      </article>
    </div>
  );
}
