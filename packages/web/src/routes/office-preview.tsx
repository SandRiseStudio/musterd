import { createFileRoute } from '@tanstack/react-router';
import { useEffect, useRef } from 'react';
import liveCss from '../live/Live.css?url';
import { memberColor } from '../live/format';
import type { OfficeData, OfficeEvent, OfficeHandle } from '../live/office-scene';

export const Route = createFileRoute('/office-preview')({
  head: () => ({
    meta: [{ title: 'musterd — office preview' }],
    links: [{ rel: 'stylesheet', href: liveCss }],
  }),
  component: OfficePreviewPage,
});

/* Synthetic fixture — no live daemon. Mounts the office scene directly and drives it with a looping
   act script so the walk/handoff/megaphone choreography plays on its own (design fixture; also how the
   motion is screenshot-verified). Buttons trigger acts on demand. */

type Kind = 'agent' | 'human';
type Mock = { name: string; kind: Kind; activity: OfficeData['nodes'][number]['activity']; state: string | null; away?: boolean };

const MOCK: Mock[] = [
  { name: 'Ada', kind: 'human', activity: 'working', state: 'reviewing the isometric office' },
  { name: 'Bo', kind: 'agent', activity: 'working', state: 'porting the floor renderer' },
  { name: 'Cy', kind: 'human', activity: 'working', state: 'wiring the firehose subscribe' },
  { name: 'Dev', kind: 'agent', activity: 'online', state: null },
  { name: 'Eli', kind: 'human', activity: 'working', state: 'writing the seating tests' },
  { name: 'Fen', kind: 'agent', activity: 'working', state: 'watching the deploy' },
  { name: 'Gus', kind: 'human', activity: 'online', state: null, away: true },
  { name: 'Hana', kind: 'agent', activity: 'working', state: 'profiling the render loop' },
  { name: 'Ivy', kind: 'human', activity: 'working', state: 'designing the character rig' },
];

function toData(): OfficeData {
  return {
    nodes: MOCK.map((m) => ({
      name: m.name,
      kind: m.kind,
      presence: m.away ? 'away' : 'online',
      activity: m.activity,
      state: m.state,
      color: memberColor(m.name, m.kind),
      role: '',
    })),
  };
}

// A looping choreography script (ms offset → event), so the room is always alive on the preview.
const SCRIPT: { at: number; ev: OfficeEvent }[] = [
  { at: 200, ev: { kind: 'walk-help', from: 'Ada', to: 'Bo', tier: 'needs-attn' } },
  { at: 500, ev: { kind: 'walk-handoff', from: 'Eli', to: 'Hana', label: 'floor.ts' } },
  { at: 1100, ev: { kind: 'walk-help', from: 'Cy', to: 'Fen', tier: 'urgent' } },
  { at: 1800, ev: { kind: 'megaphone', from: 'Ivy' } },
  { at: 2400, ev: { kind: 'screen-pulse', who: 'Hana', tone: 'status' } },
  { at: 3000, ev: { kind: 'walk-handoff', from: 'Bo', to: 'Ivy', label: 'render.ts' } },
  { at: 3600, ev: { kind: 'resolve', who: 'Fen' } },
  { at: 4200, ev: { kind: 'note', from: 'Ada', to: 'Cy', tone: 'info' } },
];
const LOOP = 5200;

function OfficePreviewPage() {
  const hostRef = useRef<HTMLDivElement>(null);
  const labelRef = useRef<HTMLDivElement>(null);
  const handleRef = useRef<OfficeHandle | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    const labelHost = labelRef.current;
    if (!host || !labelHost) return;
    let disposed = false;
    const timers: ReturnType<typeof setTimeout>[] = [];
    let loop: ReturnType<typeof setInterval> | undefined;

    import('../live/office-scene')
      .then(({ mountOffice }) => {
        if (disposed || !host || !labelHost) return;
        const handle = mountOffice(host, labelHost, false);
        handle.update(toData());
        handleRef.current = handle;
        const run = () => {
          for (const step of SCRIPT) timers.push(setTimeout(() => handleRef.current?.emit(step.ev), step.at));
        };
        run();
        loop = setInterval(run, LOOP);
      })
      .catch(() => {});

    return () => {
      disposed = true;
      for (const t of timers) clearTimeout(t);
      if (loop) clearInterval(loop);
      handleRef.current?.dispose();
      handleRef.current = null;
    };
  }, []);

  const fire = (ev: OfficeEvent) => handleRef.current?.emit(ev);

  return (
    <main className="lc">
      <header className="lc__topbar">
        <span className="lc__word">musterd</span>
        <span className="lc__team">/ office preview</span>
        <span className="lc__spacer" />
        <button className="lc__pbtn" title="request help (walk-over)" onClick={() => fire({ kind: 'walk-help', from: 'Ada', to: 'Bo', tier: 'needs-attn' })}>?</button>
        <button className="lc__pbtn" title="urgent help (run)" onClick={() => fire({ kind: 'walk-help', from: 'Cy', to: 'Fen', tier: 'urgent' })}>!</button>
        <button className="lc__pbtn" title="handoff (carry box)" onClick={() => fire({ kind: 'walk-handoff', from: 'Eli', to: 'Hana', label: 'floor.ts' })}>↦</button>
        <button className="lc__pbtn" title="broadcast (megaphone)" onClick={() => fire({ kind: 'megaphone', from: 'Ivy' })}>📣</button>
        <span className="lc__status lc__status--live">design preview</span>
      </header>
      <div className="lc__canvas lc__canvas--companion">
        <section className="lc-constellation">
          <div className="lc-gl-canvas" ref={hostRef} aria-hidden="true" />
          <div className="lc-gl-labels" ref={labelRef} aria-hidden="true" />
          <p className="lc-constellation__caption">office choreography preview</p>
        </section>
      </div>
    </main>
  );
}
