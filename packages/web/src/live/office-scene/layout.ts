import type { Dir } from './types';

/**
 * The office floor plan: 12 desk slots distributed across the interior + edges (mixed facings), a rich
 * break nook (back-right), a glass entrance (front-left), two huddle spaces, and big floor plants —
 * ported from the Figma "Floor Plan" frame. Anchors are logical floor coords (iso.ts, FLOOR=900).
 * Zones (nook / entrance / huddles) are kept clear of desks so the room reads uncluttered.
 */

/** Unit "forward" vector (logical dx,dy) for each facing — shared by drawing and the actor system. */
export const FWD: Record<Dir, [number, number]> = {
  S: [0, 1],
  N: [0, -1],
  E: [1, 0],
  W: [-1, 0],
};

/** Logical offset from a desk centre to where its member sits/stands (opposite the facing). */
export const SEAT_BACK = 40;

/** Desk slab footprint + task-chair geometry (logical) — shared by drawing (render.ts) and the
 * walkability grid (nav.ts) so walkers route around exactly what is drawn. */
export const DESK_W = 100;
export const DESK_D = 68;
export const CHAIR_SIZE = 34;
export const CHAIR_OFF = DESK_D / 2 + 17;

export interface DeskSlot {
  id: number;
  /** Desk centre (logical). */
  lx: number;
  ly: number;
  /** Which way the seated member faces — decides monitor + member draw order. */
  dir: Dir;
}

export const DESK_SLOTS: DeskSlot[] = [
  { id: 0, lx: 150, ly: 150, dir: 'S' },
  { id: 1, lx: 330, ly: 150, dir: 'S' },
  { id: 2, lx: 470, ly: 160, dir: 'E' },
  { id: 3, lx: 150, ly: 330, dir: 'E' },
  { id: 4, lx: 350, ly: 340, dir: 'N' },
  { id: 5, lx: 620, ly: 440, dir: 'N' },
  { id: 6, lx: 780, ly: 430, dir: 'W' },
  { id: 7, lx: 150, ly: 610, dir: 'N' },
  { id: 8, lx: 360, ly: 545, dir: 'N' },
  { id: 9, lx: 780, ly: 630, dir: 'W' },
  { id: 10, lx: 340, ly: 735, dir: 'S' },
  { id: 11, lx: 650, ly: 760, dir: 'N' },
];

/** The break nook — where `away` members drift; also the broadcast megaphone spot. */
export const NOOK = { lx: 700, ly: 190 };

/** The nook rug's iso radius — furniture and the away cluster stay inside it. Roomy enough that the
 * lounge set + kitchenette can breathe with real gaps between pieces. */
export const NOOK_RUG_R = 192;

/**
 * The lounge set, as *data* (offsets from NOOK, logical sizes) shared by drawing (render.ts) and
 * navigation (nav.ts) — so walkers route around exactly what is drawn. Sized to read proportionate to
 * the 100×68 desks: a real three-seat couch, full armchairs, a coffee table you could reach from them.
 * A conversation set (couch north · table centre · a chair to each side) sits in the front of the rug;
 * the kitchenette (fridge · counter+machine · water cooler) lines the back, well clear of the seating.
 */
export const LOUNGE = {
  // kitchenette across the back, spaced apart
  fridge: { dx: -110, dy: -48, w: 32, d: 28, h: 54 },
  counter: { dx: -54, dy: -76, w: 78, d: 24, h: 32 },
  machine: { dx: -74, dy: -76 },
  cooler: { dx: 42, dy: -82, w: 22, d: 22, h: 48 }, // water cooler
  plant: { dx: 112, dy: -46 },
  // conversation set in the front, with breathing room between each piece
  couch: { dx: 6, dy: 2, len: 108, dep: 44 }, // faces S (toward the room)
  table: { dx: 6, dy: 66, w: 56, d: 40 },
  chairE: { dx: -62, dy: 64, size: 52 }, // left of the table, facing it
  chairW: { dx: 72, dy: 64, size: 52 }, // right of the table, facing it
} as const;

/** Where the six visible `away` members stand — an arc on the rug around the lounge set's open (front)
 * side. Hand-placed (offsets from NOOK) so nobody stands inside the couch/armchairs/table/kitchenette. */
export const NOOK_SPOTS: ReadonlyArray<{ dx: number; dy: number }> = [
  { dx: -116, dy: 40 }, // west flank, beside the fridge
  { dx: -70, dy: 112 }, // front arc, south of the seating cluster
  { dx: -34, dy: 122 },
  { dx: 2, dy: 126 },
  { dx: 40, dy: 118 },
  { dx: 74, dy: 110 },
];

/** Where an ambient coffee-stroll pauses: standing just in front of the break-nook machine, facing it
 * (ADR 086 Phase 2). Clear of the lounge furniture and the seated nook cluster. */
export const COFFEE_STAND = { lx: NOOK.lx - 74, ly: NOOK.ly - 46 };

/** How many overflow-queue / nook avatars render individually before the rest collapse into a "+N" pill,
 * so a very large roster stays bounded instead of marching avatars off the floor. */
export const STRIP_CAP = 6;
export const NOOK_CAP = 6;

/** The glass entrance (front-left edge) — the enter/exit path endpoint + overflow strip anchor. */
export const ENTRANCE = { lx: 185, ly: 815 };

export interface Huddle {
  lx: number;
  ly: number;
  rug: string;
  poufs: [string, string, string];
}

/** One huddle space (was two — the second crowded the floor for no roster payoff). */
export const HUDDLES: Huddle[] = [
  { lx: 255, ly: 470, rug: '#7fb4aa', poufs: ['#f06d5a', '#e3a72b', '#8b6fd6'] },
];

export interface Plant {
  lx: number;
  ly: number;
  species: 'snake' | 'fiddle';
}

export const PLANTS: Plant[] = [
  { lx: 70, ly: 110, species: 'snake' },
  { lx: 470, ly: 55, species: 'fiddle' },
  { lx: 855, ly: 130, species: 'fiddle' },
  { lx: 60, ly: 720, species: 'fiddle' },
  { lx: 855, ly: 760, species: 'snake' },
  { lx: 540, ly: 855, species: 'fiddle' },
];

export interface Bookshelf {
  lx: number;
  ly: number;
  /** Which way the shelf's open (book) face points — set so it faces into the room. */
  dir: Dir;
}

/** Bookshelf footprint (logical): a slim unit that lines a wall — wide along the wall, shallow, tall. */
export const SHELF_LONG = 58;
export const SHELF_DEEP = 20;
export const SHELF_H = 66;

/** Freestanding bookshelves lining the open wall stretches between desks — warm decor, block nav. */
export const BOOKSHELVES: Bookshelf[] = [
  { lx: 250, ly: 58, dir: 'S' }, // back-left wall, between the top-row desks and the corner
  { lx: 858, ly: 320, dir: 'W' }, // right wall, above the lounge
  { lx: 56, ly: 470, dir: 'E' }, // left wall, beside the huddle
];
