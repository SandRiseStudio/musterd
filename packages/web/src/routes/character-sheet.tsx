import { createFileRoute } from '@tanstack/react-router';
import { useEffect, useRef } from 'react';
import { canvasFont, preloadCanvasFont } from '../live/canvasFont';
import { memberColor } from '../live/format';
import type { CarryKind } from '../live/office-scene/types';

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
  'dev', 'eli', 'fen', 'gus', 'hana', 'ivy', 'jo', 'kit', // a name, not the toolkit synonym <!-- vocab:ok -->
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
      const [
        { drawCharacter },
        { solveSkeleton, seedOf, typingBurst, handsInLap },
        { drawDog, drawActor, deskStationItems, actorSortAnchor, actorDepth, seatedArmsDepth },
        { CHAIR_OFF, FWD },
      ] = await Promise.all([
        import('../live/office-scene/character'),
        import('../live/office-scene/skeleton'),
        import('../live/office-scene/render'),
        import('../live/office-scene/layout'),
      ]);
      if (stop) return;

      const CELL = 190;
      /* 250, not the 210 a lone body needed: the seated row draws a whole workstation now, and a desk
         with a monitor standing on it is roughly twice a seated body's height. At 210 the monitor and
         the desk's far edge were cropped off the top of the row — the sheet exists to show exactly
         that kind of thing, so it cannot be the thing being cut off. */
      const ROW = 250;
      const cols = 6;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      // 3 blocks (seated+typing / walking / standing) × 4 facings each is too wide; instead: for each name,
      // one row of 4 facings seated, and a second sweep walking. Keep it to a readable grid.
      // + 2 extra rows at the bottom: the office dog, one cell per pose (it needs the same 4× scrutiny;
      // 9 poses wrap onto a second row rather than walking off the right edge of the sheet).
      const rows = Math.ceil(NAMES.length / cols) * 3 + 2;
      const W = cols * CELL;
      const H = rows * ROW + 40;
      canvas.width = W * dpr;
      canvas.height = H * dpr;
      canvas.style.width = `${W}px`;
      canvas.style.height = `${H}px`;
      const ctx = canvas.getContext('2d')!;

      /*
       * `?carry=laptop|box|plate|bottle|mug|phone` — DRAW THE SHEET WITH SOMETHING IN HAND.
       *
       * This sheet exists to put every body at every facing under 4x scrutiny, and it hardcoded
       * `carry: null`, so the one class of defect that is ABOUT facing was the one class it could not
       * show. That cost a real bug: the carried laptop painted after the body's own depth sort, so a
       * member walking away from the camera showed the laptop through their own back, and the tool
       * used to review bodies could not draw the frame that proves it (nick, 2026-09-14).
       *
       * Value, not presence, because there are six things to carry — unlike `?reduced` on
       * /office-preview, which is one room or the other. Inert and null unless asked for, so the
       * sheet's empty-handed day job is unchanged.
       */
      /*
       * `?gesture=N` — PLAY A GESTURE ON THE WHOLE SHEET, looping.
       *
       * Same blind spot `?carry=` fixed, one layer along: this sheet exists to put every body at every
       * facing under 4x scrutiny, and it hardcoded `gesture: 0`, so the one thing it could not show was
       * a beat. Reviewing a new gesture meant hunting it in the room at 40px and hoping the scheduler
       * picked the member you were watching (miley, 2026-09-14, adding four idle beats).
       *
       * `gestureT` is driven off the sheet clock so the beat plays over and over — a still frame of an
       * arc tells you almost nothing, and the interesting failures (a hand through a skull, an arm
       * inside the torso) happen mid-window.
       */
      const gesture = (() => {
        const v = new URLSearchParams(window.location.search).get('gesture');
        const n = v ? Number(v) : 0;
        return Number.isFinite(n) && n > 0 ? n : 0;
      })();

      const carry = (() => {
        const v = new URLSearchParams(window.location.search).get('carry');
        const kinds = ['laptop', 'box', 'plate', 'bottle', 'mug', 'phone'];
        return v && kinds.includes(v) ? (v as CarryKind) : null;
      })();

      const t0 = performance.now();
      const frame = () => {
        if (stop) return;
        const t = (performance.now() - t0) / 1000;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.fillStyle = '#e4a96b';
        ctx.fillRect(0, 0, W, H);
        // The carry as ONE sheet caption, not a per-cell label suffix: CELL is only wide enough for
        // `name · kind · dir · mode`, and appending to each cell ran the text into its neighbour's.
        // A screenshot of this sheet still has to say what it is showing, so it says it once.
        if (carry || gesture) {
          ctx.fillStyle = 'rgba(30,20,10,.72)';
          ctx.font = canvasFont(12, '--font-mono', 400);
          ctx.textAlign = 'left';
          const bits = [carry ? `carrying · ${carry}` : '', gesture ? `gesture · ${gesture}` : ''];
          ctx.fillText(bits.filter(Boolean).join('   ·   '), 10, 20);
        }

        // A big "fit" so one logical unit is ~1.6px — the character reads at roughly 4× office size.
        const fit = { ox: 0, oy: 0, scale: 1.55 };

        const MODES = [
          { label: 'seated', sit: 1, stride: 0, dir: 'S' as const }, // typing is visible in the cell; the label has to fit CELL
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
              service: false,
              presence: 'online' as const,
              activity: 'working' as const,
              posture: 'working' as const,
              state: null,
              color: memberColor(name, kind),
              role: '',
              surface: null,
              model: null,
              workTitle: null,
              workSource: null,
              laneState: null,
              moreLanes: 0,
              dnd: false,
              offline_reason: null,
              last_seen_at: null,
              // The character sheet draws BODIES, not sessions — nothing here came from a wake.
              woken: false,
            };
            const seed = seedOf(name);
            const skel = solveSkeleton({
              phase: (t * 0.6 + i * 0.13) % 1,
              sit: mode.sit,
              stride: mode.stride,
              run: false,
              t,
              typing: mode.sit ? typingBurst(seed, t) : 0,
              carry,
              help: false,
              gesture,
              gestureT: gesture ? (t * 0.45) % 1 : 0,
              seed,
            });
            // Draw at an explicit screen point by faking the projection origin.
            const f = { ...fit, ox: cx, oy: cy };

            /*
             * THE SEATED CELL DRAWS A WHOLE STATION, not a body in mid-air.
             *
             * A seated member in the room is SIX interleaved depth items — desk slab, the desk's
             * room-side half again at the front edge, chair cushion, chair back, the body, and the
             * forearms a second time on TOP of the slab. This sheet drew item five and called the row
             * "seated · typing". Everything that makes a seated beat a seated beat was therefore
             * unshowable on the one tool built to show it: the arms-over-desk overlay (#1397 was that
             * pass disagreeing with the slab), `handsInLap` suppressing it for lean/roll, and the
             * chair beats, which move a chair this cell did not have. #1394's regression — a desk
             * burying a sitter's head and torso at N/W facings — reached nick on the live broadcast
             * for exactly this reason (lane 01M2K1G140).
             *
             * It calls the ROOM'S OWN builder with a one-desk slot at this cell's fake origin, and
             * sorts by the room's own keys. A fixture that draws its own approximation of a desk is
             * worse than no fixture: it drifts, and then it is confidently wrong. Nothing about the
             * paint order is decided here — `deskStationItems` decides it, once, for both surfaces.
             */
            if (mode.sit) {
              /* The station sits 22px higher in its cell than a lone body did. At an N or W facing the
                 chair is on the NEAR side, so the sitter and their chair extend toward the viewer past
                 the desk's own origin — far enough at 4x to land on the caption. Raising the whole
                 station keeps the desk clear of the top of the row and the sitter clear of the label. */
              const sf = { ...f, oy: cy - 22 };
              const slot = { id: i, lx: 0, ly: 0, dir, pod: -1, kind: 'pod' as const };
              const fwd = FWD[dir];
              // Seated means sitting in the chair, which stands CHAIR_OFF back from the desk centre —
              // the same offset the room seats people at, so `actorSortAnchor` recognises this as
              // "at their own desk" rather than as a walker who happens to be nearby.
              const pose = {
                lx: slot.lx - fwd[0] * CHAIR_OFF,
                ly: slot.ly - fwd[1] * CHAIR_OFF,
                dir,
                small: false,
                carry,
                bubble: null,
                alpha: 1,
                moving: false,
                run: false,
                gesture,
                gestureT: gesture ? (t * 0.45) % 1 : 0,
                phase: 0,
                stride: 0,
                sit: 1,
              };
              const station = deskStationItems(ctx, sf, slot, node, {
                ownerPose: pose,
                teamName: 'revive',
                t,
              });
              const anchor = actorSortAnchor(pose, slot, undefined);
              const cellItems = [
                ...station.items,
                { d: actorDepth(anchor.lx, anchor.ly), fn: () => drawActor(ctx, sf, pose, node, t) },
              ];
              // The overlay, under the room's own gate: a beat that drops the hands into the lap must
              // NOT paint them over the slab, and a sheet that always drew it would hide that bug.
              if (!handsInLap(pose.gesture, pose.gestureT)) {
                cellItems.push({
                  d: seatedArmsDepth(slot),
                  fn: () => drawActor(ctx, sf, pose, node, t, true),
                });
              }
              for (const item of [...cellItems].sort((a, b) => a.d - b.d)) item.fn();
              ctx.fillStyle = 'rgba(30,20,10,.72)';
              ctx.font = canvasFont(11, '--font-mono', 400);
              ctx.textAlign = 'center';
              ctx.fillText(`${name} · ${kind[0]} · ${dir} · ${mode.label}`, cx, row * ROW + ROW - 6);
              return;
            }

            drawCharacter(ctx, f, {
              lx: 0,
              ly: 0,
              dir,
              node,
              skel,
              size: 1,
              alpha: 1,
              carry,
              // The painter reads these too, not just the skeleton — the sip mug sorts against the head
              // by gesture, so a sheet that solved the pose but drew with gesture 0 would disagree with
              // the room about where a hand is.
              gesture,
              gestureT: gesture ? (t * 0.45) % 1 : 0,
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
        // `face` is the drawn facing (+1 right → −1 left); the mid-turn cell holds it part-way through
        // so the swivel's foreshortening can be judged at 4× instead of only in a 150ms blur on the
        // floor — the one frame of that motion nobody could ever actually look at.
        const PET_CELLS = [
          { label: 'sleep', mode: 'sleep' as const, face: 1, depthSign: 1 as const },
          { label: 'curl', mode: 'curl' as const, face: 1, depthSign: 1 as const },
          { label: 'sit', mode: 'sit' as const, face: 1, depthSign: 1 as const },
          { label: 'walk', mode: 'walk' as const, face: 1, depthSign: 1 as const },
          { label: 'walk · flipped', mode: 'walk' as const, face: -1, depthSign: 1 as const },
          { label: 'walk · mid-turn', mode: 'walk' as const, face: 0.38, depthSign: 1 as const },
          // The narrow headings: the crossfaded chest-on / rump-on views (the old paper-thin frames).
          { label: 'walk · toward', mode: 'walk' as const, face: 0.18, depthSign: 1 as const },
          { label: 'walk · away', mode: 'walk' as const, face: 0.18, depthSign: -1 as const },
          { label: 'stretch', mode: 'stretch' as const, face: 1, depthSign: 1 as const },
        ];
        PET_CELLS.forEach((cell, i) => {
          const cx = (i % cols) * CELL + CELL / 2;
          const cy = (petRow + Math.floor(i / cols)) * ROW + ROW - 60;
          drawDog(
            ctx,
            { ox: cx, oy: cy, scale: 3.4 },
            {
              lx: 0,
              ly: 0,
              mode: cell.mode,
              modeT: cell.mode === 'curl' ? (t * 0.9) % 1.1 : 1,
              phase: t * 1.3,
              flip: cell.face < 0,
              face: cell.face,
              faceMag: Math.abs(cell.face),
              depthSign: cell.depthSign,
              path: [],
              seg: 0,
              plan: 'nap',
              sitFor: 99,
              speed: 55,
              vel: 55,
            },
            t,
          );
          ctx.fillStyle = 'rgba(30,20,10,.72)';
          ctx.font = canvasFont(11, '--font-mono', 400);
          ctx.textAlign = 'center';
          ctx.fillText(`dog · ${cell.label}`, cx, (petRow + Math.floor(i / cols)) * ROW + ROW - 6);
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
