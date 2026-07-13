import { depth, FLOOR, project, THICK, type Fit, type Pt } from './iso';
import {
  BOOKSHELVES,
  CHAIR_OFF,
  DESK_D,
  DESK_SLOTS,
  DESK_W,
  ENTRANCE,
  FWD,
  HUDDLES,
  LOUNGE,
  NOOK,
  NOOK_RUG_R,
  PLANTS,
  SHELF_DEEP,
  SHELF_H,
  SHELF_LONG,
  type Bookshelf,
  type Huddle,
} from './layout';
import { DAY_ENV, type LightEnv } from './lighting';
import { deskMoodFor, deskMoodStyle } from './moods';
import type { Placement } from './seating';
import type { Dir, OfficeNode, Pose } from './types';

/**
 * Canvas-2D drawing for the office. Everything is painter-ordered by logical depth (lx+ly) so seated
 * members sit correctly behind their desks and nearer pods overlap farther ones. The static scene is
 * baked once per data/resize; transient act cues are drawn on top each frame. Fidelity ported from the
 * Figma "Floor Plan": legged desks + task chairs + oriented glowing monitors, a rich break nook
 * (couch + armchairs + kitchenette), huddle spaces, and big floor plants.
 */

const SKIN = '#f0c9a0';

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
}

/** Dusk office (the historical hard-coded values) — also the fallback when a token can't be read. */
export const DARK_PALETTE: ScenePalette = {
  floor: '#e4a96b',
  floor2: '#c6863f',
  wood: '#7a4e2d',
  couch: '#e3a72b',
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
}

/** A round-ish iso rug (a filled iso square). */
function rug(ctx: CanvasRenderingContext2D, fit: Fit, lx: number, ly: number, r: number, fill: string): void {
  const A = project(lx - r, ly, fit);
  const B = project(lx, ly - r, fit);
  const C = project(lx + r, ly, fit);
  const D = project(lx, ly + r, fit);
  quad(ctx, [A, B, C, D], fill);
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
}

function armchair(ctx: CanvasRenderingContext2D, fit: Fit, lx: number, ly: number, c: string, dir: Dir): void {
  const f = FWD[dir];
  const sn = f[1] !== 0;
  const S = LOUNGE.chairW.size;
  box(ctx, fit, lx - f[0] * (S / 2 - 6), ly - f[1] * (S / 2 - 6), sn ? S - 2 : 10, sn ? 10 : S - 2, 32, dim(c, 0.9));
  box(ctx, fit, lx, ly, sn ? S - 2 : S, sn ? S : S - 2, 20, c);
}

function ctable(ctx: CanvasRenderingContext2D, fit: Fit, lx: number, ly: number): void {
  const s = project(lx, ly, fit);
  ellipse(ctx, { x: s.x, y: s.y }, 42 * fit.scale, 13 * fit.scale, 'rgba(0,0,0,0.12)');
  box(ctx, fit, lx, ly, LOUNGE.table.w, LOUNGE.table.d, 16, woodTop());
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
    rug: () => rug(ctx, fit, lx, ly, NOOK_RUG_R, '#ce9256'),
    items: [
      at(L.plant.dx, L.plant.dy, () => drawPlant(ctx, fit, lx + L.plant.dx, ly + L.plant.dy, 'fiddle')),
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
  return {
    rug: () => rug(ctx, fit, h.lx, h.ly, 96, h.rug),
    items: [
      at(0, -54, () => box(ctx, fit, h.lx, h.ly - 54, 44, 44, 28, h.poufs[0])),
      at(0, 0, () => box(ctx, fit, h.lx, h.ly, 66, 66, 18, woodTop())),
      at(52, 32, () => box(ctx, fit, h.lx + 52, h.ly + 32, 44, 44, 28, h.poufs[1])),
      at(-52, 32, () => box(ctx, fit, h.lx - 52, h.ly + 32, 44, 44, 28, h.poufs[2])),
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

// ── avatar (placeholder — Rive replaces this in M2) ──────────────────────────
function avatar(
  ctx: CanvasRenderingContext2D,
  fit: Fit,
  lx: number,
  ly: number,
  node: OfficeNode,
  dir: Dir,
  small = false,
  moving = false,
  run = false,
): void {
  const p = project(lx, ly, fit);
  const s = fit.scale * (small ? 0.72 : 1);
  const acc = node.color;
  const dk = hslL(acc, 0.7);
  // Walk cycle (code-drawn fallback only — the Rive rig animates its own limbs): feet alternate and the
  // arms counter-swing on a time-based phase, so a mover strides instead of gliding.
  const ph = moving ? Math.sin(performance.now() / (run ? 55 : 90)) : 0;
  ellipse(ctx, { x: p.x, y: p.y }, 24 * s, 6 * s, 'rgba(0,0,0,0.18)');
  if (moving) {
    ellipse(ctx, { x: p.x - 8 * s + ph * 5 * s, y: p.y - 3 * s - Math.max(0, ph) * 4 * s }, 5.5 * s, 3.5 * s, dk);
    ellipse(ctx, { x: p.x + 8 * s - ph * 5 * s, y: p.y - 3 * s - Math.max(0, -ph) * 4 * s }, 5.5 * s, 3.5 * s, dk);
  }
  roundRect(ctx, p.x - 19 * s, p.y - 44 * s, 38 * s, 32 * s, 12 * s, acc);
  roundRect(ctx, p.x - 25 * s, p.y - (42 - ph * 5) * s, 8 * s, 22 * s, 4 * s, dk);
  roundRect(ctx, p.x + 17 * s, p.y - (42 + ph * 5) * s, 8 * s, 22 * s, 4 * s, dk);
  ellipse(ctx, { x: p.x, y: p.y - 56 * s }, 15 * s, 15 * s, SKIN);
  if (node.kind === 'agent') {
    ctx.strokeStyle = acc;
    ctx.lineWidth = 2 * s;
    ctx.beginPath();
    ctx.moveTo(p.x, p.y - 68 * s);
    ctx.lineTo(p.x, p.y - 78 * s);
    ctx.stroke();
    ellipse(ctx, { x: p.x, y: p.y - 80 * s }, 4 * s, 4 * s, '#74e08a');
    if (dir === 'S') roundRect(ctx, p.x - 11 * s, p.y - 61 * s, 22 * s, 8 * s, 4 * s, '#2e3a38');
    ellipse(ctx, { x: p.x, y: p.y - 34 * s }, 4 * s, 4 * s, '#74e08a');
  } else {
    ellipse(ctx, { x: p.x, y: p.y - 62 * s }, 16 * s, 8 * s, hslL(node.color, 0.42));
    if (dir === 'S') {
      ellipse(ctx, { x: p.x - 6 * s, y: p.y - 55 * s }, 2.4 * s, 2.4 * s, '#2e2a26');
      ellipse(ctx, { x: p.x + 6 * s, y: p.y - 55 * s }, 2.4 * s, 2.4 * s, '#2e2a26');
    }
  }
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
 * Draw a member as a free actor at a pose: the placeholder avatar, plus a carried box (handoff) and a
 * head bubble (raised hand). Position drives depth-sort in `renderScene`, so a walker overlaps desks
 * correctly. (Rive replaces the avatar body in a later cut, behind this same call.)
 */
export function drawActor(ctx: CanvasRenderingContext2D, fit: Fit, pose: Pose, node: OfficeNode): void {
  const fade = pose.alpha < 1;
  if (fade) ctx.globalAlpha = Math.max(0, pose.alpha);
  avatar(ctx, fit, pose.lx, pose.ly, node, pose.dir, pose.small, pose.moving, pose.run);
  const p = project(pose.lx, pose.ly, fit);
  const s = fit.scale * (pose.small ? 0.72 : 1);
  if (pose.carry) {
    // a labelled box held at chest height, tinted the handoff colour
    roundRect(ctx, p.x - 11 * s, p.y - 34 * s, 22 * s, 17 * s, 3 * s, '#b592f0');
    roundRect(ctx, p.x - 11 * s, p.y - 34 * s, 22 * s, 5 * s, 2 * s, '#8a5fd6');
  }
  if (fade) ctx.globalAlpha = 1;
  if (pose.bubble) bubble(ctx, p.x, p.y - (pose.small ? 62 : 74) * fit.scale, pose.bubble, fit.scale);
}

// ── a workstation: legged desk + task chair + oriented glowing monitor ──
function chair(ctx: CanvasRenderingContext2D, fit: Fit, lx: number, ly: number, dir: Dir, color: string): void {
  const f = FWD[dir];
  const sn = f[1] !== 0;
  const lift = 10; // seat height off the floor — the legs' reach
  // four splayed legs under the seat (chairs used to sit legless on the floor)
  for (const [sx, sy] of [
    [-1, -1],
    [1, -1],
    [1, 1],
    [-1, 1],
  ] as const) {
    box(ctx, fit, lx + sx * 10, ly + sy * 10, 4, 4, lift, dim(color, 0.6));
  }
  box(ctx, fit, lx, ly, sn ? 34 : 30, sn ? 30 : 34, 12, color, lift); // seat
  box(ctx, fit, lx - f[0] * 14, ly - f[1] * 14, sn ? 34 : 7, sn ? 7 : 34, 26, dim(color, 0.85), lift + 4); // backrest
}

function monitor(
  ctx: CanvasRenderingContext2D,
  fit: Fit,
  mx: number,
  my: number,
  dir: Dir,
  working: boolean,
  surfaceUp: number,
): void {
  const sn = dir === 'S' || dir === 'N';
  const pw = sn ? 34 : 5;
  const pd = sn ? 5 : 34;
  box(ctx, fit, mx, my, 8, 6, 8, '#33272b', surfaceUp);
  box(ctx, fit, mx, my, pw, pd, 22, '#2a2e33', surfaceUp + 8);
  const scr = working ? '#7fe0ce' : '#4a6b66';
  const lo = (surfaceUp + 8) * fit.scale;
  const hi = (surfaceUp + 30) * fit.scale;
  const dn = (p: Pt, u: number): Pt => ({ x: p.x, y: p.y - u });
  if (dir === 'N') {
    const D = project(mx - pw / 2, my + pd / 2, fit);
    const C = project(mx + pw / 2, my + pd / 2, fit);
    quad(ctx, [dn(D, lo), dn(C, lo), dn(C, hi), dn(D, hi)], scr);
  } else if (dir === 'W') {
    const B = project(mx + pw / 2, my - pd / 2, fit);
    const C = project(mx + pw / 2, my + pd / 2, fit);
    quad(ctx, [dn(B, lo), dn(C, lo), dn(C, hi), dn(B, hi)], scr);
  }
  const g = project(mx, my, fit);
  ellipse(ctx, { x: g.x, y: g.y - (surfaceUp + 32) * fit.scale }, 12 * fit.scale, 4 * fit.scale, working ? '#59c3a3' : '#33504c');
}

// ── desk-surface props: a keyboard + mouse on every desk, plus a deterministic personal mix ──────────
// Each optional prop (coffee / water / photo / plant / fan / lamp) is present or not per desk from a
// stable hash of the slot id, so a desk always shows the same combination frame to frame (no jitter) but
// desks differ from each other — one desk might carry a lone coffee mug, another a lamp + plant + photo.

const KEYBOARD = '#2b2f36';
const MOUSE = '#454b54';
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

/** The desk surface height (leg height + slab thickness) — where every prop sits. */
const DESK_UP = 38 + 8;

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

/** A flat keyboard: a base tray + a slightly raised key deck, oriented across the desk (facing-relative). */
function deskKeyboard(ctx: CanvasRenderingContext2D, fit: Fit, ix: number, iy: number, sn: boolean, up: number): void {
  box(ctx, fit, ix, iy, sn ? 34 : 13, sn ? 13 : 34, 3, KEYBOARD, up);
  box(ctx, fit, ix, iy, sn ? 30 : 9, sn ? 9 : 30, 4, '#3b414a', up); // key deck, a touch proud of the tray
}

/** A little mouse beside the keyboard — long axis pointing front-to-back, rounded top. */
function deskMouse(ctx: CanvasRenderingContext2D, fit: Fit, ix: number, iy: number, sn: boolean, up: number): void {
  box(ctx, fit, ix, iy, sn ? 7 : 11, sn ? 11 : 7, 4, MOUSE, up);
  const g = project(ix, iy, fit);
  ellipse(ctx, { x: g.x, y: g.y - (up + 4) * fit.scale }, 5 * fit.scale, 3 * fit.scale, '#525863');
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
): void {
  const { lx, ly, dir, id } = slot;
  const f = FWD[dir];
  const p: [number, number] = [-f[1], f[0]]; // desk-left/right unit (perpendicular to facing)
  const sn = dir === 'S' || dir === 'N';
  const W = DESK_W;
  const Df = DESK_D;
  const DH = 38;
  const ST = 8;
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

  // the monitor at the back, then the always-present keyboard (front-centre) + mouse (front-right)
  at(Df / 2 - 12, 0, (ix, iy) => monitor(ctx, fit, ix, iy, dir, working, up));
  at(-6, 0, (ix, iy) => deskKeyboard(ctx, fit, ix, iy, sn, up));
  at(-4, 27, (ix, iy) => deskMouse(ctx, fit, ix, iy, sn, up));

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

/** Minimal Rive drawer seam (real impl in rive-rig.ts) — kept WASM-free so render.ts stays pure. */
export interface RigDrawer {
  has(name: string): boolean;
  draw(ctx: CanvasRenderingContext2D, name: string, feetX: number, feetY: number, spriteH: number): void;
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
  rig?: RigDrawer,
  teamName = 'revive',
  env: LightEnv = DAY_ENV,
): SceneAnchors {
  drawFloor(ctx, fit);

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
  const nook = nookItems(ctx, fit);
  nook.rug();
  items.push(...nook.items);
  for (const h of HUDDLES) {
    const hud = huddleItems(ctx, fit, h);
    hud.rug();
    items.push(...hud.items);
  }
  items.push({ d: depth(ENTRANCE.lx, ENTRANCE.ly), fn: () => drawEntrance(ctx, fit) });

  for (const slot of DESK_SLOTS) {
    const name = slotMember.get(slot.id) ?? null;
    const node = name ? (byName.get(name) ?? null) : null;
    items.push({ d: depth(slot.lx, slot.ly), fn: () => drawWorkstation(ctx, fit, slot, node, teamName, env) });
    // The task chair sorts at its own spot behind/in front of the desk, so a seated member paints
    // between chair and desk (or desk and chair, by facing) instead of being swallowed by either.
    const f = FWD[slot.dir];
    const cx = slot.lx - f[0] * CHAIR_OFF;
    const cy = slot.ly - f[1] * CHAIR_OFF;
    const chairColor = node ? hslL(node.color, 0.5) : '#4a5560';
    items.push({ d: depth(cx, cy), fn: () => chair(ctx, fit, cx, cy, slot.dir, chairColor) });
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
    if (rig?.has(name)) {
      // Rive character: draw its current frame at the feet, sized to match the code-drawn avatar.
      const spriteH = fit.scale * 96 * (pose.small ? 0.72 : 1);
      const alpha = pose.alpha;
      items.push({
        d: depth(pose.lx, pose.ly) + 0.1,
        fn: () => {
          if (alpha < 1) ctx.globalAlpha = Math.max(0, alpha);
          rig.draw(ctx, name, b.x, b.y, spriteH);
          if (alpha < 1) ctx.globalAlpha = 1;
        },
      });
    } else {
      items.push({ d: depth(pose.lx, pose.ly) + 0.1, fn: () => drawActor(ctx, fit, pose, node) });
    }
    bases.set(name, b);
    heads.set(name, { x: b.x, y: b.y - (pose.small ? 54 : 74) * fit.scale });
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
