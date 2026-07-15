import { drawCharacter } from './character';
import { depth, FLOOR, project, THICK, type Fit, type Pt } from './iso';
import type { CatState } from './cat';
import {
  BEAM_LEN,
  BEAM_SHEAR,
  BOOKSHELVES,
  CHAIR_LIFT,
  CHAIR_OFF,
  CHAIR_SEAT_H,
  DESK_D,
  DESK_LEG_H,
  DESK_SLAB,
  DESK_SLOTS,
  DESK_UP,
  DESK_W,
  ENTRANCE,
  FWD,
  HUDDLES,
  KEYBOARD_ALONG,
  LOUNGE,
  MEETING,
  NOOK,
  NOOK_RUG,
  NOOK_RUG_R,
  PLANTS,
  PODS,
  POD_RUG,
  PRINTER,
  RECEPTION,
  SEAT_TOP,
  SHELF_DEEP,
  SHELF_H,
  SHELF_LONG,
  WINDOWS,
  type Bookshelf,
  type Huddle,
  type Pod,
  type Rug,
} from './layout';
import { DAY_ENV, type LightEnv } from './lighting';
import { deskMoodFor, deskMoodStyle } from './moods';
import type { Placement } from './seating';
import { seedOf, solveSkeleton, typingBurst } from './skeleton';
import type { Dir, OfficeNode, Pose } from './types';

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

/** Dusk office (the historical hard-coded values) — also the fallback when a token can't be read. */
export const DARK_PALETTE: ScenePalette = {
  floor: '#e4a96b',
  floor2: '#c6863f',
  wood: '#7a4e2d',
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
function mul(h: string, f: number): string {
  const [r, g, b] = hexRgb(h);
  const c = (v: number) => Math.round(Math.min(255, v * f));
  return `rgb(${c(r)}, ${c(g)}, ${c(b)})`;
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
/** Face shading that also handles hsl bases (member-tinted furniture like chairs). */
function shade(base: string, f: number): string {
  return dim(base, f);
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

/** Wall height in screen px at scale 1 — tall enough to read as a room, short enough not to wall the view in. */
const WALL_H = 188;

// The windows + beam geometry live in layout.ts (the cat's sunbeam nap spots derive from the same data).

/**
 * The glass colour: bright sky by day (warm at golden hour via `skyTint`), a dark pane with a faint city
 * glow by night. Interpolated on `daylight`, so it tracks the same PST clock as the beam and the veil.
 */
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

function drawWalls(ctx: CanvasRenderingContext2D, fit: Fit, env: LightEnv): void {
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
      quad(ctx, [pt(w.t0 + iT, w.u0 + iU), pt(w.t1 - iT, w.u0 + iU), pt(w.t1 - iT, w.u1 - iU), pt(w.t0 + iT, w.u1 - iU)], glass);
      // panes: one vertical + one horizontal mullion, so it reads as a window, not a lit hole
      const mid = (w.t0 + w.t1) / 2;
      const midU = (w.u0 + w.u1) / 2;
      quad(ctx, [pt(mid - iT * 0.35, w.u0 + iU), pt(mid + iT * 0.35, w.u0 + iU), pt(mid + iT * 0.35, w.u1 - iU), pt(mid - iT * 0.35, w.u1 - iU)], frame);
      quad(ctx, [pt(w.t0 + iT, midU - iU * 0.35), pt(w.t1 - iT, midU - iU * 0.35), pt(w.t1 - iT, midU + iU * 0.35), pt(w.t0 + iT, midU + iU * 0.35)], frame);
    }

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

/** Deterministic 0..1 hash — the ambient-magic anchors must not shuffle on every rebake. */
function magicRnd(n: number): number {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
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
      for (const [i, p] of [pa, pb, pf1, pf0].entries()) i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y);
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
function receptionItems(ctx: CanvasRenderingContext2D, fit: Fit): DepthItem[] {
  const R = RECEPTION;
  return [
    { d: depth(R.couch.lx, R.couch.ly), fn: () => couch(ctx, fit, R.couch.lx, R.couch.ly, PAL.couch, R.couch.dir) },
    { d: depth(R.table.lx, R.table.ly), fn: () => ctable(ctx, fit, R.table.lx, R.table.ly) },
    { d: depth(R.plant.lx, R.plant.ly), fn: () => drawPlant(ctx, fit, R.plant.lx, R.plant.ly, 'fiddle') },
  ];
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

function armchair(ctx: CanvasRenderingContext2D, fit: Fit, lx: number, ly: number, c: string, dir: Dir): void {
  const f = FWD[dir];
  const sn = f[1] !== 0;
  const S = LOUNGE.chairW.size;
  box(ctx, fit, lx - f[0] * (S / 2 - 6), ly - f[1] * (S / 2 - 6), sn ? S - 2 : 10, sn ? 10 : S - 2, 32, dim(c, 0.9));
  box(ctx, fit, lx, ly, sn ? S - 2 : S, sn ? S : S - 2, 20, c);
  const seat = project(lx + f[0] * 5, ly + f[1] * 5, fit);
  ellipse(ctx, { x: seat.x, y: seat.y - 20 * fit.scale }, 21 * fit.scale, 8 * fit.scale, '#eabf50');
}

function ctable(ctx: CanvasRenderingContext2D, fit: Fit, lx: number, ly: number): void {
  const s = project(lx, ly, fit);
  ellipse(ctx, { x: s.x, y: s.y }, 42 * fit.scale, 13 * fit.scale, 'rgba(0,0,0,0.12)');
  box(ctx, fit, lx, ly, LOUNGE.table.w, LOUNGE.table.d, 16, woodTop());
  // Fruit bowl + a single flower keeps the lounge from reading like untouched showroom furniture.
  ellipse(ctx, { x: s.x, y: s.y - 18 * fit.scale }, 10 * fit.scale, 4 * fit.scale, '#e8c17d');
  ellipse(ctx, { x: s.x - 4 * fit.scale, y: s.y - 21 * fit.scale }, 3 * fit.scale, 2 * fit.scale, '#d8774f');
  ellipse(ctx, { x: s.x + 3 * fit.scale, y: s.y - 22 * fit.scale }, 3 * fit.scale, 2 * fit.scale, '#f4cf52');
}

/** One depth-sortable draw call. The nook/huddle used to paint as single blobs anchored at their
 * centre, which over-painted any member standing on the north half of their rugs — each solid piece is
 * now its own item at its own footprint depth, and flat rugs paint with the floor (see renderScene). */
interface DepthItem {
  d: number;
  fn: () => void;
}

/** The break-nook lounge, as depth items: the rug flat on the floor, every solid piece self-sorted. */
function nookItems(ctx: CanvasRenderingContext2D, fit: Fit): { rug: () => void; items: DepthItem[] } {
  const { lx, ly } = NOOK;
  const L = LOUNGE;
  const at = (dx: number, dy: number, fn: () => void): DepthItem => ({ d: depth(lx + dx, ly + dy), fn });
  return {
    rug: () => drawRug(ctx, fit, NOOK_RUG, lx, ly, NOOK_RUG_R * 2, NOOK_RUG_R * 2),
    items: [
      at(L.fridge.dx, L.fridge.dy, () => box(ctx, fit, lx + L.fridge.dx, ly + L.fridge.dy, L.fridge.w, L.fridge.d, L.fridge.h, '#edeff1')),
      at(L.counter.dx, L.counter.dy, () => {
        box(ctx, fit, lx + L.counter.dx, ly + L.counter.dy, L.counter.w, L.counter.d, L.counter.h, woodTop());
        box(ctx, fit, lx + L.machine.dx, ly + L.machine.dy, 16, 13, 10, '#33272b', L.counter.h); // machine on top
      }),
      at(L.cooler.dx, L.cooler.dy, () => watercooler(ctx, fit, lx + L.cooler.dx, ly + L.cooler.dy)),
      at(L.couch.dx, L.couch.dy, () => couch(ctx, fit, lx + L.couch.dx, ly + L.couch.dy, PAL.couch, 'S')),
      at(L.chairE.dx, L.chairE.dy, () => armchair(ctx, fit, lx + L.chairE.dx, ly + L.chairE.dy, '#c9744a', 'E')),
      at(L.table.dx, L.table.dy, () => ctable(ctx, fit, lx + L.table.dx, ly + L.table.dy)),
      at(L.chairW.dx, L.chairW.dy, () => armchair(ctx, fit, lx + L.chairW.dx, ly + L.chairW.dy, '#c9744a', 'W')),
    ],
  };
}

/** A water cooler: a slim base + a tinted bottle on top (a distinct kitchenette piece). */
function watercooler(ctx: CanvasRenderingContext2D, fit: Fit, lx: number, ly: number): void {
  const c = LOUNGE.cooler;
  box(ctx, fit, lx, ly, c.w, c.d, c.h, '#dfe7ea'); // white body
  box(ctx, fit, lx, ly, c.w - 6, c.d - 6, 16, '#8fd0e6', c.h); // blue bottle on top
}

/** A bookshelf: a wood carcass with three shelves of colourful book spines facing into the room. */
function bookshelf(ctx: CanvasRenderingContext2D, fit: Fit, s: Bookshelf): void {
  const f = FWD[s.dir];
  const sn = f[1] !== 0; // S/N run along x; E/W run along y
  const wx = sn ? SHELF_LONG : SHELF_DEEP;
  const dy = sn ? SHELF_DEEP : SHELF_LONG;
  box(ctx, fit, s.lx, s.ly, wx, dy, SHELF_H, PAL.wood); // carcass
  // book rows on the front (room-facing) face — three bands of little spines up the height
  const BOOKS = ['#c95c4a', '#e0a72b', '#5aa0c9', '#6aa86a', '#b06fc9', '#d98b4a'];
  const face = 0.5; // fraction of the long side the books span
  for (let row = 0; row < 3; row++) {
    const baseUp = 8 + row * 18;
    const n = 5;
    for (let i = 0; i < n; i++) {
      const t = (i - (n - 1) / 2) / n; // -.4..+.4 along the shelf
      const bx = s.lx + (sn ? t * SHELF_LONG * face : f[0] * (SHELF_DEEP / 2 - 2));
      const by = s.ly + (sn ? f[1] * (SHELF_DEEP / 2 - 2) : t * SHELF_LONG * face);
      const col = BOOKS[(row * 2 + i) % BOOKS.length]!;
      box(ctx, fit, bx, by, sn ? 8 : 3, sn ? 3 : 8, 13, col, baseUp);
    }
  }
}

/** A huddle, as depth items (same reasoning as the nook). Sized up to read proportionate to the desks:
 * roomier poufs and a bigger low table on a wider rug. */
function huddleItems(ctx: CanvasRenderingContext2D, fit: Fit, h: Huddle): { rug: () => void; items: DepthItem[] } {
  const at = (dx: number, dy: number, fn: () => void): DepthItem => ({ d: depth(h.lx + dx, h.ly + dy), fn });
  const pouf = (lx: number, ly: number, color: string): void => {
    const p = project(lx, ly, fit);
    ellipse(ctx, { x: p.x, y: p.y + 3 * fit.scale }, 23 * fit.scale, 8 * fit.scale, 'rgba(64, 39, 25, 0.13)');
    box(ctx, fit, lx, ly, 42, 42, 20, dim(color, 0.93));
    ellipse(ctx, { x: p.x, y: p.y - 20 * fit.scale }, 20 * fit.scale, 8 * fit.scale, mul(color, 1.07));
    ellipse(ctx, { x: p.x - 5 * fit.scale, y: p.y - 23 * fit.scale }, 7 * fit.scale, 2.2 * fit.scale, 'rgba(255,255,255,0.18)');
  };
  return {
    rug: () => drawRug(ctx, fit, h.rug, h.lx, h.ly, h.rugSize, h.rugSize),
    items: [
      at(0, -54, () => pouf(h.lx, h.ly - 54, h.poufs[0])),
      at(0, 0, () => box(ctx, fit, h.lx, h.ly, 66, 66, 18, woodTop())),
      at(52, 32, () => pouf(h.lx + 52, h.ly + 32, h.poufs[1])),
      at(-52, 32, () => pouf(h.lx - 52, h.ly + 32, h.poufs[2])),
    ],
  };
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
  ctx.font = `${Math.round(12 * scale)}px "Inter", system-ui, sans-serif`;
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

function drawPlant(
  ctx: CanvasRenderingContext2D,
  fit: Fit,
  lx: number,
  ly: number,
  species: 'snake' | 'fiddle',
): void {
  const base = project(lx, ly, fit);
  const s = fit.scale;
  ellipse(ctx, { x: base.x, y: base.y + 3 * s }, 20 * s, 6 * s, 'rgba(0,0,0,0.14)');
  box(ctx, fit, lx, ly, 24, 24, 18, '#b9603a');
  const top = { x: base.x, y: base.y - 18 * s };
  if (species === 'snake') {
    for (const [dx, h] of [
      [-13, 46],
      [-4, 56],
      [6, 50],
      [14, 38],
    ] as const) {
      ellipse(ctx, { x: top.x + dx * s, y: top.y - (h / 2) * s }, 5.5 * s, (h / 2) * s, '#3e6b3a');
      ellipse(ctx, { x: top.x + dx * s, y: top.y - h * s + 5 * s }, 4 * s, 6 * s, '#6fa35a');
    }
  } else {
    for (const [dx, dy, r] of [
      [-16, -46, 17],
      [7, -52, 16],
      [-2, -32, 14],
    ] as const) {
      ellipse(ctx, { x: top.x + dx * s, y: top.y + dy * s }, r * s, (r - 2) * s, '#6e9e52');
      ellipse(ctx, { x: top.x + (dx + 5) * s, y: top.y + (dy + 5) * s }, (r * 0.5) * s, (r * 0.4) * s, '#86b368');
    }
  }
}

// ── the office cat (behaviour in cat.ts; this is only the painter) ──────────────────────────────────────

const CAT = {
  fur: '#e08a43',
  stripe: '#c9702f',
  cream: '#f7e9d4',
  earIn: '#eaa98e',
  collar: '#e3a72b', // the huddle-pouf mustard — the team cat wears the team colour
  eye: '#3a2c1c',
} as const;

/**
 * Draw the cat at its current pose. Screen-space profile (like the members' billboarded faces): the body
 * reads side-on and `flip` mirrors it for leftward travel. Small on purpose — cat-sized next to ~40px
 * people — so judge it at 4× on /character-sheet, not here.
 */
export function drawCat(ctx: CanvasRenderingContext2D, fit: Fit, cat: CatState, t: number): void {
  const p = project(cat.lx, cat.ly, fit);
  const s = fit.scale;
  const m = cat.flip ? -1 : 1;
  const px = (dx: number, dy: number): Pt => ({ x: p.x + dx * m * s, y: p.y + dy * s });

  ctx.save();
  const tail = (x0: number, y0: number, cx: number, cy: number, x1: number, y1: number, w: number): void => {
    ctx.strokeStyle = CAT.fur;
    ctx.lineWidth = w * s;
    ctx.lineCap = 'round';
    ctx.beginPath();
    const a = px(x0, y0);
    const c = px(cx, cy);
    const b = px(x1, y1);
    ctx.moveTo(a.x, a.y);
    ctx.quadraticCurveTo(c.x, c.y, b.x, b.y);
    ctx.stroke();
  };
  const leg = (x: number, lift: number, w = 2.6): void => {
    const top = px(x, -9);
    const foot = px(x, -lift);
    ctx.strokeStyle = CAT.fur;
    ctx.lineWidth = w * s;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(top.x, top.y);
    ctx.lineTo(foot.x, foot.y);
    ctx.stroke();
  };
  const ear = (x: number, y: number, r: number): void => {
    const a = px(x - r, y);
    const b = px(x + r, y);
    const tip = px(x, y - r * 1.7);
    quad(ctx, [a, tip, b], CAT.fur);
    const ia = px(x - r * 0.45, y - r * 0.15);
    const ib = px(x + r * 0.45, y - r * 0.15);
    const itip = px(x, y - r * 1.1);
    quad(ctx, [ia, itip, ib], CAT.earIn);
  };
  const head = (x: number, y: number, awake: boolean): void => {
    ear(x - 4, y - 4.5, 2.6);
    ear(x + 3.5, y - 4.5, 2.6);
    ellipse(ctx, px(x, y), 6.2 * s, 5.6 * s, CAT.fur);
    ellipse(ctx, px(x + 2.6, y + 2.6), 2.2 * s, 1.7 * s, CAT.cream); // muzzle
    if (awake) {
      ellipse(ctx, px(x - 1.6, y - 0.6), 0.9 * s, 1.1 * s, CAT.eye);
      ellipse(ctx, px(x + 3.4, y - 0.6), 0.9 * s, 1.1 * s, CAT.eye);
    } else {
      ctx.strokeStyle = CAT.eye;
      ctx.lineWidth = 0.8 * s;
      for (const ex of [-1.6, 3.4]) {
        const a = px(ex - 1, y - 0.4);
        const b = px(ex + 1, y - 0.4);
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
      }
    }
  };
  const stripes = (x: number, y: number, r: number): void => {
    ctx.strokeStyle = CAT.stripe;
    ctx.lineWidth = 1.6 * s;
    ctx.lineCap = 'round';
    for (const dx of [-r * 0.45, 0.5, r * 0.55]) {
      const a = px(x + dx, y - r * 0.55);
      const b = px(x + dx + 1.4, y + r * 0.1);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }
  };
  const collar = (x: number, y: number, r: number): void => {
    ellipse(ctx, px(x, y), r * s, r * 0.42 * s, CAT.collar);
  };

  switch (cat.mode) {
    case 'sleep':
    case 'curl': {
      // Curled into a bun: tail wrapped round the front, head tucked, slow breathing.
      const settle = cat.mode === 'curl' ? Math.min(1, cat.modeT / CURL_VIS_S) : 1;
      const breathe = 1 + 0.045 * Math.sin(t * 2.1) * settle;
      ellipse(ctx, px(0, 1.5), 14 * s, 4.5 * s, 'rgba(0,0,0,0.14)');
      ellipse(ctx, px(0, -6), 12 * s, 7.2 * breathe * s, CAT.fur);
      stripes(-1, -7, 11);
      tail(-9, -2, 0, 2.5, 9.5, -1.5, 3.2);
      head(7, -7.5, false);
      break;
    }
    case 'sit': {
      // Upright, tail wrapped with a flicking tip, eyes open — the supervising pose.
      ellipse(ctx, px(0, 1.5), 12 * s, 4 * s, 'rgba(0,0,0,0.14)');
      const flick = Math.sin(t * 3.2) * 2.4;
      tail(-7, -3, -13, -2, -14, -6 - flick, 2.6);
      ellipse(ctx, px(-1, -8), 8 * s, 8.5 * s, CAT.fur); // haunches
      stripes(-2, -10, 8);
      ellipse(ctx, px(3.5, -12), 5.2 * s, 7 * s, CAT.fur); // chest, up
      ellipse(ctx, px(4, -9), 3 * s, 4.5 * s, CAT.cream); // chest patch
      leg(2.2, 0.5);
      leg(5.4, 0.5);
      collar(4.5, -18, 4.4);
      head(5, -23, true);
      break;
    }
    case 'stretch': {
      // The wake-up: front low and reaching, haunches high, tail straight up.
      ellipse(ctx, px(0, 1.5), 15 * s, 4.5 * s, 'rgba(0,0,0,0.14)');
      tail(-10, -16, -13, -24, -11, -27, 2.6);
      ellipse(ctx, px(-7, -13), 7.5 * s, 7 * s, CAT.fur); // haunches, up
      stripes(-8, -14, 7);
      leg(-9, 0.5, 3);
      ellipse(ctx, px(2, -6), 8 * s, 4.6 * s, CAT.fur); // chest sweeping low
      const reach = px(12, -1.5);
      const sh = px(4, -6);
      ctx.strokeStyle = CAT.fur;
      ctx.lineWidth = 2.6 * s;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(sh.x, sh.y);
      ctx.lineTo(reach.x, reach.y);
      ctx.stroke();
      collar(9.5, -9, 4);
      head(12.5, -12.5, true);
      break;
    }
    case 'walk': {
      // Padding along: diagonal gait, tail carried high, slight body bob.
      const cyc = cat.phase * Math.PI * 2;
      const bob = Math.sin(cyc * 2) * 0.7;
      ellipse(ctx, px(0, 1.5), 14 * s, 4.5 * s, 'rgba(0,0,0,0.12)');
      tail(-10, -13 + bob, -16, -22, -13, -27 + Math.sin(t * 2.3) * 1.6, 2.6);
      // far legs first, then body, then near legs — so the gait reads as four feet, not a comb
      leg(-7 + Math.sin(cyc) * 2, -Math.max(0, Math.sin(cyc)) * 2.5 + 0.5, 2.2);
      leg(6 + Math.sin(cyc + Math.PI) * 2, -Math.max(0, Math.sin(cyc + Math.PI)) * 2.5 + 0.5, 2.2);
      ellipse(ctx, px(0, -12.5 + bob), 11.5 * s, 6 * s, CAT.fur);
      stripes(-1, -13.5 + bob, 10);
      leg(-6 + Math.sin(cyc + Math.PI) * 2, -Math.max(0, Math.sin(cyc + Math.PI)) * 2.5 + 0.5);
      leg(7 + Math.sin(cyc) * 2, -Math.max(0, Math.sin(cyc)) * 2.5 + 0.5);
      collar(10.5, -16.5 + bob, 4);
      head(12.5, -21 + bob, true);
      break;
    }
  }
  ctx.restore();
}

/** How long the settle-down takes to visually damp the breathing in from the sit (matches cat.ts CURL_S). */
const CURL_VIS_S = 1.1;

/**
 * Solve a member's skeleton for this frame from their pose (see `skeleton.ts` — all the animation lives
 * there; this only decides *which* animation state the pose implies).
 */
function skelFor(pose: Pose, node: OfficeNode, t: number) {
  const seed = seedOf(node.name);
  // Typing is gated on actually working *and* actually being at the desk — a member half-way out of their
  // chair has better things to do, and a room with nobody typing is a room the scene can stop redrawing.
  const typing = node.activity === 'working' && pose.sit > 0.9 ? typingBurst(seed, t) : 0;
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
  ctx.font = `${Math.round(13 * s)}px "Inter", system-ui, sans-serif`;
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
): void {
  drawCharacter(
    ctx,
    fit,
    {
      lx: pose.lx,
      ly: pose.ly,
      dir: pose.dir,
      node,
      skel: skelFor(pose, node, t),
      size: pose.small ? 0.72 : 1,
      alpha: pose.alpha,
      carry: pose.carry,
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

function chairKindFor(id: number): ChairKind {
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
    // A 5-star caster base: five little wheels on the floor + a central column up to the cushion.
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2 + 0.4;
      const wp = project(lx + Math.cos(a) * 14, ly + Math.sin(a) * 14, fit);
      ellipse(ctx, wp, 4 * fit.scale, 2.3 * fit.scale, dim(color, 0.5));
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
  }
  const g = project(mx, my, fit);
  const pulse = working ? 0.85 + 0.15 * Math.sin(t * 2.1 + mx + my) : 1;
  ctx.save();
  ctx.globalAlpha = pulse;
  ellipse(ctx, { x: g.x, y: g.y - (up + 10 + h) * fit.scale }, wAcross * 0.35 * fit.scale, 4 * fit.scale, working ? '#59c3a3' : '#33504c');
  ctx.restore();
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
const PROP_KINDS = ['coffee', 'water', 'plant', 'photo', 'lamp', 'fan'] as const;
type PropKind = (typeof PROP_KINDS)[number];
const PROP_SPEC: Record<PropKind, { salt: number; prob: number; along: number; across: number }> = {
  coffee: { salt: 1, prob: 0.4, along: -4, across: -34 },
  water: { salt: 2, prob: 0.42, along: 7, across: -36 },
  plant: { salt: 3, prob: 0.46, along: 20, across: -40 },
  photo: { salt: 4, prob: 0.42, along: 20, across: 38 },
  lamp: { salt: 5, prob: 0.4, along: 8, across: 42 },
  fan: { salt: 6, prob: 0.38, along: -10, across: 38 },
};
/** Whether a given desk carries a given prop — a stable per-desk hash, independent of who's seated. */
function deskHasProp(id: number, kind: PropKind): boolean {
  return deskRnd(id, PROP_SPEC[kind].salt) < PROP_SPEC[kind].prob;
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

/** A desk lamp: base + slim pole + a warm glowing shade. */
function deskLamp(ctx: CanvasRenderingContext2D, fit: Fit, ix: number, iy: number, up: number, lit: boolean): void {
  box(ctx, fit, ix, iy, 10, 10, 3, '#3d4650', up); // base
  box(ctx, fit, ix, iy, 3, 3, 22, '#4a545f', up + 3); // pole
  const g = project(ix, iy, fit);
  const ty = g.y - (up + 26) * fit.scale;
  // Lit when a member's at the desk and it's dark enough out (see LightEnv.lampsOn) — warm amber shade +
  // inner glow; otherwise switched off, a cool grey shade with no glow (matches the idle fan / empty mug).
  ellipse(ctx, { x: g.x, y: ty }, 9 * fit.scale, 5 * fit.scale, lit ? '#e9c46a' : '#aab0b8');
  if (lit) ellipse(ctx, { x: g.x, y: ty + 2 * fit.scale }, 6 * fit.scale, 3 * fit.scale, '#fff1c2'); // warm glow
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
  env: LightEnv,
  t = 0,
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
  const working = node?.activity === 'working';
  const mood = node ? deskMoodStyle(deskMoodFor(teamName, node.name)) : null;

  for (const [sx, sy] of [
    [-1, -1],
    [1, -1],
    [1, 1],
    [-1, 1],
  ] as const) {
    box(ctx, fit, lx + sx * (wx / 2 - 6), ly + sy * (dy / 2 - 6), 8, 8, DH, dim(PAL.wood, 0.9));
  }
  box(ctx, fit, lx, ly, wx, dy, ST, PAL.wood, DH);

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
  at(Df / 2 - 12, 0, (ix, iy) => monitor(ctx, fit, ix, iy, dir, working, up, id, t));
  at(KEYBOARD_ALONG, 0, (ix, iy) => deskKeyboard(ctx, fit, ix, iy, sn, up, kbShoulder));
  at(KEYBOARD_ALONG + 2, 27, (ix, iy) => deskMouse(ctx, fit, ix, iy, sn, up, mouseColor));

  // optional personal props — each present-or-not per desk by a stable hash, at its own station
  for (const kind of PROP_KINDS) {
    if (!deskHasProp(id, kind) && !mood?.props.includes(kind)) continue;
    const sp = PROP_SPEC[kind];
    at(sp.along, sp.across, (ix, iy) => {
      switch (kind) {
        case 'coffee':
          return deskCoffee(ctx, fit, ix, iy, up, MUGS[Math.floor(deskRnd(id, 11) * MUGS.length)]!, node != null);
        case 'water':
          return deskWater(ctx, fit, ix, iy, up);
        case 'plant':
          return deskPlant(ctx, fit, ix, iy, up);
        case 'photo':
          return deskPhoto(ctx, fit, ix, iy, sn, up, PHOTOS[Math.floor(deskRnd(id, 41) * PHOTOS.length)]!);
        case 'lamp':
          // A lamp lights up only when someone's at the desk *and* it's dark enough out to want it on.
          return deskLamp(ctx, fit, ix, iy, up, node != null && env.lampsOn);
        case 'fan':
          return deskFan(ctx, fit, ix, iy, up);
      }
    });
  }

  props.sort((a, b) => a.sum - b.sum);
  for (const pr of props) pr.fn();
}

export interface SceneAnchors {
  heads: Map<string, Pt>;
  bases: Map<string, Pt>;
}

/**
 * Interior lighting pass, painted after all furniture/actors: a cool night veil at `env.veilAlpha` (an
 * empty office after dark goes properly dark; an occupied one is lifted by the overhead fill so it reads
 * lit), then a warm floor pool under every *lit* desk lamp — drawn additively so occupied desks glow
 * through the dark like real lamps. During the day `veilAlpha` is ~0 and lamps are off, so this no-ops.
 */
function drawInteriorLight(
  ctx: CanvasRenderingContext2D,
  fit: Fit,
  env: LightEnv,
  slotMember: Map<number, string>,
): void {
  if (env.veilAlpha > 0.01) {
    ctx.save();
    ctx.globalAlpha = env.veilAlpha;
    ctx.fillStyle = env.veilColor;
    ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height); // whole canvas (overshoots under DPR — harmless)
    ctx.restore();
  }
  if (!env.lampsOn) return;
  ctx.save();
  ctx.globalCompositeOperation = 'lighter'; // additive: the pool *adds* light back over the veil
  for (const slot of DESK_SLOTS) {
    if (!slotMember.has(slot.id) || !deskHasProp(slot.id, 'lamp')) continue; // lit lamps only (occupied desk)
    const [ix, iy] = deskPoint(slot, PROP_SPEC.lamp.along, PROP_SPEC.lamp.across);
    const p = project(ix, iy, fit);
    const r = 72 * fit.scale;
    const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, r);
    g.addColorStop(0, 'rgba(255, 200, 120, 0.42)');
    g.addColorStop(1, 'rgba(255, 200, 120, 0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.ellipse(p.x, p.y, r, r * 0.62, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
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
  cat: CatState | null = null,
): SceneAnchors {
  drawFloor(ctx, fit);
  // The room shell: back walls + windows as a backdrop (behind every item), then the daylight beams they
  // cast onto the floor (under every item). Both before the depth-sorted loop — see the walls note above.
  drawWalls(ctx, fit, env);
  drawWindowBeams(ctx, fit, env);

  // desk → seat owner (for the monitor's working glow); the owner may be walking but the seat stays lit.
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
  for (const s of BOOKSHELVES) {
    items.push({ d: depth(s.lx, s.ly), fn: () => bookshelf(ctx, fit, s) });
  }
  // Rugs are flat floor paint — draw them right after the floor (before every solid/actor), so a member
  // standing anywhere on a rug is never over-painted by it. Solid pieces self-sort at their footprints.
  for (const pod of PODS) {
    const ns = pod.axis === 'ns';
    const w = ns ? POD_RUG.across : POD_RUG.along;
    const d = ns ? POD_RUG.along : POD_RUG.across;
    drawRug(ctx, fit, pod.rug, pod.cx, pod.cy, w, d);
  }
  drawRug(ctx, fit, MEETING.rug, MEETING.lx, MEETING.ly, MEETING.rug.w, MEETING.rug.d);
  drawRug(ctx, fit, RECEPTION.rug, RECEPTION.rug.lx, RECEPTION.rug.ly, RECEPTION.rug.w, RECEPTION.rug.d);
  const nook = nookItems(ctx, fit);
  nook.rug();
  items.push(...nook.items);
  for (const h of HUDDLES) {
    const hud = huddleItems(ctx, fit, h);
    hud.rug();
    items.push(...hud.items);
  }
  items.push({ d: depth(MEETING.lx, MEETING.ly), fn: () => meetingTable(ctx, fit) });
  for (const c of MEETING.chairs) {
    const cx = MEETING.lx + c.dx;
    const cy = MEETING.ly + c.dy;
    items.push({ d: depth(cx, cy), fn: () => meetingChair(ctx, fit, cx, cy, c.dir) });
  }
  items.push(...receptionItems(ctx, fit));
  items.push({ d: depth(PRINTER.lx, PRINTER.ly), fn: () => printer(ctx, fit) });
  items.push({ d: depth(ENTRANCE.lx, ENTRANCE.ly), fn: () => drawEntrance(ctx, fit) });

  // The office cat sorts with everything else at its own floor position (behaviour lives in cat.ts).
  if (cat) items.push({ d: depth(cat.lx, cat.ly) + 0.08, fn: () => drawCat(ctx, fit, cat, t) });

  for (const slot of DESK_SLOTS) {
    const name = slotMember.get(slot.id) ?? null;
    const node = name ? (byName.get(name) ?? null) : null;
    items.push({ d: depth(slot.lx, slot.ly), fn: () => drawWorkstation(ctx, fit, slot, node, teamName, env, t) });
    // The task chair, in two depth items (see `chairBase`/`chairBack`): the cushion the member sits *on*
    // paints before them, the backrest at its own footprint — so at every facing the sitter lands between
    // the two instead of being swallowed by a single chair box.
    const f = FWD[slot.dir];
    const cx = slot.lx - f[0] * CHAIR_OFF;
    const cy = slot.ly - f[1] * CHAIR_OFF;
    const bx = cx - f[0] * CHAIR_BACK_OFF;
    const by = cy - f[1] * CHAIR_BACK_OFF;
    const chairColor = node ? hslL(node.color, 0.5) : '#4a5560';
    const chairStyle = chairStyleFor(slot.id);
    items.push({ d: depth(cx, cy) - 0.2, fn: () => chairBase(ctx, fit, cx, cy, slot.dir, chairColor, chairStyle) });
    items.push({ d: depth(bx, by), fn: () => chairBack(ctx, fit, bx, by, slot.dir, chairColor, chairStyle) });
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
    const seated = pose.sit > 0.5 && slot;

    // A seated member's depth key comes from **the chair**, not their own feet. Their feet sit a couple of
    // units off the chair centre, and at north/west-facing desks that tiny offset was enough to sort the
    // cushion in *front* of them — so the chair painted over their legs. Keying off the chair puts them
    // between its base and its backrest at every facing, which is where a person in a chair belongs.
    let d = depth(pose.lx, pose.ly) + 0.1;
    if (seated) {
      const f = FWD[slot.dir];
      d = depth(slot.lx - f[0] * CHAIR_OFF, slot.ly - f[1] * CHAIR_OFF) + 0.1;
    }
    items.push({ d, fn: () => drawActor(ctx, fit, pose, node, t) });

    // Seated overlay: the desk paints over a member sitting behind it (correct — that is what a desk does
    // to your legs), but their forearms *rest on the surface*, above it, so they must paint on top of the
    // slab. One character, two depth slots: the body at the chair, the arms on the desk. Without this the
    // hands disappear into the desk and the typing is invisible.
    if (seated) {
      items.push({
        d: depth(slot.lx, slot.ly) + 0.05,
        fn: () => drawActor(ctx, fit, pose, node, t, true),
      });
    }

    bases.set(name, b);
    // The label rides above the crown — higher for a standing member than a seated one, so it tracks the
    // head through a sit rather than floating where the head used to be.
    heads.set(name, { x: b.x, y: b.y - (pose.small ? 74 : 98 - pose.sit * 22) * fit.scale });
  }

  items.sort((a, b) => a.d - b.d);
  for (const it of items) it.fn();

  // Interior lighting: veil the room to the night level, then let occupied desks' lamps glow through.
  drawInteriorLight(ctx, fit, env, slotMember);

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

  return { heads, bases };
}

/**
 * Screen positions of the **monitors of working members** — where the Tier-A ambient glow sits (ADR 086).
 * Matches `drawWorkstation`/`monitor`'s placement so the DOM glow lands on the screen, not floating. Only
 * desk-seated `working` members get one; the returned point is the screen face centre in panel px.
 */
export function monitorAnchors(
  placements: Map<string, Placement>,
  byName: Map<string, OfficeNode>,
  fit: Fit,
): Map<string, Pt> {
  const out = new Map<string, Pt>();
  for (const [name, pl] of placements) {
    if (pl.kind !== 'desk') continue;
    if (byName.get(name)?.activity !== 'working') continue;
    const slot = DESK_SLOTS[pl.slot];
    if (!slot) continue;
    const f = FWD[slot.dir];
    // monitor sits at (Df/2 - 12) toward the facing (see drawWorkstation), screen face ~78px up at scale 1
    const s = project(slot.lx + f[0] * 22, slot.ly + f[1] * 22, fit);
    out.set(name, { x: s.x, y: s.y - 78 * fit.scale });
  }
  return out;
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
  return { x: s.x, y: s.y - (LOUNGE.counter.h + 12) * fit.scale };
}

/** A transient act cue: a tinted ring + optional glyph (`ring`), a broadcast sweep (`wave`), or a glow
 * at the entrance when someone comes or goes (`door`). */
export interface Cue {
  at: Pt;
  to?: Pt;
  source?: string;
  color: string;
  glyph: '' | '?' | '!' | '📣' | '✓' | '↦' | '↪';
  t: number;
  urgent: boolean;
  kind?: 'ring' | 'wave' | 'door' | 'thread';
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
    const eased = 1 - Math.pow(1 - t, 2);
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
    ctx.font = `${Math.round(15 * scale)}px "Inter", system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = cue.urgent ? '#f3776a' : color;
    ctx.fillText(cue.glyph, at.x, at.y - 20 * scale - rise);
    ctx.globalAlpha = 1;
  }
}
