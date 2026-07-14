import { FLOOR } from './iso';
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
/** The chair sits directly under the seat point, not behind it — a member seated at `SEAT_BACK` lands on
 * the seat rather than hovering in front of it. (Seat 40 back, chair centred 42 back: pelvis on cushion.) */
export const CHAIR_OFF = 42;

// ── Seat and desk heights ─────────────────────────────────────────────────────────────────────────────
// These decide whether a seated member reads as *at* the desk or *buried behind* it, so they are derived
// from each other rather than hand-tuned in isolation. The reference is the human one: a desk sits about a
// hand's-breadth above the seated hip, and the seated shoulder clears it comfortably. Before this the desk
// stood 46 units tall against a 92-unit character — taller than a seated person's shoulders — which is why
// only the tops of their heads showed above it.

/** Chair seat: how far the legs hold the cushion off the floor, and the cushion's own thickness. */
export const CHAIR_LIFT = 10;
export const CHAIR_SEAT_H = 12;
/** Top of the cushion — where a seated pelvis rests (see `skeleton.ts`). */
export const SEAT_TOP = CHAIR_LIFT + CHAIR_SEAT_H;

/** Desk: leg height + slab thickness. The surface lands ~14 above the seated hip — desk-height, by eye. */
export const DESK_LEG_H = 29;
export const DESK_SLAB = 7;
/** The desk surface — where every prop sits and where seated forearms come to rest. */
export const DESK_UP = DESK_LEG_H + DESK_SLAB;

/** How far behind the desk centre the keyboard sits. Within a seated member's arm reach *by construction*:
 * `skeleton.ts`'s `DESK_REACH.z` is `SEAT_BACK − KEYBOARD_ALONG`, so tucking the chair in moves the hands
 * with it instead of leaving them grasping at air. */
export const KEYBOARD_ALONG = -14;

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
  // Two of the interior desks face **S** (toward the viewer) on purpose. Most of the floor faces away, so
  // most of the team showed you the back of their head — and a face (eyes, visor, a blink) is the single
  // thing that makes a member read as a person rather than a coloured block. Kept to two: turning the
  // whole floor toward the camera would make the room read as a stage set rather than an office.
  { id: 4, lx: 350, ly: 340, dir: 'S' },
  { id: 5, lx: 620, ly: 440, dir: 'N' },
  { id: 6, lx: 780, ly: 430, dir: 'W' },
  { id: 7, lx: 150, ly: 610, dir: 'N' },
  { id: 8, lx: 520, ly: 560, dir: 'S' },
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

/** The glass entrance, set flush into the back-left floor edge (lx≈0) — the enter/exit path endpoint +
 * overflow strip anchor. `lx` is the mat centre just inside the doorway; the door plane sits ~42 back. */
export const ENTRANCE = { lx: 47, ly: 815 };

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

/** Freestanding bookshelves flush to the open wall stretches (back of footprint on the perimeter,
 * same pattern as the entrance door) — warm decor, block nav. */
export const BOOKSHELVES: Bookshelf[] = [
  { lx: 250, ly: SHELF_DEEP / 2, dir: 'S' }, // back wall, between the top-row desks and the corner
  { lx: FLOOR - SHELF_DEEP / 2, ly: 320, dir: 'W' }, // right wall, above the lounge
  { lx: SHELF_DEEP / 2, ly: 470, dir: 'E' }, // left wall, beside the huddle
];
