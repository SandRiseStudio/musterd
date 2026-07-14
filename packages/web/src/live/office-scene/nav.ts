import { FLOOR } from './iso';
import {
  BOOKSHELVES,
  CHAIR_OFF,
  CHAIR_SIZE,
  DESK_D,
  DESK_SLOTS,
  DESK_W,
  ENTRANCE,
  FWD,
  HUDDLES,
  LOUNGE,
  MEETING,
  NOOK,
  PLANTS,
  PRINTER,
  RECEPTION,
  SHELF_DEEP,
  SHELF_LONG,
} from './layout';

/**
 * Office navigation: a coarse walkability grid over the logical floor + A* with string-pulling, so
 * actors *navigate* the room instead of gliding through furniture. Solid pieces (desks + chairs, the
 * lounge set, huddle poufs/table, plants, the entrance posts) block; rugs are just paint — walkable.
 * Footprints derive from the same layout data render.ts draws, so the grid matches the picture.
 *
 * Everything is logical-space; callers get back a waypoint polyline whose first/last points are the
 * exact endpoints they asked for (endpoints inside a blocked zone — e.g. a desk seat — are fine: the
 * path steps out to the nearest free cell first, which reads as "getting up from the desk").
 */

export const CELL = 15;
const N = Math.round(FLOOR / CELL); // 60×60 cells
/** Half an avatar's body width — solid footprints inflate by this so bodies don't clip edges. */
const BODY_R = 14;

export interface P {
  lx: number;
  ly: number;
}

interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

function rect(lx: number, ly: number, w: number, d: number, pad = BODY_R): Rect {
  return { x0: lx - w / 2 - pad, y0: ly - d / 2 - pad, x1: lx + w / 2 + pad, y1: ly + d / 2 + pad };
}

/** Every solid footprint on the floor — mirrors what render.ts draws (rugs excluded: walkable). */
function solidRects(): Rect[] {
  const out: Rect[] = [];
  for (const slot of DESK_SLOTS) {
    const sn = slot.dir === 'S' || slot.dir === 'N';
    out.push(rect(slot.lx, slot.ly, sn ? DESK_W : DESK_D, sn ? DESK_D : DESK_W));
    const f = FWD[slot.dir];
    // the task chair sits behind the desk; pad it lightly so its own seat spot stays reachable
    out.push(rect(slot.lx - f[0] * CHAIR_OFF, slot.ly - f[1] * CHAIR_OFF, CHAIR_SIZE, CHAIR_SIZE, 4));
  }
  const L = LOUNGE;
  out.push(rect(NOOK.lx + L.fridge.dx, NOOK.ly + L.fridge.dy, L.fridge.w, L.fridge.d));
  out.push(rect(NOOK.lx + L.counter.dx, NOOK.ly + L.counter.dy, L.counter.w, L.counter.d));
  out.push(rect(NOOK.lx + L.cooler.dx, NOOK.ly + L.cooler.dy, L.cooler.w, L.cooler.d));
  out.push(rect(NOOK.lx + L.plant.dx, NOOK.ly + L.plant.dy, 26, 26));
  out.push(rect(NOOK.lx + L.couch.dx, NOOK.ly + L.couch.dy, L.couch.len, L.couch.dep));
  out.push(rect(NOOK.lx + L.table.dx, NOOK.ly + L.table.dy, L.table.w, L.table.d));
  out.push(rect(NOOK.lx + L.chairW.dx, NOOK.ly + L.chairW.dy, L.chairW.size, L.chairW.size));
  out.push(rect(NOOK.lx + L.chairE.dx, NOOK.ly + L.chairE.dy, L.chairE.size, L.chairE.size));
  for (const h of HUDDLES) {
    out.push(rect(h.lx, h.ly - 54, 44, 44)); // poufs (see huddleItems)
    out.push(rect(h.lx + 52, h.ly + 32, 44, 44));
    out.push(rect(h.lx - 52, h.ly + 32, 44, 44));
    out.push(rect(h.lx, h.ly, 66, 66)); // low table
  }
  out.push(rect(MEETING.lx, MEETING.ly, MEETING.w, MEETING.d));
  for (const c of MEETING.chairs) {
    out.push(rect(MEETING.lx + c.dx, MEETING.ly + c.dy, MEETING.chairSize, MEETING.chairSize, 4));
  }
  out.push(rect(RECEPTION.couch.lx, RECEPTION.couch.ly, LOUNGE.couch.dep, LOUNGE.couch.len)); // faces W
  out.push(rect(RECEPTION.table.lx, RECEPTION.table.ly, LOUNGE.table.w, LOUNGE.table.d));
  out.push(rect(RECEPTION.plant.lx, RECEPTION.plant.ly, 26, 26));
  out.push(rect(PRINTER.lx, PRINTER.ly, PRINTER.w, PRINTER.d));
  for (const p of PLANTS) out.push(rect(p.lx, p.ly, 26, 26));
  for (const s of BOOKSHELVES) {
    const sn = s.dir === 'S' || s.dir === 'N';
    out.push(rect(s.lx, s.ly, sn ? SHELF_LONG : SHELF_DEEP, sn ? SHELF_DEEP : SHELF_LONG));
  }
  // entrance door posts (the doorway between them stays open) — the door runs along the back-left wall,
  // so the posts straddle it in ly with the plane set back in −lx.
  out.push(rect(ENTRANCE.lx - 42, ENTRANCE.ly - 44, 10, 10, 6));
  out.push(rect(ENTRANCE.lx - 42, ENTRANCE.ly + 44, 10, 10, 6));
  return out;
}

let blockedGrid: Uint8Array | null = null;
function grid(): Uint8Array {
  if (blockedGrid) return blockedGrid;
  const g = new Uint8Array(N * N);
  for (const r of solidRects()) {
    const cx0 = Math.max(0, Math.floor(r.x0 / CELL));
    const cy0 = Math.max(0, Math.floor(r.y0 / CELL));
    const cx1 = Math.min(N - 1, Math.floor(r.x1 / CELL));
    const cy1 = Math.min(N - 1, Math.floor(r.y1 / CELL));
    for (let cy = cy0; cy <= cy1; cy++) for (let cx = cx0; cx <= cx1; cx++) g[cy * N + cx] = 1;
  }
  blockedGrid = g;
  return g;
}

/** Is this logical point walkable (inside the floor, not inside a solid footprint)? */
export function walkable(lx: number, ly: number): boolean {
  if (lx < 0 || ly < 0 || lx >= FLOOR || ly >= FLOOR) return false;
  return grid()[Math.floor(ly / CELL) * N + Math.floor(lx / CELL)] === 0;
}

const cellOf = (p: P): number => Math.floor(p.ly / CELL) * N + Math.floor(p.lx / CELL);
const centre = (c: number): P => ({
  lx: (c % N) * CELL + CELL / 2,
  ly: Math.floor(c / N) * CELL + CELL / 2,
});

/** Nearest free cell to `p` (spiral out) — start/goal may sit inside furniture (a desk seat). */
function nearestFree(p: P, blocked: (c: number) => boolean): number {
  const cx = Math.min(N - 1, Math.max(0, Math.floor(p.lx / CELL)));
  const cy = Math.min(N - 1, Math.max(0, Math.floor(p.ly / CELL)));
  for (let r = 0; r < N; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const x = cx + dx;
        const y = cy + dy;
        if (x < 0 || y < 0 || x >= N || y >= N) continue;
        const c = y * N + x;
        if (!blocked(c)) return c;
      }
    }
  }
  return cy * N + cx;
}

/** Straight-line clearance between two points (samples the grid) — used for string-pulling. */
function clear(a: P, b: P, blocked: (c: number) => boolean): boolean {
  const d = Math.hypot(b.lx - a.lx, b.ly - a.ly);
  const steps = Math.max(1, Math.ceil(d / (CELL / 3)));
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const lx = a.lx + (b.lx - a.lx) * t;
    const ly = a.ly + (b.ly - a.ly) * t;
    if (lx < 0 || ly < 0 || lx >= FLOOR || ly >= FLOOR) return false;
    if (blocked(Math.floor(ly / CELL) * N + Math.floor(lx / CELL))) return false;
  }
  return true;
}

/**
 * Route from → to around the furniture (and around `avoid` — other members' standing spots, softened
 * near the endpoints so a seat neighbour never walls off a seat). Returns a waypoint polyline whose
 * ends are the *exact* endpoints; a straight [from, to] when routing is unnecessary or impossible.
 */
export function findPath(from: P, to: P, avoid: P[] = []): P[] {
  const g = grid();
  // Other members block a small disc around where they stand — except near this trip's endpoints.
  const soft = new Set<number>();
  for (const a of avoid) {
    if (Math.hypot(a.lx - from.lx, a.ly - from.ly) < CELL * 3) continue;
    if (Math.hypot(a.lx - to.lx, a.ly - to.ly) < CELL * 3) continue;
    const cx = Math.floor(a.lx / CELL);
    const cy = Math.floor(a.ly / CELL);
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const x = cx + dx;
        const y = cy + dy;
        if (x >= 0 && y >= 0 && x < N && y < N) soft.add(y * N + x);
      }
    }
  }
  const blocked = (c: number): boolean => g[c] === 1 || soft.has(c);

  if (clear(from, to, blocked)) return [from, to];

  const start = g[cellOf(from)] === 1 || soft.has(cellOf(from)) ? nearestFree(from, blocked) : cellOf(from);
  const goal = g[cellOf(to)] === 1 || soft.has(cellOf(to)) ? nearestFree(to, blocked) : cellOf(to);
  if (start === goal) return [from, to];

  // A* (8-connected, no corner cutting), octile heuristic.
  const open = new Map<number, number>(); // cell → f
  const gScore = new Map<number, number>();
  const came = new Map<number, number>();
  const h = (c: number): number => {
    const dx = Math.abs((c % N) - (goal % N));
    const dy = Math.abs(Math.floor(c / N) - Math.floor(goal / N));
    return Math.max(dx, dy) + 0.4142 * Math.min(dx, dy);
  };
  gScore.set(start, 0);
  open.set(start, h(start));
  const DIRS = [
    [1, 0, 1],
    [-1, 0, 1],
    [0, 1, 1],
    [0, -1, 1],
    [1, 1, 1.4142],
    [1, -1, 1.4142],
    [-1, 1, 1.4142],
    [-1, -1, 1.4142],
  ] as const;

  let found = false;
  let guard = N * N * 4;
  while (open.size && guard-- > 0) {
    let cur = -1;
    let best = Infinity;
    for (const [c, f] of open) {
      if (f < best) {
        best = f;
        cur = c;
      }
    }
    if (cur === goal) {
      found = true;
      break;
    }
    open.delete(cur);
    const cx = cur % N;
    const cy = Math.floor(cur / N);
    for (const [dx, dy, cost] of DIRS) {
      const x = cx + dx;
      const y = cy + dy;
      if (x < 0 || y < 0 || x >= N || y >= N) continue;
      const nc = y * N + x;
      if (blocked(nc)) continue;
      // no cutting a corner diagonally past a blocked cell
      if (dx !== 0 && dy !== 0 && (blocked(cy * N + x) || blocked(y * N + cx))) continue;
      const t = gScore.get(cur)! + cost;
      if (t < (gScore.get(nc) ?? Infinity)) {
        gScore.set(nc, t);
        came.set(nc, cur);
        open.set(nc, t + h(nc));
      }
    }
  }
  if (!found) return [from, to]; // walled in — degrade to the old straight glide rather than strand

  const cells: number[] = [goal];
  for (let c = goal; came.has(c); ) {
    c = came.get(c)!;
    cells.push(c);
  }
  cells.reverse();

  // String-pull: exact endpoints + the fewest cell-centre waypoints that keep every segment clear.
  const pts: P[] = [from, ...cells.map(centre), to];
  const out: P[] = [from];
  let i = 0;
  while (i < pts.length - 1) {
    let j = pts.length - 1;
    // the first/last hops may start/end inside furniture (a seat) — always allow the adjacent hop
    for (; j > i + 1; j--) if (clear(pts[i]!, pts[j]!, blocked)) break;
    out.push(pts[j]!);
    i = j;
  }
  return out;
}
