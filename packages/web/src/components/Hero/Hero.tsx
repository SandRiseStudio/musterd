import { useEffect, useRef, useState } from 'react';
import { TAGLINE } from '../../content/roadmap.data';
import { MusterdChip } from '../../brand/MusterdWord';
import { memberColor } from '../../live/format';
import type { OfficeData, OfficeEvent, OfficeHandle } from '../../live/office-scene';
import './Hero.css';

// ── Synthetic fixture (smaller than office-preview's 9 — it's a background, not a preview). ─────────
// 5 members (3 humans / 2 agents) so the room is staffed but never busy behind the headline.

type Kind = 'agent' | 'human';
type Mock = { name: string; kind: Kind; activity: OfficeData['nodes'][number]['activity']; state: string | null };

const POOL: Mock[] = [
  { name: 'Ada', kind: 'human', activity: 'working', state: 'reviewing the roadmap' },
  { name: 'Bo', kind: 'agent', activity: 'working', state: 'porting the floor renderer' },
  { name: 'Cy', kind: 'human', activity: 'working', state: 'wiring the firehose subscribe' },
  { name: 'Fen', kind: 'agent', activity: 'working', state: 'watching the deploy' },
  { name: 'Ivy', kind: 'human', activity: 'working', state: 'designing the character rig' },
];

// A slower, subtler choreography loop — atmosphere, not narration. No megaphone (too loud for a
// background); walks and handoffs are the most graceful motion; speeches are short. ~10s loop.
const SCRIPT: { at: number; ev: OfficeEvent }[] = [
  { at: 400, ev: { kind: 'walk-help', from: 'Ada', to: 'Bo', tier: 'needs-attn' } },
  { at: 800, ev: { kind: 'speech', who: 'Cy', text: 'anyone seen the flaky test?', tone: 'accent' } },
  { at: 1400, ev: { kind: 'walk-handoff', from: 'Ivy', to: 'Fen', label: 'render.ts' } },
  { at: 2800, ev: { kind: 'speech', who: 'Fen', text: 'on it — checking the deploy', tone: 'status' } },
  { at: 3800, ev: { kind: 'screen-pulse', who: 'Bo', tone: 'status' } },
  { at: 4800, ev: { kind: 'walk-handoff', from: 'Bo', to: 'Ada', label: 'floor.ts' } },
  { at: 6200, ev: { kind: 'resolve', who: 'Fen' } },
  { at: 6800, ev: { kind: 'speech', who: 'Fen', text: 'fixed', tone: 'success' } },
  { at: 8000, ev: { kind: 'note', from: 'Ada', to: 'Cy', tone: 'info' } },
];
const LOOP = 10000;

function buildData(): OfficeData {
  return {
    nodes: POOL.map((m) => ({
      name: m.name,
      kind: m.kind,
      presence: 'online' as const,
      activity: m.activity,
      posture: m.activity === 'working' ? ('working' as const) : ('idle' as const),
      state: m.state,
      color: memberColor(m.name, m.kind),
      role: '',
    })),
  };
}

export function Hero() {
  const canvasHost = useRef<HTMLDivElement>(null);
  const labelHost = useRef<HTMLDivElement>(null);
  const handleRef = useRef<OfficeHandle | null>(null);
  const [ready, setReady] = useState(false);

  // Stable reference to the latest data builder (no roster changes on the landing hero, but the
  // pattern is consistent with office-preview and OfficeScene).
  const dataRef = useRef(buildData);
  dataRef.current = buildData;

  useEffect(() => {
    const host = canvasHost.current;
    const label = labelHost.current;
    if (!host || !label) return;

    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduced) return; // CSS gradient fallback carries the warmth; no canvas mounted.

    let disposed = false;
    const timers: ReturnType<typeof setTimeout>[] = [];
    let loop: ReturnType<typeof setInterval> | undefined;

    // Dynamic import keeps the office scene out of the SSR bundle entirely.
    import('../../live/office-scene')
      .then(({ mountOffice }) => {
        if (disposed) return;
        const handle = mountOffice(host, label, false);
        handle.update(dataRef.current());
        handleRef.current = handle;
        setReady(true);

        // Loop the choreography script so the room is always gently alive.
        const run = () => {
          for (const step of SCRIPT) {
            timers.push(setTimeout(() => handleRef.current?.emit(step.ev), step.at));
          }
        };
        run();
        loop = setInterval(run, LOOP);
      })
      .catch(() => {
        /* canvas unavailable — the gradient fallback stands in. */
      });

    return () => {
      disposed = true;
      for (const t of timers) clearTimeout(t);
      if (loop) clearInterval(loop);
      handleRef.current?.dispose();
      handleRef.current = null;
    };
  }, []);

  return (
    <header className="hero">
      <div className="hero__ground" aria-hidden="true" />
      <div className={`hero__canvas${ready ? ' is-ready' : ''}`} ref={canvasHost} aria-hidden="true" />
      <div className="hero__labels" ref={labelHost} aria-hidden="true" />
      <div className="hero__vignette" aria-hidden="true" />

      <div className="hero__content shell">
        <p className="hero__eyebrow mono">SandRise Studio</p>
        <h1 className="hero__wordmark mono">
          <MusterdChip size={56} className="hero__chip" />
          <span className="hero__word">
            musterd<span className="hero__cursor" aria-hidden="true">_</span>
          </span>
        </h1>
        <p className="hero__tagline">{TAGLINE}</p>
        <a className="hero__scroll" href="#roadmap">
          <span>the roadmap</span>
          <span className="hero__scroll-arrow" aria-hidden="true" />
        </a>
      </div>
    </header>
  );
}
