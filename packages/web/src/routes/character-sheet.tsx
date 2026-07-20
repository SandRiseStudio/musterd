import { createFileRoute } from '@tanstack/react-router';
import { useEffect, useRef } from 'react';
import { canvasFont, preloadCanvasFont } from '../live/canvasFont';
import { memberColor } from '../live/format';

/**
 * `/character-sheet` — the character turnaround. A design fixture, like `/office-preview`: it renders the
 * office character large, at every facing, across a roster of names, in each pose.
 *
 * This exists because the office draws people ~40px tall, and at that size a wardrobe bug (hair the size of
 * a beach ball, a green head under green hair) is invisible until it is shipped. Iterating on the character
 * *inside* the office is flying blind. Here, each figure is drawn at 4× so the silhouette, the hairline, the
 * face and the depth-sort can actually be judged — and it sweeps enough names to show the *distribution*,
 * which is the thing that actually matters: nobody cares whether one member looks good, only whether the
 * whole floor does.
 */

export const Route = createFileRoute('/character-sheet')({
  head: () => ({ meta: [{ title: 'musterd — character sheet' }] }),
  component: CharacterSheet,
});

const NAMES = [
  'miley', 'izzo', 'stanley', 'ryder', 'nick', 'ada', 'bo', 'cy',
  'dev', 'eli', 'fen', 'gus', 'hana', 'ivy', 'jo', 'kit',
  'lu', 'mo', 'nia', 'ola', 'pax', 'quinn', 'rex', 'sol',
];

const DIRS = ['S', 'E', 'N', 'W'] as const;

function CharacterSheet() {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    // Warm the izzocam telemetry face (Space Mono) before the canvas paints its caption labels.
    preloadCanvasFont(11, '--font-mono', 400);
    let raf = 0;
    let stop = false;

    void (async () => {
      // Client-only: the scene modules reach for canvas/DOM at import time.
      const [{ drawCharacter }, { solveSkeleton, seedOf, typingBurst }, { drawDog }] = await Promise.all([
        import('../live/office-scene/character'),
        import('../live/office-scene/skeleton'),
        import('../live/office-scene/render'),
      ]);
      if (stop) return;

      const CELL = 190;
      const ROW = 210;
      const cols = 6;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      // 3 blocks (seated+typing / walking / standing) × 4 facings each is too wide; instead: for each name,
      // one row of 4 facings seated, and a second sweep walking. Keep it to a readable grid.
      // + 1 extra row at the bottom: the office dog, one cell per pose (it needs the same 4× scrutiny).
      const rows = Math.ceil(NAMES.length / cols) * 3 + 1;
      const W = cols * CELL;
      const H = rows * ROW + 40;
      canvas.width = W * dpr;
      canvas.height = H * dpr;
      canvas.style.width = `${W}px`;
      canvas.style.height = `${H}px`;
      const ctx = canvas.getContext('2d')!;

      const t0 = performance.now();
      const frame = () => {
        if (stop) return;
        const t = (performance.now() - t0) / 1000;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.fillStyle = '#e4a96b';
        ctx.fillRect(0, 0, W, H);

        // A big "fit" so one logical unit is ~1.6px — the character reads at roughly 4× office size.
        const fit = { ox: 0, oy: 0, scale: 1.55 };

        const MODES = [
          { label: 'seated · typing', sit: 1, stride: 0, dir: 'S' as const },
          { label: 'walking', sit: 0, stride: 1, dir: 'E' as const },
          { label: 'standing', sit: 0, stride: 0, dir: 'S' as const },
        ];

        NAMES.forEach((name, i) => {
          const col = i % cols;
          const band = Math.floor(i / cols);
          MODES.forEach((mode, m) => {
            const row = band * 3 + m;
            const cx = col * CELL + CELL / 2;
            const cy = row * ROW + ROW - 30;
            // Cycle the facing per column so every direction is on the sheet.
            const dir = DIRS[(col + m) % 4]!;
            const kind = i % 2 === 0 ? ('agent' as const) : ('human' as const);
            const node = {
              name,
              kind,
              presence: 'online' as const,
              activity: 'working' as const,
              posture: 'working' as const,
              state: null,
              color: memberColor(name, kind),
              role: '',
            };
            const seed = seedOf(name);
            const skel = solveSkeleton({
              phase: (t * 0.6 + i * 0.13) % 1,
              sit: mode.sit,
              stride: mode.stride,
              run: false,
              t,
              typing: mode.sit ? typingBurst(seed, t) : 0,
              carry: null,
              help: false,
              gesture: 0,
              gestureT: 0,
              seed,
            });
            // Draw at an explicit screen point by faking the projection origin.
            const f = { ...fit, ox: cx, oy: cy };
            drawCharacter(ctx, f, {
              lx: 0,
              ly: 0,
              dir,
              node,
              skel,
              size: 1,
              alpha: 1,
              carry: null,
              t,
              seed,
            });
            ctx.fillStyle = 'rgba(30,20,10,.72)';
            ctx.font = canvasFont(11, '--font-mono', 400);
            ctx.textAlign = 'center';
            ctx.fillText(`${name} · ${kind[0]} · ${dir} · ${mode.label}`, cx, row * ROW + ROW - 6);
          });
        });
        // The office dog, at the same 4×: every pose, both facings for the walk.
        const petRow = Math.ceil(NAMES.length / cols) * 3;
        const PET_CELLS = [
          { label: 'sleep', mode: 'sleep' as const, flip: false },
          { label: 'curl', mode: 'curl' as const, flip: false },
          { label: 'sit', mode: 'sit' as const, flip: false },
          { label: 'walk', mode: 'walk' as const, flip: false },
          { label: 'walk · flipped', mode: 'walk' as const, flip: true },
          { label: 'stretch', mode: 'stretch' as const, flip: false },
        ];
        PET_CELLS.forEach((cell, i) => {
          const cx = i * CELL + CELL / 2;
          const cy = petRow * ROW + ROW - 60;
          drawDog(
            ctx,
            { ox: cx, oy: cy, scale: 3.4 },
            {
              lx: 0,
              ly: 0,
              mode: cell.mode,
              modeT: cell.mode === 'curl' ? (t * 0.9) % 1.1 : 1,
              phase: t * 1.3,
              flip: cell.flip,
              path: [],
              seg: 0,
              plan: 'nap',
              sitFor: 99,
            },
            t,
          );
          ctx.fillStyle = 'rgba(30,20,10,.72)';
          ctx.font = canvasFont(11, '--font-mono', 400);
          ctx.textAlign = 'center';
          ctx.fillText(`dog · ${cell.label}`, cx, petRow * ROW + ROW - 6);
        });
        raf = requestAnimationFrame(frame);
      };
      frame();
    })();

    return () => {
      stop = true;
      cancelAnimationFrame(raf);
    };
  }, []);

  return (
    <div style={{ background: '#e4a96b', minHeight: '100vh', padding: 16 }}>
      <canvas ref={ref} />
    </div>
  );
}
