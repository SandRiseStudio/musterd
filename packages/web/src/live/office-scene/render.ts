import { canvasFont } from '../canvasFont';
import type { WorkingHours } from '@musterd/protocol';
import type { Appearance } from './appearance';
import { drawCharacter } from './character';
import { depth, FLOOR, KX, KY, project, THICK, WALL_H, type Fit, type Pt } from './iso';
import { STRIDE, type PetState } from './pet';
import { RECEPTIONIST_WAKE_S, type ReceptionistState } from './receptionist';
import {
  BEAM_LEN,
  BEAM_SHEAR,
  ART,
  BOOKSHELVES,
  CHAIR_LIFT,
  CHAIR_OFF,
  CHAIR_SEAT_H,
  DESK_D,
  DESK_LEG_H,
  DESK_SLAB,
  BENCH,
  DESK_SLOTS,
  END_TABLE,
  DESK_UP,
  DESK_W,
  ENTRANCE,
  FRONT_DESK,
  RECEPTIONIST,
  FWD,
  KEYBOARD_ALONG,
  LEISURE_SPOTS,
  LOUNGE,
  MEETING,
  NOOK,
  NOOK_RUG,
  NOOK_RUG_R,
  PLANTS,
  PODS,
  POD_RUG,
  POD_RUG_DUO,
  POD_RUG_SOLO,
  PRINTER,
  RECEPTION,
  SEAT_TOP,
  SINK,
  WAIT_CHAIR,
  WALL_BOARD,
  WORKING_HOURS_CALENDAR,
  WINDOWS,
  type Bookshelf,
  type DeskSlot,
  type Rug,
} from './layout';
import { STICKY_CAP, type WallBoard } from './wallboard';
import { DAY_ENV, type LightEnv } from './lighting';
import { CANVAS_EASE } from './motion';
import { deskMoodFor, deskMoodStyle } from './moods';
import type { Placement } from './seating';
import { chairShift, chairYaw, GESTURE, handsInLap, seedOf, solveSkeleton, typingBurst } from './skeleton';
import type { Dir, OfficeNode, Pose } from './types';
import { formatWorkingHours } from './workingHours';

/**
 * Canvas-2D drawing for the office. Everything is painter-ordered by logical depth (lx+ly) so seated
 * members sit correctly behind their desks and nearer pods overlap farther ones. The static scene is
 * baked once per data/resize; transient act cues are drawn on top each frame. Fidelity ported from the
 * Figma "Floor Plan": legged desks + task chairs + oriented glowing monitors, a rich break nook
 * (couch + armchairs + kitchenette), huddle spaces, and big floor plants.
 */


/**
 * Theme-varying scene surfaces — the floor and the wooden/upholstered furniture. Furniture-*intrinsic*
 * colours (books, monitors, plants, skin, glass, the entrance door) are identity, not theme, and stay
 * fixed. index.ts resolves these from the office tokens (`--floor`, `--floor-2`, `--wood`, `--couch`)
 * that the active theme cascades to the canvas host, then calls `setScenePalette` before each bake — so
 * the same scene paints daylight on a light page and dusk inside the `.lc` stage.
 */
export interface ScenePalette {
  floor: string;
  floor2: string;
  wood: string;
  couch: string;
  /** The back walls — a warm interior surface (the `--wall` token, unused until now). */
  wall: string;
}

/** Dusk office (mirrors the dusk tokens in tokens.css) — also the fallback when a token can't be read. */
export const DARK_PALETTE: ScenePalette = {
  floor: '#ebae64',
  floor2: '#c8863c',
  wood: '#85552c',
  couch: '#e3a72b',
  wall: '#2a2030', // the dusk `--wall` token (tokens.css)
};

let PAL: ScenePalette = DARK_PALETTE;
export function setScenePalette(p: ScenePalette): void {
  PAL = p;
}

/** The lighter desk/counter surface — derived from the wood base so it tracks the theme in one place. */
function woodTop(): string {
  return mul(PAL.wood, 1.12);
}

// ── colour utils ──────────────────────────────────────────────────────────
function hexRgb(h: string): [number, number, number] {
  const s = h.replace('#', '');
  return [parseInt(s.slice(0, 2), 16), parseInt(s.slice(2, 4), 16), parseInt(s.slice(4, 6), 16)];
}
/** Multiply a hex colour toward black — for iso side/front face shading. */
/**
 * Scale a hex colour's channels. **Returns hex, so its own output can be fed back in** — `box()` shades a
 * solid's side faces by re-`dim()`ing the colour it was handed, so anything that returns a colour here is
 * a potential input to this function.
 *
 * It used to return `rgb(r, g, b)`, which `hexRgb` can't parse: `parseInt('rg', 16)` is `NaN`, so a
 * re-shaded colour came out `rgb(NaN, NaN, …)`. Canvas **silently ignores an invalid `fillStyle` and keeps
 * the previous one** — no throw, no warning — so those faces were painted in whatever colour the last draw
 * happened to leave behind, which changed with the depth-sort order. That's what turned the kitchenette
 * counter's sides green once idle members moved off the desks and reordered the scene. `render.test.ts`
 * guards it: every colour the scene assigns must be one canvas can actually parse.
 */
function mul(h: string, f: number): string {
  const [r, g, b] = hexRgb(h);
  const c = (v: number) => Math.round(Math.min(255, Math.max(0, v * f)));
  const hex = (v: number) => c(v).toString(16).padStart(2, '0');
  return `#${hex(r)}${hex(g)}${hex(b)}`;
}
/** Darken/lighten an `hsl()` string by a lightness factor. */
function hslL(color: string, f: number): string {
  const m = /hsl\(\s*([-\d.]+),\s*([\d.]+)%,\s*([\d.]+)%\s*\)/.exec(color);
  if (!m) return color;
  return `hsl(${m[1]}, ${m[2]}%, ${Math.max(0, Math.min(100, Number(m[3]) * f))}%)`;
}
/** Shade either an `hsl()` (member) or `#hex` (furniture) colour. */
function dim(color: string, f: number): string {
  return color.startsWith('hsl') ? hslL(color, f) : mul(color, f);
}

/** The office act-tone palette (mirrors Live.css `--lc-*`). */
export function toneColor(tone: string): string {
  switch (tone) {
    case 'accent':
      return '#f4cf52';
    case 'success':
      return '#5cd49a';
    case 'danger':
      return '#f3776a';
    case 'info':
      return '#88a9cf';
    case 'handoff':
      return '#c6a3ff';
    case 'lane':
      return '#8b84ff'; // indigo (mirrors --lc-lane) — lane transitions + defer's plan mutation
    case 'status':
      return '#2ad6bb';
    case 'steer':
      return '#ef6bbd'; // magenta-rose (mirrors --lc-steer) — interrupt-class redirect, prominent
    case 'challenge':
      return '#4bc4e0'; // cyan (mirrors --lc-challenge) — the epistemic "justify?"
    default:
      return '#ffd49a';
  }
}

// ── primitives ──────────────────────────────────────────────────────────────
function quad(ctx: CanvasRenderingContext2D, pts: Pt[], fill: string): void {
  ctx.beginPath();
  ctx.moveTo(pts[0]!.x, pts[0]!.y);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i]!.x, pts[i]!.y);
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();
}

function ellipse(ctx: CanvasRenderingContext2D, c: Pt, rx: number, ry: number, fill: string): void {
  ctx.beginPath();
  ctx.ellipse(c.x, c.y, Math.max(0.2, rx), Math.max(0.2, ry), 0, 0, Math.PI * 2);
  ctx.fillStyle = fill;
  ctx.fill();
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
  fill: string,
): void {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();
}

/** An iso block: three faces (top lightest, front medium, right darkest), footprint w×d (logical),
 * height hPx (screen px at scale 1), floated `baseUp` px off the floor. */
function box(
  ctx: CanvasRenderingContext2D,
  fit: Fit,
  lx: number,
  ly: number,
  w: number,
  d: number,
  hPx: number,
  base: string,
  baseUp = 0,
): void {
  const A = project(lx - w / 2, ly - d / 2, fit);
  const B = project(lx + w / 2, ly - d / 2, fit);
  const C = project(lx + w / 2, ly + d / 2, fit);
  const D = project(lx - w / 2, ly + d / 2, fit);
  const lo = baseUp * fit.scale;
  const hi = (baseUp + hPx) * fit.scale;
  const dn = (p: Pt, u: number): Pt => ({ x: p.x, y: p.y - u });
  quad(ctx, [dn(B, lo), dn(C, lo), dn(C, hi), dn(B, hi)], shade(base, 0.72));
  quad(ctx, [dn(D, lo), dn(C, lo), dn(C, hi), dn(D, hi)], shade(base, 0.86));
  quad(ctx, [dn(A, hi), dn(B, hi), dn(C, hi), dn(D, hi)], base);
}
/**
 * A `box` whose top footprint differs from its bottom — the shape of anything that tapers: a plant pot,
 * a waste bin, a lampshade. Same two visible side faces and the same shading as `box`, so a frustum and a
 * box sitting side by side read as the same material under the same light.
 */
function frustum(
  ctx: CanvasRenderingContext2D,
  fit: Fit,
  lx: number,
  ly: number,
  w0: number,
  d0: number,
  w1: number,
  d1: number,
  hPx: number,
  base: string,
  baseUp = 0,
): void {
  const at = (w: number, d: number, u: number): Pt[] =>
    [
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
    ].map(([sx, sy]) => {
      const p = project(lx + (sx! * w) / 2, ly + (sy! * d) / 2, fit);
      return { x: p.x, y: p.y - u };
    });
  // A0 (the far-top corner) is occluded by the box's own faces — the hole keeps the positional
  // destructure aligned with `at`'s corner order rather than renaming the three that are drawn.
  const [, B0, C0, D0] = at(w0, d0, baseUp * fit.scale);
  const [A1, B1, C1, D1] = at(w1, d1, (baseUp + hPx) * fit.scale);
  quad(ctx, [B0!, C0!, C1!, B1!], shade(base, 0.72));
  quad(ctx, [D0!, C0!, C1!, D1!], shade(base, 0.86));
  quad(ctx, [A1!, B1!, C1!, D1!], base);
}

/** Face shading that also handles hsl bases (member-tinted furniture like chairs). */
function shade(base: string, f: number): string {
  return dim(base, f);
}

// ── grounding: the diorama sits on the panel, not floating over it ──────────────────────────────────────
/**
 * A soft contact shadow pooled under the floor slab. Drawn first, before the floor — the opaque slab
 * paints over its middle, leaving only the penumbra spilling past the slab's edges, so the office reads
 * as a little model resting on the panel surface rather than a slab hanging in space. Elliptical (the
 * iso footprint), pooled toward the front where the slab base meets the ground.
 */
function drawGroundShadow(ctx: CanvasRenderingContext2D, fit: Fit): void {
  const back = project(0, 0, fit);
  const front = project(FLOOR, FLOOR, fit);
  const cx = fit.ox;
  const cy = (back.y + front.y) / 2 + THICK * fit.scale * 0.9; // pooled toward the slab's front base
  const rx = FLOOR * KX * fit.scale * 1.08;
  const ry = FLOOR * KY * fit.scale * 1.24;
  ctx.save();
  ctx.translate(cx, cy);
  ctx.scale(1, ry / rx); // draw a circle, squash it to the iso ellipse
  const g = ctx.createRadialGradient(0, 0, 0, 0, 0, rx);
  g.addColorStop(0, 'rgba(46, 30, 16, 0.30)');
  g.addColorStop(0.6, 'rgba(46, 30, 16, 0.17)');
  g.addColorStop(1, 'rgba(46, 30, 16, 0)');
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(0, 0, rx, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

/**
 * A gentle edge vignette framing the whole diorama, so the scene fades into the panel toward the corners
 * instead of hitting a hard rectangular cut. Drawn last, in device pixels (transform reset), so it covers
 * the panel exactly at any DPR — the same "overshoots-are-harmless" trick the night veil uses, but here we
 * need the true panel centre, so we go through the identity transform.
 */
function drawVignette(ctx: CanvasRenderingContext2D): void {
  const w = ctx.canvas.width;
  const h = ctx.canvas.height;
  const cx = w / 2;
  const cy = h / 2;
  const diag = Math.hypot(w, h);
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  const g = ctx.createRadialGradient(cx, cy, diag * 0.33, cx, cy, diag * 0.62);
  g.addColorStop(0, 'rgba(26, 17, 9, 0)');
  g.addColorStop(1, 'rgba(26, 17, 9, 0.2)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
  ctx.restore();
}

// ── furniture ─────────────────────────────────────────────────────────────
function drawFloor(ctx: CanvasRenderingContext2D, fit: Fit): void {
  const c00 = project(0, 0, fit);
  const c10 = project(FLOOR, 0, fit);
  const c11 = project(FLOOR, FLOOR, fit);
  const c01 = project(0, FLOOR, fit);
  const th = THICK * fit.scale;
  const dn = (p: Pt): Pt => ({ x: p.x, y: p.y + th });
  quad(ctx, [c10, c11, dn(c11), dn(c10)], PAL.floor2);
  quad(ctx, [c01, c11, dn(c11), dn(c01)], mul(PAL.floor2, 0.955));
  quad(ctx, [c00, c10, c11, c01], PAL.floor);

  // A basket-weave field of long ceramic tiles. Alternating paired orientations keeps the tactile scale
  // of the first pass without turning the whole room into a checkerboard.
  ctx.save();
  ctx.strokeStyle = 'rgba(126, 73, 30, 0.24)';
  ctx.lineWidth = Math.max(0.55, 0.85 * fit.scale);
  const cell = 90;
  const half = cell / 2;
  const plank = (lx: number, ly: number, w: number, d: number, fill: string): void => {
    const pts = [
      project(lx, ly, fit),
      project(lx + w, ly, fit),
      project(lx + w, ly + d, fit),
      project(lx, ly + d, fit),
    ];
    quad(ctx, pts, fill);
    ctx.beginPath();
    ctx.moveTo(pts[0]!.x, pts[0]!.y);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i]!.x, pts[i]!.y);
    ctx.closePath();
    ctx.stroke();
  };
  for (let lx = 0; lx < FLOOR; lx += cell) {
    for (let ly = 0; ly < FLOOR; ly += cell) {
      const warm = ((lx + ly) / cell) % 3 === 0;
      const light = warm ? 'rgba(255, 247, 211, 0.18)' : 'rgba(255, 237, 191, 0.1)';
      const shade = warm ? 'rgba(162, 88, 31, 0.065)' : 'rgba(136, 72, 25, 0.045)';
      if ((lx / cell + ly / cell) % 2 === 0) {
        plank(lx, ly, half, cell, light);
        plank(lx + half, ly, half, cell, shade);
      } else {
        plank(lx, ly, cell, half, shade);
        plank(lx, ly + half, cell, half, light);
      }
    }
  }

  // Pearlescent glints at a sparse, deterministic set of joints: a quiet "coordination dust" trail that
  // makes the floor magical up close without turning the office into a particle effect.
  ctx.globalCompositeOperation = 'lighter';
  for (let gx = 1; gx < FLOOR / cell; gx++) {
    for (let gy = 1; gy < FLOOR / cell; gy++) {
      if ((gx * 7 + gy * 11) % 13 !== 0) continue;
      const p = project(gx * cell, gy * cell, fit);
      const glow = 7 * fit.scale;
      const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, glow);
      g.addColorStop(0, 'rgba(255, 250, 213, 0.78)');
      g.addColorStop(0.28, 'rgba(255, 226, 148, 0.35)');
      g.addColorStop(1, 'rgba(255, 226, 148, 0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(p.x, p.y, glow, 0, Math.PI * 2);
      ctx.fill();
      ellipse(ctx, p, 2.5 * fit.scale, 1.5 * fit.scale, 'rgba(255, 252, 226, 0.92)');
    }
  }
  ctx.restore();
}

// ── the room shell: the two back walls + their windows (office-walls-windows.md) ────────────────────────
// The floor diamond's back corner is (0,0). The two back walls rise from the two upper edges meeting there:
// the `ly=0` edge (back-right) and the `lx=0` edge (back-left, the one the door sits in). They are drawn
// ONCE as a backdrop — right after the floor, before the depth-sorted items — because a wall spans many
// depths (it is one plane) and so can't take a single depth key; nothing on the floor is ever *behind* the
// back edges, so a backdrop that every furniture piece paints over is correct at every position.

// WALL_H (the back-wall height in screen px at scale 1) lives in iso.ts now — the fit has to reserve room
// for it above the diamond, so it's owned there and imported here for the drawing.

// The windows + beam geometry live in layout.ts (the dog's sunbeam nap spots derive from the same data).

/**
 * The glass colour: bright sky by day (warm at golden hour via `skyTint`), a dark pane with a faint city
 * glow by night. Interpolated on `daylight`, so it tracks the same PST clock as the beam and the veil.
 */
/**
 * Brighten an `rgb(...)` string by a factor, staying in `rgb(...)`.
 *
 * `glassColor` returns `rgb()`, not hex, and `mul()` only parses hex — feeding one to the other gives
 * `#NaN0b15`, which canvas silently ignores while keeping whatever colour was loaded last. That is the
 * exact class of bug the parseable-colour guard in render.test.ts exists for, and this is the third
 * time this pass has walked into it. If you need to scale a colour, check what format it is in first.
 */
function rgbMul(color: string, f: number): string {
  const m = /rgb\((\d+),\s*(\d+),\s*(\d+)\)/.exec(color);
  if (!m) return color;
  const c = (v: string) => Math.round(Math.min(255, Math.max(0, Number(v) * f)));
  return `rgb(${c(m[1]!)}, ${c(m[2]!)}, ${c(m[3]!)})`;
}

export function glassColor(env: LightEnv): string {
  const [sr, sg, sb] = hexRgb('#0f1626'); // night pane
  const m = /rgb\((\d+),\s*(\d+),\s*(\d+)\)/.exec(env.skyTint);
  const [dr, dg, db] = m ? [Number(m[1]), Number(m[2]), Number(m[3])] : [206, 226, 244];
  const t = env.daylight;
  const c = (n: number, d: number) => Math.round(n + (d - n) * t);
  return `rgb(${c(sr, dr)}, ${c(sg, dg)}, ${c(sb, db)})`;
}

/**
 * Draw the two back walls and their windows. `edge(t,u)` maps a wall coordinate to the floor point + lift,
 * so the same body serves both walls — the back-right wall runs `lx` along the `ly=0` edge, the back-left
 * runs `ly` along the `lx=0` edge.
 */
/** The two back-wall edges, as `t ∈ [0,1] → floor point` — shared by the walls, the string-light cable,
 * and the ambient-magic overlay anchors (`magicAnchors`). */
const WALL_EDGES: ReadonlyArray<(t: number) => [number, number]> = [
  (t) => [0, t * FLOOR], // back-left wall (the lx=0 edge)
  (t) => [t * FLOOR, 0], // back-right wall (the ly=0 edge)
];

/** A wall-surface point: `t` along the edge, `u` up the wall (0 floor … 1 top). */
function wallPt(edge: (t: number) => [number, number], t: number, u: number, fit: Fit): Pt {
  const [lx, ly] = edge(t);
  const p = project(lx, ly, fit);
  return { x: p.x, y: p.y - u * WALL_H * fit.scale };
}

/** The sagging string-light cable for one wall — bulbs hang at the odd indices (see drawWalls). */
function cablePts(edge: (t: number) => [number, number], fit: Fit): Pt[] {
  const out: Pt[] = [];
  for (let i = 0; i <= 12; i++) {
    const t = 0.1 + (i / 12) * 0.8;
    const sag = Math.sin((i / 12) * Math.PI) * 0.045;
    out.push(wallPt(edge, t, 0.91 - sag, fit));
  }
  return out;
}

// ── back-wall dressing ────────────────────────────────────────────────────────────────────────────────
// The walls already carry the windows and the string lights; everything hung on them lives here. It all
// goes in the gaps the windows leave (t ∈ [0.02,0.26] · [0.48,0.56] · [0.80,0.98]) and above the
// bookshelves (u > 0.36), so the dressing never fights the room's existing furniture or its light.

const DRESS = {
  frame: '#5b4130',
  mat: '#f2e7d5',
  clockFace: '#f6ead2',
  clockRim: '#4b3524',
  tick: '#94795c',
  hand: '#3a2a1c',
  rope: '#8a6a4a',
  pot: '#b9603a',
  potRim: '#cb6f45',
  vine: '#5f8f4b',
} as const;

/** A rectangle in wall space: `t` along the wall, `u` up it. */
function wallRect(
  ctx: CanvasRenderingContext2D,
  fit: Fit,
  edge: (t: number) => [number, number],
  t0: number,
  u0: number,
  t1: number,
  u1: number,
  fill: string,
): void {
  const pt = (t: number, u: number): Pt => wallPt(edge, t, u, fit);
  quad(ctx, [pt(t0, u0), pt(t1, u0), pt(t1, u1), pt(t0, u1)], fill);
}

/**
 * A disc of logical radius `r` lying flat *on* the wall. `wallPt` shears it onto the wall plane, so a
 * circle drawn here lands on screen as the ellipse a real circle on that wall would — the radius has to be
 * converted per axis (the wall is FLOOR long and WALL_H tall) or it comes out an egg.
 */
function wallDisc(
  ctx: CanvasRenderingContext2D,
  fit: Fit,
  edge: (t: number) => [number, number],
  tc: number,
  uc: number,
  r: number,
  fill: string,
): void {
  const pts: Pt[] = [];
  for (let i = 0; i < 24; i++) {
    const a = (i / 24) * Math.PI * 2;
    pts.push(wallPt(edge, tc + (Math.sin(a) * r) / FLOOR, uc + (Math.cos(a) * r) / WALL_H, fit));
  }
  quad(ctx, pts, fill);
}

/**
 * The prints' ink. Deliberately few colours, and all of them the room's own: each frame occupies only
 * ~30–45px on screen, where a motif reads as a silhouette plus two or three flats and any further
 * shade is just mud.
 */
const INK = {
  // A dusk sand, not the near-mat cream it wants to be: against #f2e7d5 the sky has to hold its own or
  // the print reads as shapes floating on the mat with no paper under them.
  sky: '#e8cfa8',
  paper: '#efe2c8',
  terracotta: '#c2694a',
  sage: '#5d7f6d',
  sageDeep: '#3f5747',
  ochre: '#d2a24c',
  teal: '#4e7d8c',
  plum: '#8a5a6d',
  line: '#4b3524',
} as const;

/**
 * The surface one print is painted on: `a` runs across the mat opening and `b` up it, both in logical
 * units out from its centre. It is the wall-space convention `wallDisc`/`wallClock` already use, which is
 * what keeps a motif's disc a real circle *on the wall* rather than a screen-space egg pasted over it.
 */
interface ArtSurface {
  rect: (a0: number, b0: number, a1: number, b1: number, fill: string) => void;
  disc: (a: number, b: number, r: number, fill: string) => void;
}

/** A print's composition, painted into an opening of half-width `hw` and half-height `hh`. */
type Motif = (g: ArtSurface, hw: number, hh: number) => void;

/**
 * The four prints. Every one of them survives being mirrored, and not by luck: the back-left wall runs
 * `+t` screen-*left*, which is the same quirk that forced the clock onto the right wall. Abstract
 * compositions are the answer — a mirrored cairn is still a cairn, where a mirrored clock lies.
 */
const MOTIFS = {
  /** A sun going down behind two bands of hill. Wants a landscape frame — the horizon is the whole idea. */
  sunrise: (g, hw, hh) => {
    g.rect(-hw, -hh, hw, hh, INK.sky);
    g.disc(hw * 0.08, -hh * 0.12, hh * 0.48, INK.terracotta); // the sun sits *in* the hills, not over them
    g.rect(-hw, -hh, hw, -hh * 0.3, INK.sage);
    g.rect(-hw, -hh, hw, -hh * 0.62, INK.sageDeep);
  },
  /** A cairn of three balanced stones: the one motif whose silhouette alone carries it, so it takes the
   * small portrait frame where nothing else would survive the size. */
  cairn: (g, hw, hh) => {
    g.rect(-hw, -hh, hw, hh, INK.paper);
    g.rect(-hw, -hh, hw, -hh * 0.72, INK.line);
    g.disc(0, -hh * 0.42, hh * 0.3, INK.terracotta);
    g.disc(hw * 0.1, hh * 0.02, hh * 0.24, INK.teal);
    g.disc(-hw * 0.06, hh * 0.4, hh * 0.17, INK.ochre);
  },
  /** Two arches, overlapping, on a ground line. */
  arches: (g, hw, hh) => {
    g.rect(-hw, -hh, hw, hh, INK.paper);
    const arch = (a0: number, a1: number, top: number, fill: string): void => {
      g.rect(a0, -hh, a1, top, fill);
      g.disc((a0 + a1) / 2, top, (a1 - a0) / 2, fill); // the dome — its radius is half the pier's width
    };
    arch(hw * 0.14, hw * 0.78, -hh * 0.12, INK.teal);
    arch(-hw * 0.72, -hw * 0.04, hh * 0.1, INK.terracotta);
    g.rect(-hw, -hh, hw, -hh * 0.8, INK.line);
  },
  /** Bauhaus-ish: a cornered quarter-disc, a bar, a floating dot, a rule. The quirky one. */
  bauhaus: (g, hw, hh) => {
    g.rect(-hw, -hh, hw, hh, INK.paper);
    g.disc(-hw, -hh, hh * 1.15, INK.plum); // the clip is what makes this a quarter, not a circle
    g.rect(hw * 0.04, -hh, hw * 0.44, hh * 0.5, INK.ochre);
    g.disc(hw * 0.62, hh * 0.34, hh * 0.32, INK.terracotta);
    g.rect(-hw, hh * 0.7, hw, hh * 0.78, INK.line);
  },
} satisfies Record<string, Motif>;

type MotifName = keyof typeof MOTIFS;

/** A framed print: frame, mat, and a motif in the opening. `w`/`h` in logical units. */
function wallArt(
  ctx: CanvasRenderingContext2D,
  fit: Fit,
  edge: (t: number) => [number, number],
  tc: number,
  uc: number,
  w: number,
  h: number,
  motif: MotifName,
  frame: 'thin' | 'thick' | 'none' = 'thick',
): void {
  const dt = w / 2 / FLOOR;
  const du = h / 2 / WALL_H;
  // Frame weight varies per piece. `none` is a stretched canvas — an unframed piece in a group is
  // what stops six prints reading as one catalogue order.
  if (frame !== 'none') {
    wallRect(ctx, fit, edge, tc - dt, uc - du, tc + dt, uc + du, DRESS.frame);
  }
  const inset = frame === 'thick' ? 0.88 : frame === 'thin' ? 0.95 : 1;
  wallRect(ctx, fit, edge, tc - dt * inset, uc - du * inset, tc + dt * inset, uc + du * inset, DRESS.mat);

  const hw = (w / 2) * 0.68; // the mat opening — a composition needs the area a lone colour block didn't
  const hh = (h / 2) * 0.68;
  const p = (a: number, b: number): Pt => wallPt(edge, tc + a / FLOOR, uc + b / WALL_H, fit);
  const g: ArtSurface = {
    rect: (a0, b0, a1, b1, fill) => quad(ctx, [p(a0, b0), p(a1, b0), p(a1, b1), p(a0, b1)], fill),
    disc: (a, b, r, fill) => {
      const pts: Pt[] = [];
      for (let i = 0; i < 20; i++) {
        const th = (i / 20) * Math.PI * 2;
        pts.push(p(a + Math.sin(th) * r, b + Math.cos(th) * r));
      }
      quad(ctx, pts, fill);
    },
  };
  // Clip to the opening, so a motif can run a shape straight off the edge — a sun half-under a horizon,
  // a disc cornered into a quarter — instead of every motif having to solve that intersection itself.
  ctx.save();
  ctx.beginPath();
  const corners: Array<[number, number]> = [
    [-hw, -hh],
    [hw, -hh],
    [hw, hh],
    [-hw, hh],
  ];
  corners.forEach(([a, b], i) => {
    const q = p(a, b);
    if (i === 0) ctx.moveTo(q.x, q.y);
    else ctx.lineTo(q.x, q.y);
  });
  ctx.closePath();
  ctx.clip();
  MOTIFS[motif](g, hw, hh);
  ctx.restore();
}

/**
 * The office wall clock, reading the office's own PST hour — the same number the lighting is computed
 * from, so the hands and the daylight can never disagree (and `?light=22` moves both).
 *
 * Right-hand wall only, and not by taste: on the back-left wall `+t` runs *screen-left*, so a clock hung
 * there would tell the time backwards.
 */
/**
 * The dial's twelve positions. `big` marks the quarters, which are the only ones set as numerals —
 * see `drawClockNumerals` for why twelve numerals cannot work on a 26px face.
 */
export const CLOCK_NUMERALS: ReadonlyArray<{ hour: number; big: boolean }> = [
  { hour: 12, big: true },
  { hour: 1, big: false },
  { hour: 2, big: false },
  { hour: 3, big: true },
  { hour: 4, big: false },
  { hour: 5, big: false },
  { hour: 6, big: true },
  { hour: 7, big: false },
  { hour: 8, big: false },
  { hour: 9, big: true },
  { hour: 10, big: false },
  { hour: 11, big: false },
];

/**
 * Paint the dial.
 *
 * Twelve numerals do not fit. The face is R=25 — about 26 screen px at /live — and the first cut set
 * all twelve as hand-drawn stroke paths, which nick called horrible, correctly: at that size each
 * numeral is a 4px scribble, and twelve scribbles in a ring is grit, not a clock.
 *
 * So the quarters get REAL TYPE, set large enough to actually read, and the other eight hours get
 * ticks. That is a normal, handsome way to draw a clock, and it spends the whole numeral budget on
 * the four positions a person actually reads a wall clock by. The type goes through `wallText` (and
 * therefore `canvasFont`), so it shears onto the wall and honours the font tokens.
 */
function drawClockNumerals(
  ctx: CanvasRenderingContext2D,
  fit: Fit,
  edge: (t: number) => [number, number],
  tc: number,
  uc: number,
  R: number,
): void {
  ctx.save();
  CLOCK_NUMERALS.forEach((n, i) => {
    const a = (i / 12) * Math.PI * 2;
    const ring = n.big ? 0.66 : 0.8;
    const t = tc + (Math.sin(a) * R * ring) / FLOOR;
    const u = uc + (Math.cos(a) * R * ring) / WALL_H;
    if (!n.big) {
      wallDisc(ctx, fit, edge, t, u, 1.3, DRESS.tick);
      return;
    }
    // Alphabetic baseline: drop it by about half a cap height so the numeral sits centred on its
    // ring position rather than hanging under it.
    const size = 11;
    wallText(ctx, fit, edge, t, u - (size * 0.35) / WALL_H, String(n.hour), size, DRESS.tick, 'center');
  });
  ctx.restore();
}

function wallClock(
  ctx: CanvasRenderingContext2D,
  fit: Fit,
  edge: (t: number) => [number, number],
  tc: number,
  uc: number,
  hours: number,
): void {
  const R = 25;
  wallDisc(ctx, fit, edge, tc, uc, R + 2.5, DRESS.clockRim);
  wallDisc(ctx, fit, edge, tc, uc, R, DRESS.clockFace);
  drawClockNumerals(ctx, fit, edge, tc, uc, R);
  // Hands: 12 o'clock is straight up the wall (+u), sweeping clockwise toward +t.
  const hand = (turns: number, len: number, w: number): void => {
    const a = turns * Math.PI * 2;
    const c = wallPt(edge, tc, uc, fit);
    const tip = wallPt(edge, tc + (Math.sin(a) * len) / FLOOR, uc + (Math.cos(a) * len) / WALL_H, fit);
    ctx.strokeStyle = DRESS.hand;
    ctx.lineWidth = w * fit.scale;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(c.x, c.y);
    ctx.lineTo(tip.x, tip.y);
    ctx.stroke();
  };
  hand((hours % 12) / 12, R * 0.5, 2.4); // the hour hand creeps with the minutes, as a real one does
  hand(hours % 1, R * 0.78, 1.5);
  wallDisc(ctx, fit, edge, tc, uc, 2, DRESS.hand);
}

/**
 * The agile board on the far-right wall — the team's real lanes as sticky notes. This deliberately
 * reverses the 2026-07-30 "set dressing only" decision: the whiteboard it replaced was a drawing of
 * work, this IS the work (nick, 2026-07-31). Same lane board the `/board` page renders, squinted at
 * from across the room — columns mirror `Board.tsx`, and on /live clicking it opens that very board,
 * so the glimpse and the close-up never disagree.
 *
 * What survives the /live downscale (~0.52) is colour and position, not words, so a lane is a
 * ~17×11-unit paper rectangle in its column's tone — above the ~10-unit resolvability floor — with a
 * seeded placement jitter so the wall reads as pinned by hands, not printed. The ONLY type is the
 * `+N` overflow badge at 9 units (the floor at which lettering survives; see the old diagram's
 * hard-won sizing notes in git history). Everything else the board says, it says with paper.
 *
 * It is a **pin board**, not a whiteboard (nick, 2026-08-02) — cork in a thin pale-oak frame, notes
 * held by washi tabs. The whiteboard reading was never only the white face: it was the face plus the
 * marker tray below it, and the tray is gone with it. What the material change buys is that the
 * notes now read as *paper someone put there*, which is what the board is actually claiming.
 *
 * `data` is null when no team is connected (previews, the connect form): the board still hangs,
 * face + caps + dividers, an empty week rather than a missing object.
 */
function wallLaneBoard(
  ctx: CanvasRenderingContext2D,
  fit: Fit,
  edge: (t: number) => [number, number],
  data: WallBoard | null,
): void {
  const { tc, uc, w: W, h: H } = WALL_BOARD;
  const p = (a: number, b: number): Pt => wallPt(edge, tc + a / FLOOR, uc + b / WALL_H, fit);
  const rect = (a0: number, b0: number, a1: number, b1: number, fill: string): void =>
    quad(ctx, [p(a0, b0), p(a1, b0), p(a1, b1), p(a0, b1)], fill);
  const stroke = (pts: [number, number][], width: number, color: string): void => {
    ctx.save();
    ctx.beginPath();
    const s0 = p(pts[0]![0], pts[0]![1]);
    ctx.moveTo(s0.x, s0.y);
    for (let i = 1; i < pts.length; i++) {
      const s = p(pts[i]![0], pts[i]![1]);
      ctx.lineTo(s.x, s.y);
    }
    ctx.strokeStyle = color;
    ctx.lineWidth = Math.max(0.6, width * fit.scale);
    ctx.lineCap = 'round';
    ctx.stroke();
    ctx.restore();
  };

  rect(-W / 2 + 4, -H / 2 - 4, W / 2 + 4, H / 2 - 4, PINBOARD.cast); // soft cast

  // The frame is LIGHTER than the cork, which is the whole reason it works: a dark surround would
  // make the board a hole in the wall, while a pale one reads as a lit edge and lets the cork become
  // the dark field the notes sit off. Thin, too — 3 units, a picture-frame lip, not a bulletin-board
  // slab (nick, 2026-08-02: "I like the pale oak but make the frame thin").
  const FR = 3;
  rect(-W / 2, -H / 2, W / 2, H / 2, PINBOARD.oak);
  stroke([[-W / 2, H / 2], [W / 2, H / 2]], 1, PINBOARD.oakLit); // sunlit top lip
  stroke([[-W / 2, -H / 2], [W / 2, -H / 2]], 1, PINBOARD.oakShade); // shaded underside
  rect(-W / 2 + FR, -H / 2 + FR, W / 2 - FR, H / 2 - FR, PINBOARD.cork);

  // Cork freckle. Seeded off the index alone (not off lane data) so the surface is *the same cork*
  // every frame — a texture that reshuffles on repaint reads as static, not as material. Kept to 150
  // flecks: each one is four wall projections, and this paints inside the ambient loop.
  for (let i = 0; i < 150; i++) {
    const h = Math.imul(i + 1, 2654435761) >>> 0;
    const a = -W / 2 + FR + 1.5 + ((h % 4096) / 4096) * (W - FR * 2 - 3);
    const b = -H / 2 + FR + 1.5 + (((h >>> 12) % 4096) / 4096) * (H - FR * 2 - 3);
    const sz = 0.9 + ((h >>> 24) % 3) * 0.35;
    rect(a, b, a + sz, b + sz, PINBOARD.fleck[h % 3]!);
  }
  // Where the cork meets the frame's top lip, one darker line — the shadow the frame casts onto the
  // cork. It is what seats the cork *inside* the frame instead of flush with it.
  stroke([[-W / 2 + FR, H / 2 - FR], [W / 2 - FR, H / 2 - FR]], 1, PINBOARD.inner);

  // Six columns inside the frame. No ruled dividers any more: cork has no lines on it, and the cap
  // strips alone carry the column read.
  const M = FR + 2;
  const colW = (W - M * 2) / WALLBOARD_TONES.length;

  for (let i = 0; i < WALLBOARD_TONES.length; i++) {
    const tone = WALLBOARD_TONES[i]!;
    const a0 = -W / 2 + M + i * colW;
    const mid = a0 + colW / 2;
    // The cap strip: each column announces its state in full colour even when it holds nothing.
    rect(a0 + 2, H / 2 - M - 2.5, a0 + colW - 2, H / 2 - M, tone.cap);

    const col = data?.[i];
    if (!col) continue;
    // Stickies hang from just under the cap, newest at the bottom (board order, same as /board).
    const noteW = 17;
    const noteH = 11;
    for (let s = 0; s < col.stickies.length; s++) {
      const seed = col.stickies[s]!.seed;
      // Seeded jitter, ±1.5 units across and ±0.8 up — pinned by a hand, stable across repaints.
      const ja = (((seed >>> (s * 3)) % 7) - 3) * 0.5;
      const jb = (((seed >>> (s * 5 + 2)) % 5) - 2) * 0.4;
      const top = H / 2 - M - 6 - s * (noteH + 2.5) + jb;
      const l = mid - noteW / 2 + ja;
      const r = mid + noteW / 2 + ja;
      // Shadow first, offset down-right: paper held a hair off the cork rather than printed on it.
      rect(l + 0.8, top - noteH - 0.8, r + 0.8, top - 0.8, PINBOARD.noteCast);
      rect(l, top - noteH, r, top, tone.note);
      // The washi tab, straddling the note's top edge onto the cork — the tape is doing the holding,
      // so it has to overlap both. Its own sheen line is what stops it reading as a painted stripe.
      const tw = 8;
      rect(mid - tw / 2 + ja, top - 1.6, mid + tw / 2 + ja, top + 1.6, tone.tape);
      rect(mid - tw / 2 + ja, top + 1, mid + tw / 2 + ja, top + 1.6, PINBOARD.tapeSheen);
    }
    // The overflow badge — the one piece of type, at the size that survives the downscale.
    if (col.count > STICKY_CAP) {
      const b = H / 2 - M - 6 - STICKY_CAP * (13.5) - 4;
      wallText(ctx, fit, edge, tc + mid / FLOOR, uc + b / WALL_H, `+${col.count - STICKY_CAP}`, 9, tone.cap, 'center');
    }
  }

  // Frame thickness — the outer edge of the oak, so the board reads as an object standing off the wall.
  stroke([[-W / 2, -H / 2], [W / 2, -H / 2], [W / 2, H / 2], [-W / 2, H / 2], [-W / 2, -H / 2]], 0.9, PINBOARD.oakShade);
}

/**
 * Column tones, one per `WALL_COLUMNS` entry in order. Canvas can't read CSS custom properties, so
 * these mirror Live.css's lane/danger/success tones as hex the way `WHITEBOARD` already does: `cap`
 * is the full-value state colour, `note` its paper-pastel wash. Board columns, left to right:
 * open · claimed · active · blocked · awaiting_acceptance · done.
 *
 * `tape` is the washi tab holding each note to the cork: the cap colour at ~75%, so the tab reads as
 * translucent paper tape over both the note and the cork behind it. Written out rather than derived
 * because canvas takes a colour string, and a per-note hex→rgba conversion would run every frame.
 */
const WALLBOARD_TONES: ReadonlyArray<{ cap: string; note: string; tape: string }> = [
  // open — warm unbleached paper
  { cap: '#B4A88F', note: '#EFE8D8', tape: 'rgba(180, 168, 143, 0.75)' },
  // claimed — lane indigo, lightened: picked up, not yet moving
  { cap: '#948DDE', note: '#E6E3F8', tape: 'rgba(148, 141, 222, 0.75)' },
  // active — the lane tone itself (--lc-lane)
  { cap: '#5A52C9', note: '#D8D4F3', tape: 'rgba(90, 82, 201, 0.75)' },
  // blocked — --lc-danger
  { cap: '#D1503F', note: '#F5DAD4', tape: 'rgba(209, 80, 63, 0.75)' },
  // awaiting acceptance — indigo leaning patient
  { cap: '#7A72D6', note: '#DFDCF6', tape: 'rgba(122, 114, 214, 0.75)' },
  // done — --lc-success
  { cap: '#2F9E6A', note: '#D5ECDF', tape: 'rgba(47, 158, 106, 0.75)' },
];

/**
 * The pin board's materials: pale oak, cork, and the shadows that seat one inside the other.
 *
 * The frame is deliberately *lighter* than the cork it holds. The instinct with a bulletin board is a
 * dark surround, and it is wrong here for a specific reason: this wall is warm cream, and a dark
 * frame on it reads as a hole punched through the wall. A pale one reads as a lit edge — and it
 * demotes the frame, which matters, because the loudest thing on this object has to stay the notes.
 */
const PINBOARD = {
  oak: '#DCBF8E',
  /** The top lip, where the window light lands. */
  oakLit: '#F0DCB4',
  /** Underside and outer edge — the frame's own thickness. */
  oakShade: '#B9915F',
  cork: '#C98F52',
  /** Three freckle tones: two lighter than the cork, one darker, so the surface reads as grain. */
  fleck: ['#B87C42', '#D9A468', '#AB7038'],
  /** The frame's shadow falling onto the cork, along the inside of the top lip. */
  inner: 'rgba(80, 45, 15, 0.35)',
  cast: 'rgba(58, 34, 12, 0.16)',
  /** Under each note — paper held off the cork by its tape, not printed onto it. */
  noteCast: 'rgba(60, 35, 10, 0.26)',
  /** The washi tab's own highlight; without it the tape is just a painted stripe. */
  tapeSheen: 'rgba(255, 251, 240, 0.5)',
} as const;

/**
 * Type lying ON a wall, sheared onto its plane rather than pasted over it in screen space.
 *
 * The wall's local frame, in the units the rest of this file already uses: one step along `t` is one
 * logical FLOOR unit, which projects to (KX, KY)·scale; one step of `u` is one WALL_H px, which is
 * (0, −1)·scale. Feeding those as a matrix puts the glyphs on the wall, leaning with the isometric.
 *
 * Two things this must get right. Local y runs **down** the wall (the matrix's `d` is +scale, not
 * −scale): canvas glyphs extend in +y from the baseline, so an up-positive frame draws every letter
 * upside down. And it composes with `transform`, never `setTransform` — the context already carries the
 * device-pixel-ratio matrix, and replacing it outright would paint this text at the wrong size on
 * every retina display.
 */
function wallText(
  ctx: CanvasRenderingContext2D,
  fit: Fit,
  edge: (t: number) => [number, number],
  t: number,
  u: number,
  text: string,
  size: number,
  fill: string,
  align: CanvasTextAlign = 'left',
): void {
  const o = wallPt(edge, t, u, fit);
  ctx.save();
  ctx.translate(o.x, o.y);
  ctx.transform(KX * fit.scale, KY * fit.scale, 0, fit.scale, 0, 0);
  ctx.font = canvasFont(size, '--font-mono', 700);
  ctx.fillStyle = fill;
  ctx.textAlign = align;
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(text, 0, 0);
  ctx.restore();
}


/**
 * The largest of `size` that still fits `text` inside `maxUnits` logical wall units. Measured with the
 * wall transform *off*: one text unit is one logical FLOOR unit either way, and `measureText` is the only
 * honest answer once copy is data (a schedule can say `MON · WED · FRI` as easily as `MON–FRI`).
 */
function fitTextSize(ctx: CanvasRenderingContext2D, text: string, size: number, maxUnits: number): number {
  ctx.save();
  ctx.font = canvasFont(size, '--font-mono', 700);
  const width = ctx.measureText(text).width;
  ctx.restore();
  return width > maxUnits ? (size * maxUnits) / width : size;
}

/** A planter hung off the wall on a bracket, trailing vines — the one piece of dressing with some droop. */
function wallHanger(
  ctx: CanvasRenderingContext2D,
  fit: Fit,
  edge: (t: number) => [number, number],
  tc: number,
  uTop: number,
): void {
  const pt = (t: number, u: number): Pt => wallPt(edge, t, u, fit);
  // Short cords: run them long and the pot swings under a narrow V that reads as a handbag, not a planter.
  const uPot = uTop - 17 / WALL_H;
  const bt = 15 / FLOOR;

  /**
   * An ellipse in WALL space — a ring of `wallPt` samples rather than `ctx.ellipse`, so it shears with
   * the wall like everything else on it. This is the shape that does the heavy lifting below: the whole
   * "it looks flat, not 3D-ish" complaint (nick, 2026-07-30) came down to the pot having no visible
   * opening. A trapezoid is a shape; a trapezoid with an ellipse across its mouth is a container.
   */
  const wallEllipse = (t: number, u: number, rt: number, ru: number, fill: string): void => {
    const pts: Pt[] = [];
    for (let i = 0; i < 18; i++) {
      const th = (i / 18) * Math.PI * 2;
      pts.push(pt(t + (Math.cos(th) * rt) / FLOOR, u + (Math.sin(th) * ru) / WALL_H));
    }
    quad(ctx, pts, fill);
  };

  /** One trailing vine. `back` runs it behind the pot, dimmed — see the ordering note below. */
  const vine = (dt: number, drop: number, back: boolean): void => {
    ctx.strokeStyle = back ? dim(DRESS.vine, 0.72) : DRESS.vine;
    ctx.lineWidth = Math.max(0.8, (back ? 1.4 : 1.7) * fit.scale);
    ctx.lineCap = 'round';
    const a = pt(tc + dt / FLOOR, uPot);
    const c = pt(tc + (dt * 1.9) / FLOOR, uPot - drop / 2 / WALL_H);
    const b = pt(tc + (dt * 1.4) / FLOOR, uPot - drop / WALL_H);
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.quadraticCurveTo(c.x, c.y, b.x, b.y);
    ctx.stroke();
    ellipse(ctx, b, (back ? 2.8 : 3.4) * fit.scale, (back ? 2.1 : 2.6) * fit.scale, back ? dim(DRESS.vine, 0.72) : DRESS.vine);
  };

  // Cords, converging on ONE bracket point rather than running near-parallel — parallel cords are the
  // other half of the flat read, because nothing in the picture recedes.
  ctx.strokeStyle = DRESS.rope;
  ctx.lineWidth = Math.max(0.6, 1.1 * fit.scale);
  for (const dt of [-13 / FLOOR, 0, 13 / FLOOR]) {
    ctx.beginPath();
    const a = pt(tc, uTop);
    const b = pt(tc + dt, uPot);
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
  }
  ctx.beginPath(); // the bracket it all hangs from
  const h0 = pt(tc, uTop);
  ctx.arc(h0.x, h0.y, Math.max(0.8, 1.6 * fit.scale), 0, Math.PI * 2);
  ctx.fillStyle = DRESS.rope;
  ctx.fill();

  // Painter's order is the whole trick, and it is why the vines are split rather than looped once:
  // BACK vines → pot → rim → interior → FRONT vines. Foliage passing behind the pot is what states
  // that the pot has a far side at all. Drawn in one pass they all sit in front, and the plant reads
  // as a decal stuck on top of a bowl.
  vine(-15, 30, true);
  vine(9, 40, true);

  // The bowl: a tapered body with a shaded side, so it is lit rather than filled flat.
  quad(
    ctx,
    [pt(tc - bt, uPot), pt(tc + bt, uPot), pt(tc + bt * 0.62, uPot - 17 / WALL_H), pt(tc - bt * 0.62, uPot - 17 / WALL_H)],
    DRESS.pot,
  );
  quad(
    ctx,
    [pt(tc + bt * 0.34, uPot), pt(tc + bt, uPot), pt(tc + bt * 0.62, uPot - 17 / WALL_H), pt(tc + bt * 0.38, uPot - 17 / WALL_H)],
    dim(DRESS.pot, 0.86),
  );
  // The mouth: rim ellipse, then the shadowed interior inside it.
  wallEllipse(tc, uPot, 15, 5.2, DRESS.potRim);
  wallEllipse(tc, uPot - 0.4 / WALL_H, 12.2, 3.9, dim(DRESS.pot, 0.62));
  wallEllipse(tc, uPot - 1.6 / WALL_H, 9.5, 2.6, DRESS.vine); // the soil/foliage crown in the opening

  vine(-11, 34, false);
  vine(2, 50, false);
  vine(12, 27, false);
}

function drawWalls(
  ctx: CanvasRenderingContext2D,
  fit: Fit,
  env: LightEnv,
  teamWorkingHours: WorkingHours | null = null,
  wallBoard: WallBoard | null = null,
  t = 0,
): void {
  /**
   * What each wall carries. The right wall gets the clock (it is the only one whose `+t` runs screen-right,
   * so it is the only one a clock can be hung on) plus a print over the corner bookshelf and a pair by the
   * corner; the left wall gets a tall print between its windows and the hanging planter. Nothing sits below
   * u 0.36 (the bookshelves' height) or inside a window's `t` span.
   */
  const dress = (edge: (t: number) => [number, number], wallIndex: 0 | 1): void => {
    // Nothing goes high near the back corner: that is where the wall is tallest on screen and the canvas
    // crops its top edge, so anything hung up there loses the wall behind it and floats.
    for (const a of ART) {
      if (a.wall !== wallIndex) continue;
      wallArt(ctx, fit, edge, a.tc, a.uc, a.w, a.h, a.motif, a.frame);
    }
    if (wallIndex === 1) {
      wallClock(ctx, fit, edge, 0.52, 0.62, env.hours); // dead centre, between the windows
      if (teamWorkingHours) workingHoursSign(ctx, fit, edge, teamWorkingHours, t);
      // The agile board — far-right gap. Must be THIS wall: `+t` runs screen-left on the other one
      // (same constraint that fixed the clock here), and a kanban has a reading direction.
      wallLaneBoard(ctx, fit, edge, wallBoard);
      return;
    }
    wallHanger(ctx, fit, edge, 0.52, 0.76); // between the windows — where you'd really hang one
  };

  const wall = (
    edge: (t: number) => [number, number],
    faceShade: number,
  ): void => {
    const pt = (t: number, u: number): Pt => wallPt(edge, t, u, fit);
    // the wall face
    quad(ctx, [pt(0, 0), pt(1, 0), pt(1, 1), pt(0, 1)], shade(PAL.wall, faceShade));
    // a darker top cap, so the wall has a lip where it meets the (absent) ceiling
    quad(ctx, [pt(0, 1), pt(1, 1), pt(1, 1.04), pt(0, 1.04)], shade(PAL.wall, faceShade * 0.86));
    // windows
    const frame = shade(PAL.wall, faceShade * 0.7);
    const glass = glassColor(env);
    for (const w of WINDOWS) {
      quad(ctx, [pt(w.t0, w.u0), pt(w.t1, w.u0), pt(w.t1, w.u1), pt(w.t0, w.u1)], frame); // reveal
      const iT = (w.t1 - w.t0) * 0.08;
      const iU = (w.u1 - w.u0) * 0.1;
      // One sun: the nearer window is brighter. This is the change that buys most of the warmth, and
      // it costs nothing in realism because it is simply what happens.
      quad(ctx, [pt(w.t0 + iT, w.u0 + iU), pt(w.t1 - iT, w.u0 + iU), pt(w.t1 - iT, w.u1 - iU), pt(w.t0 + iT, w.u1 - iU)], rgbMul(glass, w.bright));
      // Panes, so it reads as a window rather than a lit hole. The vertical count alternates between
      // units — a real facade mixes them, and four identical windows was the complaint.
      const midU = (w.u0 + w.u1) / 2;
      for (let m = 1; m < w.mullions; m++) {
        const t = w.t0 + ((w.t1 - w.t0) * m) / w.mullions;
        quad(ctx, [pt(t - iT * 0.3, w.u0 + iU), pt(t + iT * 0.3, w.u0 + iU), pt(t + iT * 0.3, w.u1 - iU), pt(t - iT * 0.3, w.u1 - iU)], frame);
      }
      quad(ctx, [pt(w.t0 + iT, midU - iU * 0.35), pt(w.t1 - iT, midU - iU * 0.35), pt(w.t1 - iT, midU + iU * 0.35), pt(w.t0 + iT, midU + iU * 0.35)], frame);
      // A bloom where the light spills onto the wall above the head — the glow a bright window
      // actually throws, and the reason the top of the reveal never reads as a hard cut.
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = 0.16 * w.bright;
      quad(ctx, [pt(w.t0 - 0.012, w.u1), pt(w.t1 + 0.012, w.u1), pt(w.t1 + 0.012, w.u1 + 0.07), pt(w.t0 - 0.012, w.u1 + 0.07)], '#ffe9b8');
      ctx.restore();
      // The sill, and whatever is standing on it. A window without a ledge is a hole in a wall.
      const sillU = w.u0 - 0.018;
      quad(ctx, [pt(w.t0 - 0.014, sillU), pt(w.t1 + 0.014, sillU), pt(w.t1 + 0.014, w.u0), pt(w.t0 - 0.014, w.u0)], shade(PAL.wall, faceShade * 1.06));
      if (w.sill) {
        const st = (w.t0 + w.t1) / 2 + (w.t1 - w.t0) * 0.24;
        const sp = pt(st, w.u0);
        const r = fit.scale;
        if (w.sill === 'plant') {
          ellipse(ctx, { x: sp.x, y: sp.y - 4 * r }, 4.5 * r, 4 * r, PLANT.pot);
          ellipse(ctx, { x: sp.x, y: sp.y - 10 * r }, 6 * r, 5 * r, PLANT.leaf);
          ellipse(ctx, { x: sp.x - 3 * r, y: sp.y - 12 * r }, 3.5 * r, 3 * r, PLANT.leafLit);
        } else {
          ellipse(ctx, { x: sp.x, y: sp.y - 4 * r }, 3.6 * r, 3.4 * r, '#f2e7d5');
          ellipse(ctx, { x: sp.x, y: sp.y - 6 * r }, 3.2 * r, 1.6 * r, '#c9a887');
        }
      }
    }

    dress(edge, edge === WALL_EDGES[1] ? 1 : 0);

    // A low, slightly sagging strand of warm bulbs turns the architectural shell into a place people
    // chose to inhabit. The bulbs stay on in daylight too, but read as tiny pearl pins rather than glare.
    const cable = cablePts(edge, fit);
    ctx.save();
    ctx.strokeStyle = 'rgba(91, 61, 38, 0.46)';
    ctx.lineWidth = Math.max(0.7, 1.25 * fit.scale);
    ctx.beginPath();
    cable.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
    ctx.stroke();
    ctx.globalCompositeOperation = 'lighter';
    for (let i = 1; i < cable.length - 1; i += 2) {
      const p = cable[i]!;
      const r = 8 * fit.scale;
      const glow = ctx.createRadialGradient(p.x, p.y + 2 * fit.scale, 0, p.x, p.y + 2 * fit.scale, r);
      glow.addColorStop(0, 'rgba(255, 236, 166, 0.76)');
      glow.addColorStop(0.25, 'rgba(255, 190, 82, 0.35)');
      glow.addColorStop(1, 'rgba(255, 190, 82, 0)');
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(p.x, p.y + 2 * fit.scale, r, 0, Math.PI * 2);
      ctx.fill();
      ellipse(ctx, { x: p.x, y: p.y + 2 * fit.scale }, 2.4 * fit.scale, 2.9 * fit.scale, '#fff0b0');
    }
    ctx.restore();
  };
  // Two faces at slightly different shades so the back corner reads (like box()'s side faces).
  // back-left wall (lx=0 edge) is a touch darker — more edge-on to the implied upper-left light.
  wall(WALL_EDGES[0]!, 0.9);
  // back-right wall (ly=0 edge) catches more of that light.
  wall(WALL_EDGES[1]!, 0.99);
}

/** Monday-first, the order the week strip reads in. */
const WEEK = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;

/** The wall calendar that turns the Team's recurring schedule into a warm office ritual. */
function workingHoursSign(
  ctx: CanvasRenderingContext2D,
  fit: Fit,
  edge: (t: number) => [number, number],
  schedule: WorkingHours,
  t: number,
): void {
  const copy = formatWorkingHours(schedule);
  if (!copy) return;
  const { tc, uc, w: W, h: H } = WORKING_HOURS_CALENDAR;
  // Everything below is laid out in logical wall units off the card's centre, because that is the space
  // the copy is measured in too — mixing the two is what let the schedule line run off the paper.
  const T = (dx: number): number => tc + dx / FLOOR;
  const U = (dy: number): number => uc + dy / WALL_H;
  const halfW = W / 2;
  const halfH = H / 2;
  const INNER = W - 18; // the paper's printable width: card less frame, trim and a breathing margin either side

  const BAND = halfH - 16; // the mustard header's lower edge — the paper proper starts here

  // No hanging cord: the clock's dial comes within a few units of the frame, and a cord tall enough to
  // read would cross it. The card sits flush, like the art on the same wall.
  ctx.save();
  ctx.globalAlpha = 0.22;
  wallRect(ctx, fit, edge, T(-halfW + 6), U(-halfH - 6), T(halfW + 6), U(halfH - 6), '#503522');
  ctx.globalAlpha = 1;
  wallRect(ctx, fit, edge, T(-halfW), U(-halfH), T(halfW), U(halfH), '#6a4a30'); // oak frame
  wallRect(ctx, fit, edge, T(-halfW), U(halfH - 2), T(halfW), U(halfH), '#8a6440'); // its sunlit top edge
  wallRect(ctx, fit, edge, T(-halfW + 2), U(-halfH + 2), T(halfW - 2), U(halfH - 2), '#c39a41'); // brass trim
  wallRect(ctx, fit, edge, T(-halfW + 4), U(-halfH + 4), T(halfW - 4), U(halfH - 4), '#fbf1d8'); // paper

  // The header: mustard, with a hairline of shadow under it so the band sits *on* the sheet.
  wallRect(ctx, fit, edge, T(-halfW + 4), U(BAND), T(halfW - 4), U(halfH - 4), '#e1ad01');
  wallRect(ctx, fit, edge, T(-halfW + 4), U(BAND - 1.5), T(halfW - 4), U(BAND), 'rgba(120,84,20,0.28)');
  // Two punched holes in the band, the way a wall calendar's top sheet is punched.
  for (const dx of [-halfW + 12, halfW - 12]) wallDisc(ctx, fit, edge, T(dx), U(halfH - 9), 2.2, '#b8862a');

  // The days on the band, the hours across the sheet. Both shrink to the paper rather than overrun it:
  // days can be a list ("MON · WED · FRI"), not just a run.
  const line = (dy: number, text: string, size: number, fill: string): void =>
    wallText(ctx, fit, edge, tc, U(dy), text, fitTextSize(ctx, text, size, INNER), fill, 'center');
  line(halfH - 13, copy.days, 11.5, '#4e331f');
  line(-7, copy.hours, 16, '#33261c');

  // A hairline rule, then a week strip: seven marks, the working ones filled. The strip says what the
  // days line says in the one language that survives being eight pixels tall, and gives the sheet a
  // foot to stand on rather than trailing off into blank paper.
  wallRect(ctx, fit, edge, T(-halfW + 13), U(-12), T(halfW - 13), U(-11.3), 'rgba(120,96,60,0.18)');
  const on = new Set(schedule.days);
  WEEK.forEach((day, i) => {
    const dx = (i - 3) * 11;
    const lit = on.has(day);
    wallDisc(ctx, fit, edge, T(dx), U(-17.5), 3.4, lit ? '#e1ad01' : 'rgba(120,96,60,0.2)');
    if (lit) wallDisc(ctx, fit, edge, T(dx), U(-17.5), 1.5, '#7a5a1c');
  });

  // A brass tack in the header gives the card a restrained life. t=0 is its complete, static
  // reduced-motion posture.
  ctx.globalAlpha = 0.72 + Math.sin(t * 1.2) * 0.08;
  wallDisc(ctx, fit, edge, T(-halfW + 12), U(halfH - 9), 1.1, '#f4dc9a');
  ctx.globalAlpha = 1;
  ctx.restore();
}

/** Deterministic 0..1 hash — the ambient-magic anchors must not shuffle on every rebake. */
function magicRnd(n: number): number {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}

/**
 * The agile board's screen-space bounding box — the DOM hotspot on /live is positioned from this
 * (the `magicAnchors` pattern: pure geometry out, index.ts places the element). The wall shears the
 * board, so the box brackets all four projected corners rather than trusting any two.
 */
export function boardAnchor(fit: Fit): { x: number; y: number; w: number; h: number } {
  const { tc, uc, w: W, h: H } = WALL_BOARD;
  const edge = WALL_EDGES[WALL_BOARD.wall]!;
  const corners = [
    wallPt(edge, tc - W / 2 / FLOOR, uc - H / 2 / WALL_H, fit),
    wallPt(edge, tc + W / 2 / FLOOR, uc - H / 2 / WALL_H, fit),
    wallPt(edge, tc + W / 2 / FLOOR, uc + H / 2 / WALL_H, fit),
    wallPt(edge, tc - W / 2 / FLOOR, uc + H / 2 / WALL_H, fit),
  ];
  const xs = corners.map((c) => c.x);
  const ys = corners.map((c) => c.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}

/**
 * Screen anchors for the ambient-magic CSS overlay (index.ts): golden dust motes floating inside each
 * window's daylight shaft, and a twinkle halo on each string-light bulb. Both mirror the geometry the
 * canvas draws — the beams (`drawWindowBeams`) and the cable (`cablePts`) — so the overlay sits exactly
 * on the painted light. Positions are hash-deterministic: rebakes reposition, never reshuffle.
 */
export function magicAnchors(fit: Fit): { motes: Pt[]; bulbs: Pt[] } {
  const motes: Pt[] = [];
  const bulbs: Pt[] = [];
  WALL_EDGES.forEach((edge, wi) => {
    // Bulbs: the same odd cable indices drawWalls glows (dropped the same 2px the canvas drops them).
    const cable = cablePts(edge, fit);
    for (let i = 1; i < cable.length - 1; i += 2) {
      bulbs.push({ x: cable[i]!.x, y: cable[i]!.y + 2 * fit.scale });
    }
    // Motes: a handful of points per window, scattered through the beam's floor throw and lifted off the
    // floor — they drift in the *shaft* of light, which is what sells the light as volume, not paint.
    WINDOWS.forEach((w, ci) => {
      for (let k = 0; k < 6; k++) {
        const n = wi * 100 + ci * 10 + k;
        const t = w.t0 + (0.15 + 0.7 * magicRnd(n)) * (w.t1 - w.t0);
        const d = 14 + magicRnd(n + 1) * BEAM_LEN * 0.72;
        const shear = (d / BEAM_LEN) * BEAM_SHEAR;
        const [ex, ey] = edge(t);
        const p = wi === 0 ? project(d, ey + shear, fit) : project(ex + shear, d, fit);
        motes.push({ x: p.x, y: p.y - (6 + magicRnd(n + 2) * 40) * fit.scale });
      }
    });
  });
  return { motes, bulbs };
}

/**
 * The daylight beams — a warm parallelogram of light cast from each window onto the floor, reaching into
 * the room and sheared sideways to imply an angled sun. Additive (it *adds* light), strength tied to
 * `skyStrength`, so at night there is simply no beam. Drawn on the floor before the furniture, so a desk
 * correctly sits *on* the light rather than glowing.
 */
function drawWindowBeams(ctx: CanvasRenderingContext2D, fit: Fit, env: LightEnv): void {
  if (env.skyStrength < 0.02) return;
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  const beam = (base: (t: number) => [number, number], into: (l: [number, number], d: number) => [number, number]): void => {
    for (const w of WINDOWS) {
      const a = base(w.t0);
      const b = base(w.t1);
      const far0 = into(a, BEAM_LEN);
      const far1 = into(b, BEAM_LEN);
      const pa = project(a[0], a[1], fit);
      const pb = project(b[0], b[1], fit);
      const pf0 = project(far0[0], far0[1], fit);
      const pf1 = project(far1[0], far1[1], fit);
      // fade along the throw: bright at the window sill, gone at the far end.
      const grad = ctx.createLinearGradient((pa.x + pb.x) / 2, (pa.y + pb.y) / 2, (pf0.x + pf1.x) / 2, (pf0.y + pf1.y) / 2);
      const m = /rgb\((\d+),\s*(\d+),\s*(\d+)\)/.exec(env.skyTint);
      const [r, g, bl] = m ? [m[1], m[2], m[3]] : ['255', '210', '150'];
      const peak = 0.5 * env.skyStrength;
      grad.addColorStop(0, `rgba(${r}, ${g}, ${bl}, ${peak})`);
      grad.addColorStop(1, `rgba(${r}, ${g}, ${bl}, 0)`);
      ctx.fillStyle = grad;
      ctx.beginPath();
      for (const [i, p] of [pa, pb, pf1, pf0].entries()) {
        if (i === 0) ctx.moveTo(p.x, p.y);
        else ctx.lineTo(p.x, p.y);
      }
      ctx.closePath();
      ctx.fill();
    }
  };
  // back-left wall (lx=0): beam throws into +lx, sheared along +ly.
  beam((t) => [0, t * FLOOR], (l, d) => [d, l[1] + (d / BEAM_LEN) * BEAM_SHEAR]);
  // back-right wall (ly=0): beam throws into +ly, sheared along +lx.
  beam((t) => [t * FLOOR, 0], (l, d) => [l[0] + (d / BEAM_LEN) * BEAM_SHEAR, d]);
  ctx.restore();
}

/** A round-ish iso rug (a filled iso square). */
function rug(ctx: CanvasRenderingContext2D, fit: Fit, lx: number, ly: number, r: number, fill: string): void {
  const A = project(lx - r, ly, fit);
  const B = project(lx, ly - r, fit);
  const C = project(lx + r, ly, fit);
  const D = project(lx, ly + r, fit);
  quad(ctx, [A, B, C, D], fill);
}

/** A rectangular iso rug — zones a pod / the meeting table / reception, which are rectangular, not round. */
function rugRect(
  ctx: CanvasRenderingContext2D,
  fit: Fit,
  lx: number,
  ly: number,
  w: number,
  d: number,
  fill: string,
): void {
  quad(
    ctx,
    [
      project(lx - w / 2, ly - d / 2, fit),
      project(lx + w / 2, ly - d / 2, fit),
      project(lx + w / 2, ly + d / 2, fit),
      project(lx - w / 2, ly + d / 2, fit),
    ],
    fill,
  );
}

/**
 * Paint a zone rug: its shape (rectangle or diamond) in its field colour, then its weave *inside* that
 * outline — an inset border, or stripes across the short axis. Every rug on the floor goes through here,
 * so a zone's rug is a piece of data (`Rug`) rather than a bespoke call, and no pattern can leak past a
 * rug's own edge onto the floor.
 */
function drawRug(ctx: CanvasRenderingContext2D, fit: Fit, r: Rug, lx: number, ly: number, w: number, d: number): void {
  if (r.shape === 'diamond') {
    rug(ctx, fit, lx, ly, w / 2, r.fill);
    if (r.weave === 'border') rug(ctx, fit, lx, ly, w / 2 - 14, r.mark);
    return;
  }
  rugRect(ctx, fit, lx, ly, w, d, r.fill);
  if (r.weave === 'border') {
    rugRect(ctx, fit, lx, ly, w - 26, d - 26, r.mark);
    rugRect(ctx, fit, lx, ly, w - 40, d - 40, r.fill);
  } else if (r.weave === 'stripes') {
    // bands running across the rug's short axis, inset from the ends so they read as woven, not painted on
    const across = w >= d;
    const span = across ? w : d;
    const inset = 18;
    for (let i = 0; i < 3; i++) {
      const off = -span / 4 + (i * span) / 4;
      const bw = across ? 16 : w - inset * 2;
      const bd = across ? d - inset * 2 : 16;
      rugRect(ctx, fit, lx + (across ? off : 0), ly + (across ? 0 : off), bw, bd, r.mark);
    }
  }
  // Four tiny pom-poms give every woven rectangle a handmade edge. They also break up the strict
  // box-on-box geometry without changing any footprints or painter-order assumptions.
  for (const [sx, sy] of [
    [-1, -1],
    [1, -1],
    [1, 1],
    [-1, 1],
  ] as const) {
    const p = project(lx + sx * (w / 2 - 4), ly + sy * (d / 2 - 4), fit);
    ellipse(ctx, p, 4.2 * fit.scale, 2.4 * fit.scale, r.mark);
  }
}

/** The meeting table: a long slab on four legs, with four chairs pulled up to it. */
function meetingTable(ctx: CanvasRenderingContext2D, fit: Fit): void {
  const M = MEETING;
  const s = project(M.lx, M.ly, fit);
  ellipse(ctx, { x: s.x, y: s.y + 2 * fit.scale }, (M.w / 2) * fit.scale, 20 * fit.scale, 'rgba(0,0,0,0.12)');
  for (const [sx, sy] of [
    [-1, -1],
    [1, -1],
    [1, 1],
    [-1, 1],
  ] as const) {
    box(ctx, fit, M.lx + sx * (M.w / 2 - 8), M.ly + sy * (M.d / 2 - 8), 8, 8, M.h - 6, dim(PAL.wood, 0.9));
  }
  box(ctx, fit, M.lx, M.ly, M.w, M.d, 6, woodTop(), M.h - 6);
  // The conference speakerphone: a three-lobed puck with a dark grille and one LED. This is the object
  // that tells you a table is a conference table rather than a long desk, which is the whole reason it
  // is here. Static — a blinking LED would drag the still layer onto the animated one for nothing.
  const hub = M.lx - 46;
  for (const [dx, dy] of [
    [0, -9],
    [8, 5],
    [-8, 5],
  ] as const) {
    box(ctx, fit, hub + dx, M.ly + dy, 13, 13, 3, '#3a3a3e', M.h);
  }
  box(ctx, fit, hub, M.ly, 17, 17, 4.5, '#2c2c30', M.h);
  const puck = project(hub, M.ly, fit);
  ellipse(ctx, { x: puck.x, y: puck.y - (M.h + 4.5) * fit.scale }, 5 * fit.scale, 2.4 * fit.scale, '#4a4a50');
  box(ctx, fit, hub + 5, M.ly - 4, 1.8, 1.8, 0.7, '#6ee7a0', M.h + 4.5); // the LED

  // A tiny shared centrepiece: ceramic pot, leaves, and mustard blossom. At office scale it reads as a
  // warm irregularity on the long slab; in companion mode the individual pieces resolve.
  box(ctx, fit, M.lx, M.ly, 14, 14, 9, '#efe2c6', M.h);
  const vase = project(M.lx, M.ly, fit);
  ellipse(ctx, { x: vase.x - 4 * fit.scale, y: vase.y - 43 * fit.scale }, 5 * fit.scale, 7 * fit.scale, '#6f985d');
  ellipse(ctx, { x: vase.x + 4 * fit.scale, y: vase.y - 45 * fit.scale }, 5 * fit.scale, 7 * fit.scale, '#7eaa69');
  ellipse(ctx, { x: vase.x, y: vase.y - 50 * fit.scale }, 3.5 * fit.scale, 3 * fit.scale, '#f4cf52');
}

/** A meeting chair — the same two-piece cushion/backrest trick as a task chair, in a plain wood tone. */
function meetingChair(ctx: CanvasRenderingContext2D, fit: Fit, lx: number, ly: number, dir: Dir): void {
  chairBase(ctx, fit, lx, ly, dir, '#8a6a4c');
  const f = FWD[dir];
  chairBack(ctx, fit, lx - f[0] * CHAIR_BACK_OFF, ly - f[1] * CHAIR_BACK_OFF, dir, '#8a6a4c');
}

/** The printer/supply station: a grey body with a paper tray and a stack of output on top. */
function printer(ctx: CanvasRenderingContext2D, fit: Fit): void {
  const P = PRINTER;
  box(ctx, fit, P.lx, P.ly, P.w, P.d, P.h, '#9aa3ab');
  box(ctx, fit, P.lx, P.ly, P.w - 12, P.d - 10, 5, '#6d757d', P.h); // output tray
  box(ctx, fit, P.lx, P.ly, P.w - 20, P.d - 16, 4, '#f2f0ea', P.h + 5); // paper
}

/** Reception: a waiting couch turned toward the door, a low table, and a plant — the nook's vocabulary. */
/**
 * The front desk: a counter with a RAISED TRANSACTION LEDGE — the ledge is the load-bearing detail,
 * because a counter without one is just a big desk, and the ledge is what makes the corner read as
 * reception rather than as a thirteenth workstation. Monitor turned away from the room (you see the
 * back of reception screens), a phone, a small plant, the visitor log.
 */
function frontDesk(ctx: CanvasRenderingContext2D, fit: Fit, t: number, working: boolean): void {
  const D = FRONT_DESK;
  const f = FWD[D.dir];
  const sn = f[1] !== 0; // S/N desks run their long axis along x
  box(ctx, fit, D.lx, D.ly, D.long - 4, D.deep - 3, D.high - 4, dim(PAL.wood, 0.9)); // base
  box(ctx, fit, D.lx, D.ly, D.long, D.deep, 4, woodTop(), D.high - 4); // worktop
  // The transaction ledge along the visitor edge — the detail that says reception, not workstation.
  box(ctx, fit, D.lx + f[0] * (D.deep / 2 - 4), D.ly + f[1] * (D.deep / 2 - 4), sn ? D.long - 8 : 8, sn ? 8 : D.long - 8, 9, dim(PAL.wood, 0.82), D.high);

  /** Desk-relative placement, exactly as `drawWorkstation` does it: `along` runs toward the monitor,
   *  `across` runs sideways. Reusing the members' own frame is what makes her station match theirs. */
  const at = (along: number, across: number): [number, number] => {
    const p: [number, number] = [-f[1], f[0]];
    return [D.lx + f[0] * along + p[0] * across, D.ly + f[1] * along + p[1] * across];
  };

  // The SAME monitor, keyboard and mouse the desks use, in the same relative spots. She sits at
  // SEAT_BACK behind the desk facing `dir`, so a monitor `deep/2 - 14` along that facing sits in
  // front of her with its screen toward her and its back to the room — which is both what a real
  // reception desk looks like and what makes her read as facing her screen rather than the camera.
  const [mx, my] = at(D.deep / 2 - 17, 0);
  monitor(ctx, fit, mx, my, D.dir, working, D.high, null, t);
  const [kx, ky] = at(KEYBOARD_ALONG, 0);
  deskKeyboard(ctx, fit, kx, ky, sn, D.high);
  const [sx, sy] = at(KEYBOARD_ALONG + 2, 27);
  deskMouse(ctx, fit, sx, sy, sn, D.high);

  // A corded landline on her left — the phone `GESTURE.call` picks up. Base, cradled handset, keypad.
  const [px_, py_] = at(-8, -40);
  box(ctx, fit, px_, py_, 20, 15, 4, '#4a4a50', D.high);
  box(ctx, fit, px_, py_ - 4, 21, 7, 5, '#3a3a3e', D.high + 4);
  box(ctx, fit, px_, py_ + 3, 13, 5, 1.2, '#6a6a72', D.high + 4);

  // A plant at the far end, foliage seated ON the rim (drawPlant's lesson: a gap reads as a bush
  // hovering over a crate), and the visitor log open on the ledge side.
  const [gx, gy] = at(-6, 44);
  const POT_H = 11;
  box(ctx, fit, gx, gy, 15, 15, POT_H, PLANT.pot, D.high);
  box(ctx, fit, gx, gy, 17, 17, 2.5, PLANT.rim, D.high + POT_H);
  const pp = project(gx, gy, fit);
  const potTop = (D.high + POT_H + 2.5) * fit.scale;
  ellipse(ctx, { x: pp.x, y: pp.y - potTop - 4 * fit.scale }, 11 * fit.scale, 7 * fit.scale, PLANT.leaf);
  ellipse(ctx, { x: pp.x - 4 * fit.scale, y: pp.y - potTop - 8 * fit.scale }, 7 * fit.scale, 5 * fit.scale, PLANT.leafLit);
  const [lx2, ly2] = at(2, -24);
  box(ctx, fit, lx2, ly2, 24, 16, 1.6, '#f2ecd9', D.high);
  box(ctx, fit, lx2, ly2, 2, 16, 2.2, '#c9bfa5', D.high);
}

/**
 * The receptionist, at her desk — a FULL member-sized character through the same `drawCharacter`
 * path as everybody else, not a bespoke pile of ellipses.
 *
 * The first cut hand-drew her at roughly half scale, which read exactly as what it was: "a mini
 * version of the other characters" (nick, 2026-07-30). She now sits in a chair at a desk-height
 * counter like any member, at `size: 1`, and gets the real skeleton — so she types with the same
 * `typing` solve and takes a call with `GESTURE.call`, the beat the skeleton already had.
 *
 * What still makes her STAFF rather than roster is everything around the drawing: she is not in the
 * node map, gets no nameplate, is in no headcount, and never walks. She is drawn as a `human` so she
 * has a face rather than an agent's visor — a receptionist behind a visor reads as another agent,
 * which is precisely the confusion to avoid.
 *
 * Her look is WRITTEN DOWN, not hashed. Hashing is right for members — a name is all the identity
 * the floor has — but she is one designed character, and leaving her to the hash meant nobody had
 * ever looked at what it produced: gold skin under dark red long hair, which closed around her face
 * into a single oval and read as a seal. A fixed character gets fixed art.
 */
const RECEPTIONIST_LOOK: Appearance = {
  skin: '#e8b07d',
  // A ponytail rather than the full fall: she is seen from the chest up behind a counter, and a long
  // mass in that framing has nothing to hang against, so it silhouettes into the head.
  hair: 'ponytail',
  // Auburn, not near-black. Dark brown hair over a low hairline put a dark band across her brow that
  // ran straight into the dark glasses frame below it — two dark bands with a sliver of skin between
  // them, which is why her eyes read as a smudge rather than as eyes. The glasses are gone for the
  // same reason: at this size she can have a hairline OR eyewear across the face, not both.
  hairColor: '#a06c38',
  facialHair: 'none',
  hat: 'none',
  hatColor: '#2a2118',
  // Long sleeves — bare forearms in gold-on-gold were half of why she had no readable arms.
  cut: 'long',
  bareArms: false,
  bottom: '#3f5570',
  shoes: '#22262b',
  accessory: 'none',
  accessoryColor: '#2f7f6a',
  smile: 'soft',
  presents: 'femme',
};
const RECEPTIONIST_NODE: OfficeNode = {
  name: 'receptionist',
  kind: 'human',
  service: false,
  presence: 'online',
  activity: 'working',
  posture: 'working',
  state: null,
  color: 'hsl(172, 32%, 46%)',
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
};

function drawReceptionist(ctx: CanvasRenderingContext2D, fit: Fit, r: ReceptionistState, t: number): void {
  const asleep = r.mode === 'asleep';
  const wake =
    asleep ? 0
    : r.mode === 'waking' ? Math.min(1, r.modeT / RECEPTIONIST_WAKE_S)
    : 1;
  // Asleep is a slump, not a separate drawing: the same seated figure folded forward over the desk.
  // `sit` stays 1 throughout — she never stands up, which is most of what "never leaves the desk"
  // means to the painter.
  const gesture =
    r.mode === 'call' ? GESTURE.call
    : asleep || r.mode === 'waking' ? GESTURE.chin // chin-on-hand reads as dozing at a desk
    : 0;
  const gestureT =
    r.mode === 'call' ? Math.min(0.98, r.modeT / Math.max(r.beatLen, 0.01))
    : asleep ? 0.5 // held at the plateau: a still slump, no animation on an empty office
    : 1 - wake;
  const typing = r.mode === 'typing';
  const pose: Pose = {
    lx: RECEPTIONIST.lx,
    ly: RECEPTIONIST.ly,
    dir: RECEPTIONIST.dir,
    sit: 1,
    phase: 0,
    stride: 0,
    run: false,
    small: false,
    alpha: 1,
    carry: r.mode === 'call' ? 'phone' : null,
    bubble: null,
    gesture,
    gestureT,
    moving: false,
  };
  drawCharacter(ctx, fit, {
    lx: pose.lx,
    ly: pose.ly,
    dir: pose.dir,
    node: RECEPTIONIST_NODE,
    skel: solveSkeleton({
      phase: 0,
      sit: 1,
      stride: 0,
      run: false,
      t,
      // Her typing is the members' typing burst, on her own seed so she is not in lockstep with a desk.
      typing: typing ? typingBurst(RECEPTIONIST_SEED, t) : 0,
      carry: pose.carry,
      help: false,
      gesture,
      gestureT,
      seed: RECEPTIONIST_SEED,
    }),
    size: 1,
    alpha: 1,
    carry: pose.carry,
    gesture,
    gestureT,
    t,
    seed: RECEPTIONIST_SEED / 0xffffffff,
    look: RECEPTIONIST_LOOK,
  });
}

/** Her own stable seed — sharing a desk's seed would put her typing in lockstep with a member's. */
const RECEPTIONIST_SEED = 0x9e3779b9;

/** What the scene draws when nobody has stepped her yet: an empty office, which is the honest default. */
const SLEEPING_RECEPTIONIST: ReceptionistState = {
  mode: 'asleep',
  modeT: 0,
  aloneT: 0,
  lastSlot: -1,
  beatLen: 0,
};

function receptionItems(ctx: CanvasRenderingContext2D, fit: Fit, recep: ReceptionistState | null, t: number): DepthItem[] {
  const R = RECEPTION;
  return [
    // She sorts at her own feet, north of the counter, so the counter paints over her lower body.
    {
      d: depth(RECEPTIONIST.lx, RECEPTIONIST.ly),
      fn: () => drawReceptionist(ctx, fit, recep ?? SLEEPING_RECEPTIONIST, t),
    },
    { d: depth(FRONT_DESK.lx, FRONT_DESK.ly), fn: () => frontDesk(ctx, fit, t, recep?.mode === 'typing') },
    { d: depth(R.endTable.lx, R.endTable.ly), fn: () => endTable(ctx, fit, R.endTable.lx, R.endTable.ly) },
    {
      d: depth(R.chair.lx, R.chair.ly),
      fn: () => armchair(ctx, fit, R.chair.lx, R.chair.ly, PAL.couch, R.chair.dir, WAIT_CHAIR),
    },
    { d: depth(R.plant.lx, R.plant.ly), fn: () => drawPlant(ctx, fit, R.plant.lx, R.plant.ly, 'fiddle') },
  ];
}

/**
 * Reception's end table: a small square top between the two waiting chairs, with a fanned pair of
 * magazines on it. The magazines are the whole point — an empty side table is a plinth, and a waiting
 * area reads as one the moment there is something on it somebody could have been reading.
 */
function endTable(ctx: CanvasRenderingContext2D, fit: Fit, lx: number, ly: number): void {
  const s = project(lx, ly, fit);
  ellipse(ctx, { x: s.x, y: s.y }, 20 * fit.scale, 7 * fit.scale, 'rgba(0,0,0,0.12)');
  box(ctx, fit, lx, ly, END_TABLE, END_TABLE, 16, woodTop());
  // Two magazines, offset so the lower one shows along one edge.
  box(ctx, fit, lx - 2, ly + 1, 15, 11, 1.1, '#d9c7a8', 16);
  box(ctx, fit, lx + 1, ly - 1, 15, 11, 1.1, '#c98f6a', 17.1);
}

function couch(ctx: CanvasRenderingContext2D, fit: Fit, lx: number, ly: number, c: string, dir: Dir): void {
  const f = FWD[dir];
  const p: [number, number] = [-f[1], f[0]];
  const sn = f[1] !== 0;
  const L = LOUNGE.couch.len;
  const Dp = LOUNGE.couch.dep;
  box(ctx, fit, lx - f[0] * (Dp / 2 - 4), ly - f[1] * (Dp / 2 - 4), sn ? L : 10, sn ? 10 : L, 34, dim(c, 0.9));
  box(ctx, fit, lx, ly, sn ? L : Dp, sn ? Dp : L, 20, c);
  box(ctx, fit, lx + p[0] * (L / 2 - 5), ly + p[1] * (L / 2 - 5), sn ? 10 : Dp, sn ? Dp : 10, 27, dim(c, 0.95));
  box(ctx, fit, lx - p[0] * (L / 2 - 5), ly - p[1] * (L / 2 - 5), sn ? 10 : Dp, sn ? Dp : 10, 27, dim(c, 0.95));
  // Three plump seat pads soften the block silhouette. Iso circles project to ellipses, so the cushions
  // keep their rounded living-room character at every sofa facing.
  for (const along of [-34, 0, 34]) {
    const cp = project(lx + p[0] * along + f[0] * 4, ly + p[1] * along + f[1] * 4, fit);
    ellipse(ctx, { x: cp.x, y: cp.y - 20 * fit.scale }, 18 * fit.scale, 7 * fit.scale, '#f3c95a');
  }
  // Two mismatched throw pillows: intentionally a little quirky, and small enough not to compete with
  // member colours or act cues.
  const pillowColors = ['#f1dcc0', '#6f9e8c'];
  for (const [i, along] of [-25, 27].entries()) {
    const pp = project(lx + p[0] * along - f[0] * 12, ly + p[1] * along - f[1] * 12, fit);
    ellipse(ctx, { x: pp.x, y: pp.y - 36 * fit.scale }, 11 * fit.scale, 9 * fit.scale, pillowColors[i]!);
  }
}

/**
 * An upholstered chair with a back. The break nook's armchairs were the only callers until the nook
 * lost them (2026-08-02); reception's waiting pair uses the same painter at a smaller `size`, because
 * a waiting-room chair *is* a small armchair and inventing a second one would put two upholstery
 * languages in one room.
 */
function armchair(
  ctx: CanvasRenderingContext2D,
  fit: Fit,
  lx: number,
  ly: number,
  c: string,
  dir: Dir,
  size: number,
): void {
  const f = FWD[dir];
  const sn = f[1] !== 0;
  const S = size;
  box(ctx, fit, lx - f[0] * (S / 2 - 6), ly - f[1] * (S / 2 - 6), sn ? S - 2 : 10, sn ? 10 : S - 2, 32, dim(c, 0.9));
  box(ctx, fit, lx, ly, sn ? S - 2 : S, sn ? S : S - 2, 20, c);
  const seat = project(lx + f[0] * 5, ly + f[1] * 5, fit);
  ellipse(ctx, { x: seat.x, y: seat.y - 20 * fit.scale }, 21 * fit.scale, 8 * fit.scale, '#eabf50');
}

function ctable(ctx: CanvasRenderingContext2D, fit: Fit, lx: number, ly: number): void {
  const s = project(lx, ly, fit);
  ellipse(ctx, { x: s.x, y: s.y }, 42 * fit.scale, 13 * fit.scale, 'rgba(0,0,0,0.12)');
  box(ctx, fit, lx, ly, LOUNGE.table.w, LOUNGE.table.d, 16, woodTop());
  // A tray with a couple of books left on it, beside the bowl. Showroom furniture is furniture nobody
  // has used; the tray is the cheapest possible evidence that somebody sat here and put something down.
  box(ctx, fit, lx - 13, ly + 3, 22, 15, 1.2, '#b98a5e', 16);
  box(ctx, fit, lx - 13, ly + 3, 18, 12, 2.4, BOOK_COLORS[7]!, 17.2);
  box(ctx, fit, lx - 12, ly + 3, 16, 11, 2, BOOK_COLORS[5]!, 19.6);
  // Fruit bowl + a single flower keeps the lounge from reading like untouched showroom furniture.
  ellipse(ctx, { x: s.x + 8 * fit.scale, y: s.y - 18 * fit.scale }, 10 * fit.scale, 4 * fit.scale, '#e8c17d');
  ellipse(ctx, { x: s.x + 4 * fit.scale, y: s.y - 21 * fit.scale }, 3 * fit.scale, 2 * fit.scale, '#d8774f');
  ellipse(ctx, { x: s.x + 11 * fit.scale, y: s.y - 22 * fit.scale }, 3 * fit.scale, 2 * fit.scale, '#f4cf52');
}

/** One depth-sortable draw call. The nook/huddle used to paint as single blobs anchored at their
 * centre, which over-painted any member standing on the north half of their rugs — each solid piece is
 * now its own item at its own footprint depth, and flat rugs paint with the floor (see renderScene). */
interface DepthItem {
  d: number;
  fn: () => void;
}

/** The break-nook lounge, as depth items: the rug flat on the floor, every solid piece self-sorted. */
function nookItems(
  ctx: CanvasRenderingContext2D,
  fit: Fit,
  fridgeOpen = false,
): { rug: () => void; items: DepthItem[] } {
  const { lx, ly } = NOOK;
  const L = LOUNGE;
  const at = (dx: number, dy: number, fn: () => void): DepthItem => ({ d: depth(lx + dx, ly + dy), fn });
  return {
    rug: () => drawRug(ctx, fit, NOOK_RUG, lx, ly, NOOK_RUG_R * 2, NOOK_RUG_R * 2),
    items: [
      at(L.fridge.dx, L.fridge.dy, () => fridge(ctx, fit, lx + L.fridge.dx, ly + L.fridge.dy, fridgeOpen)),
      at(L.counter.dx, L.counter.dy, () => {
        // Base cabinets, then a slab that overhangs them — the overhang is what separates a worktop
        // from a plain box, and it is most of why this now reads as a fitted kitchen run.
        box(ctx, fit, lx + L.counter.dx, ly + L.counter.dy, L.counter.w - 4, L.counter.d - 3, L.counter.h - 4, dim(woodTop(), 0.88));
        box(ctx, fit, lx + L.counter.dx, ly + L.counter.dy, L.counter.w, L.counter.d, 4, woodTop(), L.counter.h - 4);
        // Backsplash upstand along the run's back edge. A worktop that just stops is a table; a
        // worktop that turns up the wall is a kitchen, and this is the cheapest way to say so.
        box(ctx, fit, lx + L.counter.dx, ly + L.counter.dy - L.counter.d / 2 + 1.5, L.counter.w, 3, 16, dim(woodTop(), 0.8), L.counter.h);
        // Cabinet doors: two seams down the run, so the base is cabinetry rather than a solid plinth.
        for (const seam of [-0.22, 0.22]) {
          box(ctx, fit, lx + L.counter.dx + L.counter.w * seam, ly + L.counter.dy + L.counter.d / 2 - 2, 1.2, 1, L.counter.h - 8, dim(woodTop(), 0.72), 2);
        }
        coffeeMachine(ctx, fit, lx + L.machine.dx, ly + L.machine.dy, L.counter.h);
        counterSink(ctx, fit, lx + SINK.dx, ly + SINK.dy, L.counter.h);
        // What a counter actually carries beside the machine: the beans, and the mugs waiting their turn.
        // The bag is kraft-paper warm on purpose — in dark roast brown it and the machine read as one
        // black lump rather than two objects.
        box(ctx, fit, lx + L.counter.dx + 18, ly + L.counter.dy + 1, 9, 8, 12, '#a97c50', L.counter.h);
        box(ctx, fit, lx + L.counter.dx + 18, ly + L.counter.dy + 1, 9, 8, 2, '#59402f', L.counter.h + 12); // rolled top
        for (let i = 0; i < 2; i++) {
          frustum(ctx, fit, lx + L.counter.dx + 32, ly + L.counter.dy, 6, 6, 7, 7, 5, '#f2e7d5', L.counter.h + i * 5);
        }
      }),
      at(L.cooler.dx, L.cooler.dy, () => watercooler(ctx, fit, lx + L.cooler.dx, ly + L.cooler.dy)),
      at(L.couch.dx, L.couch.dy, () => couch(ctx, fit, lx + L.couch.dx, ly + L.couch.dy, PAL.couch, 'S')),
      at(L.table.dx, L.table.dy, () => ctable(ctx, fit, lx + L.table.dx, ly + L.table.dy)),
    ],
  };
}

/**
 * The kitchenette's three appliances. Each was a plain block; each is now built the way the bookshelf
 * builds its books — small boxes stood proud of the room-facing (+y) face, which is the only face detail
 * can live on and still read at this projection.
 *
 * Their appliance white is warm (#e8e2d6), not the blue-grey a real office fridge is: this room is lit
 * amber from the windows down, and a genuinely cold white in it reads as a hole punched in the wall.
 */
const APPLIANCE = '#e8e2d6';

/** Body height of the espresso machine. `coffeeAnchor` reads it too — the ambient steam has to leave the
 * warmer plate, so the plate's height is shared data rather than a constant repeated in two places. */
export const MACHINE_H = 15;

/** The fridge: two doors under a seam, handles, someone's note, and a crate parked on top. While an
 * errand browses it (`open`), the lower door swings out and the opening shows dark with a lit shelf. */
function fridge(ctx: CanvasRenderingContext2D, fit: Fit, lx: number, ly: number, open = false): void {
  const f = LOUNGE.fridge;
  const front = ly + f.d / 2; // the room-facing face — everything below is proud of it by ~1 unit
  box(ctx, fit, lx, ly, f.w, f.d, f.h, APPLIANCE);
  box(ctx, fit, lx, front, f.w - 4, 1.5, 1.5, '#c3b9a8', 34); // the freezer/fridge seam
  if (open) {
    // The lower compartment stands open: a dark inset with one lit shelf line, and the door swung
    // out as a slab perpendicular to the face, hinge at the west edge (box() can't rotate — at this
    // scale a proud perpendicular slab *is* an open door).
    box(ctx, fit, lx, front, f.w - 6, 1.2, 30, '#2e2a26', 3); // the dark opening
    box(ctx, fit, lx, front, f.w - 10, 1.4, 1.6, '#f6ead2', 17); // a shelf catching the fridge light
    box(ctx, fit, lx - f.w / 2 + 1, front + 8, 3, 16, 32, dim(APPLIANCE, 0.9), 2); // the swung door
    box(ctx, fit, lx + 11, front, 2.5, 2.5, 12, '#6e6558', 38); // upper handle stays
  } else {
    for (const up of [38, 18]) box(ctx, fit, lx + 11, front, 2.5, 2.5, 12, '#6e6558', up); // door handles
    box(ctx, fit, lx - 6, front, 7, 1.2, 8, '#f4cf52', 24); // a note, stuck on at eye height
  }
  box(ctx, fit, lx - 5, ly - 2, 15, 13, 9, '#c9744a', f.h); // a crate someone left on top
}

/** The counter sink: an inset basin with a rim and a little gooseneck faucet — the plate drop-off. */
function counterSink(ctx: CanvasRenderingContext2D, fit: Fit, lx: number, ly: number, up: number): void {
  // Scaled with the run: a 16-unit basin on a 120-unit counter reads as a soap dish.
  box(ctx, fit, lx, ly, 26, 18, 1.4, '#cfd6d8', up); // the rim
  box(ctx, fit, lx, ly, 20, 13, 1, '#7d8a90', up + 0.5); // the basin, reading dark against the rim
  box(ctx, fit, lx - 10, ly - 6, 2.2, 2.2, 10, '#9aa8ae', up); // faucet riser at the back corner
  box(ctx, fit, lx - 7, ly - 6, 7, 2.2, 1.8, '#9aa8ae', up + 10); // …bending over the basin
}

/** The espresso machine: a body with a warmer plate, a lit switch, a group head, and a cup under it. */
function coffeeMachine(ctx: CanvasRenderingContext2D, fit: Fit, lx: number, ly: number, up: number): void {
  box(ctx, fit, lx, ly, 16, 12, MACHINE_H, '#3f3236', up); // body
  box(ctx, fit, lx, ly, 12, 8, 2, '#8e8288', up + MACHINE_H); // the warmer plate on top
  box(ctx, fit, lx - 5, ly + 6, 2, 1.2, 2, '#f4cf52', up + 9); // the little lit switch
  box(ctx, fit, lx + 2, ly + 6.5, 5, 2, 4, '#6a5c62', up + 5); // group head + spout
  box(ctx, fit, lx, ly + 5, 13, 4, 1.5, '#2b2226', up); // drip tray
  frustum(ctx, fit, lx + 2, ly + 9, 3.5, 3.5, 4.5, 4.5, 5, '#f6ead2', up + 1.5); // a cup, catching it
}

/** The water cooler: a body with a tap and a cup tube, under a bottle that tapers like a real one. */
function watercooler(ctx: CanvasRenderingContext2D, fit: Fit, lx: number, ly: number): void {
  const c = LOUNGE.cooler;
  const front = ly + c.d / 2;
  box(ctx, fit, lx, ly, c.w, c.d, c.h, APPLIANCE);
  box(ctx, fit, lx, front, 8, 3, 5, '#5f6b70', 26); // the tap block
  box(ctx, fit, lx, front + 1, 2, 3, 2, '#8fa6ae', 24); // and its spout
  box(ctx, fit, lx - 7, front, 3, 2, 10, '#cfd6d8', 30); // the cup tube down one side
  // The bottle, inverted as they are: a narrow neck flaring into the body, tapering back to a flat base.
  frustum(ctx, fit, lx, ly, 8, 8, 14, 14, 5, '#a9dcea', c.h);
  frustum(ctx, fit, lx, ly, 14, 14, 15, 15, 12, '#8fd0e6', c.h + 5);
  frustum(ctx, fit, lx, ly, 15, 15, 12, 12, 5, '#7cc3db', c.h + 17);
}

/** A bookshelf: a wood carcass with three shelves of colourful book spines facing into the room. */
/**
 * Stable per-book noise. Seeded, never `Math.random()`: the shelves live on the baked still layer and
 * get repainted on every resize, and a book that changes width between repaints flickers.
 */
export function shelfRnd(shelf: number, book: number, salt: number): number {
  let h = (shelf * 73856093) ^ (book * 19349663) ^ (salt * 83492791);
  h = Math.imul(h ^ (h >>> 15), 2246822507);
  h = Math.imul(h ^ (h >>> 13), 3266489909);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/**
 * Spine colours. The white and the black are the point: a shelf of only saturated mid-tones is the
 * tell that a palette was picked rather than accumulated. They are punctuation against the warm
 * body, not equal members of it.
 */
export const BOOK_COLORS: readonly string[] = [
  '#c95c4a',
  '#e0a72b',
  '#5aa0c9',
  '#6aa86a',
  '#b06fc9',
  '#d98b4a',
  '#8c4a3a',
  '#3f7a8c',
  '#a8422f',
  '#7a6ab0',
  '#f4f1ea', // the white one
  '#22201d', // the black one
];

/** Page-edges seen from the room. Cream and near-uniform — that flatness is the whole joke. */
export const PAGE_EDGE = '#e8dcc4';

/** Spines light enough that lettering has to go on in a dark ink to be seen at all. */
const LIGHT_SPINES = new Set(['#f4f1ea', '#e0a72b']);

export interface BookSpine {
  /** Centre offset along the shelf, from the middle. */
  along: number;
  w: number;
  h: number;
  color: string;
  /** 0 upright; otherwise the height squash of a book tipped against its neighbour. */
  lean: number;
  /** The spine title, or `''` for a book with nothing to read (a reversed shelf, or a narrow spine). */
  title: string;
  /** The title's ink. Chosen per book with the spine, so a shelf's lettering varies like its cloth. */
  ink: string;
}

/**
 * Title inks, split by the VALUE of the spine they go on. Real books letter their spines in gilt,
 * cream, black, colours — a shelf where every dark spine carries the same white ink reads as one
 * printing run (nick, 2026-07-30: "they don't all have to be white text"). The split is the part
 * that is not negotiable: at four pixels wide, lettering is a value contrast or it is nothing, so a
 * dark spine draws from the light pool and a light spine from the dark pool — variety comes from
 * within the pool, never by relaxing the contrast rule.
 */
const INK_ON_DARK: readonly string[] = ['#f5f2ec', '#e8c87a', '#c9dbe8', '#e8b4a8', '#d9c9ea'];
const INK_ON_LIGHT: readonly string[] = ['#2a2622', '#5c3a2e', '#2e4a5c', '#6b2f3a'];

/**
 * Spine titles. Short on purpose: a spine is a few units wide, so the text is set DOWN the spine and
 * its length is bounded by the book's height, not its width. Two or three short words is what fits.
 */
const BOOK_TITLES: readonly string[] = [
  'atlas',
  'notes',
  'iso',
  'canvas',
  'form',
  'light',
  'colour',
  'type',
  'grids',
  'shape',
  'depth',
  'room',
  'index',
  'draft',
  'plans',
];

/**
 * Pack one shelf band with books.
 *
 * Packed by WIDTH rather than by count, because the widths vary — a fixed count of varied spines
 * leaves a ragged gap at one end. Uniform verticals were the single biggest reason the old shelves
 * read as a texture swatch rather than as books, so the lean matters more than it looks: it is
 * applied as a height squash plus a gap on the lean side rather than a rotation, because `box()` is
 * axis-aligned and a real rotation would mean a new primitive for a two-pixel effect.
 *
 * `marks` is lettering, and it is deliberately not text. A spine is about 4 x 7 screen px at /live,
 * where real glyphs render as a grey smear and no font token can fix it — the problem is the pixel
 * count, not the family. Bars at a consistent cap height are what a title looks like across a room,
 * and they resolve into type-like texture at /broadcast and /office-preview scale.
 * **Do not "fix" these into real strings.**
 */
export function packShelf(si: number, row: number, long: number, reversed: boolean): BookSpine[] {
  const out: BookSpine[] = [];
  const span = long * 0.9;
  const seed = (i: number, salt: number): number => shelfRnd(si, row * 32 + i, salt);
  let along = -span / 2;
  for (let i = 0; along < span / 2 - 4; i++) {
    // Narrower, and packed nearly touching. Books on a shelf lean on each other; the first cut had
    // both a wide spine range and visible air between every volume, which is what made the row read
    // as a colour swatch rather than as books (nick, 2026-07-30: "they don't look like books").
    const w = 4 + seed(i, 1) * 3.5; // 4..7.5
    if (along + w > span / 2) break; // never overhang the carcass
    const h = 11 + seed(i, 2) * 5; // 11..16
    const lean = seed(i, 4) < 0.14 ? 0.86 : 0;
    const color = reversed
      ? shade(PAGE_EDGE, 0.97 + seed(i, 6) * 0.06)
      : BOOK_COLORS[Math.floor(seed(i, 3) * BOOK_COLORS.length)]!;
    // A backwards shelf has nothing to read — that is what makes it read as backwards.
    const title = reversed ? '' : BOOK_TITLES[Math.floor(seed(i, 5) * BOOK_TITLES.length)]!;
    const pool = LIGHT_SPINES.has(color) ? INK_ON_LIGHT : INK_ON_DARK;
    const ink = pool[Math.floor(seed(i, 7) * pool.length)]!;
    out.push({ along: along + w / 2, w, h: h * (lean || 1), color, lean, title, ink });
    along += w + (lean ? 1.8 : 0.25); // shoulder to shoulder; the leaner needs a gap to fall into
  }
  return out;
}

/**
 * A title running DOWN a book's spine, the way a title on a shelved book actually runs.
 *
 * Drawn in screen space and rotated a quarter turn, not sheared onto a face like `wallText`: a spine
 * is a narrow vertical strip, "up" projects straight up the screen in this isometric, and rotating
 * about the spine's centre puts the type exactly where a real title sits. Building a per-book face
 * matrix would buy nothing at four pixels wide.
 *
 * The size is bounded by the spine's WIDTH (the text's cap height has to fit across the spine) while
 * its length is bounded by the book's height — which is why `BOOK_TITLES` are all short words. Then
 * the whole thing is clipped to the spine rectangle, so a long word is cut off by the edge of the
 * book rather than running out over its neighbours.
 *
 * At /live this is fine lettering rather than legible words — that is what type this size is. It
 * resolves on /office-preview and /broadcast, which is where anybody reads a book title anyway.
 */
function spineTitle(
  ctx: CanvasRenderingContext2D,
  fit: Fit,
  bx: number,
  by: number,
  baseUp: number,
  b: BookSpine,
): void {
  const size = Math.min(b.w * 0.72, 4.6);
  if (size < 2) return; // below this the ink is a smudge, and a smudge is worse than a plain spine
  const p = project(bx, by, fit);
  const cx = p.x;
  const cy = p.y - (baseUp + b.h / 2) * fit.scale;
  ctx.save();
  ctx.beginPath();
  ctx.rect(cx - (b.w / 2) * fit.scale, cy - (b.h / 2) * fit.scale, b.w * fit.scale, b.h * fit.scale);
  ctx.clip();
  ctx.translate(cx, cy);
  ctx.rotate(-Math.PI / 2);
  ctx.font = canvasFont(Math.round(size * fit.scale * 10) / 10, '--font-mono', 700);
  ctx.fillStyle = b.ink;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(b.title, 0, 0);
  ctx.restore();
}

/**
 * One object on each shelf top.
 *
 * Its own small painters rather than `drawPlant` and friends: those carry a floor contact shadow and
 * floor-scale proportions, and a 19-unit pot with a shadow pooled under it reads as a plant standing
 * *behind* the shelf, not on it. Everything here is sized for a surface a metre and a half up.
 *
 * The photo leans rather than stands. Leaning is what makes an object read as *placed* by somebody,
 * and it is the cheapest possible break in the "every rectangle is square to the room" grid.
 */
function shelfDecor(ctx: CanvasRenderingContext2D, fit: Fit, s: Bookshelf): void {
  const up = s.high;
  const f = FWD[s.dir];
  const sn = f[1] !== 0;
  // Nudge the object toward the room-facing edge so it sits on the front of the top, not the middle.
  const dx = sn ? 0 : f[0] * 2;
  const dy = sn ? f[1] * 2 : 0;
  const x = s.lx + dx;
  const y = s.ly + dy;
  switch (s.decor) {
    case 'plant': {
      box(ctx, fit, x, y, 13, 13, 9, PLANT.pot, up);
      box(ctx, fit, x, y, 15, 15, 2.5, PLANT.rim, up + 9);
      ellipse(ctx, { x: project(x, y, fit).x, y: project(x, y, fit).y - (up + 15) * fit.scale }, 11 * fit.scale, 6 * fit.scale, PLANT.leaf);
      ellipse(ctx, { x: project(x, y, fit).x - 5 * fit.scale, y: project(x, y, fit).y - (up + 18) * fit.scale }, 7 * fit.scale, 4 * fit.scale, PLANT.leafLit);
      return;
    }
    case 'photo': {
      box(ctx, fit, x, y, sn ? 18 : 4, sn ? 4 : 18, 22, DRESS.frame, up);
      box(ctx, fit, x - dx * 0.6, y - dy * 0.6, sn ? 14 : 2, sn ? 2 : 14, 17, DRESS.mat, up + 2.5);
      return;
    }
    case 'books': {
      box(ctx, fit, x, y, sn ? 22 : 14, sn ? 14 : 22, 4, BOOK_COLORS[0]!, up);
      box(ctx, fit, x, y, sn ? 19 : 12, sn ? 12 : 19, 3.5, BOOK_COLORS[3]!, up + 4);
      box(ctx, fit, x, y, sn ? 16 : 11, sn ? 11 : 16, 3, BOOK_COLORS[10]!, up + 7.5);
      return;
    }
    case 'trophy': {
      box(ctx, fit, x, y, 10, 10, 4, '#6b5220', up);
      box(ctx, fit, x, y, 4, 4, 7, '#c9a44a', up + 4);
      ellipse(ctx, { x: project(x, y, fit).x, y: project(x, y, fit).y - (up + 13) * fit.scale }, 6 * fit.scale, 4 * fit.scale, '#d8b55c');
      return;
    }
  }
}

function bookshelf(ctx: CanvasRenderingContext2D, fit: Fit, s: Bookshelf, si: number): void {
  const f = FWD[s.dir];
  const sn = f[1] !== 0; // S/N run along x; E/W run along y
  const wx = sn ? s.long : s.deep;
  const dy = sn ? s.deep : s.long;
  box(ctx, fit, s.lx, s.ly, wx, dy, s.high, mul(PAL.wood, s.tone)); // carcass
  // Book rows on the front (room-facing) face. The bands are spread over the unit's own height
  // rather than pinned at a fixed pitch, so a low-wide unit reads as a credenza with two shelves
  // instead of a tall one with its top sliced off.
  const bandGap = (s.high - 14) / s.rows;
  for (let row = 0; row < s.rows; row++) {
    const baseUp = 8 + row * bandGap;
    for (const b of packShelf(si, row, s.long, s.reversed === true)) {
      const bx = s.lx + (sn ? b.along : f[0] * (s.deep / 2 - 2));
      const by = s.ly + (sn ? f[1] * (s.deep / 2 - 2) : b.along);
      box(ctx, fit, bx, by, sn ? b.w : 3, sn ? 3 : b.w, b.h, b.color, baseUp);
      if (b.title) spineTitle(ctx, fit, bx, by, baseUp, b);
    }
  }
  shelfDecor(ctx, fit, s);
}

/** A faint floor pad marking one spot in the entrance waiting queue (drawn under an overflow member). */
function drawQueuePad(ctx: CanvasRenderingContext2D, fit: Fit, lx: number, ly: number): void {
  const p = project(lx, ly, fit);
  ctx.globalAlpha = 0.45;
  ellipse(ctx, { x: p.x, y: p.y + 3 * fit.scale }, 21 * fit.scale, 7 * fit.scale, '#7a4e2d');
  ctx.globalAlpha = 1;
}

/** A small screen-space "+N …" pill — collapses the members past the queue/nook cap into one count. */
function drawCountPill(ctx: CanvasRenderingContext2D, at: Pt, text: string, scale: number): void {
  ctx.font = canvasFont(Math.round(12 * scale));
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const w = ctx.measureText(text).width + 18 * scale;
  const h = 20 * scale;
  roundRect(ctx, at.x - w / 2, at.y - h / 2, w, h, h / 2, 'rgba(20, 24, 31, 0.82)');
  ctx.fillStyle = '#cfe7ee';
  ctx.fillText(text, at.x, at.y);
}

function drawEntrance(ctx: CanvasRenderingContext2D, fit: Fit): void {
  const { lx, ly } = ENTRANCE;
  const s = fit.scale;
  const H = 96;
  // The door is set into the back-left wall (the lx≈0 floor edge): it runs *along* the wall (±ly) and its
  // plane sits `dx` back toward the edge (−lx), so the panel is flush with the perimeter, not floating
  // inland. The mat sits just inside (+lx), its rear corner meeting the threshold.
  const dx = 42;
  const wx = lx - dx; // door plane, nestled against the floor edge
  // welcome mat: a bordered two-tone mat instead of the old flat brown patch
  rug(ctx, fit, lx + 28, ly, 70, '#6b4326');
  rug(ctx, fit, lx + 28, ly, 58, '#8f5c33');
  // contact shadow along the door base — grounds the posts on the floor (every other standing piece
  // has one; without it the tall glass panel reads as floating)
  const foot = project(wx, ly, fit);
  ellipse(ctx, { x: foot.x, y: foot.y + 2 * s }, 52 * s, 15 * s, 'rgba(0,0,0,0.13)');
  // threshold strip under the doorway (runs along the wall)
  box(ctx, fit, wx, ly, 6, 94, 3, '#4e3a24');
  // door posts
  box(ctx, fit, wx, ly - 44, 10, 10, H, '#5c452c');
  box(ctx, fit, wx, ly + 44, 10, 10, H, '#5c452c');
  const a = project(wx, ly - 44, fit);
  const b = project(wx, ly + 44, fit);
  const up = H * s;
  // glass: a vertical sky-tint gradient (brighter at the top) instead of one flat wash
  const glass = ctx.createLinearGradient(0, Math.min(a.y, b.y) - up, 0, Math.max(a.y, b.y));
  glass.addColorStop(0, 'rgba(207, 231, 238, 0.42)');
  glass.addColorStop(0.6, 'rgba(207, 231, 238, 0.18)');
  glass.addColorStop(1, 'rgba(207, 231, 238, 0.3)');
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(a.x, a.y);
  ctx.lineTo(b.x, b.y);
  ctx.lineTo(b.x, b.y - up);
  ctx.lineTo(a.x, a.y - up);
  ctx.closePath();
  ctx.fillStyle = glass;
  ctx.fill();
  // a soft diagonal sheen across the panes
  ctx.clip();
  ctx.globalAlpha = 0.14;
  ctx.fillStyle = '#ffffff';
  const shx = (b.x - a.x) * 0.22;
  ctx.beginPath();
  ctx.moveTo(a.x + shx, a.y);
  ctx.lineTo(a.x + shx * 1.8, a.y - up);
  ctx.lineTo(a.x + shx * 2.4, a.y - up);
  ctx.lineTo(a.x + shx * 1.6, a.y);
  ctx.closePath();
  ctx.fill();
  ctx.globalAlpha = 1;
  ctx.restore();
  // double-door mullion + slim frame rails + handles
  const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  ctx.strokeStyle = 'rgba(94, 70, 44, 0.9)';
  ctx.lineWidth = Math.max(1, 2.2 * s);
  ctx.beginPath();
  ctx.moveTo(mid.x, mid.y);
  ctx.lineTo(mid.x, mid.y - up);
  ctx.stroke();
  ctx.lineWidth = Math.max(1, 1.2 * s);
  ctx.strokeStyle = 'rgba(94, 70, 44, 0.55)';
  for (const t of [0.32, 0.78]) {
    ctx.beginPath();
    ctx.moveTo(a.x, a.y - up * t + (mid.y - a.y) * 0);
    ctx.lineTo(b.x, b.y - up * t);
    ctx.stroke();
  }
  const hy = mid.y - up * 0.44;
  ctx.fillStyle = '#3c2e1e';
  roundRect(ctx, mid.x - 5.5 * s, hy - 7 * s, 2.6 * s, 14 * s, 1.3 * s, '#3c2e1e');
  roundRect(ctx, mid.x + 2.9 * s, hy - 7 * s, 2.6 * s, 14 * s, 1.3 * s, '#3c2e1e');
  // header beam over the doorway
  box(ctx, fit, wx, ly, 8, 98, 10, '#6b4a2a', H);
}

const PLANT = {
  pot: '#b9603a',
  rim: '#cb6f45',
  soil: '#4a3326',
  trunk: '#7c5a3c',
  stem: '#4e7a3c',
  snake: '#3e6b3a',
  snakeTip: '#6fa35a',
  leaf: '#6e9e52',
  leafLit: '#86b368',
} as const;

/** Planter geometry, in logical units: a tapered pot, then a rim band, then the soil the plant grows out of. */
const POT = { base: 17, top: 25, h: 19, rimW: 27, rimH: 3.5 };
const SOIL_UP = POT.h + POT.rimH;

/**
 * A potted plant, drawn as *one object*: a tapered planter, a rim, soil, and foliage that grows out of the
 * soil. The parts are joined on purpose — an earlier cut hung the fiddle's leaves ~30 units above the pot
 * with nothing in between, which read (fairly) as a stray crate on the floor with a bush hovering over it.
 * A fiddle-leaf fig gets the bare woody trunk it has in life; a snake plant's blades rise straight from the
 * soil. Either way, every green thing traces back to the pot it is standing in.
 */
function drawPlant(
  ctx: CanvasRenderingContext2D,
  fit: Fit,
  lx: number,
  ly: number,
  species: 'snake' | 'fiddle',
): void {
  const base = project(lx, ly, fit);
  const s = fit.scale;
  const at = (dx: number, up: number): Pt => ({ x: base.x + dx * s, y: base.y - up * s });
  ellipse(ctx, { x: base.x, y: base.y + 3 * s }, 20 * s, 6 * s, 'rgba(0,0,0,0.14)');
  frustum(ctx, fit, lx, ly, POT.base, POT.base, POT.top, POT.top, POT.h, PLANT.pot);
  box(ctx, fit, lx, ly, POT.rimW, POT.rimW, POT.rimH, PLANT.rim, POT.h);
  ellipse(ctx, at(0, SOIL_UP), 10 * s, 5 * s, PLANT.soil);

  if (species === 'snake') {
    // Blades straight out of the soil, tallest in the middle — each one starts *in* the pot.
    for (const [dx, h] of [
      [-9, 46],
      [-3, 58],
      [4, 51],
      [10, 39],
    ] as const) {
      ellipse(ctx, at(dx, SOIL_UP + h / 2), 5 * s, (h / 2) * s, PLANT.snake);
      ellipse(ctx, at(dx, SOIL_UP + h - 5), 3.4 * s, 5.5 * s, PLANT.snakeTip);
    }
    return;
  }

  // Fiddle-leaf fig: a trunk out of the soil, leaves hung off its top — so the canopy has something to
  // hang from. Each leaf's stem runs back to the trunk, which is what stops the blobs reading as a cloud.
  const CROWN = 27; // where the trunk ends and the canopy starts
  const trunkTop = at(-2, SOIL_UP + CROWN);
  ctx.strokeStyle = PLANT.trunk;
  ctx.lineWidth = 3 * s;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(base.x, base.y - SOIL_UP * s);
  ctx.quadraticCurveTo(base.x + 2 * s, base.y - (SOIL_UP + CROWN * 0.55) * s, trunkTop.x, trunkTop.y);
  ctx.stroke();
  for (const [dx, up, r] of [
    [10, CROWN - 7, 8.5], // one leaf slung low off the trunk — without it the plant reads as a lollipop
    [-14, CROWN + 4, 13],
    [11, CROWN + 10, 12],
    [-2, CROWN + 20, 11],
  ] as const) {
    const c = at(dx, SOIL_UP + up);
    ctx.strokeStyle = PLANT.stem;
    ctx.lineWidth = 1.6 * s;
    ctx.beginPath();
    ctx.moveTo(trunkTop.x, trunkTop.y);
    ctx.lineTo(c.x, c.y);
    ctx.stroke();
    ellipse(ctx, c, r * s, (r - 2) * s, PLANT.leaf);
    ellipse(ctx, { x: c.x + 4 * s, y: c.y + 4 * s }, r * 0.45 * s, r * 0.36 * s, PLANT.leafLit);
  }
}

// ── the office dog (behaviour in pet.ts; this is only the painter) ──────────────────────────────────────

const DOG = {
  fur: '#f1ece2', // warm white — the floor is warm, and a pure white dog reads as a hole in it
  /** The same coat in shadow, for the two legs on the far side of the body. A white dog trotting on
   *  white legs is a body with four invisible sticks under it: the far pair has to sit *behind*
   *  something, and depth on a flat painter is a tone, not a z-index. */
  furFar: '#d6cec0',
  patch: '#332e2a', // soft near-black; true #000 goes flat and lifts out of the room's palette
  cream: '#fdfaf4', // muzzle, chest, paws, tail tip — a shade brighter than the coat, so it still separates
  earIn: '#8a6a62',
  collar: '#e3a72b', // the huddle-pouf mustard — the team dog wears the team colour
  tag: '#f6d98a',
  eye: '#2a2320',
  nose: '#241d19',
  tongue: '#e28a86',
} as const;

/**
 * How much bigger than its original build the dog is drawn. Applied to the whole figure by scaling the
 * unit multiplier once, so every radius, stroke width and offset in this painter moves together and the
 * proportions can't drift.
 */
const DOG_SIZE = 1.25;

/** Tail-wag rate (Hz). Fast enough to read as a wag at office scale without buzzing. */
const WAG_HZ = 4.6;

/**
 * How far a paw travels, in dog units, over one gait cycle — **derived from the walk, never tuned by
 * eye.** A planted paw tracks backward under the dog at exactly ground speed, so its reach has to
 * equal the ground the dog covers in a cycle, converted into the painter's units:
 *
 * · `STRIDE` logical units of floor per cycle (pet.ts owns the cadence);
 * · `× MEAN_KX` — the dog is a side-on billboard on a 2:1 iso, so only the screen-*x* part of its
 *   travel is visible as travel. That part is |cos θ − sin θ|·KX of the distance, whose mean over
 *   every heading is √2·(2/π)·KX ≈ 0.637. Averaging is the honest move: a per-heading reach would
 *   freeze the legs solid whenever the dog walked straight into the screen;
 * · `÷ DOG_SIZE` — the painter's units are the dog's own, and the dog got bigger.
 *
 * The bug this replaces was a hand-picked ±2-unit swing left behind when the dog was scaled up: the
 * paws moved a quarter of the ground the body did, so the animal skated across the room with its
 * feet twitching. Anything that changes the dog's size or cadence now moves this with it.
 */
const MEAN_KX = 0.6366;
const GAIT_REACH = (STRIDE * MEAN_KX) / DOG_SIZE;
/** Fraction of each cycle a paw spends planted. A trot sits a shade above half. */
const DUTY = 0.56;
/** How high a paw lifts through its swing, dog units. */
const GAIT_LIFT = 2.9;

/**
 * Where one paw is in its cycle: `x` in units of `GAIT_REACH` (−0.5 behind the hip → +0.5 ahead),
 * `lift` in units of `GAIT_LIFT`.
 *
 * **Stance is a straight line and that is the whole point** — the paw is on the floor, so it tracks
 * backward at precisely the speed the floor passes under it and does not scrub. The return is a
 * Hermite whose end slopes *match that stance velocity at both handoffs*, so the paw is already
 * moving backward as it touches down and keeps moving backward as it plants: C¹ across the join,
 * with no hitch at the moment the weight lands. A sine would have stalled the paw dead at both ends
 * of the swing, which is the sewing-machine look every cheap walk cycle has.
 */
export function pawCycle(u: number): { x: number; lift: number } {
  const p = ((u % 1) + 1) % 1;
  if (p < DUTY) return { x: 0.5 - p / DUTY, lift: 0 };
  const q = (p - DUTY) / (1 - DUTY);
  const v = -(1 - DUTY) / DUTY; // stance velocity, expressed in swing-normalised time
  const q2 = q * q;
  const q3 = q2 * q;
  const x =
    (2 * q3 - 3 * q2 + 1) * -0.5 + (q3 - 2 * q2 + q) * v + (-2 * q3 + 3 * q2) * 0.5 + (q3 - q2) * v;
  // Lift weighted early: a paw leaves the floor smartly and comes down softly, which is what makes a
  // trot land rather than stamp.
  return { x, lift: Math.sin(Math.PI * Math.pow(q, 0.82)) };
}

/**
 * Draw the office dog at its current pose. Screen-space profile (like the members' billboarded faces): the
 * body reads side-on and `flip` mirrors it for leftward travel. Small on purpose — dog-sized next to ~40px
 * people — so judge it at 4× on /character-sheet, not here.
 *
 * Everything that makes this a *dog* rather than the cat that used to live here is in this function: ears
 * that flop instead of pricking up, a snout out front, cream paws, and a tail that wags where the cat's
 * curled. The behaviour machine driving it (pet.ts) never learned what species it is.
 *
 * The coat is white with black patches, which on a warm floor is a stronger silhouette than a solid
 * mid-tone ever was: the patches carry the shape, so the dog stays legible at office scale instead of
 * relying on its outline against whatever it happens to be standing on.
 */
export function drawDog(ctx: CanvasRenderingContext2D, fit: Fit, pet: PetState, t: number): void {
  const p = project(pet.lx, pet.ly, fit);
  // The one place the dog's size is set: every offset and radius below is in these units, so scaling
  // here scales the whole animal without touching a single pose.
  const s = fit.scale * DOG_SIZE;

  // The contact shadow is painted in world space, BEFORE the facing mirror. It belongs to the floor,
  // not to the body: a pool of shade that narrowed as the dog swivelled would read as the light
  // moving. During a trot it also breathes with the bob — the dog is lightest at the top of its
  // stride, and a shadow that ignores that is what makes a walk cycle feel weightless.
  const sh = DOG_SHADOW[pet.mode];
  const air = pet.mode === 'walk' ? 0.06 * Math.cos(pet.phase * 4 * Math.PI) : 0;
  ellipse(
    ctx,
    { x: p.x, y: p.y + 1.5 * s },
    sh.r * (1 - air) * s,
    sh.r * sh.flat * (1 - air) * s,
    `rgba(0,0,0,${(sh.a * (1 - air * 1.6)).toFixed(3)})`,
  );

  ctx.save();
  // Facing is a CONTINUOUS mirror (`pet.face`), not a boolean flip: a change of direction plays as
  // the body narrowing, passing through square-on and opening out the other way. Applied as a canvas
  // transform rather than a sign on every offset, so radii, stroke widths and clip paths all
  // foreshorten together — half a turn drawn with mirrored offsets but unmirrored radii is a dog
  // turning inside out.
  //
  // The floor is a RIBCAGE, not a degenerate-matrix guard. It used to be 0.03 — enough to keep the
  // matrix invertible, and also the exact "sheet of paper turning edge-on" nick kept seeing: a flat
  // profile squashed to 3% of its width IS a sheet of paper, geometrically. In life a dog seen from
  // any angle is still as wide as its chest, so the profile never narrows past this before the
  // chest-on view (below) has fully taken over and hidden it.
  const m = pet.face >= 0 ? Math.max(pet.face, 0.16) : Math.min(pet.face, -0.16);
  ctx.translate(p.x, p.y);
  ctx.scale(m, 1);
  const px = (dx: number, dy: number): Pt => ({ x: dx * s, y: dy * s });

  const stroke = (a: Pt, b: Pt, w: number, color: string): void => {
    ctx.strokeStyle = color;
    ctx.lineWidth = w * s;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
  };
  /** A tapered tail along a quadratic, with the cream tip every dog in this office is issued. */
  const tail = (x0: number, y0: number, cx: number, cy: number, x1: number, y1: number, w: number): void => {
    ctx.strokeStyle = DOG.patch;
    ctx.lineWidth = w * s;
    ctx.lineCap = 'round';
    ctx.beginPath();
    const a = px(x0, y0);
    const c = px(cx, cy);
    const b = px(x1, y1);
    ctx.moveTo(a.x, a.y);
    ctx.quadraticCurveTo(c.x, c.y, b.x, b.y);
    ctx.stroke();
    // The cream tip is the last stretch of the tail *restroked* at the same width, not a disc stuck on the
    // end — a round cap plus a circle makes a bulb, and the tail reads as a balloon on a string.
    const dx = x1 - cx;
    const dy = y1 - cy;
    const d = Math.hypot(dx, dy) || 1;
    const back = px(x1 - (dx / d) * 2.4, y1 - (dy / d) * 2.4);
    stroke(back, b, w, DOG.cream);
  };
  /**
   * A leg, hip to paw. The hip stays pinned to the body and only the paw travels, which is the
   * difference between a leg and the sliding pole this used to draw: a limb whose top moved with its
   * foot never looked attached to the animal.
   *
   * The knee is a quadratic control point pushed off the hip→paw line by `bend`, so the leg flexes
   * as it folds under and straightens as it reaches. Cheap, and at office scale indistinguishable
   * from solving the joint properly.
   */
  const limb = (
    hipX: number,
    footX: number,
    lift: number,
    w: number,
    bend: number,
    far = false,
  ): void => {
    const hip = px(hipX, -9.2);
    const foot = px(footX, -lift);
    // Perpendicular to the leg, so the bend reads the same whatever angle the stride puts it at.
    const dx = foot.x - hip.x;
    const dy = foot.y - hip.y;
    const len = Math.hypot(dx, dy) || 1;
    const knee = {
      x: (hip.x + foot.x) / 2 + (dy / len) * bend * s * m,
      y: (hip.y + foot.y) / 2 - (dx / len) * bend * s * m,
    };
    ctx.strokeStyle = far ? DOG.furFar : DOG.fur;
    ctx.lineWidth = w * s;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(hip.x, hip.y);
    ctx.quadraticCurveTo(knee.x, knee.y, foot.x, foot.y);
    ctx.stroke();
    ellipse(ctx, foot, w * 0.56 * s, w * 0.42 * s, far ? DOG.furFar : DOG.cream);
  };
  /** A standing leg — straight down from the hip, for the poses that are not mid-stride. */
  const leg = (x: number, lift: number, w = 2.6): void => limb(x, x, lift, w, 0);
  /** A floppy ear: hangs down the side of the head and swings a little with the body. Both are black —
   * on a white dog the ears are the markings that read first, at any size. */
  const ear = (x: number, y: number, r: number, swing = 0): void => {
    ellipse(ctx, px(x + swing * 0.4, y + r * 0.9), r * 0.78 * s, r * 1.45 * s, DOG.patch);
    ellipse(ctx, px(x + swing * 0.4, y + r * 0.95), r * 0.4 * s, r * 0.85 * s, DOG.earIn);
  };
  /**
   * The head, snout-first. `awake` opens the eye; a sleeping dog gets a lash line and its muzzle resting
   * on its paws. Drawn ear-then-skull so the far ear tucks behind the head.
   */
  const head = (x: number, y: number, awake: boolean, swing = 0, tongue = false): void => {
    ear(x - 3.6, y - 2.4, 2.5, swing); // far ear, behind the skull
    ellipse(ctx, px(x, y), 5.8 * s, 5.2 * s, DOG.fur);
    // The eye patch — one dark side to the face, clipped to the skull so it can't spill onto the snout.
    // A white dog needs it: without a marking up here the head is a blank oval and the whole animal
    // loses its expression at office scale.
    ctx.save();
    ctx.beginPath();
    const skull = px(x, y);
    ctx.ellipse(skull.x, skull.y, 5.8 * s, 5.2 * s, 0, 0, Math.PI * 2);
    ctx.clip();
    ellipse(ctx, px(x + 0.4, y - 1.4), 3.4 * s, 3.8 * s, DOG.patch);
    ctx.restore();
    ellipse(ctx, px(x + 4.6, y + 2.2), 4.3 * s, 2.5 * s, DOG.cream); // snout, out front
    if (tongue) ellipse(ctx, px(x + 5.4, y + 4), 1.5 * s, 1.1 * s, DOG.tongue);
    ellipse(ctx, px(x + 8.2, y + 1.4), 1.25 * s, 1.05 * s, DOG.nose);
    ellipse(ctx, px(x + 2.4, y - 3.4), 2.4 * s, 1.5 * s, DOG.patch); // brow — reads as the patch's top edge
    // The eye sits *on* the patch, so it gets a pale rim: a dark eye on dark fur is no eye at all.
    if (awake) {
      ellipse(ctx, px(x + 1.4, y - 1), 1.55 * s, 1.7 * s, DOG.cream);
      ellipse(ctx, px(x + 1.4, y - 1), 1 * s, 1.15 * s, DOG.eye);
      ellipse(ctx, px(x + 1.75, y - 1.5), 0.34 * s, 0.34 * s, '#ffffff'); // catchlight — the whole charm of a face
    } else {
      ellipse(ctx, px(x + 1.4, y - 0.8), 1.7 * s, 1 * s, DOG.cream);
      stroke(px(x + 0.5, y - 0.8), px(x + 2.3, y - 0.8), 0.8, DOG.eye);
    }
    ear(x + 2.6, y - 2.2, 2.7, swing); // near ear, over the cheek
  };
  /**
   * Black patches, clipped to whichever body ellipse the pose just drew — so a marking always sits *on*
   * the dog instead of floating beside it, whatever shape the pose folded it into.
   *
   * Blob placement is in fractions of the body's own radii rather than absolute units, which is what
   * lets the same three markings ride a curled comma, an upright sit and a trotting flank and stay
   * recognisably the same dog. They are deliberately off-centre and different sizes: three tidy blobs
   * read as a pattern, three scruffy ones read as an animal.
   */
  const patches = (x: number, y: number, rx: number, ry: number): void => {
    ctx.save();
    ctx.beginPath();
    const c = px(x, y);
    ctx.ellipse(c.x, c.y, rx * s, ry * s, 0, 0, Math.PI * 2);
    ctx.clip();
    // Over the back and shoulders — the big one, and the marking that carries the silhouette.
    ellipse(ctx, px(x - rx * 0.16, y - ry * 0.68), rx * 0.68 * s, ry * 0.92 * s, DOG.patch);
    // Hip, thrown the other way so the two never merge into one stripe down the spine.
    ellipse(ctx, px(x - rx * 0.66, y + ry * 0.18), rx * 0.36 * s, ry * 0.6 * s, DOG.patch);
    // A small one low on the flank: the bit of asymmetry that stops it reading as two-tone.
    ellipse(ctx, px(x + rx * 0.44, y + ry * 0.42), rx * 0.19 * s, ry * 0.28 * s, DOG.patch);
    ctx.restore();
  };
  /** A single patch clipped to a smaller part (the chest), for the same reason. */
  const patchOn = (x: number, y: number, rx: number, ry: number): void => {
    ctx.save();
    ctx.beginPath();
    const c = px(x, y);
    ctx.ellipse(c.x, c.y, rx * s, ry * s, 0, 0, Math.PI * 2);
    ctx.clip();
    ellipse(ctx, px(x - rx * 0.5, y - ry * 0.45), rx * 0.62 * s, ry * 0.5 * s, DOG.patch);
    ctx.restore();
  };
  /**
   * The roundness pass: a warm belly shade and a crown of light, clipped to the body ellipse the pose
   * just drew. Painted OVER the patches — light falls on the coat and its markings alike, which is
   * what turns a flat sticker into a volume (nick, 2026-07-29: "the dog isn't really 3d looking like
   * the members are"). Both stay on the warm axis: a neutral grey shade on a warm floor reads as dirt.
   */
  const shade = (x: number, y: number, rx: number, ry: number): void => {
    ctx.save();
    ctx.beginPath();
    const c = px(x, y);
    ctx.ellipse(c.x, c.y, rx * s, ry * s, 0, 0, Math.PI * 2);
    ctx.clip();
    ellipse(ctx, px(x, y + ry * 0.66), rx * 1.08 * s, ry * 0.6 * s, 'rgba(88, 62, 40, 0.16)');
    ellipse(ctx, px(x - rx * 0.12, y - ry * 0.58), rx * 0.8 * s, ry * 0.46 * s, 'rgba(255, 252, 243, 0.3)');
    ctx.restore();
  };
  const collar = (x: number, y: number, r: number): void => {
    ellipse(ctx, px(x, y), r * s, r * 0.42 * s, DOG.collar);
    ellipse(ctx, px(x + r * 0.15, y + r * 0.5), r * 0.24 * s, r * 0.26 * s, DOG.tag);
  };

  switch (pet.mode) {
    case 'sleep':
    case 'curl': {
      // Nose-to-tail comma: chin down on the front paws, tail draped round the flank (a dog flops where a
      // cat wraps into a bun), slow breathing that damps in as the settle completes.
      const settle = pet.mode === 'curl' ? Math.min(1, pet.modeT / CURL_VIS_S) : 1;
      const breathe = 1 + 0.05 * Math.sin(t * 1.9) * settle;
      tail(-9, -7, -14, 0.5, -4, 1, 2.8); // draped round the flank, behind the body — a dog flops, it doesn't wrap
      ellipse(ctx, px(-0.5, -5.5), 12.5 * s, 6.8 * breathe * s, DOG.fur);
      patches(-0.5, -5.5, 12.5, 6.8 * breathe);
      shade(-0.5, -5.5, 12.5, 6.8 * breathe);
      ellipse(ctx, px(7.5, -2), 3.6 * s, 1.8 * s, DOG.cream); // front paws, tucked under the chin
      head(7, -6.5, false);
      break;
    }
    case 'sit': {
      // Upright on the haunches, front legs straight, tail sweeping the floor behind — the supervising
      // pose, and the one members walk past. Tongue out: a sitting dog watching you work is a happy one.
      const wag = Math.sin(t * WAG_HZ * Math.PI * 2);
      tail(-6.5, -6, -12, -1 + wag * 1.2, -14.5, 0.5 + wag * 2.6, 2.8); // thumping the floor
      ellipse(ctx, px(-1.5, -7.5), 8.2 * s, 8.5 * s, DOG.fur); // haunches
      patches(-1.5, -7.5, 8.2, 8.5);
      shade(-1.5, -7.5, 8.2, 8.5);
      ellipse(ctx, px(3.5, -12), 5.4 * s, 7.2 * s, DOG.fur); // chest, up
      // A patch over the shoulder rather than the old cream blaze, which is invisible now the coat is
      // white. It also separates the chest from the haunches, which would otherwise merge into one blob.
      patchOn(3.5, -12, 5.4, 7.2);
      shade(3.5, -12, 5.4, 7.2);
      leg(2.2, 0.5);
      leg(5.4, 0.5);
      collar(4.5, -18.5, 4.4);
      head(5, -23, true, wag * 0.5, true);
      break;
    }
    case 'stretch': {
      // The play-bow every dog wakes up with: front paws reaching, chest to the floor, rump high, tail up.
      const wag = Math.sin(t * WAG_HZ * Math.PI * 2);
      tail(-9.5, -16, -14 + wag * 2, -22, -11 + wag * 3.5, -26, 2.8);
      ellipse(ctx, px(-7, -13), 7.8 * s, 7.2 * s, DOG.fur); // haunches, up
      patches(-7, -13, 7.8, 7.2);
      shade(-7, -13, 7.8, 7.2);
      leg(-9, 0.5, 3);
      ellipse(ctx, px(2, -5.5), 8.5 * s, 4.4 * s, DOG.fur); // chest sweeping low
      shade(2, -5.5, 8.5, 4.4);
      stroke(px(4, -5.5), px(13, -1.5), 2.6, DOG.fur); // front legs reaching out flat
      ellipse(ctx, px(13, -1.5), 1.5 * s, 1 * s, DOG.cream);
      collar(9.5, -8.5, 4);
      head(12, -12, true, 0, true);
      break;
    }
    case 'walk': {
      // Trotting: the two diagonal pairs, each paw planted for most of its cycle so the feet hold the
      // floor while the body travels over them. Far legs, then body, then near legs — so it reads as
      // four feet, not a comb.
      const a = pawCycle(pet.phase); // far hind + near front
      const b = pawCycle(pet.phase + 0.5); // far front + near hind
      // Two beats of rise and fall per cycle (one per diagonal), and a matching fore/aft surge — the
      // body is thrown forward as each pair drives and eases back as it swings through.
      const bob = -Math.cos(pet.phase * 4 * Math.PI) * 0.95;
      const surge = Math.sin(pet.phase * 4 * Math.PI) * 0.55;
      const wag = Math.sin(t * WAG_HZ * Math.PI * 2);
      // A hind leg folds forward under the dog, a front leg folds back — opposite knees, which is
      // most of what separates a dog's trot from a pantomime horse.
      const hind = (c: typeof a, hipX: number, w: number, far = false): void =>
        limb(hipX, hipX + c.x * GAIT_REACH, c.lift * GAIT_LIFT + 0.5, w, -1.5 - c.lift * 1.4, far);
      const front = (c: typeof a, hipX: number, w: number, far = false): void =>
        limb(hipX, hipX + c.x * GAIT_REACH, c.lift * GAIT_LIFT + 0.5, w, 1.4 + c.lift * 1.3, far);
      // A sabre, not a flagpole: it leaves the rump going BACKWARD and only then sweeps up, so the
      // curve reads as a tail carried high rather than an aerial bolted to the hips. The wag swings
      // the tip through the arc; the base barely moves, which is how a tail actually works.
      tail(-10 + surge, -13.5 + bob, -18 + wag * 1.2, -19, -15.5 + wag * 3.2, -25, 2.8);
      hind(a, -7 + surge, 2.4, true);
      front(b, 6 + surge, 2.4, true);
      ellipse(ctx, px(surge, -12.5 + bob), 11.5 * s, 6 * s, DOG.fur);
      // Shoulder and haunch mass: two overlapping forms a half-tone off the barrel, the standard
      // illustrator's fake for a rib cage. This is what the legs attach TO — without it they read as
      // sticks under a shape, and the flat barrel is most of why a mid-turn dog read as paper even
      // after the roundness pass below (the shade pass lights a volume; it cannot invent one).
      // Under `patches`/`shade`, so markings and light fall across them like the rest of the coat.
      ellipse(ctx, px(6.2 + surge, -12 + bob), 5.4 * s, 5.2 * s, 'rgba(214, 206, 192, 0.55)');
      ellipse(ctx, px(-6.8 + surge, -12.2 + bob), 5.9 * s, 5.5 * s, 'rgba(214, 206, 192, 0.55)');
      patches(surge, -12.5 + bob, 11.5, 6);
      shade(surge, -12.5 + bob, 11.5, 6);
      hind(b, -6 + surge, 2.9);
      front(a, 7 + surge, 2.9);
      collar(10.5 + surge, -16.5 + bob, 4);
      // The head lags the body by a fraction of a beat — the follow-through that stops the whole dog
      // reading as one rigid piece bouncing on springs.
      const lag = -Math.cos((pet.phase - 0.055) * 4 * Math.PI) * 0.95;
      head(12.5 + surge * 1.15, -21 + lag, true, -lag * 1.2, true);
      break;
    }
  }
  ctx.restore();

  // ── the toward/away view ───────────────────────────────────────────────────────────────────────
  // The profile above is a billboard: walking at or away from the camera the mirror narrows it toward
  // a sliver, and a sliver held for a whole diagonal is the "extremely thin, like a piece of paper"
  // read (nick, 2026-07-29). So once the mirror gets narrow, crossfade in the view the billboard
  // never had — a chest-on (or rump-on) dog on the same gait cycles. The profile keeps painting
  // underneath; by the time this is opaque the profile is a few pixels wide and fully hidden, so the
  // fade never shows a double image.
  const towardness = towardnessFor(pet.face);
  if (pet.mode === 'walk' && towardness > 0) drawDogFacing(ctx, p, s, pet, t, towardness);
}

/**
 * How much of the chest-on view to blend in as the profile squashes.
 *
 * The window starts EARLIER than the original 0.55: the band between full profile and 0.55 was the
 * remaining "paper" band — squashed billboard, no chest-on view yet — and a walking dog turns
 * constantly, so it spent most of every turn inside it. The ramp ends at |face| 0.35, comfortably
 * above the 0.16 ribcage floor in `drawDog`, so the profile underneath is fully hidden while it is
 * still a plausible body width. Exported for the tests: this is pure geometry policy, no canvas.
 */
export function towardnessFor(face: number): number {
  return Math.min(1, Math.max(0, (0.75 - Math.abs(face)) / 0.4));
}

/**
 * The dog seen along its own spine — toward the camera (`pet.depthSign === 1`, we get the face) or
 * away (we get the rump and the back of the head). Deliberately the same vocabulary as the profile:
 * cream paws, one dark eye patch, the mustard collar, the wagging cream-tipped tail — so the
 * crossfade reads as the same animal turning, not a sprite swap.
 */
function drawDogFacing(
  ctx: CanvasRenderingContext2D,
  p: Pt,
  s: number,
  pet: PetState,
  t: number,
  alpha: number,
): void {
  const toward = pet.depthSign === 1;
  // A whisper of the dying profile heading, so the figure leans out of the turn rather than snapping
  // to dead-symmetric the instant the crossfade starts.
  const lean = pet.face * 2.2;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.translate(p.x, p.y);
  const px = (dx: number, dy: number): Pt => ({ x: dx * s, y: dy * s });

  const a = pawCycle(pet.phase);
  const b = pawCycle(pet.phase + 0.5);
  const bob = -Math.cos(pet.phase * 4 * Math.PI) * 0.95;
  const wag = Math.sin(t * WAG_HZ * Math.PI * 2);
  const lag = -Math.cos((pet.phase - 0.055) * 4 * Math.PI) * 0.95;

  /** A straight leg seen end-on: only the lift and a little lateral sway of the stride survive the
   *  foreshortening — the reach itself points along the view axis and vanishes. */
  const leg = (x: number, c: { x: number; lift: number }, w: number, far = false): void => {
    const hip = px(x + lean * 0.4, -9.2 + bob * 0.4);
    const foot = px(x * (1 + 0.12 * c.x) + lean * 0.4, -(c.lift * GAIT_LIFT + 0.5));
    ctx.strokeStyle = far ? DOG.furFar : DOG.fur;
    ctx.lineWidth = w * s;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(hip.x, hip.y);
    ctx.lineTo(foot.x, foot.y);
    ctx.stroke();
    ellipse(ctx, foot, w * 0.56 * s, w * 0.42 * s, far ? DOG.furFar : DOG.cream);
  };
  /** The tail, end-on: base hidden by the body, the cream tip swinging wide of the rump. */
  const tail = (): void => {
    const bx = (pet.flip ? -1 : 1) * 1.6 + lean;
    const base = px(bx, -14 + bob);
    const mid = px(bx + wag * 1.4, -18.5 + bob);
    const tip = px(bx + wag * 3, -21.5 + bob);
    ctx.strokeStyle = DOG.patch;
    ctx.lineWidth = 2.6 * s;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(base.x, base.y);
    ctx.quadraticCurveTo(mid.x, mid.y, tip.x, tip.y);
    ctx.stroke();
    ctx.strokeStyle = DOG.cream;
    ctx.beginPath();
    ctx.moveTo((mid.x + tip.x) / 2, (mid.y + tip.y) / 2);
    ctx.lineTo(tip.x, tip.y);
    ctx.stroke();
  };
  /** The head, straight on (or from behind). Both ears show; the away view is all crown patch. */
  const head = (): void => {
    const hx = lean * 1.6;
    const hy = -21 + lag;
    // both floppy ears, hanging off the sides of the skull
    for (const ex of [-4.6, 4.6]) {
      ellipse(ctx, px(hx + ex, hy - 0.6), 1.9 * s, 3.5 * s, DOG.patch);
      if (toward) ellipse(ctx, px(hx + ex * 0.98, hy - 0.4), 0.9 * s, 2 * s, DOG.earIn);
    }
    ellipse(ctx, px(hx, hy), 5.2 * s, 5 * s, DOG.fur);
    ctx.save();
    ctx.beginPath();
    const skull = px(hx, hy);
    ctx.ellipse(skull.x, skull.y, 5.2 * s, 5 * s, 0, 0, Math.PI * 2);
    ctx.clip();
    if (toward) {
      // the one-sided eye patch, same side the profile wears it
      ellipse(ctx, px(hx + (pet.flip ? -1.9 : 1.9), hy - 1.3), 2.9 * s, 3.5 * s, DOG.patch);
    } else {
      // back of the head: the patch saddles the whole crown and there is no face to draw
      ellipse(ctx, px(hx, hy - 1.2), 4.5 * s, 4.2 * s, DOG.patch);
    }
    ctx.restore();
    if (!toward) return;
    ellipse(ctx, px(hx, hy + 2.6), 3.2 * s, 2.2 * s, DOG.cream); // muzzle, dead centre
    ellipse(ctx, px(hx + 0.4, hy + 4.6), 1.2 * s, 1 * s, DOG.tongue);
    ellipse(ctx, px(hx, hy + 1.7), 1.25 * s, 1 * s, DOG.nose);
    for (const ex of [-2.1, 2.1]) {
      ellipse(ctx, px(hx + ex, hy - 1), 1.35 * s, 1.5 * s, DOG.cream);
      ellipse(ctx, px(hx + ex, hy - 1), 0.85 * s, 1 * s, DOG.eye);
      ellipse(ctx, px(hx + ex + 0.3, hy - 1.4), 0.3 * s, 0.3 * s, '#ffffff');
    }
  };
  /** The barrel: rounder than the profile's side view, with the same shade/highlight roundness pass. */
  const body = (): void => {
    const by = -12.5 + bob;
    ellipse(ctx, px(lean, by), 7.2 * s, 6.2 * s, DOG.fur);
    ctx.save();
    ctx.beginPath();
    const c = px(lean, by);
    ctx.ellipse(c.x, c.y, 7.2 * s, 6.2 * s, 0, 0, Math.PI * 2);
    ctx.clip();
    if (toward) {
      ellipse(ctx, px(lean - 2.6, by - 2.2), 3.2 * s, 3.4 * s, DOG.patch); // shoulder patch
      ellipse(ctx, px(lean + 0.6, by + 2.4), 3.2 * s, 3.2 * s, DOG.cream); // chest blaze
    } else {
      ellipse(ctx, px(lean + 0.4, by - 1.6), 4.6 * s, 4.2 * s, DOG.patch); // the saddle over the back
      ellipse(ctx, px(lean - 3.6, by + 1.4), 2 * s, 2.6 * s, DOG.patch);
    }
    ellipse(ctx, px(lean, by + 4), 7.6 * s, 3.6 * s, 'rgba(88, 62, 40, 0.16)');
    ellipse(ctx, px(lean - 0.8, by - 3.6), 5.6 * s, 2.8 * s, 'rgba(255, 252, 243, 0.3)');
    ctx.restore();
  };
  const collar = (): void => {
    ellipse(ctx, px(lean, -17 + bob), 4.3 * s, 1.35 * s, DOG.collar);
    if (toward) ellipse(ctx, px(lean + 0.6, -15.6 + bob), 1 * s, 1.1 * s, DOG.tag);
  };

  if (toward) {
    tail(); // far side, peeking over the rump
    leg(-4.4, a, 2.4, true);
    leg(4.4, b, 2.4, true);
    body();
    leg(-2.5, b, 2.9);
    leg(2.5, a, 2.9);
    collar();
    head();
  } else {
    head(); // beyond the body, so the shoulders overlap its chin
    collar();
    leg(-4.4, b, 2.4, true);
    leg(4.4, a, 2.4, true);
    body();
    leg(-2.5, a, 2.9);
    leg(2.5, b, 2.9);
    tail(); // nearest the camera — over everything
  }
  ctx.restore();
}

/** The pool of shade each pose casts: radius and flatness in dog units, and its darkness. */
const DOG_SHADOW: Record<PetState['mode'], { r: number; flat: number; a: number }> = {
  sleep: { r: 15, flat: 0.307, a: 0.14 },
  curl: { r: 15, flat: 0.307, a: 0.14 },
  sit: { r: 13, flat: 0.323, a: 0.14 },
  stretch: { r: 16, flat: 0.288, a: 0.14 },
  walk: { r: 14.5, flat: 0.31, a: 0.12 },
};

/** How long the settle-down takes to visually damp the breathing in from the sit (matches pet.ts CURL_S). */
const CURL_VIS_S = 1.1;

/**
 * Solve a member's skeleton for this frame from their pose (see `skeleton.ts` — all the animation lives
 * there; this only decides *which* animation state the pose implies).
 */
function skelFor(pose: Pose, node: OfficeNode, t: number) {
  const seed = seedOf(node.name);
  // Typing is gated on `posture`, **not `activity`** — the same source of truth the seating uses. A stale
  // member keeps its last-known `activity: working` while the server projects its posture down to `idle`,
  // so gating on activity left it drumming an imaginary keyboard on the lounge couch. Posture puts working
  // members at desks and idle members on the furniture, so keying typing off it means only a member the
  // floor placed at a desk types. The `sit > 0.9` guard still holds — no typing while rising from a chair.
  // And no typing *through a gesture* — a member mid-stretch or mid-sip has their hands anywhere but the keys.
  const typing = node.posture === 'working' && pose.sit > 0.9 && pose.gesture === 0 ? typingBurst(seed, t) : 0;
  return solveSkeleton({
    phase: pose.phase,
    sit: pose.sit,
    stride: pose.stride,
    run: pose.run,
    t,
    typing,
    carry: pose.carry,
    help: pose.bubble !== null,
    gesture: pose.gesture,
    gestureT: pose.gestureT,
    seed,
  });
}

/** A speech/thought bubble over an actor's head (raised-hand `?`, urgent `!`). Screen-space. */
function bubble(ctx: CanvasRenderingContext2D, x: number, y: number, glyph: '?' | '!', s: number): void {
  const w = 22 * s;
  const h = 18 * s;
  roundRect(ctx, x - w / 2, y - h, w, h, 6 * s, '#20242b');
  ctx.fillStyle = '#20242b';
  ctx.beginPath();
  ctx.moveTo(x - 4 * s, y - 2 * s);
  ctx.lineTo(x + 4 * s, y - 2 * s);
  ctx.lineTo(x, y + 5 * s);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = glyph === '!' ? '#f3776a' : '#f4cf52';
  ctx.font = canvasFont(Math.round(13 * s));
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(glyph, x, y - h / 2);
}

/**
 * Draw a member as a free actor at a pose. Position drives the depth-sort in `renderScene`, so a walker
 * overlaps desks correctly; the body itself is whatever `skeleton.ts` solved for this frame.
 *
 * `armsOnly` is the seated overlay pass — see `renderScene`.
 */
export function drawActor(
  ctx: CanvasRenderingContext2D,
  fit: Fit,
  pose: Pose,
  node: OfficeNode,
  t: number,
  armsOnly = false,
  /** Mug colour while a sip beat is playing — the painter puts it in the raised hand. */
  mug?: string,
): void {
  drawCharacter(
    ctx,
    fit,
    {
      lx: pose.lx,
      ly: pose.ly,
      dir: pose.dir,
      ...(pose.heading !== undefined ? { heading: pose.heading } : {}),
      node,
      skel: skelFor(pose, node, t),
      size: pose.small ? 0.72 : 1,
      alpha: pose.alpha,
      carry: pose.carry,
      gesture: pose.gesture,
      gestureT: pose.gestureT,
      ...(mug !== undefined ? { mug } : {}),
      t,
      seed: seedOf(node.name),
    },
    armsOnly,
  );
  if (!armsOnly && pose.bubble) {
    const p = project(pose.lx, pose.ly, fit);
    bubble(ctx, p.x, p.y - (pose.small ? 74 : 98) * fit.scale, pose.bubble, fit.scale);
  }
}

// ── a workstation: legged desk + task chair + oriented glowing monitor ──
/**
 * A task chair, in **two pieces**, because a seated member is *inside* it — and painter's order can only
 * put a whole object in front of or behind them.
 *
 * The cushion is under the sitter and the backrest is behind their back, so drawing the chair as one box
 * meant whichever side of the member it sorted on, it was wrong: it swallowed them from the waist down.
 * Split, each piece sorts at its own footprint and the right thing happens at every facing on its own — the
 * sitter paints over the cushion they are sitting on, and the backrest paints over their back only when the
 * chair is actually between them and the viewer.
 */
const CHAIR_BACK_OFF = 14; // how far behind the seat centre the backrest stands

// ── task-chair variety ──────────────────────────────────────────────────────────────────────────────
// Not every desk gets the same chair. The *kind* is a stable per-desk hash (like the surface props), so a
// desk always shows the same chair frame to frame but the pod reads as a real office — a plain task stool
// here, a wheeled office chair there, an armed exec seat, the odd high-backed gamer chair. The variation
// never touches the two load-bearing invariants: the cushion top stays at SEAT_TOP (where `skeleton.ts`
// lands a seated pelvis) and the backrest keeps its footprint (so a sitter still sorts between the two).
type ChairKind = 'stool' | 'wheeled' | 'exec' | 'gamer';
interface ChairStyle {
  caster: boolean; // a 5-star wheeled base instead of four splayed legs
  backH: number; // backrest height
  backW: number; // backrest width along the shoulders
  arms: boolean; // a low armrest each side
  headrest: boolean; // a headrest bump above the backrest
  wings: boolean; // racing-style side bolsters on the backrest
}
const CHAIR_ARM_SALT = 22;
const TASK_CHAIR: ChairStyle = { caster: false, backH: 26, backW: 34, arms: false, headrest: false, wings: false };

// The office is a *fixed* set of 12 desks (three pods of four). A probability hash over so few ids doesn't
// guarantee coverage — it can (and did) bucket all 12 into one variant, so the variety never shows. Instead
// each desk's chair/monitor is a curated spread: every kind appears, and every pod shows a mix (adjacent
// desks differ), which is exactly what makes the variety read. Still fully deterministic + stable per frame.
const CHAIR_KINDS_BY_ID: readonly ChairKind[] = [
  'gamer', 'wheeled', 'exec', 'stool', // pod 0 (top — two desks face the camera)
  'exec', 'gamer', 'stool', 'wheeled', // pod 1 (centre)
  'wheeled', 'exec', 'gamer', 'stool', // pod 2 (left)
];

/** Exported for the ambient scheduler: the chair beats (swivel/roll) need casters — a stool can't. */
export function chairKindFor(id: number): ChairKind {
  return CHAIR_KINDS_BY_ID[id % CHAIR_KINDS_BY_ID.length]!;
}
function chairStyleFor(id: number): ChairStyle {
  const arms = deskRnd(id, CHAIR_ARM_SALT) < 0.5;
  switch (chairKindFor(id)) {
    case 'stool':
      return TASK_CHAIR;
    case 'wheeled':
      return { caster: true, backH: 27, backW: 34, arms, headrest: false, wings: false };
    case 'exec':
      return { caster: true, backH: 35, backW: 36, arms: true, headrest: false, wings: false };
    case 'gamer':
      return { caster: true, backH: 43, backW: 38, arms: true, headrest: true, wings: true };
  }
}

/** Legs + cushion — the part a member sits *on*, so it paints before them. */
function chairBase(
  ctx: CanvasRenderingContext2D,
  fit: Fit,
  lx: number,
  ly: number,
  dir: Dir,
  color: string,
  style: ChairStyle = TASK_CHAIR,
): void {
  const sn = FWD[dir][1] !== 0;
  const p: [number, number] = [-FWD[dir][1], FWD[dir][0]]; // across-seat unit
  if (style.caster) {
    // A 5-star caster base: a central column, five ARMS radiating from it, and a wheel at each tip.
    //
    // The arms are the whole point of this block. Without them the base was five ellipses and a post
    // with nothing between — five dots hovering under the seat (nick, 2026-08-03: "it just looks like
    // 4 floats dots at the bottom"). A star base is *legs*; the wheels are only what the legs stand
    // on, and drawing the wheels without the legs draws the wrong half of the object.
    //
    // `box()` is axis-aligned so it cannot draw a spoke pointing anywhere but N/S/E/W. Each arm is a
    // projected quad instead: two points at the hub, two at the wheel, tapering outward the way a
    // real cast-alloy leg does, and lifted just off the floor so it reads as sitting ON the castors.
    const ARM_R = 14;
    const LIFT = 3.4;
    const arms: { d: number; a: number }[] = [];
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2 + 0.4;
      arms.push({ a, d: Math.cos(a) + Math.sin(a) }); // iso depth of the tip
    }
    // Back arms before front ones, or a near arm is painted over by the far one across the hub.
    arms.sort((m, n) => m.d - n.d);
    for (const { a } of arms) {
      const ux = Math.cos(a);
      const uy = Math.sin(a);
      const px = -uy;
      const py = ux;
      const at = (r: number, w: number): Pt => {
        const s = project(lx + ux * r + px * w, ly + uy * r + py * w, fit);
        return { x: s.x, y: s.y - LIFT * fit.scale };
      };
      quad(ctx, [at(1.5, 3.4), at(ARM_R, 2.1), at(ARM_R, -2.1), at(1.5, -3.4)], dim(color, 0.62));
      // The castor at the tip: a dark tyre with a highlight, so it reads as a wheel under the leg
      // rather than a smudge at the end of it.
      const wp = project(lx + ux * ARM_R, ly + uy * ARM_R, fit);
      ellipse(ctx, wp, 4 * fit.scale, 2.3 * fit.scale, dim(color, 0.42));
      ellipse(
        ctx,
        { x: wp.x, y: wp.y - 1.4 * fit.scale },
        2.4 * fit.scale,
        1.2 * fit.scale,
        dim(color, 0.72),
      );
    }
    box(ctx, fit, lx, ly, 6, 6, CHAIR_LIFT, dim(color, 0.55));
  } else {
    for (const [sx, sy] of [
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
    ] as const) {
      box(ctx, fit, lx + sx * 10, ly + sy * 10, 4, 4, CHAIR_LIFT, dim(color, 0.6));
    }
  }
  // The cushion top is SEAT_TOP — the exact height `skeleton.ts` puts a seated pelvis at, so a member lands
  // on the chair rather than near it.
  box(ctx, fit, lx, ly, sn ? 34 : 30, sn ? 30 : 34, CHAIR_SEAT_H, color, CHAIR_LIFT);
  // Armrests: a low rail either side, resting on the cushion (so they read beside the sitter's forearms).
  if (style.arms) {
    for (const s of [-1, 1] as const) {
      const ax = lx + p[0] * s * 17;
      const ay = ly + p[1] * s * 17;
      box(ctx, fit, ax, ay, sn ? 7 : 5, sn ? 5 : 7, 6, dim(color, 0.72), SEAT_TOP);
    }
  }
}

/** The backrest — its own footprint, so it sorts behind or in front of the sitter purely by facing. */
function chairBack(
  ctx: CanvasRenderingContext2D,
  fit: Fit,
  lx: number,
  ly: number,
  dir: Dir,
  color: string,
  style: ChairStyle = TASK_CHAIR,
): void {
  const sn = FWD[dir][1] !== 0;
  const p: [number, number] = [-FWD[dir][1], FWD[dir][0]];
  box(ctx, fit, lx, ly, sn ? style.backW : 7, sn ? 7 : style.backW, style.backH, dim(color, 0.85), CHAIR_LIFT + 4);
  if (style.wings) {
    // Two darker vertical bolsters at the shoulders — the racing-chair silhouette.
    for (const s of [-1, 1] as const) {
      const wx = lx + p[0] * s * (style.backW / 2 - 2);
      const wy = ly + p[1] * s * (style.backW / 2 - 2);
      box(ctx, fit, wx, wy, 5, 5, style.backH + 3, dim(color, 0.68), CHAIR_LIFT + 4);
    }
  }
  if (style.headrest) {
    box(ctx, fit, lx, ly, sn ? 16 : 5, sn ? 5 : 16, 7, dim(color, 0.78), CHAIR_LIFT + 4 + style.backH);
  }
}

// ── monitor variety ─────────────────────────────────────────────────────────────────────────────────
// Desks differ in what's on them: a lone monitor, two panels on a dual-arm stand, or one ultrawide curved
// screen. Curated per desk (same reasoning as the chairs — a probability hash over 12 fixed ids doesn't
// guarantee coverage, and did collapse to all-single). Every pod gets a mix, and the two camera-facing
// desks (ids 0,1) carry the boldest setups so the variety actually reads. Every panel still lights teal
// when its member is `working` and stays dim otherwise — the load-bearing work cue is intact.
type MonitorSetup = 'single' | 'dual' | 'ultrawide' | 'laptopRiser' | 'laptopDock';
// Two laptop rigs, from real desk hardware: `laptopRiser` = an open laptop raised on an aluminium stand
// beside the monitor; `laptopDock` = a *closed* laptop stood vertically in a wooden dock. Both sit on
// N/W-facing desks — the rows whose faces point at the camera — so the riser's lit screen and the dock's
// silver body read. ids 2 (pod 0, N), 7/10/11 (W).
const MONITOR_SETUPS_BY_ID: readonly MonitorSetup[] = [
  'single', 'dual', 'laptopRiser', 'ultrawide', // pod 0 (top — 2,3 face the camera)
  'single', 'dual', 'ultrawide', 'laptopDock', // pod 1 (centre — 6,7 face the camera)
  'single', 'dual', 'laptopRiser', 'laptopDock', // pod 2 (left — 10,11 face the camera)
];
function monitorSetupFor(id: number): MonitorSetup {
  return MONITOR_SETUPS_BY_ID[id % MONITOR_SETUPS_BY_ID.length]!;
}

// ── screen life: the animated desktop on a working member's monitor ─────────────────────────────────
// A lit screen isn't a flat teal slab any more — it's a tiny living desktop: editor windows with
// traffic-light dots, pastel code lines that type themselves in and scroll away, a blinking caret, and
// the occasional sparkle drifting up off the glass. Everything is deterministic in (seed, t) — the seed
// keeps each desk's windows in their own places frame to frame, and `t` (the scene clock) drives typing,
// blink and sparkle phase, so two desks never twinkle in sync.

/** Stable 0..1 from two ints — same shape as `deskRnd`, usable before its declaration point. */
function scrRnd(seed: number, salt: number): number {
  let h = (2166136261 ^ (seed + 1)) >>> 0;
  h = Math.imul(h, 16777619) ^ (salt * 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 2246822519);
  return ((h ^ (h >>> 13)) >>> 0) / 4294967296;
}

/** The code-line syntax palette — warm mustard first (it's musterd's office), then mint/coral/lavender. */
const CODE_HUES = ['#ffd166', '#7fe0ce', '#f4989c', '#c8b6f2', '#9ad1ff'] as const;
// Lit wallpaper brighter than the idle slab, so "glowing = working" still reads from across the room;
// the editor panes are the dark thing, floating on it like real windows.
const SCREEN_BG = '#2f9a8a';
const SCREEN_IDLE = '#4a6b66';

/** Map from screen-face UV (u across 0..1, v up 0..1) to canvas px. The face is a parallelogram: its
 * bottom edge runs BL→BR in projected space and its vertical is a straight screen-space lift of `vh`. */
type FaceMap = (u: number, v: number) => Pt;

function faceQuad(ctx: CanvasRenderingContext2D, map: FaceMap, u0: number, v0: number, u1: number, v1: number, fill: string): void {
  quad(ctx, [map(u0, v0), map(u1, v0), map(u1, v1), map(u0, v1)], fill);
}

/** Paint the living desktop inside an already-computed screen face. `wPx` is the face's on-canvas width
 * (decides how much detail fits); `windows` is how many editor panes to draw (1 for a laptop lid). */
function drawScreenLife(
  ctx: CanvasRenderingContext2D,
  map: FaceMap,
  wPx: number,
  scale: number,
  seed: number,
  t: number,
  windows: number,
): void {
  ctx.save();
  const path = [map(0, 0), map(1, 0), map(1, 1), map(0, 1)];
  ctx.beginPath();
  ctx.moveTo(path[0]!.x, path[0]!.y);
  for (let i = 1; i < 4; i++) ctx.lineTo(path[i]!.x, path[i]!.y);
  ctx.closePath();
  ctx.fillStyle = SCREEN_BG;
  ctx.fill();
  ctx.clip();

  // A slow aurora wash behind the windows — two soft drifting bands, so even the "wallpaper" is alive.
  for (let a = 0; a < 2; a++) {
    const cu = 0.5 + 0.42 * Math.sin(t * 0.21 + a * 2.4 + seed);
    faceQuad(ctx, map, cu - 0.26, 0, cu + 0.26, 1, a === 0 ? 'rgba(213, 255, 244, 0.16)' : 'rgba(255, 224, 130, 0.13)');
  }

  const tiny = wPx < 26 * scale; // laptop lids and far-off panels: fewer, chunkier details
  for (let k = 0; k < windows; k++) {
    const r = (s: number): number => scrRnd(seed, k * 97 + s);
    // Window k's stable geometry, in face UV. The second window offsets right/down so panes overlap.
    const wu = 0.05 + r(1) * 0.18 + k * 0.34;
    const wv = 0.08 + r(2) * 0.14 + k * 0.1;
    const ww = Math.min(0.56 + r(3) * 0.14, 0.97 - wu);
    const wh = Math.min(0.62 + r(4) * 0.2, 0.9 - wv);
    // Pane + title bar (the near-black chrome makes the pastel lines pop) + traffic-light dots.
    faceQuad(ctx, map, wu, wv, wu + ww, wv + wh, '#123b40');
    const barH = 0.14;
    faceQuad(ctx, map, wu, wv + wh - barH, wu + ww, wv + wh, '#0a2b30');
    if (!tiny) {
      const dots = ['#ff6b6b', '#ffc24b', '#59d68f'];
      for (let d = 0; d < 3; d++) {
        const c = map(wu + 0.035 + d * 0.055, wv + wh - barH / 2);
        ellipse(ctx, c, 1.1 * scale, 0.8 * scale, dots[d]!);
      }
    }
    // Code lines typing in: a rolling cycle — each pane types its rows top to bottom, holds, then a new
    // "file" (gen) reshuffles the line widths. The caret blinks at the end of the line being typed.
    const rows = tiny ? 3 : 5;
    const cycle = t * 1.5 + r(5) * 40;
    const gen = Math.floor(cycle / (rows + 3));
    const prog = cycle - gen * (rows + 3); // 0..rows+3: type rows, then hold
    const lineH = (wh - barH) / (rows + 1);
    for (let row = 0; row < rows; row++) {
      if (prog < row) break;
      const full = 0.2 + scrRnd(seed, k * 97 + gen * 13 + row * 31) * (ww - 0.3);
      const frac = Math.max(0, Math.min(1, prog - row)); // this row's typed-in fraction
      const lv = wv + wh - barH - (row + 1) * lineH;
      const hue = CODE_HUES[(seed + gen + row * 2 + k) % CODE_HUES.length]!;
      const indent = scrRnd(seed, k * 97 + gen * 13 + row * 31 + 7) < 0.35 ? 0.08 : 0;
      faceQuad(ctx, map, wu + 0.05 + indent, lv, wu + 0.05 + indent + full * frac, lv + lineH * 0.45, hue);
      if (frac < 1 && Math.floor(t * 2.6) % 2 === 0) {
        // the blinking caret, riding the end of the active line
        faceQuad(ctx, map, wu + 0.05 + indent + full * frac, lv - lineH * 0.1, wu + 0.07 + indent + full * frac, lv + lineH * 0.6, '#fff6da');
      }
    }
  }
  ctx.restore();

  // Sparkles: two motes per screen, each on its own loop — born near the glass, drifting up past the top
  // edge and fading. Drawn unclipped so the magic visibly leaves the screen. Four-point star = two slivers.
  for (let s = 0; s < 2; s++) {
    const period = 3.2 + scrRnd(seed, 300 + s) * 2.5;
    const ph = (t / period + scrRnd(seed, 310 + s)) % 1;
    const a = Math.sin(ph * Math.PI);
    if (a < 0.05) continue;
    const p = map(0.15 + scrRnd(seed, 320 + s) * 0.7 + 0.08 * Math.sin(t * 1.7 + s * 3), 0.55 + ph * 0.9);
    const r = (1.6 + 1.1 * a) * scale;
    ctx.save();
    ctx.globalAlpha = a * 0.9;
    quad(ctx, [{ x: p.x - r, y: p.y }, { x: p.x, y: p.y - r * 0.32 }, { x: p.x + r, y: p.y }, { x: p.x, y: p.y + r * 0.32 }], '#ffe9a8');
    quad(ctx, [{ x: p.x, y: p.y - r }, { x: p.x + r * 0.32, y: p.y }, { x: p.x, y: p.y + r }, { x: p.x - r * 0.32, y: p.y }], '#fff6da');
    ctx.restore();
  }
}

/** One monitor panel: the stand box + the screen face (shown on the camera-facing N/W faces) + a soft
 * glow. A working member's screen runs the animated desktop (see `drawScreenLife`); an idle one stays a
 * flat dim slab, so "lit + alive = working" remains the load-bearing cue. `wAcross` is the panel width
 * along the shoulders; `h` its height; `curved` shades the outer thirds so an ultrawide reads as bowed. */
function screenPanel(
  ctx: CanvasRenderingContext2D,
  fit: Fit,
  mx: number,
  my: number,
  dir: Dir,
  working: boolean,
  up: number,
  wAcross: number,
  h: number,
  curved: boolean,
  t = 0,
): void {
  const sn = dir === 'S' || dir === 'N';
  const pw = sn ? wAcross : 5;
  const pd = sn ? 5 : wAcross;
  box(ctx, fit, mx, my, pw, pd, h, '#2a2e33', up + 8);
  const lo = (up + 8) * fit.scale;
  const hi = (up + 8 + h) * fit.scale;
  const dn = (p: Pt, u: number): Pt => ({ x: p.x, y: p.y - u });
  // The camera-facing face's bottom corners (BL→BR left-to-right on canvas); vertical is a straight lift.
  let BL: Pt | null = null;
  let BR: Pt | null = null;
  if (dir === 'N') {
    BL = project(mx - pw / 2, my + pd / 2, fit);
    BR = project(mx + pw / 2, my + pd / 2, fit);
  } else if (dir === 'W') {
    BL = project(mx + pw / 2, my + pd / 2, fit);
    BR = project(mx + pw / 2, my - pd / 2, fit);
  }
  if (BL && BR) {
    const bl = BL;
    const br = BR;
    if (working) {
      const map: FaceMap = (u, v) => ({ x: bl.x + u * (br.x - bl.x), y: bl.y + u * (br.y - bl.y) - lo - v * (hi - lo) });
      const wPx = Math.abs(br.x - bl.x);
      drawScreenLife(ctx, map, wPx, fit.scale, Math.abs(Math.round(mx * 7 + my * 13)), t, wAcross >= 30 ? 2 : 1);
    } else {
      quad(ctx, [dn(bl, lo), dn(br, lo), dn(br, hi), dn(bl, hi)], SCREEN_IDLE);
    }
    if (curved) {
      // Bow shading over whatever's on screen — translucent, so the animated desktop stays visible.
      const L2 = { x: bl.x + (br.x - bl.x) / 3, y: bl.y + (br.y - bl.y) / 3 };
      const R2 = { x: bl.x + ((br.x - bl.x) * 2) / 3, y: bl.y + ((br.y - bl.y) * 2) / 3 };
      quad(ctx, [dn(bl, lo), dn(L2, lo), dn(L2, hi), dn(bl, hi)], 'rgba(6, 20, 22, 0.22)');
      quad(ctx, [dn(R2, lo), dn(br, lo), dn(br, hi), dn(R2, hi)], 'rgba(6, 20, 22, 0.22)');
    }
    if (working) {
      // Light *emitted* from the lit screen: an additive bloom over the face plus a softer spill onto the
      // desk in front of it. Drawn here, inside the workstation's own depth item, so a monitor standing in
      // front occludes it — unlike the old DOM overlay, which always painted above the canvas and let a
      // back-row screen's glow bleed over a nearer monitor as a floating disc. Only the camera-facing lit
      // face (N/W) reaches this branch, so the glow only ever appears on a screen you can actually see.
      const cw = Math.abs(br.x - bl.x); // screen face width, px
      const chh = hi - lo; // screen face height, px
      const cx = (bl.x + br.x) / 2;
      const cyBottom = (bl.y + br.y) / 2 - lo; // screen's bottom edge (meets the desk)
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      const bloom = ctx.createRadialGradient(cx, cyBottom - chh * 0.5, 0, cx, cyBottom - chh * 0.5, cw * 0.66);
      bloom.addColorStop(0, 'rgba(154, 228, 240, 0.38)');
      bloom.addColorStop(1, 'rgba(154, 228, 240, 0)');
      ctx.fillStyle = bloom;
      ctx.beginPath();
      ctx.ellipse(cx, cyBottom - chh * 0.5, cw * 0.66, chh * 0.74, 0, 0, Math.PI * 2);
      ctx.fill();
      const spill = ctx.createRadialGradient(cx, cyBottom + chh * 0.34, 0, cx, cyBottom + chh * 0.34, cw * 0.9);
      spill.addColorStop(0, 'rgba(122, 210, 226, 0.2)');
      spill.addColorStop(1, 'rgba(122, 210, 226, 0)');
      ctx.fillStyle = spill;
      ctx.beginPath();
      ctx.ellipse(cx, cyBottom + chh * 0.34, cw * 0.9, chh * 0.52, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
  }
}

function monitor(
  ctx: CanvasRenderingContext2D,
  fit: Fit,
  mx: number,
  my: number,
  dir: Dir,
  working: boolean,
  surfaceUp: number,
  id: number | null,
  t = 0,
): void {
  const setup = id == null ? 'single' : monitorSetupFor(id);
  const p: [number, number] = [-FWD[dir][1], FWD[dir][0]]; // across-desk unit
  if (setup === 'dual') {
    // Two full-size panels (each the size of a single monitor) on a shared dual-arm stand, sat side by
    // side so they read as two real screens, not two half-screens. `[-1,1]` order paints the nearer last.
    box(ctx, fit, mx, my, 12, 8, 8, '#33272b', surfaceUp); // shared dual-arm foot
    for (const s of [-1, 1] as const) {
      screenPanel(ctx, fit, mx + p[0] * s * 18, my + p[1] * s * 18, dir, working, surfaceUp, 34, 22, false, t);
    }
  } else if (setup === 'ultrawide') {
    box(ctx, fit, mx, my, 10, 6, 8, '#33272b', surfaceUp);
    screenPanel(ctx, fit, mx, my, dir, working, surfaceUp, 54, 20, true, t);
  } else if (setup === 'laptopRiser' || setup === 'laptopDock') {
    // A single monitor with a laptop rig to one side (side alternates by desk id): either an open laptop
    // raised on an aluminium stand, or a closed laptop stood in a wooden vertical dock.
    box(ctx, fit, mx, my, 8, 6, 8, '#33272b', surfaceUp);
    screenPanel(ctx, fit, mx, my, dir, working, surfaceUp, 34, 22, false, t);
    const side = id != null && id % 2 === 0 ? 1 : -1;
    const lxp = mx + p[0] * side * 30;
    const lyp = my + p[1] * side * 30;
    if (setup === 'laptopRiser') laptopRiser(ctx, fit, lxp, lyp, dir, working, surfaceUp, t);
    else laptopDock(ctx, fit, lxp, lyp, dir, surfaceUp);
  } else {
    box(ctx, fit, mx, my, 8, 6, 8, '#33272b', surfaceUp);
    screenPanel(ctx, fit, mx, my, dir, working, surfaceUp, 34, 22, false, t);
  }
}

const LAPTOP_SILVER = '#c7ccd2';

/** An **open** laptop raised on an aluminium stand (the elevated-riser kind): a slim column lifts a top
 * plate to near monitor height, with the silver keyboard base + a dark key deck on it and the open lid
 * standing at the back, its screen lit on the camera-facing face. Silver so it reads as a laptop, not a
 * second monitor. Placed only on N/W desks so the lid's lit face shows. */
function laptopRiser(
  ctx: CanvasRenderingContext2D,
  fit: Fit,
  mx: number,
  my: number,
  dir: Dir,
  working: boolean,
  up: number,
  t = 0,
): void {
  const sn = dir === 'S' || dir === 'N';
  const f = FWD[dir];
  box(ctx, fit, mx, my, sn ? 20 : 14, sn ? 14 : 20, 2, '#aeb4bc', up); // stand base plate on the desk
  box(ctx, fit, mx, my, 7, 7, 12, '#b6bcc4', up + 2); // slim support column (laptop reads as lifted)
  const plateUp = up + 14;
  box(ctx, fit, mx, my, sn ? 22 : 15, sn ? 15 : 22, 2, '#bcc2ca', plateUp); // top plate
  const deckUp = plateUp + 2;
  box(ctx, fit, mx - f[0] * 3, my - f[1] * 3, sn ? 22 : 15, sn ? 15 : 22, 2, LAPTOP_SILVER, deckUp); // keyboard base
  box(ctx, fit, mx - f[0] * 3, my - f[1] * 3, sn ? 17 : 10, sn ? 10 : 17, 1, '#2b2f36', deckUp + 2); // dark key deck
  // Open lid standing at the back of the base, with a lit screen on the camera-facing face.
  const lw = sn ? 22 : 5;
  const ld = sn ? 5 : 22;
  const cx = mx + f[0] * 5;
  const cy = my + f[1] * 5;
  const lidUp = deckUp + 1;
  box(ctx, fit, cx, cy, lw, ld, 16, dim(LAPTOP_SILVER, 0.9), lidUp); // silver lid
  const lo = (lidUp + 2) * fit.scale;
  const hi = (lidUp + 14) * fit.scale;
  const dn = (pt: Pt, u: number): Pt => ({ x: pt.x, y: pt.y - u });
  let BL: Pt | null = null;
  let BR: Pt | null = null;
  if (dir === 'N') {
    BL = project(cx - lw / 2, cy + ld / 2, fit);
    BR = project(cx + lw / 2, cy + ld / 2, fit);
  } else if (dir === 'W') {
    BL = project(cx + lw / 2, cy + ld / 2, fit);
    BR = project(cx + lw / 2, cy - ld / 2, fit);
  }
  if (BL && BR) {
    const bl = BL;
    const br = BR;
    if (working) {
      // The laptop's little screen runs the same living desktop as the monitor — one pane, chunky details.
      const map: FaceMap = (u, v) => ({ x: bl.x + u * (br.x - bl.x), y: bl.y + u * (br.y - bl.y) - lo - v * (hi - lo) });
      drawScreenLife(ctx, map, Math.abs(br.x - bl.x), fit.scale, Math.abs(Math.round(cx * 7 + cy * 13)), t, 1);
    } else {
      quad(ctx, [dn(bl, lo), dn(br, lo), dn(br, hi), dn(bl, hi)], SCREEN_IDLE);
    }
  }
  const g = project(cx, cy, fit);
  ellipse(ctx, { x: g.x, y: g.y - (lidUp + 16) * fit.scale }, 7 * fit.scale, 3 * fit.scale, working ? '#59c3a3' : '#33504c');
}

/** A **closed** laptop stood vertically in a wooden dock: a walnut cradle with a slot, and the laptop as a
 * thin, tall silver slab rising out of it (its broad aluminium back to the room, hinge down). A quiet logo
 * dot sells the "back of a closed laptop" read. No lit screen — it's shut. */
function laptopDock(ctx: CanvasRenderingContext2D, fit: Fit, mx: number, my: number, dir: Dir, up: number): void {
  const sn = dir === 'S' || dir === 'N';
  box(ctx, fit, mx, my, sn ? 22 : 14, sn ? 14 : 22, 7, '#7c5230', up); // walnut cradle
  box(ctx, fit, mx, my, sn ? 8 : 4, sn ? 4 : 8, 2, '#5f3f24', up + 7); // dark slot groove on top
  // The closed laptop: broad (screen width) along the shoulders, thin (closed thickness) front-to-back,
  // tall (the laptop's depth, now vertical). Its wide silver face turns toward the camera.
  const w = sn ? 28 : 6;
  const d = sn ? 6 : 28;
  box(ctx, fit, mx, my, w, d, 30, LAPTOP_SILVER, up + 6);
  const g = project(mx, my, fit);
  ellipse(ctx, { x: g.x, y: g.y - (up + 22) * fit.scale }, 4 * fit.scale, 3 * fit.scale, dim(LAPTOP_SILVER, 0.82)); // logo dot
}

// ── desk-surface props: a keyboard + mouse on every desk, plus a deterministic personal mix ──────────
// Each optional prop (coffee / water / photo / plant / fan / lamp) is present or not per desk from a
// stable hash of the slot id, so a desk always shows the same combination frame to frame (no jitter) but
// desks differ from each other — one desk might carry a lone coffee mug, another a lamp + plant + photo.

const KEYBOARD = '#2b2f36';
const MOUSE = '#454b54';
/** Mouse shells, so the peripheral isn't identical desk to desk (paired with keyboard-width variety). */
const MOUSE_COLORS = ['#454b54', '#5a6069', '#6a5568', '#4a5f57', '#6b5a48'];
/** Keyboard widths along the shoulders: compact / standard / full — chosen per desk by a stable hash. */
const KEYBOARD_WIDTHS = [26, 34, 40] as const;
const KB_SALT = 32;
/** Distinct "photos" for standing frames — each desk with a frame gets one of these by hash. */
const PHOTOS = ['#6fa3c9', '#e0a05a', '#8db36a', '#c97f9c', '#9a8fce', '#d9b24a', '#e08585', '#5ab0a4'];
/** Mug colours, so coffee cups aren't all identical. */
const MUGS = ['#d6d0c6', '#c95c4a', '#3d6b8f', '#e0a72b', '#5f8a5a'];

/** FNV-ish hash of (desk id, salt) → a stable 0..1. Deterministic, so props never flicker per frame. */
function deskRnd(id: number, salt: number): number {
  let h = (2166136261 ^ (id + 1)) >>> 0;
  h = Math.imul(h, 16777619) ^ (salt * 0x9e3779b1);
  h = Math.imul(h, 16777619);
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

/** The optional personal props and where each sits on the desk, in desk-relative (along-facing, across)
 * coords: `along` +toward the monitor / −toward the seat, `across` +right / −left. `salt`+`prob` decide
 * per-desk presence from a stable hash. Shared by the canvas draw AND the animated-overlay anchors
 * (`animatedDeskAnchors`) so the spinning fan / coffee steam land exactly on the drawn prop. */
const PROP_KINDS = ['coffee', 'water', 'plant', 'photo', 'fan'] as const;
type PropKind = (typeof PROP_KINDS)[number];
const PROP_SPEC: Record<PropKind, { salt: number; prob: number; along: number; across: number }> = {
  coffee: { salt: 1, prob: 0.4, along: -4, across: -34 },
  water: { salt: 2, prob: 0.42, along: 7, across: -36 },
  plant: { salt: 3, prob: 0.46, along: 20, across: -40 },
  photo: { salt: 4, prob: 0.42, along: 20, across: 38 },
  fan: { salt: 6, prob: 0.38, along: -10, across: 38 },
};
/** Whether a given desk carries a given prop — a stable per-desk hash, independent of who's seated.
 * Exported for the ambient scheduler: a sip beat needs a mug on that member's desk to sip from. */
export function deskHasProp(id: number, kind: PropKind): boolean {
  return deskRnd(id, PROP_SPEC[kind].salt) < PROP_SPEC[kind].prob;
}
/** The mug colour a desk's coffee cup uses — one hash shared by the desk prop and the in-hand sip mug. */
function deskMugColor(id: number): string {
  return MUGS[Math.floor(deskRnd(id, 11) * MUGS.length)]!;
}
/** Desk-relative (along,across) → absolute logical point, given the desk's facing. */
function deskPoint(slot: { lx: number; ly: number; dir: Dir }, along: number, across: number): [number, number] {
  const f = FWD[slot.dir];
  return [slot.lx + f[0] * along - f[1] * across, slot.ly + f[1] * along + f[0] * across];
}

/** A flat keyboard: a base tray + a slightly raised key deck, oriented across the desk (facing-relative).
 * `shoulder` is its width along the shoulders (compact/standard/full) — per-desk, so keyboards vary. */
function deskKeyboard(ctx: CanvasRenderingContext2D, fit: Fit, ix: number, iy: number, sn: boolean, up: number, shoulder = 34): void {
  box(ctx, fit, ix, iy, sn ? shoulder : 13, sn ? 13 : shoulder, 3, KEYBOARD, up);
  box(ctx, fit, ix, iy, sn ? shoulder - 4 : 9, sn ? 9 : shoulder - 4, 4, '#3b414a', up); // key deck, a touch proud of the tray
}

/** A little mouse beside the keyboard — long axis pointing front-to-back, rounded top. Shell colour varies
 * per desk (`color`) so no two stations are quite identical. */
function deskMouse(ctx: CanvasRenderingContext2D, fit: Fit, ix: number, iy: number, sn: boolean, up: number, color = MOUSE): void {
  box(ctx, fit, ix, iy, sn ? 7 : 11, sn ? 11 : 7, 4, color, up);
  const g = project(ix, iy, fit);
  ellipse(ctx, { x: g.x, y: g.y - (up + 4) * fit.scale }, 5 * fit.scale, 3 * fit.scale, mul(color, 1.2));
}

function deskCoffee(ctx: CanvasRenderingContext2D, fit: Fit, ix: number, iy: number, up: number, mug: string, filled: boolean): void {
  box(ctx, fit, ix, iy, 11, 11, 12, mug, up); // mug body
  const g = project(ix, iy, fit);
  const rim = { x: g.x, y: g.y - (up + 12) * fit.scale };
  // A full mug (a member's at the desk) shows a dark coffee surface and steams; an unattended mug is
  // drawn empty — just its bare inner shadow, no coffee, no steam.
  ellipse(ctx, rim, 5.2 * fit.scale, 2.5 * fit.scale, filled ? '#3a2416' : dim(mug, 0.68));
}

function deskWater(ctx: CanvasRenderingContext2D, fit: Fit, ix: number, iy: number, up: number): void {
  box(ctx, fit, ix, iy, 9, 9, 24, '#bfe3f2', up); // translucent-looking body
  box(ctx, fit, ix, iy, 6, 6, 4, '#5aa0c9', up + 24); // cap
}

/** A standing photo frame: a thin upright frame with an inset "photo" panel on its room-facing faces. */
function deskPhoto(ctx: CanvasRenderingContext2D, fit: Fit, ix: number, iy: number, sn: boolean, up: number, photo: string): void {
  box(ctx, fit, ix, iy, sn ? 20 : 6, sn ? 6 : 20, 18, '#cfc8b8', up); // frame
  box(ctx, fit, ix, iy, sn ? 15 : 3, sn ? 3 : 15, 13, photo, up + 3); // inset photo (shows on the visible faces)
}

/** A small potted desk plant — terracotta pot + a low leafy cluster. */
function deskPlant(ctx: CanvasRenderingContext2D, fit: Fit, ix: number, iy: number, up: number): void {
  box(ctx, fit, ix, iy, 12, 12, 9, '#b9603a', up);
  const g = project(ix, iy, fit);
  const ty = g.y - (up + 9) * fit.scale;
  ellipse(ctx, { x: g.x, y: ty - 4 * fit.scale }, 9 * fit.scale, 7 * fit.scale, '#5f9350');
  ellipse(ctx, { x: g.x - 4 * fit.scale, y: ty - 1 * fit.scale }, 5 * fit.scale, 4 * fit.scale, '#74a860');
  ellipse(ctx, { x: g.x + 4 * fit.scale, y: ty - 6 * fit.scale }, 4.5 * fit.scale, 4 * fit.scale, '#6fa35a');
}

/** A desktop fan: a small base + neck holding a round grille disc. */
function deskFan(ctx: CanvasRenderingContext2D, fit: Fit, ix: number, iy: number, up: number): void {
  box(ctx, fit, ix, iy, 9, 9, 5, '#556069', up); // base
  box(ctx, fit, ix, iy, 3, 3, 12, '#4c565f', up + 4); // neck
  const g = project(ix, iy, fit);
  const cy = g.y - (up + 17) * fit.scale;
  ellipse(ctx, { x: g.x, y: cy }, 11 * fit.scale, 8 * fit.scale, '#8794a0');
  ellipse(ctx, { x: g.x, y: cy }, 8 * fit.scale, 5.5 * fit.scale, '#aeb9c2');
  ellipse(ctx, { x: g.x, y: cy }, 2.4 * fit.scale, 1.8 * fit.scale, '#5a646e'); // hub
}

/** A desk lamp: base + slim pole + a shade that glows warm when lit. Re-introduced from #304's removal
 * under that PR's own objection: the fixture draws ONLY at an occupied desk now (the sitter brought it,
 * the sitter takes it), so an unattended lamp can never float over an empty desk again — and it lights
 * only when it's dark enough out to want it (`LightEnv.lampsOn`), with its floor pool cast in
 * `drawInteriorLight`. */
function deskLamp(ctx: CanvasRenderingContext2D, fit: Fit, ix: number, iy: number, up: number, lit: boolean): void {
  box(ctx, fit, ix, iy, 10, 10, 3, '#3d4650', up); // base
  box(ctx, fit, ix, iy, 3, 3, 22, '#4a545f', up + 3); // pole
  const g = project(ix, iy, fit);
  const ty = g.y - (up + 26) * fit.scale;
  ellipse(ctx, { x: g.x, y: ty }, 9 * fit.scale, 5 * fit.scale, lit ? '#e9c46a' : '#aab0b8');
  if (lit) ellipse(ctx, { x: g.x, y: ty + 2 * fit.scale }, 6 * fit.scale, 3 * fit.scale, '#fff1c2'); // warm glow
}

/** Where the lamp stands on an occupied desk (desk-relative along/across — the old #222 prop spot). */
const LAMP_ALONG = 8;
const LAMP_ACROSS = 42;

/**
 * A folded brass desk wedge — the physical nameplate standing on every member's desk (Delight D).
 * Desk furniture, not a person label: the floating chip remains the walking identity; this one
 * belongs to the DESK, engraved with its owner's name whether they are seated, stepped away or
 * offline. Deliberately oversized against true desk scale (the mock proved a to-scale wedge
 * vanishes into the wood — same licence the speech bubbles already take), and brass, not bone:
 * cream sits too close to the desk's own value and disappears; the metal band is what separates
 * object from wood.
 *
 * The base carries a status light-pipe that spills onto the desk: working breathes (on `t`),
 * online-idle amber, dnd a steady ember, away/offline unlit. The plate keeps the two presence
 * CLAIMS the old baked plate made (§4/ADR 315): a stepped-away owner's plate says so in words,
 * and a disconnected seat keeps its amber corner glint.
 *
 * Anchor (ix,iy) is the plate's centre on the desk surface; length runs across the desk, face
 * turned toward the viewer (whichever sign of the facing axis has positive iso depth).
 */
function deskWedge(
  ctx: CanvasRenderingContext2D,
  fit: Fit,
  ix: number,
  iy: number,
  dir: Dir,
  node: OfficeNode,
  t: number,
  steppedAway: boolean,
): void {
  const f = FWD[dir];
  const p: [number, number] = [-f[1], f[0]];
  // Face toward the viewer: iso depth grows along +lx+ly, so flip the facing axis if it points away.
  const away: [number, number] = f[0] + f[1] > 0 ? [-f[0], -f[1]] : [f[0], f[1]];
  const O = project(ix, iy, fit);
  // A screen-space iso basis vector for one logical direction, normalized — derived via project()
  // so the wedge shares the room's exact axonometry without re-exporting KX/KY. Only the direction
  // is ever wanted here (the plate is sized in screen px, not logical units), so it normalizes at
  // the source rather than handing back a length nothing reads.
  const unit = (d: [number, number]): { x: number; y: number } => {
    const q = project(ix + d[0], iy + d[1], fit);
    const v = { x: q.x - O.x, y: q.y - O.y };
    const m = Math.hypot(v.x, v.y);
    return { x: v.x / m, y: v.y / m };
  };
  const deskY = O.y - DESK_UP * fit.scale;

  // Type first — the plate is sized to its engraving. ≥13px so it bakes legibly at stream scale
  // (the old owned-desk plate's clamp), which is also what keeps canvas type viable here at all.
  const name = node.name.toUpperCase();
  const px = Math.max(13, Math.round(13 * fit.scale));
  ctx.font = canvasFont(px, '--font-display', 700);
  // Letterspaced caps, engraver style — via the real canvas property (a no-op string assignment on
  // engines without it), so the glyph run stays ONE string: tests and text extraction see the name.
  const track = `${(px * 0.1).toFixed(1)}px`;
  ctx.letterSpacing = track;
  const nameW = ctx.measureText(name).width;
  ctx.letterSpacing = '0px';
  const sub = steppedAway ? 'stepped away' : null;

  // Wedge geometry in SCREEN pixels, mock-proven: the plate is deliberately oversized against true
  // desk scale (a to-scale wedge vanishes into the wood — the speech bubbles take the same
  // licence), so it is sized to its engraving in px and only leaned/foreshortened along the iso
  // axes. `sEff` clamps the world scale so depth still reads without the type collapsing.
  const sEff = Math.max(0.85, Math.min(1.15, fit.scale));
  const puN = (() => {
    const u = unit(p);
    return u.x < 0 ? { x: -u.x, y: -u.y } : u; // never paint the engraving upside down
  })();
  const buN = unit(away);
  const len = Math.max(34, nameW + 14); // screen px along the plate
  const high = px + (sub ? px : 0) + 8 * sEff; // face height, screen px
  const lean = 6 * sEff; // how far the top edge leans back, screen px
  const half = len / 2;
  const P = (a: number, b: number, h: number): [number, number] => [
    O.x + a * puN.x + b * buN.x,
    deskY + a * puN.y + b * buN.y - h,
  ];
  const poly = (pts: [number, number][]): void => {
    ctx.beginPath();
    ctx.moveTo(pts[0]![0], pts[0]![1]);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i]![0], pts[i]![1]);
    ctx.closePath();
  };

  const fbl = P(-half, 0, 0);
  const fbr = P(half, 0, 0);
  const ftl = P(-half, lean, high);
  const ftr = P(half, lean, high);

  // Contact shadow pooled under the fold — what seats the object on the wood.
  ctx.save();
  ctx.globalAlpha = 0.3;
  ctx.fillStyle = '#2a1a08';
  poly([P(-half - 2, -1.5, 0), P(half + 2, -1.5, 0), P(half + 2, lean * 2.6, 0), P(-half - 2, lean * 2.6, 0)]);
  ctx.fill();
  ctx.restore();

  // The fold's rear foot — a sliver of darker material behind the face.
  ctx.fillStyle = '#6b4d1f';
  poly([fbl, fbr, P(half, lean * 2.2, 0), P(-half, lean * 2.2, 0)]);
  ctx.fill();

  // Brass frame, then the engraved face panel inset within it.
  ctx.fillStyle = '#b98f42';
  poly([fbl, fbr, ftr, ftl]);
  ctx.fill();
  const grad = ctx.createLinearGradient(ftl[0], ftl[1], fbl[0], fbl[1]);
  grad.addColorStop(0, '#9c7433');
  grad.addColorStop(0.55, '#d8b166');
  grad.addColorStop(1, '#9c7433');
  ctx.fillStyle = grad;
  const inset = 2;
  poly([
    P(-half + inset, lean * 0.12, 1.6),
    P(half - inset, lean * 0.12, 1.6),
    P(half - inset, lean * 0.88, high - 1.8),
    P(-half + inset, lean * 0.88, high - 1.8),
  ]);
  ctx.fill();

  // Top ridge catching the ceiling light — the fold's one specular line.
  ctx.strokeStyle = '#f7e2ac';
  ctx.lineWidth = Math.max(1, 1.4 * fit.scale);
  ctx.globalAlpha = 0.95;
  ctx.beginPath();
  ctx.moveTo(ftl[0], ftl[1]);
  ctx.lineTo(ftr[0], ftr[1]);
  ctx.stroke();
  ctx.globalAlpha = 1;

  // Status light-pipe along the base + its spill onto the desk. Working breathes on `t` (the scene's
  // existing frame clock — no new rAF); away/offline stays unlit, absence reads as dark brass.
  const offline = node.presence === 'offline';
  const pipe =
    steppedAway || offline || node.presence === 'away'
      ? null
      : node.dnd
        ? '#e8804f'
        : node.posture === 'working'
          ? '#7ddba0'
          : '#f4cf52';
  if (pipe) {
    const breathe = node.posture === 'working' && !node.dnd ? 0.72 + 0.28 * Math.sin(t / 640) : 1;
    ctx.save();
    ctx.globalAlpha = 0.14 * breathe;
    ctx.fillStyle = pipe;
    poly([P(-half - 2, -5.5, 0), P(half + 2, -5.5, 0), P(half + 2, 0.8, 0), P(-half - 2, 0.8, 0)]);
    ctx.fill();
    ctx.globalAlpha = 0.95 * breathe;
    ctx.strokeStyle = pipe;
    ctx.lineWidth = Math.max(1.2, 1.9 * fit.scale);
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(fbl[0] + puN.x * 3, fbl[1] + puN.y * 3);
    ctx.lineTo(fbr[0] - puN.x * 3, fbr[1] - puN.y * 3);
    ctx.stroke();
    ctx.restore();
  }

  // The engraving. Ink dark-on-brass with a hairline light undercut — debossed, not printed.
  const mid = P(0, lean * 0.5, high * (sub ? 0.62 : 0.52));
  const angle = Math.atan2(puN.y, puN.x);
  ctx.save();
  ctx.translate(mid[0], mid[1]);
  ctx.rotate(angle);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = canvasFont(px, '--font-display', 700);
  ctx.letterSpacing = track;
  ctx.fillStyle = 'rgba(255, 246, 224, 0.5)';
  ctx.fillText(name, 0, 0.8);
  ctx.fillStyle = '#2a1d0c';
  ctx.fillText(name, 0, 0);
  ctx.letterSpacing = '0px';
  if (sub) {
    // Declared absence, said in words on the plate — a jacket alone is decoration, not a claim.
    ctx.font = canvasFont(Math.max(10, Math.round(10 * fit.scale)), '--font-mono', 400);
    ctx.fillStyle = 'rgba(42, 29, 12, 0.72)';
    ctx.fillText('stepped away', 0, px * 0.78);
  }
  ctx.restore();

  if (!steppedAway && node.offline_reason === 'disconnected') {
    // The one alarming flavor (ADR 315): a disconnected seat keeps its amber glint, top-right of the frame.
    ctx.fillStyle = '#d9a13c';
    ctx.beginPath();
    ctx.arc(ftr[0] - puN.x * 4, ftr[1] + 3, Math.max(2, 2.2 * fit.scale), 0, Math.PI * 2);
    ctx.fill();
  }
}

/** The desk of a workstation: legs + slab + oriented monitor (glowing if its owner works), plus a
 * keyboard + mouse and a deterministic mix of personal props. The task chair and the seated member are
 * NOT drawn here — the chair is its own depth item at its own footprint (see renderScene) and members are
 * free actors (see `drawActor`), so chair < sitter < desk (or the mirror of it, by facing) paint in true
 * painter's order instead of the desk blob swallowing both. Surface props self-sort back-to-front within
 * the desk by their own footprint depth, so a tall lamp/photo behind a mug never paints through it. */
function drawWorkstation(
  ctx: CanvasRenderingContext2D,
  fit: Fit,
  slot: { lx: number; ly: number; dir: Dir; id: number },
  node: OfficeNode | null,
  teamName: string,
  /** This desk is a kept, bodiless desk — an offline owner's or a stepped-away member's (§4). */
  owned = false,
  t = 0,
  /** Props to skip this frame — a prop currently "in the owner's hand" (sip mug) isn't on the desk. */
  hide?: Set<PropKind>,
  /** Is it dark enough out for desk lamps to be on? (`LightEnv.lampsOn`, threaded from the scene.) */
  lampsLit = false,
): void {
  const { lx, ly, dir, id } = slot;
  const f = FWD[dir];
  const p: [number, number] = [-f[1], f[0]]; // desk-left/right unit (perpendicular to facing)
  const sn = dir === 'S' || dir === 'N';
  const W = DESK_W;
  const Df = DESK_D;
  const DH = DESK_LEG_H;
  const ST = DESK_SLAB;
  const wx = sn ? W : Df;
  const dy = sn ? Df : W;
  const up = DESK_UP; // desk-surface height — where every prop sits (DH + ST)
  // `posture`, not `activity` — a lit screen full of scrolling code is the strongest "this seat is working"
  // signal in the room, so it must follow the same source of truth as placement. An idle member who spilled
  // onto a desk, or a stale member still carrying `activity: working`, gets a dark screen like any empty desk.
  const working = node?.posture === 'working';
  const mood = node ? deskMoodStyle(deskMoodFor(teamName, node.name)) : null;
  // Owned empty desk (presence-honesty §4): the offline owner keeps the desk — chair in, monitor
  // dark, their name baked on a small plate. The lamp is off (nobody switched it on), a warm screen
  // glow fades over the first hour since they left, and a disconnected seat gets an amber glint.
  const ownedEmpty = node != null && owned;
  // A stepped-away owner is present-but-absent (declared): same bodiless desk, different words.
  const steppedAway = ownedEmpty && node.presence !== 'offline';

  for (const [sx, sy] of [
    [-1, -1],
    [1, -1],
    [1, 1],
    [-1, 1],
  ] as const) {
    box(ctx, fit, lx + sx * (wx / 2 - 6), ly + sy * (dy / 2 - 6), 8, 8, DH, dim(PAL.wood, 0.9));
  }
  box(ctx, fit, lx, ly, wx, dy, ST, PAL.wood, DH);
  // Bevelled front lip (Delight D): a soft rim light along the slab's two viewer-facing top edges,
  // so the worktop reads as a finished edge rather than a raw extrusion.
  {
    const e = project(lx - wx / 2, ly + dy / 2, fit);
    const s2 = project(lx + wx / 2, ly + dy / 2, fit);
    const e2 = project(lx + wx / 2, ly - dy / 2, fit);
    const yUp = up * fit.scale;
    ctx.strokeStyle = 'rgba(255, 238, 205, 0.32)';
    ctx.lineWidth = Math.max(1, 1.1 * fit.scale);
    ctx.beginPath();
    ctx.moveTo(e.x, e.y - yUp);
    ctx.lineTo(s2.x, s2.y - yUp);
    ctx.lineTo(e2.x, e2.y - yUp);
    ctx.stroke();
  }

  // Surface props, placed in desk-relative (along-facing, across) coords and self-sorted back-to-front so
  // overlaps paint correctly regardless of the desk's facing. `along` +toward the monitor, −toward the seat.
  interface Prop {
    sum: number;
    fn: () => void;
  }
  const props: Prop[] = [];
  const at = (along: number, across: number, fn: (ix: number, iy: number) => void): void => {
    const ix = lx + f[0] * along + p[0] * across;
    const iy = ly + f[1] * along + p[1] * across;
    props.push({ sum: f[0] * along + p[0] * across + (f[1] * along + p[1] * across), fn: () => fn(ix, iy) });
  };

  // The monitor at the back, then the keyboard + mouse pulled in to where a seated member's hands actually
  // land (`KEYBOARD_ALONG`; `skeleton.ts` reaches for exactly this spot).
  const kbShoulder = KEYBOARD_WIDTHS[Math.floor(deskRnd(id, KB_SALT) * KEYBOARD_WIDTHS.length)]!;
  const mouseColor = MOUSE_COLORS[Math.floor(deskRnd(id, KB_SALT + 1) * MOUSE_COLORS.length)]!;
  // Felt desk mat under the keyboard + mouse (Delight D) — a deep-green pad that gives the work
  // gear a home and breaks up the bare slab. Flat paint sorted a hair before the keyboard so it
  // never covers what sits on it.
  if (node)
    at(KEYBOARD_ALONG - 1, 6, (ix, iy) => {
      const quad = (a: number, cr: number): Pt =>
        project(ix + f[0] * a + p[0] * cr, iy + f[1] * a + p[1] * cr, fit);
      const yUp = up * fit.scale;
      const c1 = quad(-11, -30);
      const c2 = quad(11, -30);
      const c3 = quad(11, 30);
      const c4 = quad(-11, 30);
      ctx.fillStyle = 'rgba(38, 66, 54, 0.85)';
      ctx.beginPath();
      ctx.moveTo(c1.x, c1.y - yUp);
      ctx.lineTo(c2.x, c2.y - yUp);
      ctx.lineTo(c3.x, c3.y - yUp);
      ctx.lineTo(c4.x, c4.y - yUp);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = 'rgba(255, 238, 205, 0.14)';
      ctx.lineWidth = Math.max(1, fit.scale);
      ctx.stroke();
    });
  at(Df / 2 - 12, 0, (ix, iy) => monitor(ctx, fit, ix, iy, dir, working, up, id, t));
  at(KEYBOARD_ALONG, 0, (ix, iy) => deskKeyboard(ctx, fit, ix, iy, sn, up, kbShoulder));
  at(KEYBOARD_ALONG + 2, 27, (ix, iy) => deskMouse(ctx, fit, ix, iy, sn, up, mouseColor));
  // The desk lamp is work gear, not a hashed personality prop: every OCCUPIED desk has one (the
  // sitter brought it), no empty desk ever does — see deskLamp for the #304 story. Lit only after dark.
  if (node) at(LAMP_ALONG, LAMP_ACROSS, (ix, iy) => deskLamp(ctx, fit, ix, iy, up, lampsLit && !ownedEmpty));

  // optional personal props — each present-or-not per desk by a stable hash, at its own station
  for (const kind of PROP_KINDS) {
    if (hide?.has(kind)) continue;
    if (!deskHasProp(id, kind) && !mood?.props.includes(kind)) continue;
    const sp = PROP_SPEC[kind];
    at(sp.along, sp.across, (ix, iy) => {
      switch (kind) {
        case 'coffee':
          return deskCoffee(ctx, fit, ix, iy, up, deskMugColor(id), node != null);
        case 'water':
          return deskWater(ctx, fit, ix, iy, up);
        case 'plant':
          return deskPlant(ctx, fit, ix, iy, up);
        case 'photo':
          return deskPhoto(ctx, fit, ix, iy, sn, up, PHOTOS[Math.floor(deskRnd(id, 41) * PHOTOS.length)]!);
        case 'fan':
          return deskFan(ctx, fit, ix, iy, up);
      }
    });
  }

  // The owned-desk plate + texture (presence-honesty §4) ride the same prop pipeline so they
  // depth-sort with the desk. All static paint keyed to data refreshes — no new rAF.
  if (ownedEmpty && node) {
    const age = node.last_seen_at != null ? Date.now() - node.last_seen_at : Infinity;
    // warm desk: screen afterglow fades over ~1h; a stepped-away desk keeps it (they just left)
    const warmth = steppedAway ? 0.6 : Math.max(0, 1 - age / 3_600_000);
    if (warmth > 0)
      at(Df / 2 - 12, 0, (ix, iy) => {
        const b = project(ix, iy, fit);
        ctx.fillStyle = `rgba(122, 148, 156, ${(0.18 * warmth).toFixed(3)})`;
        ctx.fillRect(b.x - 15 * fit.scale, b.y - (up + 23) * fit.scale, 30 * fit.scale, 18 * fit.scale);
      });
  }

  // The brass desk wedge (Delight D): every desk with an owner carries one — occupied, stepped
  // away or offline — because the plate belongs to the desk, not the person. It subsumes the old
  // baked owned-desk plate (same ≥13px legibility clamp, same stepped-away wording and
  // disconnected glint) and rides the prop pipeline so it depth-sorts with the desk.
  if (node) {
    // The viewer-nearest desk corner — always visible in front, clear of both the seated body
    // (desk-centre front) and the monitor (desk-centre back), whatever the desk's facing.
    const alongSign = f[0] + f[1] > 0 ? 1 : -1;
    const acrossSign = p[0] + p[1] > 0 ? 1 : -1;
    at(alongSign * (Df / 2 - 10), acrossSign * (W / 2 - 15), (ix, iy) =>
      deskWedge(ctx, fit, ix, iy, dir, node, t, steppedAway),
    );
  }

  props.sort((a, b) => a.sum - b.sum);
  for (const pr of props) pr.fn();
}

/**
 * The back-wall bench counter, drawn ONCE (not per seat): a long worktop in the desk vocabulary —
 * same leg height, same slab overhang — so it reads as workspace, not kitchenette. Sitters face the
 * wall; each seat's monitor and keyboard are per-slot items (`benchStation`) sorted a hair after the
 * counter, because a long box sorted at its centre would otherwise paint over the gear at its ends —
 * the couch/`depthAt` problem, solved the same way.
 */
function benchCounter(ctx: CanvasRenderingContext2D, fit: Fit): void {
  const B = BENCH;
  // Legs at the ends and thirds, then the top with a small overhang — a worktop, not a slab wall.
  for (const along of [-B.long / 2 + 8, -B.long / 6, B.long / 6, B.long / 2 - 8]) {
    box(ctx, fit, B.lx + along, B.ly, 8, 8, DESK_LEG_H, dim(PAL.wood, 0.9));
  }
  box(ctx, fit, B.lx, B.ly, B.long, B.deep, DESK_SLAB, PAL.wood, DESK_LEG_H);
}

/** One bench seat's gear: monitor + keyboard on the shared counter. The screen faces the sitter —
 * which is also toward the camera, so a working bench member still shows a lit screen to the room. */
function benchStation(
  ctx: CanvasRenderingContext2D,
  fit: Fit,
  slot: DeskSlot,
  node: OfficeNode | null,
  t: number,
): void {
  const working = node?.posture === 'working';
  const kbShoulder = KEYBOARD_WIDTHS[Math.floor(deskRnd(slot.id, KB_SALT) * KEYBOARD_WIDTHS.length)]!;
  monitor(ctx, fit, slot.lx, slot.ly - (BENCH.deep / 2 - 12), slot.dir, working, DESK_UP, slot.id, t);
  deskKeyboard(ctx, fit, slot.lx, slot.ly - KEYBOARD_ALONG, true, DESK_UP, kbShoulder);
}

export interface SceneAnchors {
  heads: Map<string, Pt>;
  bases: Map<string, Pt>;
}

/** A soft additive warm pool: an ellipse of warm light that *adds* back over the night veil. */
function warmPool(ctx: CanvasRenderingContext2D, p: Pt, r: number, flatten: number, color: string, peak: number): void {
  const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, r);
  g.addColorStop(0, `rgba(${color}, ${peak})`);
  g.addColorStop(1, `rgba(${color}, 0)`);
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.ellipse(p.x, p.y, r, r * flatten, 0, 0, Math.PI * 2);
  ctx.fill();
}

/**
 * Interior lighting pass, painted after all furniture/actors: a cool night veil at `env.veilAlpha` (an
 * empty office after dark goes properly dark), then — gated on it being dark enough to want the lights on
 * (`env.lampsOn`) — the warm sources that punch back through the veil, all additive and all scaled by how
 * deep the night is (`night`), so the room stays cosy-dark but never pitch black:
 *
 *  - **The string lights emit** — each bulb (same anchors the canvas paints, see `magicAnchors`) casts a
 *    faint warm pool down the wall and onto the floor beneath it. Previously the bulbs glowed but lit nothing.
 *  - **A personal glow per present member** — a soft warm pool that travels with each online member, so
 *    the character work (faces, cheeks, the round body) never dissolves into the veil.
 *
 * Kept deliberately gentle: the office is meant to read *dim and cosy* after dark (the overhead fill the
 * lighting model already bakes into an occupied room is the only ceiling light — these just add warmth and
 * legibility, they don't try to light the room up). During the day `veilAlpha` is ~0 and `lampsOn` is
 * false, so everything below no-ops.
 */
function drawInteriorLight(
  ctx: CanvasRenderingContext2D,
  fit: Fit,
  env: LightEnv,
  slotMember: Map<number, string>,
  poses: Map<string, Pose>,
  byName: Map<string, OfficeNode>,
): void {
  if (env.veilAlpha > 0.01) {
    ctx.save();
    ctx.globalAlpha = env.veilAlpha;
    ctx.fillStyle = env.veilColor;
    ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height); // whole canvas (overshoots under DPR — harmless)
    ctx.restore();
  }
  if (!env.lampsOn) return;
  // How deep the night is, 0..1 — the warm sources scale by it, so they fade in as dusk falls rather than
  // snapping on at the lamp threshold.
  const night = Math.min(1, env.veilAlpha / 0.55);

  ctx.save();
  ctx.globalCompositeOperation = 'lighter'; // additive: each pool *adds* light back over the veil

  // The string lights emit: a warm pool cast down from each bulb onto the wall + floor beneath it. Tuned
  // to actually read against the veil (a first pass was too faint to see) while staying a warm accent.
  for (const b of magicAnchors(fit).bulbs) {
    warmPool(ctx, { x: b.x, y: b.y + 24 * fit.scale }, 52 * fit.scale, 0.95, '255, 200, 120', 0.2 * night);
  }

  // Desk lamps emit — a warm pool cast from each occupied desk's lamp (the fixture drawWorkstation adds
  // for every sitter) onto the desk corner and floor beside it. Desk-anchored where the personal glow
  // below is body-anchored: together they read as "a person working in their own pool of lamplight".
  for (const slot of DESK_SLOTS) {
    if (!slotMember.has(slot.id)) continue;
    const [ix, iy] = deskPoint(slot, LAMP_ALONG, LAMP_ACROSS);
    warmPool(ctx, project(ix, iy, fit), 78 * fit.scale, 0.62, '255, 200, 120', 0.28 * night);
  }

  // A personal glow travelling with each present (online) member, in two layers: a wide soft halo that
  // lights the desk and floor AROUND them (nick, 2026-08-19: the first cut kept faces legible but lit no
  // space — the pools read as face-paint, not lamps), and a brighter core so the character work (faces,
  // cheeks, the round body) never dissolves into the veil.
  for (const [name, pose] of poses) {
    const node = byName.get(name);
    if (!node || node.presence !== 'online') continue;
    const b = project(pose.lx, pose.ly, fit);
    const scale = pose.small ? 0.7 : 1;
    // the halo sits lower (toward the desk surface/floor) and flatter, like light landing on things.
    // Gentle on purpose: pools are additive, so two neighbours overlap into a wash if the halo runs hot
    // (the first cut at 0.19 did exactly that — nick: "now it looks too bright").
    warmPool(ctx, { x: b.x, y: b.y - 10 * fit.scale * scale }, 88 * fit.scale * scale, 0.72, '255, 206, 140', 0.11 * night);
    // the core is centred a little up the body so it warms the face/torso, not just the feet
    warmPool(ctx, { x: b.x, y: b.y - 30 * fit.scale * scale }, 52 * fit.scale * scale, 0.9, '255, 214, 158', 0.25 * night);
  }

  ctx.restore();
}

/**
 * How far from a desk's centre still counts as being *in* its chair. The chair sits `CHAIR_OFF` back
 * from the desk, and an occupant a little forward of that; beyond this radius a member is somewhere
 * else in the room, whatever their seating placement says.
 */
const AT_DESK_R = CHAIR_OFF + 28;

/**
 * Where a member's avatar sorts in the painter's order this frame — the floor point whose depth keys
 * them against the furniture.
 *
 * Three cases, in order:
 *
 * 1. **Sitting at their own desk** → the chair, not their feet. Their feet land a couple of units off
 *    the chair centre, and at north/west-facing desks that offset was enough to sort the cushion in
 *    *front* of them, so the chair painted over their legs. Keying off the chair puts them between its
 *    base and its backrest at every facing, which is where a person in a chair belongs. The chair's
 *    *current* spot, so a roll-back beat slides chair and sitter together.
 * 2. **Sitting on something that sorts as one big box** → that box's centre, via `depthAt`. The pose
 *    carries it for an errand's sit leg (actors.ts lifts it off the leg); a leisure *placement* carries
 *    it for a member whose home is that seat. The couch needs it either way — one long box sorted at
 *    its centre paints over a sitter on a cushion west of that centre.
 * 3. **Anything else** → their own feet.
 *
 * Case 1 is why this is a function rather than two lines inline. `sit > 0.5 && placement.kind ===
 * 'desk'` looks like "sitting at their desk" and is not: an errand sits a walker down on the lounge
 * couch while their placement is still their desk, so a member eating on the couch was sorted at a
 * desk on the far side of the room and the room painted over them — they simply vanished until they
 * stood up. The same test has a second face, because the sit blend eases *down* rather than switching:
 * for a moment after standing, a member walking away from the couch still read as seated and still
 * sorted at that distant desk, which is a body sliding through the lounge furniture.
 *
 * So "seated at my desk" has to mean actually being at that desk, which is what `atOwnDesk` measures.
 */
export function actorSortAnchor(
  pose: Pose,
  slot: { lx: number; ly: number; dir: Dir } | undefined,
  spot: { depthAt?: { lx: number; ly: number } } | undefined,
): { lx: number; ly: number; seatedAtDesk: boolean } {
  const atOwnDesk = !!slot && Math.hypot(pose.lx - slot.lx, pose.ly - slot.ly) < AT_DESK_R;
  if (pose.sit > 0.5 && atOwnDesk && slot) {
    const f = FWD[slot.dir];
    const shift = chairShift(pose.gesture, pose.gestureT);
    return {
      lx: slot.lx - f[0] * (CHAIR_OFF + shift),
      ly: slot.ly - f[1] * (CHAIR_OFF + shift),
      seatedAtDesk: true,
    };
  }
  const sitAt = pose.depthAt ?? spot?.depthAt;
  if (pose.sit > 0.5 && sitAt) return { lx: sitAt.lx, ly: sitAt.ly, seatedAtDesk: false };
  return { lx: pose.lx, ly: pose.ly, seatedAtDesk: false };
}

/**
 * Draw the whole office in painter's order, returning per-member screen anchors. Desks are drawn empty;
 * each present member is drawn as a free actor at its current `poses` entry (home seat when idle, or
 * interpolated mid-walk), so seated and walking members depth-sort against desks the same way.
 */
export function renderScene(
  ctx: CanvasRenderingContext2D,
  fit: Fit,
  placements: Map<string, Placement>,
  byName: Map<string, OfficeNode>,
  poses: Map<string, Pose>,
  /** The scene clock, in seconds — everything that animates on its own (breathing, typing) reads it. */
  t = 0,
  teamName = 'revive',
  env: LightEnv = DAY_ENV,
  pet: PetState | null = null,
  /** Errand scene effects, derived per-frame by the actor system (`actors.sceneFx()`): an open fridge
   * door, desks whose water bottle is currently in its owner's hand. Absent → everything at rest. */
  fx?: { fridgeOpen: boolean; bottleCarriers: Set<string> },
  /** The receptionist's state (receptionist.ts). Absent → asleep, which is the empty-office truth. */
  recep: ReceptionistState | null = null,
  /** The real lane board squinted down for the wall (wallboard.ts). Null → the empty board hangs. */
  wallBoard: WallBoard | null = null,
  /** Optional Team schedule for the wall sign. */
  teamWorkingHours: WorkingHours | null = null,
): SceneAnchors {
  // Grounds the diorama on the panel surface before anything else paints (the floor covers its middle).
  drawGroundShadow(ctx, fit);
  drawFloor(ctx, fit);
  // The room shell: back walls + windows as a backdrop (behind every item), then the daylight beams they
  // cast onto the floor (under every item). Both before the depth-sorted loop — see the walls note above.
  // Roster order (Map insertion order), so a member keeps the same spot on the in/out board.
  drawWalls(ctx, fit, env, teamWorkingHours, wallBoard, t);
  drawWindowBeams(ctx, fit, env);

  // Desk-slot index → seat owner (for the monitor's working glow). Placement stores an index into
  // `DESK_SLOTS`; IDs are deliberately stable but sparse after pod sizes change, so they are not
  // interchangeable.
  const slotMember = new Map<number, string>();
  for (const [name, pl] of placements) if (pl.kind === 'desk') slotMember.set(pl.slot, name);

  const heads = new Map<string, Pt>();
  const bases = new Map<string, Pt>();

  interface Item {
    d: number;
    fn: () => void;
  }
  const items: Item[] = [];

  for (const plant of PLANTS) {
    items.push({ d: depth(plant.lx, plant.ly), fn: () => drawPlant(ctx, fit, plant.lx, plant.ly, plant.species) });
  }
  BOOKSHELVES.forEach((s, si) => {
    // The index is the book seed — it is what makes shelf 0 and shelf 2 hold different books
    // despite being the same size.
    items.push({ d: depth(s.lx, s.ly), fn: () => bookshelf(ctx, fit, s, si) });
  });
  // Rugs are flat floor paint — draw them right after the floor (before every solid/actor), so a member
  // standing anywhere on a rug is never over-painted by it. Solid pieces self-sort at their footprints.
  for (const pod of PODS) {
    const ns = pod.axis === 'ns';
    const dims = pod.size === 1 ? POD_RUG_SOLO : pod.size === 2 ? POD_RUG_DUO : POD_RUG;
    const w = ns ? dims.across : dims.along;
    const d = ns ? dims.along : dims.across;
    drawRug(ctx, fit, pod.rug, pod.cx, pod.cy, w, d);
  }
  drawRug(ctx, fit, MEETING.rug, MEETING.lx, MEETING.ly, MEETING.rug.w, MEETING.rug.d);
  drawRug(ctx, fit, RECEPTION.rug, RECEPTION.rug.lx, RECEPTION.rug.ly, RECEPTION.rug.w, RECEPTION.rug.d);
  const nook = nookItems(ctx, fit, fx?.fridgeOpen ?? false);
  nook.rug();
  items.push(...nook.items);
  items.push({ d: depth(MEETING.lx, MEETING.ly), fn: () => meetingTable(ctx, fit) });
  for (const c of MEETING.chairs) {
    const cx = MEETING.lx + c.dx;
    const cy = MEETING.ly + c.dy;
    items.push({ d: depth(cx, cy), fn: () => meetingChair(ctx, fit, cx, cy, c.dir) });
  }
  items.push(...receptionItems(ctx, fit, recep, t));
  items.push({ d: depth(PRINTER.lx, PRINTER.ly), fn: () => printer(ctx, fit) });
  items.push({ d: depth(ENTRANCE.lx, ENTRANCE.ly), fn: () => drawEntrance(ctx, fit) });

  // The office dog sorts with everything else at its own floor position (behaviour lives in pet.ts).
  if (pet) items.push({ d: depth(pet.lx, pet.ly) + 0.08, fn: () => drawDog(ctx, fit, pet, t) });

  // The bench's shared counter, once — its seats' gear rides per-slot below.
  items.push({ d: depth(BENCH.lx, BENCH.ly), fn: () => benchCounter(ctx, fit) });

  for (const [slotIndex, slot] of DESK_SLOTS.entries()) {
    const name = slotMember.get(slotIndex) ?? null;
    const node = name ? (byName.get(name) ?? null) : null;
    const deskPl = name ? placements.get(name) : undefined;
    const deskOwned = deskPl?.kind === 'desk' && deskPl.owned === true;
    const ownerPose = name ? poses.get(name) : undefined;
    // Sip beat: while the owner's mug is in their hand, the desk copy vanishes — one mug, not two.
    const sipping =
      !!ownerPose &&
      ownerPose.sit > 0.9 &&
      ownerPose.gesture === GESTURE.sip &&
      ownerPose.gestureT > 0.12 &&
      ownerPose.gestureT < 0.95;
    // A prop leaves the desk while it's "in the owner's hand": the sip mug, or the errand's bottle.
    const hidden: PropKind[] = [];
    if (sipping) hidden.push('coffee');
    if (name && fx?.bottleCarriers.has(name)) hidden.push('water');
    const hide = hidden.length ? new Set<PropKind>(hidden) : undefined;
    if (slot.kind === 'bench') {
      // No per-seat slab — the shared counter is already an item. +0.1 sorts the gear after the
      // counter's long box (same centre-sorted-box problem the couch solves with depthAt).
      items.push({ d: depth(BENCH.lx, BENCH.ly) + 0.1, fn: () => benchStation(ctx, fit, slot, node, t) });
    } else {
      items.push({ d: depth(slot.lx, slot.ly), fn: () => drawWorkstation(ctx, fit, slot, node, teamName, deskOwned, t, hide, env.lampsOn) });
    }
    // The task chair, in two depth items (see `chairBase`/`chairBack`): the cushion the member sits *on*
    // paints before them, the backrest at its own footprint — so at every facing the sitter lands between
    // the two instead of being swallowed by a single chair box.
    //
    // Chair beats move the chair with its sitter: roll-back slides both pieces straight back from the
    // desk; swivel swings the backrest around the seat centre — the same pure curves the actor system
    // applies to the body, so chair and member can never drift apart.
    const f = FWD[slot.dir];
    const shift = ownerPose && ownerPose.sit > 0.9 ? chairShift(ownerPose.gesture, ownerPose.gestureT) : 0;
    const yaw = ownerPose && ownerPose.sit > 0.9 ? chairYaw(ownerPose.gesture, ownerPose.gestureT) : 0;
    const cx = slot.lx - f[0] * (CHAIR_OFF + shift);
    const cy = slot.ly - f[1] * (CHAIR_OFF + shift);
    const bdx = -f[0] * CHAIR_BACK_OFF;
    const bdy = -f[1] * CHAIR_BACK_OFF;
    const bx = cx + bdx * Math.cos(yaw) - bdy * Math.sin(yaw);
    const by = cy + bdx * Math.sin(yaw) + bdy * Math.cos(yaw);
    const chairColor = node ? hslL(node.color, 0.5) : '#4a5560';
    const chairStyle = chairStyleFor(slot.id);
    items.push({ d: depth(cx, cy) - 0.2, fn: () => chairBase(ctx, fit, cx, cy, slot.dir, chairColor, chairStyle) });
    items.push({ d: depth(bx, by), fn: () => chairBack(ctx, fit, bx, by, slot.dir, chairColor, chairStyle) });
    // Stepped-away texture (§4 lane 4): a jacket in the owner's colour draped over the chair back —
    // the visual half of the plate's "stepped away"; offline owners get no jacket (they went home).
    if (deskOwned && node && node.presence !== 'offline') {
      const jx = bx;
      const jy = by;
      const jc = hslL(node.color, 0.42);
      items.push({
        d: depth(jx, jy) + 0.01,
        fn: () => {
          const b = project(jx, jy, fit);
          const wJ = 16 * fit.scale;
          const hJ = 13 * fit.scale;
          const top = b.y - 30 * fit.scale;
          ctx.fillStyle = jc;
          ctx.beginPath();
          ctx.moveTo(b.x - wJ / 2, top);
          ctx.lineTo(b.x + wJ / 2, top);
          ctx.lineTo(b.x + wJ / 2 - 2 * fit.scale, top + hJ);
          ctx.lineTo(b.x - wJ / 2 + 2 * fit.scale, top + hJ);
          ctx.closePath();
          ctx.fill();
        },
      });
    }
  }

  // Queue lane: a faint pad under each overflow (strip) member so the entrance line reads as a designated
  // waiting area. Positions come from the live poses, so drawing never re-derives the seating maths.
  for (const [name, pl] of placements) {
    if (pl.kind !== 'strip') continue;
    const pose = poses.get(name);
    if (!pose) continue;
    items.push({ d: depth(pose.lx, pose.ly) - 0.2, fn: () => drawQueuePad(ctx, fit, pose.lx, pose.ly) });
  }

  for (const [name, pose] of poses) {
    const node = byName.get(name);
    if (!node) continue;
    const b = project(pose.lx, pose.ly, fit);
    const pl = placements.get(name);
    const slot = pl?.kind === 'desk' ? DESK_SLOTS[pl.slot] : undefined;
    const spot = pl?.kind === 'leisure' ? LEISURE_SPOTS[pl.spot] : undefined;
    const anchor = actorSortAnchor(pose, slot, spot);
    const seated = anchor.seatedAtDesk && slot;
    const d = depth(anchor.lx, anchor.ly) + 0.1;
    // The desk mug travels with a sipping owner — passed down so the hand mug matches the desk mug.
    const mug = seated && pose.gesture === GESTURE.sip ? deskMugColor(slot.id) : undefined;
    items.push({ d, fn: () => drawActor(ctx, fit, pose, node, t, false, mug) });

    // Seated overlay: the desk paints over a member sitting behind it (correct — that is what a desk does
    // to your legs), but their forearms *rest on the surface*, above it, so they must paint on top of the
    // slab. One character, two depth slots: the body at the chair, the arms on the desk. Without this the
    // hands disappear into the desk and the typing is invisible. Skipped while a beat has dropped the
    // hands into the lap — lap arms painted over the slab would float on the desk.
    if (seated && !handsInLap(pose.gesture, pose.gestureT)) {
      items.push({
        d: depth(slot.lx, slot.ly) + 0.05,
        fn: () => drawActor(ctx, fit, pose, node, t, true, mug),
      });
    }

    bases.set(name, b);
    // The label rides above the crown — higher for a standing member than a seated one, so it tracks the
    // head through a sit rather than floating where the head used to be. Lifted clear of the firefly wisp
    // that now hovers over the head (see `drawHead`), so the name reads as a plate floating above the mote.
    heads.set(name, { x: b.x, y: b.y - (pose.small ? 90 : 116 - pose.sit * 22) * fit.scale });
  }

  items.sort((a, b) => a.d - b.d);
  for (const it of items) it.fn();

  // Interior lighting: veil the room to the night level, then let occupied desks' lamps glow through.
  drawInteriorLight(ctx, fit, env, slotMember, poses, byName);

  // Collapse any queue/nook members past the render cap into a single "+N" pill, so a very large roster
  // stays bounded. Hidden count = placed-but-not-drawn (capped members get no pose in homePoses).
  let stripTotal = 0;
  let nookTotal = 0;
  let stripDrawn = 0;
  let nookDrawn = 0;
  for (const [name, pl] of placements) {
    if (pl.kind === 'strip') {
      stripTotal++;
      if (poses.has(name)) stripDrawn++;
    } else if (pl.kind === 'nook') {
      nookTotal++;
      if (poses.has(name)) nookDrawn++;
    }
  }
  if (stripTotal - stripDrawn > 0) {
    const a = project(ENTRANCE.lx + 34, ENTRANCE.ly - 10, fit);
    drawCountPill(ctx, { x: a.x, y: a.y - 66 * fit.scale }, `+${stripTotal - stripDrawn} waiting`, fit.scale);
  }
  if (nookTotal - nookDrawn > 0) {
    const a = project(NOOK.lx, NOOK.ly, fit);
    drawCountPill(ctx, { x: a.x, y: a.y - 52 * fit.scale }, `+${nookTotal - nookDrawn} away`, fit.scale);
  }

  // Frame the whole diorama last — a soft edge vignette so the scene fades into the panel at the corners.
  drawVignette(ctx);

  return { heads, bases };
}

/**
 * Screen anchors for the *animated* desk props (Tier-A CSS overlays, ADR 086): the spinning point of each
 * desktop fan's grille and the steam source above each desk coffee mug. Recomputed from the same
 * `PROP_SPEC` geometry the canvas draw uses, so a fan/steam element always lands on its drawn prop. Which
 * desks *carry* a prop is a stable per-desk hash, but both animate **only at an occupied desk** — an
 * unattended running fan or a steaming fresh mug reads as wrong (nobody's there). `occupied` (the set of
 * desk slot ids with a seated member) gates both; the physical fan and mug are still drawn at empty desks,
 * just idle (the fan off, the mug empty — see `deskFan` / `deskCoffee`).
 */
export function animatedDeskAnchors(fit: Fit, occupied: Set<number>): { fans: Pt[]; coffees: Pt[] } {
  const fans: Pt[] = [];
  const coffees: Pt[] = [];
  for (const slot of DESK_SLOTS) {
    if (!occupied.has(slot.id)) continue; // empty desk: fan idle, mug empty — nothing animates
    if (deskHasProp(slot.id, 'fan')) {
      const [ix, iy] = deskPoint(slot, PROP_SPEC.fan.along, PROP_SPEC.fan.across);
      const b = project(ix, iy, fit);
      fans.push({ x: b.x, y: b.y - (DESK_UP + 17) * fit.scale }); // matches deskFan's grille centre
    }
    if (deskHasProp(slot.id, 'coffee')) {
      const [ix, iy] = deskPoint(slot, PROP_SPEC.coffee.along, PROP_SPEC.coffee.across);
      const b = project(ix, iy, fit);
      coffees.push({ x: b.x, y: b.y - (DESK_UP + 12) * fit.scale }); // matches deskCoffee's mug rim
    }
  }
  return { fans, coffees };
}

/** Screen position of the break-nook coffee machine (the ambient steam source, ADR 086). */
export function coffeeAnchor(fit: Fit): Pt {
  const s = project(NOOK.lx + LOUNGE.machine.dx, NOOK.ly + LOUNGE.machine.dy, fit);
  // Off the warmer plate, which is the machine's full height (MACHINE_H) above the counter — steam
  // rising out of the middle of the body instead would read as the machine being on fire.
  return { x: s.x, y: s.y - (LOUNGE.counter.h + MACHINE_H + 2) * fit.scale };
}

/** A transient act cue: a tinted ring + optional glyph (`ring`), a broadcast sweep (`wave`), a glow
 * at the entrance when someone comes or goes (`door`), or a celebration burst over an accepted
 * member's head (`confetti`). */
export interface Cue {
  at: Pt;
  to?: Pt;
  source?: string;
  color: string;
  glyph: '' | '?' | '!' | '📣' | '✓' | '↦' | '↪';
  t: number;
  urgent: boolean;
  kind?: 'ring' | 'wave' | 'door' | 'thread' | 'confetti';
}

/** The celebration palette — the cue-family literals the scene already speaks (accept green, the
 * accent mustard, handoff violet, danger coral), cycled per particle. */
const CONFETTI_COLORS = ['#5cd49a', '#f4cf52', '#c6a3ff', '#f3776a'] as const;
const CONFETTI_COUNT = 18;

/**
 * One confetti particle's whole flight, derived from its index alone — deterministic, so a cue
 * draws identically for a given `t` (no per-frame randomness to make tests flaky or frames shear).
 * A ballistic puff: up and out from the head, gravity pulling the tail down, spinning as it goes.
 */
function confettiParticle(i: number, t: number, scale: number, at: Pt) {
  // Golden-angle fan: spreads the launch directions without two particles ever sharing one.
  const angle = -Math.PI / 2 + Math.sin(i * 2.399963) * 1.1;
  const speed = (34 + ((i * 7919) % 23)) * scale;
  const x = at.x + Math.cos(angle) * speed * t * 1.6;
  const y = at.y + Math.sin(angle) * speed * t * 1.9 + 52 * scale * t * t; // gravity
  const spin = t * (4 + (i % 5)) + i;
  return { x, y, spin, color: CONFETTI_COLORS[i % CONFETTI_COLORS.length]! };
}

export function drawCue(ctx: CanvasRenderingContext2D, cue: Cue, scale: number): void {
  const { at, color, t } = cue;

  if (cue.kind === 'thread' && cue.to) {
    const dx = cue.to.x - at.x;
    const dy = cue.to.y - at.y;
    const lift = Math.min(70, Math.max(18, Math.hypot(dx, dy) * 0.18));
    const control = {
      x: at.x + dx / 2,
      y: at.y + dy / 2 - lift * scale,
    };
    const eased = CANVAS_EASE.out(t);
    ctx.globalAlpha = (1 - t) * 0.58;
    ctx.strokeStyle = color;
    ctx.lineWidth = 2 * scale;
    ctx.setLineDash([7 * scale, 8 * scale]);
    ctx.lineDashOffset = -eased * 30 * scale;
    ctx.beginPath();
    ctx.moveTo(at.x, at.y);
    ctx.quadraticCurveTo(control.x, control.y, cue.to.x, cue.to.y);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
    return;
  }

  if (cue.kind === 'confetti') {
    // The acceptance celebration: a one-shot ballistic puff of paper over the celebrant's head.
    // Fully derived from `t` — nothing stored per frame, nothing re-arms, so it costs exactly one
    // cue lifetime and holds still under ?still like every other event cue.
    ctx.globalAlpha = Math.max(0, 1 - t * t * 1.15);
    for (let i = 0; i < CONFETTI_COUNT; i++) {
      const p = confettiParticle(i, t, scale, at);
      ctx.save();
      ctx.translate(p.x, p.y - 26 * scale);
      ctx.rotate(p.spin);
      ctx.fillStyle = p.color;
      // Fleck size is stream-tested: 4.8×2.8 read as noise at room zoom (2026-08-19 eyeball),
      // and the 720p encode eats another third — these proportions are the floor, not a taste call.
      ctx.fillRect(-3.6 * scale, -2.1 * scale, 7.2 * scale, 4.2 * scale);
      ctx.restore();
    }
    ctx.globalAlpha = 1;
    return;
  }

  if (cue.kind === 'wave') {
    // A broadcast sweep: a big, diffuse ring rolling out from the announcer across the room.
    const grow = 1 - Math.pow(1 - t, 2);
    const r = (24 + grow * 300) * scale;
    ctx.globalAlpha = (1 - t) * (1 - t) * 0.5;
    ctx.strokeStyle = color;
    ctx.lineWidth = 3 * scale;
    ctx.beginPath();
    ctx.ellipse(at.x, at.y, r, r * 0.6, 0, 0, Math.PI * 2);
    ctx.stroke();
    ctx.globalAlpha = 1;
    return;
  }

  if (cue.kind === 'door') {
    // The entrance "opens" — a glass-tall glow that brightens then fades as someone passes through.
    const w = 58 * scale;
    const h = 96 * scale;
    ctx.globalAlpha = Math.sin(Math.min(1, t) * Math.PI) * 0.5;
    ctx.fillStyle = color;
    roundRect(ctx, at.x - w / 2, at.y - h, w, h, 6 * scale, color);
    ctx.globalAlpha = 1;
    return;
  }

  const grow = 1 - Math.pow(1 - t, 3);
  const r = (8 + grow * 34) * scale;
  ctx.globalAlpha = (1 - t) * (1 - t) * 0.9;
  ctx.strokeStyle = color;
  ctx.lineWidth = (cue.urgent ? 3.5 : 2.4) * scale;
  ctx.beginPath();
  ctx.ellipse(at.x, at.y, r, r * 0.6, 0, 0, Math.PI * 2);
  ctx.stroke();
  ctx.globalAlpha = 1;
  if (cue.glyph) {
    const rise = t * 26 * scale;
    ctx.globalAlpha = Math.max(0, 1 - t * 1.1);
    ctx.font = canvasFont(Math.round(15 * scale));
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = cue.urgent ? '#f3776a' : color;
    ctx.fillText(cue.glyph, at.x, at.y - 20 * scale - rise);
    ctx.globalAlpha = 1;
  }
}
