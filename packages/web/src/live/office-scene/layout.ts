import { FLOOR } from './iso';
import type { Dir } from './types';

/**
 * The office floor plan. Anchors are logical floor coords (iso.ts, FLOOR=900).
 *
 * The 12 desks are grouped into **three pods of four** rather than scattered across the interior. A
 * loose grid of identical lone desks made a partly-full room read as a half-abandoned one: each empty
 * desk sat alone in the middle of nothing, so it read as missing furniture rather than as a colleague
 * who happens to be out. In a pod, an empty desk is a teammate's desk — the pod is the unit that reads
 * as occupied, and one person at a pod of four looks like an office, not a vacancy. Making the desks
 * *bigger* was the tempting alternative and is the wrong one: bigger desks only make the empty ones
 * louder.
 *
 * The pods leave the middle and the front of the floor open, and that space is programmed rather than
 * left as bare floor: a break nook (right), a huddle in the centre, a meeting table and a reception
 * area across the front, and wall pieces (bookshelves, plants, a printer) around the edges.
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
  /** Which pod this desk belongs to (index into `PODS`). */
  pod: number;
}

/**
 * A rug: a flat zone marker on the floor. Each one carries its own `shape`, `weave` and colours, because
 * a floor of identical tan rectangles reads as a rendering artefact rather than as furnishing — the rugs
 * are how you tell one zone from another at a glance, and identical rugs throw that away.
 *
 * `weave` paints *inside* the rug's own outline, so a pattern never leaks onto the floor:
 *  - `border` — an inset field in a second colour (a bound rug)
 *  - `stripes` — bands across the rug's short axis (a runner / a kilim)
 *  - `plain` — one flat field
 */
export interface Rug {
  shape: 'rect' | 'diamond';
  weave: 'plain' | 'border' | 'stripes';
  /** The rug's field colour, and the colour of its border/stripes. */
  fill: string;
  mark: string;
}

/**
 * A pod: four desks in two facing pairs, monitors inward against a shared privacy screen, seats on the
 * outside. `axis` is the axis the pairs face along — `'ns'` seats a pair to the north and a pair to the
 * south (so both north desks face **S**, toward the viewer); `'ew'` turns the pod a quarter-turn.
 *
 * Exactly one pod is `'ns'`, which is what keeps **exactly two desks facing the viewer**. A face — eyes,
 * a visor, a blink — is the one thing that makes a member read as a person rather than a coloured block,
 * so the room needs some; turning more of the floor toward the camera would make it a stage set.
 */
export interface Pod {
  id: number;
  cx: number;
  cy: number;
  axis: 'ns' | 'ew';
  /** The pod's floor rug — a zone marker under the whole cluster, seats included. With no divider to carry
   * it, the rug is the *only* thing that makes a pod a place: it is what lets a member say "the blue pod". */
  rug: Rug;
}

export const PODS: Pod[] = [
  {
    id: 0,
    cx: 240,
    cy: 220,
    axis: 'ns',
    rug: { shape: 'rect', weave: 'border', fill: '#93a9a4', mark: '#75908a' },
  },
  {
    id: 1,
    cx: 620,
    cy: 560,
    axis: 'ew',
    rug: { shape: 'rect', weave: 'stripes', fill: '#97a7b8', mark: '#7c8ca0' },
  },
  {
    id: 2,
    cx: 260,
    cy: 560,
    axis: 'ew',
    rug: { shape: 'rect', weave: 'border', fill: '#ab97a4', mark: '#8b7683' },
  },
];

/** Desk centre offsets from the pod centre: along the pairing axis, and across it (two desks per row). */
export const POD_ALONG = 40; // desk centre to pod centre, across the shared screen (68-deep desks → a 12 gap)
export const POD_ACROSS = 55; // the two desks of a row, side by side (100-wide desks → a 10 gap)
/**
 * No divider stands between the two rows, and that is a decision rather than an omission.
 *
 * A screen in the gap sits ~40 units *nearer the camera* than the back row's desks, so from this fixed
 * iso angle it is literally between you and their desktop. There is no painter order that shows both: sort
 * the screen at its own footprint and it paints over that row's monitors, keyboard and mug; sort it behind
 * them and their desk slab eats its lower half, so it reads as a broken half-panel. Every version of the
 * fix trades one of the two away — and a member's monitor (lit when they work, dark when they don't) is
 * load-bearing, while the divider is decor. So the divider goes.
 *
 * What makes a pod read as a pod is the desks facing each other across a shared rug, not a panel.
 */
export const POD_RUG = { along: 230, across: 250 };

/** The four desks of a pod, in pod-local order (north/west row first). */
function podDesks(pod: Pod): DeskSlot[] {
  const ns = pod.axis === 'ns';
  const near: Dir = ns ? 'S' : 'E'; // the row on the low side faces *into* the pod, i.e. toward +axis
  const far: Dir = ns ? 'N' : 'W';
  const at = (along: number, across: number, dir: Dir, i: number): DeskSlot => ({
    id: pod.id * 4 + i,
    lx: pod.cx + (ns ? across : along),
    ly: pod.cy + (ns ? along : across),
    dir,
    pod: pod.id,
  });
  return [
    at(-POD_ALONG, -POD_ACROSS, near, 0),
    at(-POD_ALONG, POD_ACROSS, near, 1),
    at(POD_ALONG, -POD_ACROSS, far, 2),
    at(POD_ALONG, POD_ACROSS, far, 3),
  ];
}

export const DESK_SLOTS: DeskSlot[] = PODS.flatMap(podDesks);

/** The break nook — where `away` members drift; also the broadcast megaphone spot. */
export const NOOK = { lx: 700, ly: 190 };

/** The nook rug's iso radius — furniture and the away cluster stay inside it. Roomy enough that the
 * lounge set + kitchenette can breathe with real gaps between pieces. */
export const NOOK_RUG_R = 192;

/** The nook's rug: the room's one big diamond, bound with a darker edge. */
export const NOOK_RUG: Rug = { shape: 'diamond', weave: 'border', fill: '#ce9256', mark: '#b2743c' };

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
  // (a nook plant used to sit at dx 112 — removed to thin the nook's right edge, which already has the
  // big floor plant at 830,330 and the right-wall bookshelf beside it.)
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
  rug: Rug;
  rugSize: number;
  poufs: [string, string, string];
}

/** One huddle space, in the clearing the three pods leave in the middle of the room. */
export const HUDDLES: Huddle[] = [
  {
    // Shifted east of the north pod's rug; the old centre overlapped that zone and made the huddle
    // look partially tucked beneath its desks.
    lx: 450,
    ly: 350,
    // A logical rectangle projects as an iso diamond on the floor. The former logical diamond projected
    // as a screen-space rectangle, which read like translucent panels attached to the poufs.
    // Softened toward the muted pod-rug treatment: a calmer clay field with a low-contrast border, so the
    // huddle rug seats onto the floor instead of popping forward like a floating slab.
    rug: { shape: 'rect', weave: 'border', fill: '#d4a483', mark: '#c69172' },
    rugSize: 168,
    poufs: ['#f06d5a', '#e3a72b', '#8b6fd6'],
  },
];

/** The meeting table in the front corner: a long table with four chairs, on its own rug. */
export const MEETING = {
  lx: 740,
  ly: 800,
  w: 170,
  d: 92,
  h: 30,
  /** Chair centres, as offsets — two down each long side. */
  chairs: [
    { dx: -52, dy: -72, dir: 'S' as Dir },
    { dx: 52, dy: -72, dir: 'S' as Dir },
    { dx: -52, dy: 72, dir: 'N' as Dir },
    { dx: 52, dy: 72, dir: 'N' as Dir },
  ],
  chairSize: 36,
  rug: { w: 300, d: 196, shape: 'rect', weave: 'stripes', fill: '#9aa886', mark: '#7e8c6b' },
} as const;

/**
 * Reception, in the left corner: the rug the entrance queue waits on, a waiting couch turned back toward
 * the door, and a low table. The queue strip (`ENTRANCE` + `STRIP_CAP`) already lands here, so this
 * dresses a space members genuinely stand in rather than adding a decorative island somewhere pretty.
 *
 * The pieces are the *same* couch and coffee table the break nook uses — a second furniture vocabulary
 * for one corner would read as a different building.
 */
export const RECEPTION = {
  // The rug keeps a clear band of bare floor between itself and pod 2's rug (which reaches ly 685). Two
  // rugs meeting edge-to-edge fuse into one big shapeless patch and both zones stop reading as zones —
  // the floor *between* rugs is what makes each one an area rather than a stain.
  rug: { lx: 170, ly: 800, w: 300, d: 170, shape: 'rect', weave: 'border', fill: '#c07a55', mark: '#9c5c3c' },
  /** Past the far end of the queue strip, facing back down it toward the door. */
  couch: { lx: 330, ly: 800, dir: 'W' as Dir },
  table: { lx: 258, ly: 800 },
  plant: { lx: 335, ly: 690 },
} as const;

/** The printer/supply station against the back wall. */
export const PRINTER = { lx: 390, ly: 60, w: 46, d: 34, h: 32 };

export interface Plant {
  lx: number;
  ly: number;
  species: 'snake' | 'fiddle';
}

/** Big floor plants — mostly on the perimeter, where they soften the wall edges and break up the bare
 * floor between zones without standing in a walking line. */
export const PLANTS: Plant[] = [
  { lx: 70, ly: 110, species: 'snake' },
  { lx: 480, ly: 55, species: 'fiddle' },
  { lx: 855, ly: 130, species: 'fiddle' },
  { lx: 60, ly: 640, species: 'fiddle' },
  { lx: 862, ly: 690, species: 'snake' },
  { lx: 380, ly: 870, species: 'fiddle' },
  { lx: 110, ly: 380, species: 'fiddle' }, // left flank, between the huddle and the wall
  { lx: 830, ly: 330, species: 'snake' }, // right flank, under the nook shelf
  { lx: 830, ly: 870, species: 'fiddle' }, // front corner, past the meeting table
];

/** A back-wall window, as a fraction along its wall's edge `[t0,t1]` and up the wall `[u0,u1]`.
 * Layout data (not paint): the daylight beams, and the cat's sunbeam nap spots, both derive from it. */
export interface Win {
  t0: number;
  t1: number;
  u0: number;
  u1: number;
}
/** Two windows per back wall — spaced so the wall reads as a facade, not a single porthole. */
export const WINDOWS: readonly Win[] = [
  { t0: 0.28, t1: 0.46, u0: 0.34, u1: 0.82 },
  { t0: 0.58, t1: 0.78, u0: 0.34, u1: 0.82 },
];

/** How far into the room a window's daylight beam reaches (logical units), and its sideways sun-shear. */
export const BEAM_LEN = 150;
export const BEAM_SHEAR = 46;

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
  { lx: 130, ly: SHELF_DEEP / 2, dir: 'S' }, // back wall, in the corner behind pod 0
  { lx: FLOOR - SHELF_DEEP / 2, ly: 320, dir: 'W' }, // right wall, below the lounge
  { lx: SHELF_DEEP / 2, ly: 240, dir: 'E' }, // left wall, beside pod 0
  { lx: SHELF_DEEP / 2, ly: 560, dir: 'E' }, // left wall, beside pod 2
];
