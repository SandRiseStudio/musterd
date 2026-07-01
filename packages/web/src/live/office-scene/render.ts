import { depth, FLOOR, project, THICK, type Fit, type Pt } from './iso';
import { DESK_SLOTS, ENTRANCE, NOOK, PLANTS, type DeskSlot } from './layout';
import type { Placement } from './seating';
import type { Dir, OfficeNode } from './types';

/**
 * Canvas-2D drawing for the office (M1). Everything is drawn back-to-front (painter's order by logical
 * depth) so seated members sit correctly behind their desks and nearer pods overlap farther ones. The
 * static scene is baked once per data/resize; transient act cues are drawn on top each frame.
 */

const FWD: Record<Dir, [number, number]> = {
  S: [0, 1],
  N: [0, -1],
  E: [1, 0],
  W: [-1, 0],
};

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
/** Darken/lighten an `hsl()` string by a lightness factor (avatars use member `hsl` colours). */
function hslL(color: string, f: number): string {
  const m = /hsl\(\s*([-\d.]+),\s*([\d.]+)%,\s*([\d.]+)%\s*\)/.exec(color);
  if (!m) return color;
  return `hsl(${m[1]}, ${m[2]}%, ${Math.max(0, Math.min(100, Number(m[3]) * f))}%)`;
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
  quad(ctx, [dn(B, lo), dn(C, lo), dn(C, hi), dn(B, hi)], mul(base, 0.72));
  quad(ctx, [dn(D, lo), dn(C, lo), dn(C, hi), dn(D, hi)], mul(base, 0.86));
  quad(ctx, [dn(A, hi), dn(B, hi), dn(C, hi), dn(D, hi)], base);
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

function drawNook(ctx: CanvasRenderingContext2D, fit: Fit): void {
  rug(ctx, fit, NOOK.lx, NOOK.ly, 120, '#ce9256');
  box(ctx, fit, NOOK.lx, NOOK.ly - 44, 96, 30, 24, '#e3a72b'); // couch back+seat (chunky)
  box(ctx, fit, NOOK.lx, NOOK.ly + 34, 54, 40, 12, WOOD_TOP); // coffee table
}

function drawEntrance(ctx: CanvasRenderingContext2D, fit: Fit): void {
  rug(ctx, fit, ENTRANCE.lx, ENTRANCE.ly, 66, '#7a4e2d');
  // a simple glass doorway: two posts + a translucent panel
  box(ctx, fit, ENTRANCE.lx - 42, ENTRANCE.ly - 40, 8, 8, 92, '#7e6042');
  box(ctx, fit, ENTRANCE.lx + 42, ENTRANCE.ly - 40, 8, 8, 92, '#7e6042');
  const a = project(ENTRANCE.lx - 42, ENTRANCE.ly - 40, fit);
  const b = project(ENTRANCE.lx + 42, ENTRANCE.ly - 40, fit);
  const up = 92 * fit.scale;
  ctx.globalAlpha = 0.28;
  quad(ctx, [a, b, { x: b.x, y: b.y - up }, { x: a.x, y: a.y - up }], '#cfe7ee');
  ctx.globalAlpha = 1;
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
  box(ctx, fit, lx, ly, 22, 22, 16, '#b9603a');
  const top = { x: base.x, y: base.y - 16 * s };
  if (species === 'snake') {
    for (const [dx, h] of [
      [-11, 40],
      [-3, 50],
      [6, 44],
      [13, 34],
    ] as const) {
      ellipse(ctx, { x: top.x + dx * s, y: top.y - (h / 2) * s }, 5 * s, (h / 2) * s, '#3e6b3a');
    }
  } else {
    for (const [dx, dy] of [
      [-14, -40],
      [7, -46],
      [-2, -30],
    ] as const) {
      ellipse(ctx, { x: top.x + dx * s, y: top.y + dy * s }, 15 * s, 14 * s, '#6e9e52');
    }
  }
}

// ── avatar (M1 placeholder — Rive replaces this in M2) ───────────────────────
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
  // shadow
  ellipse(ctx, { x: p.x, y: p.y }, 24 * s, 6 * s, 'rgba(0,0,0,0.16)');
  // body
  roundRect(ctx, p.x - 19 * s, p.y - 44 * s, 38 * s, 32 * s, 12 * s, acc);
  // arms
  roundRect(ctx, p.x - 25 * s, p.y - 42 * s, 8 * s, 22 * s, 4 * s, dk);
  roundRect(ctx, p.x + 17 * s, p.y - 42 * s, 8 * s, 22 * s, 4 * s, dk);
  // head
  ellipse(ctx, { x: p.x, y: p.y - 56 * s }, 15 * s, 15 * s, SKIN);
  if (node.kind === 'agent') {
    // antenna + always-on status LED (the agent tell)
    ctx.strokeStyle = acc;
    ctx.lineWidth = 2 * s;
    ctx.beginPath();
    ctx.moveTo(p.x, p.y - 68 * s);
    ctx.lineTo(p.x, p.y - 78 * s);
    ctx.stroke();
    ellipse(ctx, { x: p.x, y: p.y - 80 * s }, 4 * s, 4 * s, '#74e08a');
    if (dir === 'S') {
      // visor
      roundRect(ctx, p.x - 11 * s, p.y - 61 * s, 22 * s, 8 * s, 4 * s, '#2e3a38');
    }
    ellipse(ctx, { x: p.x, y: p.y - 34 * s }, 4 * s, 4 * s, '#74e08a'); // chest LED
  } else {
    // hair (human tell)
    const hair = hslL(node.color, 0.42);
    ellipse(ctx, { x: p.x, y: p.y - 62 * s }, 16 * s, 8 * s, hair);
    if (dir === 'S') {
      ellipse(ctx, { x: p.x - 6 * s, y: p.y - 55 * s }, 2.4 * s, 2.4 * s, '#2e2a26');
      ellipse(ctx, { x: p.x + 6 * s, y: p.y - 55 * s }, 2.4 * s, 2.4 * s, '#2e2a26');
    }
  }
}

// ── a single workstation (desk + oriented monitor + seated member) ───────────
function drawWorkstation(
  ctx: CanvasRenderingContext2D,
  fit: Fit,
  slot: DeskSlot,
  node: OfficeNode | null,
): void {
  const { lx, ly, dir } = slot;
  const f = FWD[dir];
  const sn = dir === 'S' || dir === 'N';
  const W = 104;
  const Df = 70;
  const DH = 40;
  const ST = 8;
  const wx = sn ? W : Df;
  const dy = sn ? Df : W;
  const memX = lx - f[0] * (Df / 2 + 6);
  const memY = ly - f[1] * (Df / 2 + 6);

  const drawDesk = () => {
    // four legs
    for (const [sx, sy] of [
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
    ] as const) {
      box(ctx, fit, lx + sx * (wx / 2 - 6), ly + sy * (dy / 2 - 6), 8, 8, DH, '#6e4726');
    }
    box(ctx, fit, lx, ly, wx, dy, ST, WOOD, DH); // slab
  };
  const drawMonitor = () => {
    const mx = lx + f[0] * (Df / 2 - 12);
    const my = ly + f[1] * (Df / 2 - 12);
    box(ctx, fit, mx, my, sn ? 40 : 6, sn ? 6 : 40, 20, '#2a2e33', DH + ST);
    // screen glow — bright when working, dim when idle
    const glow = node && node.activity === 'working' ? '#59c3a3' : '#3a5450';
    const g = project(mx, my, fit);
    const up = (DH + ST + 18) * fit.scale;
    ellipse(ctx, { x: g.x, y: g.y - up }, 13 * fit.scale, 4 * fit.scale, glow);
  };
  const drawMember = () => {
    if (node) avatar(ctx, fit, memX, memY, node, dir);
  };

  const behind = dir === 'S' || dir === 'E';
  if (behind) {
    drawMember();
    drawDesk();
    drawMonitor();
  } else {
    drawDesk();
    drawMonitor();
    drawMember();
  }
}

export interface SceneAnchors {
  /** member name → head-top screen point (for HTML labels + act cues). */
  heads: Map<string, Pt>;
  /** member name → desk/base screen point. */
  bases: Map<string, Pt>;
}

/**
 * Draw the whole static office to `ctx` in painter's order, returning per-member screen anchors so the
 * caller can place name labels and act cues. `placements` maps member → seat; `byName` supplies the node.
 */
export function renderScene(
  ctx: CanvasRenderingContext2D,
  fit: Fit,
  placements: Map<string, Placement>,
  byName: Map<string, OfficeNode>,
): SceneAnchors {
  drawFloor(ctx, fit);

  // seat index → member (for desks)
  const slotMember = new Map<number, string>();
  const nookMembers: string[] = [];
  const stripMembers: string[] = [];
  for (const [name, pl] of placements) {
    if (pl.kind === 'desk') slotMember.set(pl.slot, name);
    else if (pl.kind === 'nook') nookMembers.push(name);
    else if (pl.kind === 'strip') stripMembers.push(name);
  }
  nookMembers.sort();
  stripMembers.sort();

  const heads = new Map<string, Pt>();
  const bases = new Map<string, Pt>();
  const s = fit.scale;

  interface Item {
    d: number;
    fn: () => void;
  }
  const items: Item[] = [];

  for (const plant of PLANTS) {
    items.push({ d: depth(plant.lx, plant.ly), fn: () => drawPlant(ctx, fit, plant.lx, plant.ly, plant.species) });
  }
  items.push({ d: depth(NOOK.lx, NOOK.ly) - 1, fn: () => drawNook(ctx, fit) });
  items.push({ d: depth(ENTRANCE.lx, ENTRANCE.ly), fn: () => drawEntrance(ctx, fit) });

  for (const slot of DESK_SLOTS) {
    const name = slotMember.get(slot.id) ?? null;
    const node = name ? (byName.get(name) ?? null) : null;
    items.push({ d: depth(slot.lx, slot.ly), fn: () => drawWorkstation(ctx, fit, slot, node) });
    if (name && node) {
      const f = FWD[slot.dir];
      const base = project(slot.lx - f[0] * 41, slot.ly - f[1] * 41, fit);
      bases.set(name, base);
      heads.set(name, { x: base.x, y: base.y - 74 * s });
    }
  }

  // away members clustered on the nook rug
  nookMembers.forEach((name, i) => {
    const node = byName.get(name);
    if (!node) return;
    const col = i % 3;
    const row = Math.floor(i / 3);
    const lx = NOOK.lx - 40 + col * 40;
    const ly = NOOK.ly + 20 + row * 34;
    items.push({ d: depth(lx, ly) + 0.5, fn: () => avatar(ctx, fit, lx, ly, node, 'S', true) });
    const base = project(lx, ly, fit);
    bases.set(name, base);
    heads.set(name, { x: base.x, y: base.y - 54 * s });
  });

  // overflow members queue near the entrance
  stripMembers.forEach((name, i) => {
    const node = byName.get(name);
    if (!node) return;
    const lx = ENTRANCE.lx - 70 + (i % 4) * 46;
    const ly = ENTRANCE.ly - 90 - Math.floor(i / 4) * 40;
    items.push({ d: depth(lx, ly), fn: () => avatar(ctx, fit, lx, ly, node, 'N', true) });
    const base = project(lx, ly, fit);
    bases.set(name, base);
    heads.set(name, { x: base.x, y: base.y - 54 * s });
  });

  items.sort((a, b) => a.d - b.d);
  for (const it of items) it.fn();

  return { heads, bases };
}

/** A transient act cue (M1: a tinted ring + optional glyph over a desk). */
export interface Cue {
  at: Pt;
  color: string;
  glyph: '' | '?' | '!' | '📣' | '✓' | '↦';
  t: number; // 0..1 progress
  urgent: boolean;
}

export function drawCue(ctx: CanvasRenderingContext2D, cue: Cue, scale: number): void {
  const { at, color, t } = cue;
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
