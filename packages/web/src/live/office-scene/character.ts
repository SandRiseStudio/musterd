import { project, type Fit, type Pt } from './iso';
import { FWD } from './layout';
import { CHAR, type Skel, type V3 } from './skeleton';
import type { Dir, OfficeNode } from './types';

/**
 * The character painter: flattens a `Skel` (3D joints, see `skeleton.ts`) onto the 2:1 iso canvas.
 *
 * Deliberately dumb. It owns no animation — every curve lives in the skeleton — so it stays swappable:
 * this is the file a future 3D renderer *replaces*, while the walk cycle and the sit survive it.
 *
 * Two things it does own, both of which are depth, not motion:
 *  - **Facing.** Character space (+z forward, +x right) is rotated onto the floor by the member's facing,
 *    so one skeleton serves all four directions — no mirrored art, no baked profiles.
 *  - **Self-occlusion.** Limbs are depth-sorted *within* the character by their own world depth, so the
 *    near arm swings in front of the torso and the far arm behind it, and it falls out correctly for every
 *    facing rather than being special-cased per direction. The far limbs are also shaded down a touch,
 *    which is what stops a flat-filled figure from reading as a paper cut-out.
 */

const SKIN = '#f0c9a0';
const SKIN_DARK = '#d9ac82';
/** Torso thickness. Kept under 2×`CHAR.shoulderW` so the arms hang outside the body's silhouette. */
const TORSO_W = 25;

/** Darken/lighten an `hsl()` string by a lightness factor (mirrors render.ts's `hslL`). */
function hslL(color: string, f: number): string {
  const m = /hsl\(\s*([\d.]+)[, ]+([\d.]+)%[, ]+([\d.]+)%/.exec(color);
  if (!m) return color;
  const [, h, s, l] = m;
  return `hsl(${h}, ${s}%, ${Math.max(0, Math.min(100, Number(l) * f))}%)`;
}
/** Shade a flat fill for a limb that is on the character's far side — a cheap, effective depth cue. */
function far(color: string): string {
  return hslL(color, 0.82);
}

/** Where a character-space joint lands on screen, and how deep it is on the floor. */
interface Proj {
  p: Pt;
  d: number;
}

/**
 * Project one joint. Character space (x right, y up, z forward) is rotated onto the floor by the facing,
 * added to the member's floor point, projected, then lifted by the joint's height.
 */
function projector(lx: number, ly: number, dir: Dir, fit: Fit, s: number): (j: V3) => Proj {
  const f = FWD[dir];
  const r: [number, number] = [f[1], -f[0]]; // the character's right, on the floor
  return (j: V3): Proj => {
    const wx = lx + (f[0] * j.z + r[0] * j.x) * s;
    const wy = ly + (f[1] * j.z + r[1] * j.x) * s;
    const p = project(wx, wy, fit);
    return { p: { x: p.x, y: p.y - j.y * s * fit.scale }, d: wx + wy };
  };
}

/** A limb segment: a rounded bar from a→b. Flat-filled and capped, to sit with the blocky furniture. */
function bone(ctx: CanvasRenderingContext2D, a: Pt, b: Pt, w: number, color: string): void {
  ctx.strokeStyle = color;
  ctx.lineWidth = w;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.moveTo(a.x, a.y);
  ctx.lineTo(b.x, b.y);
  ctx.stroke();
}

function disc(ctx: CanvasRenderingContext2D, c: Pt, rx: number, ry: number, color: string): void {
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.ellipse(c.x, c.y, Math.max(0.1, rx), Math.max(0.1, ry), 0, 0, Math.PI * 2);
  ctx.fill();
}

export interface CharacterOpts {
  lx: number;
  ly: number;
  dir: Dir;
  node: OfficeNode;
  skel: Skel;
  /** Uniform size multiplier — nook/queue actors render at 0.72. */
  size: number;
  alpha: number;
  carry: boolean;
  /** Scene clock (s) and the member's seed — the face's own small life: a blink, an LED pulse. */
  t: number;
  seed: number;
}

/**
 * How open the eyes are, 0→1. A blink is *fast* (~120ms) and rare (every 4–8s, seeded per member), which
 * is precisely why it registers as alive rather than as a twitch — you never quite catch it happening.
 */
function blink(t: number, seed: number): number {
  const period = 4 + seed * 4;
  const p = (t + seed * 20) % period;
  if (p > 0.13) return 1;
  return Math.abs(p - 0.065) / 0.065; // shut and open again across the window
}

/**
 * Draw a member. `armsOnly` re-draws just the arms — the seated overlay pass, which paints the forearms
 * *over* the desk they are resting on (a seated member's whole arm is above the desk surface, so once the
 * desk slab has been painted the arms belong on top of it). See `renderScene`.
 */
export function drawCharacter(
  ctx: CanvasRenderingContext2D,
  fit: Fit,
  o: CharacterOpts,
  armsOnly = false,
): void {
  const { skel: k, node, dir, size } = o;
  const s = size;
  const px = projector(o.lx, o.ly, dir, fit, s);
  const u = fit.scale * s; // one logical unit, in screen px, at this character's size
  const acc = node.color;
  const dk = hslL(acc, 0.7);

  const prev = ctx.globalAlpha;
  if (o.alpha < 1) ctx.globalAlpha = Math.max(0, o.alpha);

  // ── the character's own parts, each with a depth so they sort against one another ──
  interface Part {
    d: number;
    fn: () => void;
  }
  const parts: Part[] = [];

  const arm = (i: 0 | 1): Part => {
    const sh = px(k.shoulder[i]);
    const el = px(k.elbow[i]);
    const wr = px(k.wrist[i]);
    const d = (sh.d + el.d + wr.d) / 3;
    // Behind the torso → shade down. `k.chest`'s depth is the reference plane.
    const back = d < px(k.chest).d;
    const c = back ? far(dk) : dk;
    return {
      d,
      fn: () => {
        bone(ctx, sh.p, el.p, 7.5 * u, c);
        bone(ctx, el.p, wr.p, 6.5 * u, c);
        disc(ctx, wr.p, 3.6 * u, 3.2 * u, back ? SKIN_DARK : SKIN); // the hand
      },
    };
  };

  const leg = (i: 0 | 1): Part => {
    const hp = px(k.hip[i]);
    const kn = px(k.knee[i]);
    const an = px(k.ankle[i]);
    const d = (hp.d + kn.d + an.d) / 3;
    const back = d < px(k.pelvis).d;
    const c = back ? far(dk) : dk;
    return {
      d,
      fn: () => {
        bone(ctx, hp.p, kn.p, 9 * u, c);
        bone(ctx, kn.p, an.p, 8 * u, c);
        // The foot: a small slab pointing the way the character faces.
        const toe = px({ x: k.ankle[i].x, y: 1.5, z: k.ankle[i].z + 6 });
        bone(ctx, an.p, toe.p, 5.5 * u, back ? far(dk) : dk);
      },
    };
  };

  if (armsOnly) {
    for (const p of [arm(0), arm(1)].sort((a, b) => a.d - b.d)) p.fn();
    if (o.carry) drawCarry(ctx, px, k, u);
    ctx.globalAlpha = prev;
    return;
  }

  // Contact shadow — tightens and darkens as the body settles, so a mid-stride lift reads off the floor.
  const ground = project(o.lx, o.ly, fit);
  disc(ctx, ground, 21 * u, 5.5 * u, 'rgba(0,0,0,0.16)');

  parts.push(leg(0), leg(1));

  // Torso: pelvis → chest → neck, tapering upward, plus a shoulder bar across the top. The bar is what
  // gives the silhouette actual shoulders instead of a tube, and it must stay narrower than `shoulderW` so
  // the arms hang clear of the body.
  const pel = px(k.pelvis);
  const ch = px(k.chest);
  const nk = px(k.neck);
  const shL = px(k.shoulder[0]);
  const shR = px(k.shoulder[1]);
  parts.push({
    d: ch.d,
    fn: () => {
      bone(ctx, pel.p, ch.p, TORSO_W * u, acc);
      bone(ctx, ch.p, nk.p, (TORSO_W - 5) * u, acc);
      bone(ctx, shL.p, shR.p, 9 * u, acc); // the shoulder line
      if (node.kind === 'agent') disc(ctx, ch.p, 3 * u, 2.8 * u, '#74e08a'); // the chest LED
    },
  });

  parts.push(arm(0), arm(1));
  parts.sort((a, b) => a.d - b.d);
  for (const p of parts) p.fn();

  // The head always paints last — it is the top of the silhouette at every facing, and it is the thing the
  // eye reads first, so it never gets clipped by an arm.
  drawHead(ctx, px, k, node, dir, u, acc, o.t, o.seed);
  if (o.carry) drawCarry(ctx, px, k, u);

  ctx.globalAlpha = prev;
}

/** The head, and the agent/human tell — antenna + visor, or hair + eyes. */
function drawHead(
  ctx: CanvasRenderingContext2D,
  px: (j: V3) => Proj,
  k: Skel,
  node: OfficeNode,
  dir: Dir,
  u: number,
  acc: string,
  t: number,
  seed: number,
): void {
  // A short neck, so the head is *carried* rather than welded onto the shoulders.
  const nk = px(k.neck);
  const hd = px(k.head);
  bone(ctx, nk.p, hd.p, 8 * u, SKIN_DARK);
  const r = k.headR * u;
  disc(ctx, hd.p, r, r * 0.98, SKIN);
  // The face only reads when the character is turned toward the viewer; from behind it is just a head.
  const facingUs = dir === 'S' || dir === 'E';

  if (node.kind === 'agent') {
    const tip = px({ x: k.head.x, y: k.head.y + CHAR.headR + 10, z: k.head.z });
    bone(ctx, hd.p, tip.p, 1.8 * u, acc);
    // The LED breathes — an agent's one involuntary sign of life, and it reads from right across the room.
    const pulse = 0.82 + 0.18 * Math.sin(t * 1.6 + seed * 6);
    disc(ctx, tip.p, 3.6 * u * pulse, 3.4 * u * pulse, '#74e08a');
    if (facingUs) {
      // The visor sits on the face, so it must ride the head's forward offset, not the head's centre.
      const vis = px({ x: k.head.x, y: k.head.y - 1.5, z: k.head.z + CHAR.headR * 0.6 });
      ctx.fillStyle = '#2e3a38';
      ctx.beginPath();
      ctx.ellipse(vis.p.x, vis.p.y, r * 0.74, r * 0.3, 0, 0, Math.PI * 2);
      ctx.fill();
    }
  } else {
    // Hair: a cap over the crown, tinted from the member's own colour so it stays in the palette.
    const cap = px({ x: k.head.x, y: k.head.y + 5, z: k.head.z - 1 });
    disc(ctx, cap.p, r * 1.02, r * 0.62, hslL(node.color, 0.42));
    if (facingUs) {
      const open = blink(t, seed);
      for (const dx of [-0.4, 0.4]) {
        const e = px({ x: k.head.x + dx * CHAR.headR, y: k.head.y - 1, z: k.head.z + CHAR.headR * 0.7 });
        disc(ctx, e.p, 2.3 * u, 2.4 * u * open, '#2e2a26');
      }
    }
  }
}

/** The handoff box, carried at the chest between the hands. */
function drawCarry(ctx: CanvasRenderingContext2D, px: (j: V3) => Proj, k: Skel, u: number): void {
  const c = px({ x: 0, y: k.chest.y - 1, z: k.chest.z + 13 });
  ctx.fillStyle = '#b592f0';
  ctx.fillRect(c.p.x - 11 * u, c.p.y - 9 * u, 22 * u, 17 * u);
  ctx.fillStyle = '#8a5fd6';
  ctx.fillRect(c.p.x - 11 * u, c.p.y - 9 * u, 22 * u, 5 * u);
}
