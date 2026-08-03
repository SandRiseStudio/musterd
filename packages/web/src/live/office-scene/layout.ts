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
 * left as bare floor: a break nook (right), a meeting table and a reception area across the front, and
 * wall pieces (bookshelves, plants, a printer) around the edges.
 *
 * **2026-08-02 — the floor is being re-cut for twenty desks.** The huddle space in the middle is gone,
 * the nook lost its armchairs, the meeting table shrank and reception became a small counter with two
 * waiting chairs. Every one of those was floor spent on furniture that seated one or two people; the
 * middle they free is where the extra desks go.
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
  /** Which pod this desk belongs to (index into `PODS`) — `-1` for bench and window desks. */
  pod: number;
  /**
   * Which desk species this is (2026-08-02, scaling to twenty seats). A `pod` desk is the full
   * workstation; `bench` seats share one wall counter and face the wall (heads-down focus — the one
   * arrangement where backs to the room is the honest read); a `window` desk stands alone off the
   * right wall, facing the room with the window light behind it.
   */
  kind: 'pod' | 'bench' | 'window';
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
  /** Four desks (two facing pairs) or two (one facing pair) — the 2026-08-02 re-cut mixes sizes so
   * the room reads grown-organically rather than stamped from a grid. */
  size: 1 | 2 | 4;
  /** The pod's floor rug — a zone marker under the whole cluster, seats included. With no divider to carry
   * it, the rug is the *only* thing that makes a pod a place: it is what lets a member say "the blue pod". */
  rug: Rug;
}

export const PODS: Pod[] = [
  {
    id: 0,
    cx: 215,
    // The band under the bench is the constraint above (north seats must clear MIN_SPOT_GAP from the
    // bench chairs) and pod 2's pads the one below. 255 sits in the middle of that pocket instead of
    // against its south edge. (255 was tried on 2026-08-03 and fails: at that latitude the north
    // seats' stand-behind floor lands in the bench chairs' grid cells.)
    cy: 290,
    axis: 'ns',
    size: 4,
    rug: { shape: 'rect', weave: 'border', fill: '#93a9a4', mark: '#75908a' },
  },
  {
    // The room's other quad. It sat at (620, 570) hard against the right column and was the hub of
    // the last crowding: 18 units to the meeting rug, 21 to one window desk, 31 to the other. West
    // into the middle is where the space is — the huddle, the centre duo and pod 3's second desk all
    // came out of that band, and nothing had moved in to use it.
    id: 1,
    cx: 560,
    cy: 545,
    axis: 'ew',
    size: 4,
    rug: { shape: 'rect', weave: 'stripes', fill: '#97a7b8', mark: '#7c8ca0' },
  },
  {
    // The old third quad, cut to a duo (2026-08-02). 2026-08-03: pulled west and north into the left
    // column — the room now reads as three columns (left desks / centre desks / nook+pod1 right).
    id: 2,
    cx: 245,
    cy: 560,
    axis: 'ew',
    size: 2,
    rug: { shape: 'rect', weave: 'border', fill: '#ab97a4', mark: '#8b7683' },
  },
  {
    // Upper-centre, in the clearing the huddle left. 'ew' is load-bearing: an 'ns' pod here would add
    // a third viewer-facing desk and break the exactly-two rule pod 0 carries.
    //
    // A DUO until 2026-08-03, now a solo — the one desk this round spends. It was the lounge's west
    // wall, 13 units off the nook's rug, and it could not move: a duo's two seats put their
    // stand-behind floor on OPPOSITE sides, so it needed ~350 units of width in a band that had ~190.
    // One desk needs that clearance on one side only, which is what let it move 45 west and hand the
    // lounge a 55-unit margin where it had 13.
    id: 3,
    cx: 455,
    cy: 250,
    axis: 'ew',
    size: 1,
    rug: { shape: 'rect', weave: 'stripes', fill: '#a8ab8e', mark: '#8c9070' },
  },
];

/*
 * There is no pod 4. The centre duo that stood at (350, 700) is gone with the 2026-08-03 declutter:
 * the floor drops 20 → 18 desks, and this is the cluster that bought the most room per seat removed.
 * It was the piece with the least air around it — 20 units to the meeting rug, 25 to reception's —
 * and it stood in the front strip, which is the one band the door has to cross to reach anything.
 */

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
/** A duo's rug — the facing pair sits on the pod's axis, so the rug is narrow across it. The 170
 * along is what lets the front duo fit between reception's rug and the meeting zone's. */
export const POD_RUG_DUO = { along: 170, across: 140 };
/** A solo's rug — one desk's worth, and no bigger: the whole point of a solo is the floor it gives back. */
export const POD_RUG_SOLO = { along: 130, across: 120 };

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
    kind: 'pod',
  });
  if (pod.size === 1) {
    // The desk sits ON the pod centre and faces `near`, so its seat — and the 60 units of floor the
    // occupant needs to push back and stand — land on the side AWAY from whatever this pod was moved
    // to make room for.
    return [at(0, 0, near, 0)];
  }
  if (pod.size === 2) {
    // One facing pair on the pod's axis. Ids keep the *4 stride (0 and 2), so a duo's desks hash to
    // the same props/chair-styles they would as the corresponding quad rows — and ids stay unique.
    return [at(-POD_ALONG, 0, near, 0), at(POD_ALONG, 0, far, 2)];
  }
  return [
    at(-POD_ALONG, -POD_ACROSS, near, 0),
    at(-POD_ALONG, POD_ACROSS, near, 1),
    at(POD_ALONG, -POD_ACROSS, far, 2),
    at(POD_ALONG, POD_ACROSS, far, 3),
  ];
}

/**
 * The back-wall bench (2026-08-02): one long counter under the windows, four seats, sitters facing
 * the wall. Backs to the room is a real cost here — a face is what makes a member a person — and it
 * is paid deliberately: the bench is the room's heads-down row, and turned backs are the honest way
 * to draw that. The window desks below are the counterweight (they face the room).
 *
 * `lx` had to thread a needle: bookshelf 0 ends at x≈152, the kitchenette's fridge starts at 568,
 * and pod 0 slid south (cy 220 → 300) specifically so bench chairs at ly≈104 clear its north-row
 * seats by a full MIN_SPOT_GAP. The printer moved out of the run (it stood at lx 390, mid-bench).
 */
export const BENCH = { lx: 320, ly: 62, long: 300, deep: 30, seats: 4, dir: 'N' as Dir };

/**
 * The two standalone window desks on the right flank — facing the ROOM, window light behind them.
 *
 * They stand ~60 off the wall rather than flush against it, and that is forced, not styled: the
 * navigability invariant demands 60 units of open floor behind every seat (the "push the chair back
 * and stand" test), and a room-facing seat flush to the wall has the wall there instead. The float
 * also happens to be the better picture — a desk pulled out from the window reads as an earned
 * corner office, where a flush one reads as furniture pushed out of the way.
 */
export const WINDOW_DESKS: ReadonlyArray<{ lx: number; ly: number; dir: Dir }> = [
  // Both on the right wall, separated in `ly` so neither footprint reaches pod 1's rug (they used to
  // run 9 units under it). They are NOT split one-per-wall, which was tried on 2026-08-03 and is not
  // possible: a room-facing desk seats its occupant on the WALL side, so the left wall would need
  // ~150 units of clear floor for desk + seat + stand-behind, and that band is pod 0's rug at the top,
  // reception at the bottom and the door posts in between. The one built there measured a 5.6x detour
  // from the door — a seat nobody could reach without crossing the whole room first.
  { lx: 776, ly: 390, dir: 'W' },
  { lx: 776, ly: 760, dir: 'W' },
];

const benchSlots: DeskSlot[] = Array.from({ length: BENCH.seats }, (_, i) => ({
  id: PODS.length * 4 + i,
  lx: BENCH.lx - BENCH.long / 2 + (i + 0.5) * (BENCH.long / BENCH.seats),
  ly: BENCH.ly,
  dir: BENCH.dir,
  pod: -1,
  kind: 'bench' as const,
}));

const windowSlots: DeskSlot[] = WINDOW_DESKS.map((w, i) => ({
  id: PODS.length * 4 + BENCH.seats + i,
  lx: w.lx,
  ly: w.ly,
  dir: w.dir,
  pod: -1,
  kind: 'window' as const,
}));

/** Every seat on the floor: pods first (so ids 0..11 stay the pod desks), then bench, then window. */
export const DESK_SLOTS: DeskSlot[] = [...PODS.flatMap(podDesks), ...benchSlots, ...windowSlots];

/** The break nook — where `away` members drift; also the broadcast megaphone spot.
 *
 * (700,190) → (740,180) → (725,185). The middle step shoved it east to escape pod 3's rug and left it
 * 18 units off the east wall and 38 off the north — boxed on all four sides at once (13/24/18/38).
 * Pod 3 becoming a solo desk is what let it come back off the walls. */
export const NOOK = { lx: 725, ly: 175 };

/** The nook rug's iso radius — furniture and the away cluster stay inside it. Shrunk 192 → 148 with
 * the armchairs it was sized around (2026-08-02): the rug only needs to cover the kitchenette run and
 * the couch now, and a rug much wider than its furniture reads as a stain rather than a zone.
 * 142 → 150 once pod 3 stopped crowding it.
 *
 * It is sized to the SEATING — couch, coffee table, and the arc of away members — and NOT to the
 * kitchenette, which stands proud of it on bare floor. That is deliberate and it is why this rug can
 * stay modest: the run is 200 units wide sitting 70 back from centre, so a diamond that reached its
 * far corner would need r≈195 and would swallow the whole corner of the room. Nobody puts a rug under
 * a kitchen counter anyway. */
export const NOOK_RUG_R = 150;

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
  // Kitchenette across the back, spaced apart.
  //
  // Sized against the desks, not against itself (nick, 2026-07-30: "the scale of the sink and that
  // kitchenette is off — it's a little small compared to the rest of the office space"). A desk is
  // 100 x 68; a 78-wide counter beside it read as a side table with a bowl on it. The run now grows
  // to the RIGHT — the left end is pinned by the fridge, and extending that way would have buried it.
  fridge: { dx: -104, dy: -44, w: 36, d: 30, h: 72 },
  counter: { dx: -30, dy: -70, w: 120, d: 30, h: 34 },
  machine: { dx: -71, dy: -70 },
  cooler: { dx: 42, dy: -76, w: 26, d: 26, h: 52 }, // water cooler
  // (a nook plant used to sit at dx 112 — removed to thin the nook's right edge, which already has the
  // big floor plant at 830,330 and the right-wall bookshelf beside it.)
  // Conversation set in the front. The gaps are the point: a coffee table sits a stride from a couch,
  // not against it, and the old 64-unit centre spacing put the table's edge within a few units of the
  // couch front (couch dep 44, table d 40 — 42 units of furniture across a 64-unit gap).
  couch: { dx: 6, dy: -4, len: 108, dep: 44 }, // faces S (toward the room)
  table: { dx: 6, dy: 86, w: 56, d: 40 },
  // The chairs stay where they were. Pushing them out with the table walked chairW into a reading
  // spot (MIN_SPOT_GAP) and put an away member's stand point on furniture — the gap this set needed
  // was between the couch and the table, and widening everything just moved the crowding outward.
  // The chairs do not move. Pushing them out with the table walked chairW into a reading spot
  // (MIN_SPOT_GAP) and closed the aisle behind them onto the away members' stand points — the gap
  // this set actually needed was between the couch and the table, and widening everything else just
  // moved the crowding outward into the arc of people standing behind it.
  // The two armchairs are GONE with the 2026-08-02 downsizing. They were the nook's widest pieces and
  // the reason its rug had to be 192 — and a lounge set for three is more seating than a break nook
  // needs once the floor has twenty desks competing for the same square units. The couch stays: it is
  // what makes the corner read as a place to sit rather than a kitchen.
} as const;

/** Where the six visible `away` members stand — an arc on the rug around the lounge set's open (front)
 * side. Hand-placed (offsets from NOOK) so nobody stands inside the couch/armchairs/table/kitchenette. */
export const NOOK_SPOTS: ReadonlyArray<{ dx: number; dy: number }> = [
  // Re-placed for the 148 rug (2026-08-02). The old arc sat as far out as |dx|+|dy| = 184, which was
  // inside the 192 rug and is well outside this one — an away member standing off the rug reads as
  // someone who wandered out of the nook rather than someone in it. Pulled into a tighter horseshoe
  // that still clears the couch (x -48..60, y -26..18) and the coffee table (x -22..34, y 54..94).
  { dx: -100, dy: 8 }, // west flank, south of the fridge
  { dx: -78, dy: 58 }, // southwest corner of the set
  { dx: -58, dy: 78 }, // front arc, clear of the coffee table's west corner
  { dx: 10, dy: 134 },
  { dx: 74, dy: 62 }, // southeast corner
  { dx: 96, dy: 14 }, // east flank, below the cooler
];

/** Where an ambient coffee-stroll pauses: standing just in front of the break-nook machine, facing it
 * (ADR 086 Phase 2). Clear of the lounge furniture and the seated nook cluster. */
export const COFFEE_STAND = { lx: NOOK.lx - 74, ly: NOOK.ly - 46 };

/** The kitchenette sink's spot on the counter (centre-run, between the machine and the bean bag) —
 * shared by the counter painter and the fridge errand's plate drop-off. */
export const SINK = { dx: -49, dy: -70 };

// ── errand stand points (ADR 086 Phase 3: purposeful errands) ─────────────────────────────────────────
// Each is where the walker *stands* during the errand's dwell, just clear of the appliance's inflated
// nav footprint (`nav.solidRects` pads by the body radius), facing it ('N' — the kitchenette lines the
// nook's back edge). Endpoints inside a blocked cell would get nudged by `nearestFree`, so standing
// clear keeps the dwell exactly where the leg says it is.
/** In front of the fridge, for the open-and-browse dwell. */
export const FRIDGE_STAND = { lx: NOOK.lx + LOUNGE.fridge.dx, ly: NOOK.ly + LOUNGE.fridge.dy + 44 };
/** In front of the water cooler, for the bottle-fill dwell. */
export const COOLER_STAND = { lx: NOOK.lx + LOUNGE.cooler.dx, ly: NOOK.ly + LOUNGE.cooler.dy + 34 };
/** In front of the counter sink, where an empty plate is set down. */
export const SINK_STAND = { lx: NOOK.lx + SINK.dx, ly: NOOK.ly + LOUNGE.counter.dy + 38 };

/** How many overflow-queue / nook avatars render individually before the rest collapse into a "+N" pill,
 * so a very large roster stays bounded instead of marching avatars off the floor. */
export const STRIP_CAP = 6;
export const NOOK_CAP = 6;

/** The glass entrance, set flush into the back-left floor edge (lx≈0) — the enter/exit path endpoint +
 * overflow strip anchor. `lx` is the mat centre just inside the doorway; the door plane sits ~42 back. */
export const ENTRANCE = { lx: 47, ly: 815 };

/*
 * The huddle space is GONE (nick, 2026-08-02: "the huddle space in the middle, I'm not in love with
 * it"). It was three poufs and a low table on a clay rug at (450, 350), and it cost the room the one
 * thing this floor is now short of: middle. The desks are going from twelve to twenty, and the
 * clearing the huddle sat in is where the new clusters go.
 *
 * Its three leisure spots are not simply lost — the reception waiting chairs take over that job (see
 * `RECEPTION` and `LEISURE_SPOTS`), which keeps four interleaved leisure zones rather than three.
 */

/**
 * The meeting table in the front corner: a long table with four chairs, on its own rug.
 *
 * **Chairs down one long side and one at each end**, not two down each side — because the front strip
 * of floor is shallower than a both-sides table needs. Between the pod rugs (which reach ly 685) and
 * the floor's edge at 900 there are ~215 units, and seating two rows with a body-width aisle behind
 * each wants ~240. The old both-sides arrangement fitted only by giving its south row no floor to
 * stand on: those two chairs were seats nobody could walk to, and a member placed in one slid through
 * the table to reach it. Ends instead, shifted west for room to pull the east chair out — same four
 * seats, all of them approachable, and a head seat at each end reads more like a meeting anyway.
 */
export const MEETING = {
  // 700 → 580 → 500. Each step west has been paying for the same thing: the front-right corner was
  // carrying the meeting zone AND a standalone window desk AND the bottom of pod 1, and 21 units
  // between a rug and a desk is not a gap, it is a collision that happens to miss. At 500 the corner
  // holds one desk, and the meeting rug is 101 units clear of it.
  lx: 500,
  ly: 805,
  // Downsized 170×92 → 150×80 (2026-08-02), and no further — this table's size is pinned by its SEATS,
  // not by taste. Shrinking it pulls the head chairs inward, and a head chair that closes on the
  // near side chair collapses the two into one smeared avatar on screen (the exact failure `MIN_SPOT_GAP`
  // exists to catch; at 130 wide the pair measured 47 against a floor of 52). Most of the floor this
  // zone gives back comes from its rug, which shrank much harder.
  w: 150,
  d: 80,
  h: 30,
  /**
   * Chair centres, as offsets — two along the room side, one at each head.
   *
   * The side pair sits tucked in toward the middle and the heads are pushed well out, so that the
   * near-side chair and the near head don't collapse into one another on screen. The 2:1 iso squashes
   * `ly`, and a side chair diagonally adjacent to a head reads as a single smeared avatar long before
   * the floor plan suggests it would (`MIN_SPOT_GAP`, held by layout.test.ts).
   */
  chairs: [
    { dx: -40, dy: -72, dir: 'S' as Dir },
    { dx: 40, dy: -72, dir: 'S' as Dir },
    { dx: -124, dy: 0, dir: 'E' as Dir },
    { dx: 124, dy: 0, dir: 'W' as Dir },
  ],
  chairSize: 36,
  rug: { w: 250, d: 175, shape: 'rect', weave: 'stripes', fill: '#9aa886', mark: '#7e8c6b' },
} as const;

/**
 * Reception, in the left corner: the rug the entrance queue waits on, two waiting chairs turned back
 * toward the door, and an end table between them. The queue strip (`ENTRANCE` + `STRIP_CAP`) already
 * lands here, so this dresses a space members genuinely stand in rather than adding a decorative
 * island somewhere pretty.
 *
 * **A waiting room, not a second lounge** (nick, 2026-08-02). It used to borrow the break nook's
 * three-seat couch and coffee table, which was the right instinct — one furniture vocabulary for the
 * building — carried one size too far: a couch that big made the corner read as a second lounge
 * competing with the real one, and it ate the floor the cubicles needed. Two chairs and an end table
 * say "wait here a moment" instead of "settle in", in a fraction of the footprint.
 */
export const WAIT_CHAIR = 34;
export const END_TABLE = 26;
export const RECEPTION = {
  // Smaller again (260x165 -> 210x125) and pulled into the corner. The rug's east edge is what sets
  // the lane: at 290 it left 15 units to the front duo's rug, which is not a walkway, it is a gap.
  // At 255 there are 110 clear units between this rug and the meeting rug, and that band runs
  // unbroken from the door to the middle of the room.
  rug: { lx: 140, ly: 810, w: 200, d: 120, shape: 'rect', weave: 'border', fill: '#c07a55', mark: '#9c5c3c' },
  // ONE chair now (2026-08-03), on the rug's SOUTH EDGE facing north into the room. `ly` is the
  // load-bearing number: the door is at ly 815, so anything whose padded footprint reaches that band
  // walls the entrance off from the room — at 838 you could not walk a single step east out of the
  // door. 856 keeps the chair's cells clear of the doorway's.
  //
  // A waiting room with two chairs was still furnishing for a queue this room does not form; one
  // chair and a magazine table says the same thing and gives the corner back its floor.
  chair: { lx: 205, ly: 856, dir: 'N' as Dir },
  /** Beside it, where a magazine would go. */
  endTable: { lx: 152, ly: 860 },
  // Off the lane entirely, at the rug's south-east corner — a corner piece, not a bollard.
  plant: { lx: 268, ly: 872 },
} as const;

/**
 * The front desk (reception design 2026-07-30): a counter on the reception rug, facing the arrivals
 * path, anchoring the couch/table/plant cluster that used to wait for nothing. The receptionist
 * stands NORTH of the counter — smaller lx+ly, so the counter paints in front of her and occludes
 * her lower body, which is what makes a figure behind a desk read as behind it. The check-in marks
 * sit SOUTH, on the walk path, side by side: simultaneous arrivals check in **in parallel**, never
 * as a queue — the beat is ceremony, and ceremony that queues is the gate the design rejected.
 */
// Sized against the DESKS, not against itself. It was 88x30x34 next to 100x68x36 workstations, which
// read as a hall table (nick, 2026-07-30: "the front desk is very small compared to the rest of the
// desks"). A reception counter is a shade wider and shallower than a workstation, at the same height.
//
// Trimmed 108x62 → 92x50 on 2026-08-02, which is NOT a walk-back of that fix: it stays at desk HEIGHT
// and reads as a counter, it just stops matching a workstation's full footprint. What forced it is the
// crowding nick reported — the counter's south face sat within a few units of the cubicle rug behind
// it, and every unit here is one the reception area gets back.
//
// 2026-08-03: (112, 690) → (95, 745) → (165, 742). The first move tucked it into the corner beside
// the door; the second pushes it back off the door, because a counter that close to the entrance
// reads as blocking the way in rather than greeting it (nick: "a tiny bit further to the right").
// The receptionist still stands north of it and the check-in marks still land south.
export const FRONT_DESK = { lx: 165, ly: 742, long: 92, deep: 50, high: DESK_UP, dir: 'S' as Dir };
/** She sits behind it exactly like a member sits at a desk — same SEAT_BACK, same chair, same size. */
export const RECEPTIONIST = { lx: FRONT_DESK.lx, ly: FRONT_DESK.ly - SEAT_BACK, dir: 'S' as Dir };
// South of the overflow queue strip, not across it: the counter grew to desk scale and pushed both
// the strip and the marks apart. A mark inside a blocked cell gets nudged by `nearestFree` and the
// pause lands somewhere other than in front of the desk, so `nav.test.ts` holds all three walkable.
export const CHECK_IN_MARKS: ReadonlyArray<{ lx: number; ly: number }> = [
  { lx: 120, ly: 800 },
  { lx: 175, ly: 800 },
  { lx: 230, ly: 800 },
];
/** The pause at the mark, seconds. A beat, not a gate. */
export const CHECK_IN_S = 1.2;

/** The printer/supply station against the back wall — moved out of the bench run (it stood at
 * lx 390, which is now mid-counter), into the band between the bench's end and the kitchenette. */
export const PRINTER = { lx: 505, ly: 60, w: 46, d: 34, h: 32 };

export interface Plant {
  lx: number;
  ly: number;
  species: 'snake' | 'fiddle';
}

/** Big floor plants — mostly on the perimeter, where they soften the wall edges and break up the bare
 * floor between zones without standing in a walking line. */
export const PLANTS: Plant[] = [
  { lx: 70, ly: 110, species: 'snake' },
  // (a fiddle stood at 480,55 — removed with the bench: it landed against the counter's end, and a
  // plant wedged between a bench and a printer is clutter, not softening.)
  { lx: 855, ly: 130, species: 'fiddle' },
  { lx: 55, ly: 645, species: 'fiddle' }, // left wall, in the gap between pod 2 and reception
  { lx: 866, ly: 610, species: 'snake' }, // right flank, between the two window desks (760 was one's stand-behind floor)
  { lx: 380, ly: 870, species: 'fiddle' },
  { lx: 66, ly: 470, species: 'fiddle' }, // left flank, in the rug gap between pods 0 and 2
  { lx: 830, ly: 330, species: 'snake' }, // right flank, under the nook shelf
  // Front corner, past the meeting table. Kept clear of the aisle the east head chair is pulled out
  // into (that chair's occupant stands around lx 842 to sit down), so the corner stays decoration
  // rather than a wall. A plant that fences off a seat is how the meeting corner got into trouble
  // once already.
  { lx: 872, ly: 878, species: 'fiddle' },
];

/** A back-wall window, as a fraction along its wall's edge `[t0,t1]` and up the wall `[u0,u1]`.
 * Layout data (not paint): the daylight beams, and the dog's sunbeam nap spots, both derive from it. */
export interface Win {
  t0: number;
  t1: number;
  u0: number;
  u1: number;
  /** Vertical pane divisions — 2 gives the classic four-light, 3 a taller-lit unit. */
  mullions: 2 | 3;
  /** What stands on the ledge, if anything. */
  sill: 'plant' | 'mug' | null;
  /** Glass brightness multiplier. Monotone along the wall: one sun, not four. */
  bright: number;
}

/**
 * Where the art hangs. `wall` indexes `WALL_EDGES` — 0 is the back-left (its `+t` runs screen-LEFT,
 * so it mirrors text and can only take type-free pieces), 1 the back-right.
 *
 * Six pieces rather than two identical ones, varied on three independent axes — size, orientation and
 * treatment — because two of anything at the same size and height reads as a pattern rather than as a
 * collection. The salon cluster is three small pieces hung as a group, which is the arrangement that
 * most obviously says "somebody chose these" instead of "one print was centred on each wall".
 */
export interface ArtPiece {
  wall: 0 | 1;
  tc: number;
  uc: number;
  w: number;
  h: number;
  motif: 'sunrise' | 'cairn' | 'arches' | 'bauhaus';
  frame: 'thin' | 'thick' | 'none';
}

export const ART: readonly ArtPiece[] = [
  // back-left wall: a large landscape near the corner, then the salon cluster of three past the
  // far window. Both walls are mostly glass, so the only places a picture can hang are the corner
  // stretch (t < 0.28), the gap between the windows (0.46–0.58) and the far end (t > 0.78) —
  // `layout.test.ts` holds this, because the first cut hung three of these ON a window.
  { wall: 0, tc: 0.14, uc: 0.56, w: 54, h: 42, motif: 'arches', frame: 'thick' },
  { wall: 0, tc: 0.83, uc: 0.68, w: 26, h: 26, motif: 'bauhaus', frame: 'none' },
  { wall: 0, tc: 0.92, uc: 0.66, w: 22, h: 30, motif: 'cairn', frame: 'thin' },
  { wall: 0, tc: 0.87, uc: 0.46, w: 30, h: 22, motif: 'sunrise', frame: 'thin' },
  // back-right wall: the big one, and a small square under the clock.
  //
  // It used to hang at tc 0.15, directly over the corner bookshelf — which was fine when that unit
  // was 66 tall and is not now that the tall-narrow archetype took it to 88 plus a plant on top. The
  // shelf ate the picture's bottom third (nick, 2026-07-30: "a piece of art hidden behind a
  // bookcase"). Moved along the wall into the clear stretch between that shelf and the near window
  // rather than raised, because the wall crops at the top near this corner.
  { wall: 1, tc: 0.23, uc: 0.58, w: 60, h: 44, motif: 'sunrise', frame: 'thick' },
  { wall: 1, tc: 0.52, uc: 0.34, w: 24, h: 24, motif: 'cairn', frame: 'thin' },
];
/**
 * Two windows per back wall — spaced so the wall reads as a facade, not a single porthole.
 *
 * They are no longer four copies of one window (nick, 2026-07-30: "make these windows more magical
 * looking, more warm looking, but let's not overdo it so that it looks like they're not realistic or
 * don't have actual utility"). Every difference below is something that happens in a real room:
 *
 * · `mullions` alternates the pane pattern, the way a real facade mixes units.
 * · `sill` puts an object on the ledge — a sill is what makes a window part of a room rather than a
 *   hole in a wall, and the thing standing on it is the proof someone lives here.
 * · `bright` is the one that buys most of the warmth for nothing: windows nearer the sun are
 *   brighter. It MUST stay monotone along the wall — a random brightness reads as broken glass
 *   rather than as sunlight, and the daylight beams on the floor derive from the same numbers.
 */
export const WINDOWS: readonly Win[] = [
  { t0: 0.28, t1: 0.46, u0: 0.34, u1: 0.82, mullions: 2, sill: 'plant', bright: 1 },
  { t0: 0.58, t1: 0.78, u0: 0.34, u1: 0.82, mullions: 3, sill: 'mug', bright: 0.88 },
];

/** How far into the room a window's daylight beam reaches (logical units), and its sideways sun-shear. */
export const BEAM_LEN = 150;
export const BEAM_SHEAR = 46;

/**
 * The agile board — the wall object that replaced the dry-erase whiteboard (nick, 2026-07-31). It is
 * the one data-bearing thing on either wall: real lanes as sticky notes, and on /live the click
 * target that opens the work board itself. Geometry lives here (not at the draw call) so the
 * collision guards in `layout.test.ts` hold it to the same rules as the art: never over a window,
 * never behind a shelf, never off the end of the wall.
 *
 * Wall 1 is load-bearing, same reason as the clock: `+t` runs screen-left on the other wall, and a
 * kanban read right-to-left is wrong in a way a viewer feels before they can say why. It sits in the
 * whiteboard's old slot, widened into the free stretch at the wall's far end (six columns need the
 * elbow room; every neighbour stays where it was).
 *
 * `tc` is off the window on purpose. At 0.87 the board's left edge landed ~6 units from window 2's
 * right edge (`t1` 0.78 → 702; 0.87·900 − 75 = 708), which is close enough that the two objects read
 * as one crowded strip rather than as a window and a board (nick, 2026-08-02: "very snug against the
 * window"). At 0.885 the gap is ~22 — a hand's breadth of bare wall — and the far edge still stops
 * ~28 short of the wall's end, so it is a shift, not a slide into the corner.
 */
export const WALL_BOARD = { wall: 1 as const, tc: 0.885, uc: 0.6, w: 150, h: 74 };

/** What sits on a shelf top. A credenza-height top is a real surface — leaving it bare repeats the
 *  same uniformity problem one shelf down. */
export type ShelfDecor = 'plant' | 'photo' | 'books' | 'trophy';

export interface Bookshelf {
  lx: number;
  ly: number;
  /** Which way the shelf's open (book) face points — set so it faces into the room. */
  dir: Dir;
  /** Along the wall. */
  long: number;
  /** Into the room. */
  deep: number;
  high: number;
  /** Book bands up the carcass — scales with height, so a low unit is not a tall one squashed. */
  rows: number;
  /** Carcass tone multiplier off `PAL.wood`. */
  tone: number;
  /** Shelved spine-in, page-edges to the room. Exactly one unit, and it is deliberate. */
  reversed?: boolean;
  decor: ShelfDecor;
}

/** Default bookshelf footprint (logical): wide along the wall, shallow, tall. Each unit overrides
 *  these — they are the baseline the archetypes vary from, not the shape of every shelf. */
export const SHELF_LONG = 58;
export const SHELF_DEEP = 20;
export const SHELF_H = 66;

/**
 * Freestanding bookshelves flush to the open wall stretches (back of footprint on the perimeter,
 * same pattern as the entrance door) — warm decor, block nav.
 *
 * Three archetypes rather than four copies of one box (nick, 2026-07-30: "right now we have the same
 * uniform bookshelves throughout the office space"). A tall-narrow reads as a bookcase; a low-wide
 * puts its top at a height where an object actually reads, which is what makes `decor` worth having;
 * the standard is the baseline. The carcass `tone` varies too — a room accumulates furniture over
 * years, it does not buy a matched set in one afternoon.
 */
const DEEP_WIDE = 22; // the low-wide archetype is a touch deeper than the slim units

export const BOOKSHELVES: Bookshelf[] = [
  // back wall, corner behind pod 0 — tall narrow
  {
    lx: 130,
    ly: SHELF_DEEP / 2,
    dir: 'S',
    long: 44,
    deep: SHELF_DEEP,
    high: 88,
    rows: 4,
    tone: 1.0,
    decor: 'plant',
  },
  // right wall below the lounge — low wide, and the one shelved backwards
  {
    lx: FLOOR - DEEP_WIDE / 2,
    ly: 320,
    dir: 'W',
    long: 76,
    deep: DEEP_WIDE,
    high: 46,
    rows: 2,
    tone: 0.94,
    reversed: true,
    decor: 'photo',
  },
  // left wall beside pod 0 — the standard unit, i.e. the constants above
  {
    lx: SHELF_DEEP / 2,
    ly: 240,
    dir: 'E',
    long: SHELF_LONG,
    deep: SHELF_DEEP,
    high: SHELF_H,
    rows: 3,
    tone: 1.05,
    decor: 'books',
  },
  // left wall beside pod 2 — low wide
  {
    lx: DEEP_WIDE / 2,
    ly: 560,
    dir: 'E',
    long: 70,
    deep: DEEP_WIDE,
    high: 48,
    rows: 2,
    tone: 0.97,
    decor: 'trophy',
  },
];

// ── Leisure spots ─────────────────────────────────────────────────────────────────────────────────────

export interface LeisureSpot {
  /** Which programmed zone this belongs to — the read the spot is meant to give at a glance. */
  zone: 'lounge' | 'waiting' | 'meeting' | 'reading';
  lx: number;
  ly: number;
  dir: Dir;
  /** Seated blend at rest: `1` folded onto the furniture, `0` standing (a reader at the shelves). */
  sit: number;
  /**
   * Sort the occupant at **this furniture's** depth rather than at their own feet — the same trick that
   * puts a desk member between `chairBase` and `chairBack` (see `renderScene`). Only needed for a piece
   * drawn as one box that is *long* relative to a person: the couch is sorted at its centre, so a sitter
   * on a cushion west of that centre has the lower depth key and the couch paints over them. Anchoring
   * them here makes the couch and its occupants one composite that sorts as a unit. Applied only while
   * actually seated — a walker sorts at their own feet like anyone else.
   */
  depthAt?: { lx: number; ly: number };
}

/** A chair's cushion centre sits `CHAIR_OFF` back while its occupant sits `SEAT_BACK` back, so an
 * occupant lands this far toward the facing from the chair's own centre. Same relation as a desk. */
const CHAIR_SEAT_FWD = CHAIR_OFF - SEAT_BACK;

/**
 * Which cushion of a couch is offered as a seat, as an offset along the couch's length.
 *
 * One, not three: the cushions are 34 apart, which this 2:1 iso squashes to ~27 screen units at scale 1 —
 * narrower than an avatar. Three sitters render as one smear of overlapping heads under three stacked
 * name labels. The couch stays a three-seater as *furniture*; it seats one, and the two armchairs facing
 * it take the other two lounge spots. See `MIN_SPOT_GAP`.
 *
 * The cushion chosen is the **west** one (`+34`, away from the camera): it's the only one far enough from
 * armchair W in screen space to clear `MIN_SPOT_GAP`. It's also the cushion that *needs* `depthAt` —
 * being west of the couch's centre is exactly what made the couch paint over it.
 */
const COUCH_ALONG = [34];

/** Build the seats of a couch drawn at (lx,ly) facing `dir`: one per offered cushion, in its own frame. */
function couchSeats(zone: LeisureSpot['zone'], lx: number, ly: number, dir: Dir): LeisureSpot[] {
  const f = FWD[dir];
  const p: [number, number] = [-f[1], f[0]];
  return COUCH_ALONG.map((along) => ({
    zone,
    // `+ f * 4` matches where `couch()` paints the cushion pads — the occupant sits on the pad rather
    // than back inside the backrest.
    lx: lx + p[0] * along + f[0] * 4,
    ly: ly + p[1] * along + f[1] * 4,
    dir,
    sit: 1,
    // The couch is one long box sorted at its centre; sort its occupant there too, or it paints over them.
    depthAt: { lx, ly },
  }));
}

/**
 * The minimum distance between two leisure spots, in **screen** units at scale 1 — the axis that
 * actually matters, since the 2:1 iso squashes the `ly` axis to half and can slam two spots that look
 * comfortably apart on the floor plan into the same patch of pixels. (The break nook's right armchair and
 * the couch's right cushion are 64 apart on the floor and 37 apart on screen: one avatar, visibly.)
 *
 * 52 is calibrated against what the room already draws: pairs at ~59+ read as two people sitting near
 * each other, ~37 reads as one smeared avatar. `layout.test.ts` holds every pair to it, so a spot added
 * to a zone can't quietly re-create the pile.
 */
export const MIN_SPOT_GAP = 52;

/**
 * Where an **idle** member goes (ADR 140 posture): the room's programmed leisure furniture. A member who
 * is live but has no task in hand is not at their desk — they're on the couch, on a pouf in the huddle,
 * at the meeting table, or browsing the shelves. Desks are then exactly the members who are *working*,
 * which is the whole point: the floor should answer "who is actually running?" without reading a chip.
 *
 * Derived from the same furniture data `render.ts` draws, so an occupant lands **on** a cushion rather
 * than beside it. Assignment is a hash-probe over this array (see `seating.ts`), so the order decides who
 * clusters with whom on a collision: the zones are **interleaved** rather than grouped, so a probe that
 * walks off the end of one zone lands in a different one and idle members spread across the room instead
 * of stacking onto one couch.
 */
export const LEISURE_SPOTS: LeisureSpot[] = (() => {
  const L = LOUNGE;
  // The couch cushion is the nook's only seat now — the two armchairs went with the 2026-08-02
  // downsizing. `couchSeats` still offers exactly one cushion, for the reason it always did: three
  // sitters on one couch render as a single smear of overlapping heads.
  const lounge: LeisureSpot[] = [
    ...couchSeats('lounge', NOOK.lx + L.couch.dx, NOOK.ly + L.couch.dy, 'S'),
  ];
  // Reception's two waiting chairs, which inherit the huddle's job of being the second leisure zone.
  // Someone idling in the waiting chairs is a true thing for an office to show, and it keeps four
  // zones to interleave — with three, a probe walking off the end of one zone lands in its neighbour
  // too often and idle members clump.
  const waiting: LeisureSpot[] = [RECEPTION.chair].map((c) => {
    const f = FWD[c.dir];
    return {
      zone: 'waiting' as const,
      lx: c.lx + f[0] * CHAIR_SEAT_FWD,
      ly: c.ly + f[1] * CHAIR_SEAT_FWD,
      dir: c.dir,
      sit: 1,
    };
  });
  // All four meeting chairs are seats — see MEETING for why they sit along one side and the two ends
  // rather than down both sides. `nav.test.ts` holds every offered spot to having open floor beside it,
  // so an arrangement that walls a chair in fails a test rather than shipping as a seat nobody can
  // walk to.
  const meeting: LeisureSpot[] = MEETING.chairs.map((c) => {
    const f = FWD[c.dir];
    return {
      zone: 'meeting' as const,
      lx: MEETING.lx + c.dx + f[0] * CHAIR_SEAT_FWD,
      ly: MEETING.ly + c.dy + f[1] * CHAIR_SEAT_FWD,
      dir: c.dir,
      sit: 1,
    };
  });
  // A reader stands clear of the shelf's footprint, facing *back into* it — the one leisure spot that
  // isn't a seat, so the zone doesn't read as four flavours of sitting down.
  const reading: LeisureSpot[] = BOOKSHELVES.map((s) => {
    const f = FWD[s.dir];
    const back: Dir = s.dir === 'S' ? 'N' : s.dir === 'N' ? 'S' : s.dir === 'E' ? 'W' : 'E';
    return {
      zone: 'reading' as const,
      lx: s.lx + f[0] * (SHELF_DEEP / 2 + 28),
      ly: s.ly + f[1] * (SHELF_DEEP / 2 + 28),
      dir: back,
      sit: 0,
    };
  });
  // Interleave: round-robin the zones so consecutive indices are in different parts of the room.
  const zones = [lounge, waiting, meeting, reading];
  const out: LeisureSpot[] = [];
  for (let i = 0; out.length < zones.reduce((n, z) => n + z.length, 0); i++) {
    for (const z of zones) if (z[i]) out.push(z[i]!);
  }
  return out;
})();
