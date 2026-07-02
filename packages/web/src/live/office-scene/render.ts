import { depth, FLOOR, project, THICK, type Fit, type Pt } from './iso';
import { DESK_SLOTS, ENTRANCE, FWD, HUDDLES, NOOK, PLANTS, type Huddle } from './layout';
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
const WOOD = '#7a4e2d';
const WOOD_TOP = '#8a5a34';

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
    case 'status':
      return '#2ad6bb';
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
  quad(ctx, [c10, c11, dn(c11), dn(c10)], '#c6863f');
  quad(ctx, [c01, c11, dn(c11), dn(c01)], '#be7e38');
  quad(ctx, [c00, c10, c11, c01], '#e4a96b');
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
  const L = 84;
  const Dp = 38;
  box(ctx, fit, lx - f[0] * (Dp / 2 - 3), ly - f[1] * (Dp / 2 - 3), sn ? L : 8, sn ? 8 : L, 26, dim(c, 0.9));
  box(ctx, fit, lx, ly, sn ? L : Dp, sn ? Dp : L, 15, c);
  box(ctx, fit, lx + p[0] * (L / 2 - 4), ly + p[1] * (L / 2 - 4), sn ? 8 : Dp, sn ? Dp : 8, 20, dim(c, 0.95));
  box(ctx, fit, lx - p[0] * (L / 2 - 4), ly - p[1] * (L / 2 - 4), sn ? 8 : Dp, sn ? Dp : 8, 20, dim(c, 0.95));
}

function armchair(ctx: CanvasRenderingContext2D, fit: Fit, lx: number, ly: number, c: string, dir: Dir): void {
  const f = FWD[dir];
  const sn = f[1] !== 0;
  box(ctx, fit, lx - f[0] * 16, ly - f[1] * 16, sn ? 40 : 8, sn ? 8 : 40, 24, dim(c, 0.9));
  box(ctx, fit, lx, ly, sn ? 40 : 42, sn ? 42 : 40, 15, c);
}

function ctable(ctx: CanvasRenderingContext2D, fit: Fit, lx: number, ly: number): void {
  const s = project(lx, ly, fit);
  ellipse(ctx, { x: s.x, y: s.y }, 32 * fit.scale, 10 * fit.scale, 'rgba(0,0,0,0.12)');
  box(ctx, fit, lx, ly, 46, 32, 12, WOOD_TOP);
}

function drawNook(ctx: CanvasRenderingContext2D, fit: Fit): void {
  const { lx, ly } = NOOK;
  rug(ctx, fit, lx, ly, 132, '#ce9256');
  // kitchenette along the back
  drawPlant(ctx, fit, lx + 104, ly - 34, 'fiddle');
  box(ctx, fit, lx - 96, ly - 34, 32, 28, 48, '#edeff1'); // fridge
  box(ctx, fit, lx - 40, ly - 42, 72, 26, 30, '#8a5a34'); // counter
  box(ctx, fit, lx - 58, ly - 42, 14, 12, 5, '#33272b'); // coffee machine
  couch(ctx, fit, lx + 24, ly - 4, '#e3a72b', 'S');
  armchair(ctx, fit, lx - 44, ly + 52, '#c9744a', 'E');
  ctable(ctx, fit, lx + 24, ly + 48);
  armchair(ctx, fit, lx + 88, ly + 46, '#c9744a', 'W');
}

function drawHuddle(ctx: CanvasRenderingContext2D, fit: Fit, h: Huddle): void {
  rug(ctx, fit, h.lx, h.ly, 62, h.rug);
  box(ctx, fit, h.lx, h.ly - 40, 26, 26, 18, h.poufs[0]);
  box(ctx, fit, h.lx, h.ly, 40, 40, 12, WOOD_TOP);
  box(ctx, fit, h.lx + 38, h.ly + 24, 26, 26, 18, h.poufs[1]);
  box(ctx, fit, h.lx - 38, h.ly + 24, 26, 26, 18, h.poufs[2]);
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
  rug(ctx, fit, ENTRANCE.lx, ENTRANCE.ly, 70, '#7a4e2d');
  box(ctx, fit, ENTRANCE.lx - 44, ENTRANCE.ly - 42, 8, 8, 96, '#7e6042');
  box(ctx, fit, ENTRANCE.lx + 44, ENTRANCE.ly - 42, 8, 8, 96, '#7e6042');
  const a = project(ENTRANCE.lx - 44, ENTRANCE.ly - 42, fit);
  const b = project(ENTRANCE.lx + 44, ENTRANCE.ly - 42, fit);
  const up = 96 * fit.scale;
  ctx.globalAlpha = 0.3;
  quad(ctx, [a, b, { x: b.x, y: b.y - up }, { x: a.x, y: a.y - up }], '#cfe7ee');
  ctx.globalAlpha = 1;
  box(ctx, fit, ENTRANCE.lx - 44, ENTRANCE.ly - 42, 92, 6, 8, '#7e6042', 96);
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
): void {
  const p = project(lx, ly, fit);
  const s = fit.scale * (small ? 0.72 : 1);
  const acc = node.color;
  const dk = hslL(acc, 0.7);
  ellipse(ctx, { x: p.x, y: p.y }, 24 * s, 6 * s, 'rgba(0,0,0,0.18)');
  roundRect(ctx, p.x - 19 * s, p.y - 44 * s, 38 * s, 32 * s, 12 * s, acc);
  roundRect(ctx, p.x - 25 * s, p.y - 42 * s, 8 * s, 22 * s, 4 * s, dk);
  roundRect(ctx, p.x + 17 * s, p.y - 42 * s, 8 * s, 22 * s, 4 * s, dk);
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
  avatar(ctx, fit, pose.lx, pose.ly, node, pose.dir, pose.small);
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
  box(ctx, fit, lx, ly, sn ? 34 : 30, sn ? 30 : 34, 14, color); // seat
  box(ctx, fit, lx - f[0] * 14, ly - f[1] * 14, sn ? 34 : 7, sn ? 7 : 34, 30, dim(color, 0.85)); // backrest
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

/** The furniture of a desk: legs + slab + task chair + oriented monitor (glowing if its owner works).
 * The seated member is NOT drawn here — members are free actors drawn separately (see `drawActor`), so
 * they depth-sort against desks whether seated or walking. */
function drawWorkstation(
  ctx: CanvasRenderingContext2D,
  fit: Fit,
  slot: { lx: number; ly: number; dir: Dir },
  node: OfficeNode | null,
): void {
  const { lx, ly, dir } = slot;
  const f = FWD[dir];
  const sn = dir === 'S' || dir === 'N';
  const W = 100;
  const Df = 68;
  const DH = 38;
  const ST = 8;
  const wx = sn ? W : Df;
  const dy = sn ? Df : W;
  const working = node?.activity === 'working';
  const chairColor = node ? hslL(node.color, 0.5) : '#4a5560';

  const drawChair = () => chair(ctx, fit, lx - f[0] * (Df / 2 + 17), ly - f[1] * (Df / 2 + 17), dir, chairColor);
  const drawDeskMon = () => {
    for (const [sx, sy] of [
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
    ] as const) {
      box(ctx, fit, lx + sx * (wx / 2 - 6), ly + sy * (dy / 2 - 6), 8, 8, DH, '#6e4726');
    }
    box(ctx, fit, lx, ly, wx, dy, ST, WOOD, DH);
    monitor(ctx, fit, lx + f[0] * (Df / 2 - 12), ly + f[1] * (Df / 2 - 12), dir, working, DH + ST);
  };

  // Chair behind the desk for front/right facings; in front for back/left facings.
  if (dir === 'S' || dir === 'E') {
    drawChair();
    drawDeskMon();
  } else {
    drawDeskMon();
    drawChair();
  }
}

export interface SceneAnchors {
  heads: Map<string, Pt>;
  bases: Map<string, Pt>;
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
  items.push({ d: depth(NOOK.lx, NOOK.ly) - 1, fn: () => drawNook(ctx, fit) });
  for (const h of HUDDLES) items.push({ d: depth(h.lx, h.ly), fn: () => drawHuddle(ctx, fit, h) });
  items.push({ d: depth(ENTRANCE.lx, ENTRANCE.ly), fn: () => drawEntrance(ctx, fit) });

  for (const slot of DESK_SLOTS) {
    const name = slotMember.get(slot.id) ?? null;
    const node = name ? (byName.get(name) ?? null) : null;
    items.push({ d: depth(slot.lx, slot.ly), fn: () => drawWorkstation(ctx, fit, slot, node) });
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
    const a = project(ENTRANCE.lx - 34, ENTRANCE.ly - 56, fit);
    drawCountPill(ctx, { x: a.x, y: a.y - 66 * fit.scale }, `+${stripTotal - stripDrawn} waiting`, fit.scale);
  }
  if (nookTotal - nookDrawn > 0) {
    const a = project(NOOK.lx, NOOK.ly, fit);
    drawCountPill(ctx, { x: a.x, y: a.y - 52 * fit.scale }, `+${nookTotal - nookDrawn} away`, fit.scale);
  }

  return { heads, bases };
}

/**
 * Screen positions of the **monitors of working members** — where the Tier-A ambient glow sits (ADR 085).
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

/** Screen position of the break-nook coffee machine (the ambient steam source, ADR 085). */
export function coffeeAnchor(fit: Fit): Pt {
  const s = project(NOOK.lx - 58, NOOK.ly - 42, fit);
  return { x: s.x, y: s.y - 8 * fit.scale };
}

/** A transient act cue: a tinted ring + optional glyph (`ring`), a broadcast sweep (`wave`), or a glow
 * at the entrance when someone comes or goes (`door`). */
export interface Cue {
  at: Pt;
  color: string;
  glyph: '' | '?' | '!' | '📣' | '✓' | '↦';
  t: number;
  urgent: boolean;
  kind?: 'ring' | 'wave' | 'door';
}

export function drawCue(ctx: CanvasRenderingContext2D, cue: Cue, scale: number): void {
  const { at, color, t } = cue;

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
