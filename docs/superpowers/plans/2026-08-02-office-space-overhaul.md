# Office Space Overhaul Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this
> plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. (Team rule: no writing
> subagents — the lane owner executes inline. musterd lane `01KZ2DZPGV6A92EBVS9STYSQDD`.)

**Goal:** Ship the approved office overhaul spec
(`docs/superpowers/specs/2026-08-02-office-space-overhaul-design.md`): cork pin board, 62%
unpin-and-float overlay, enamel-pin nameplates, and a 20-desk floor plan.

**Architecture:** Four independent workstreams, sequenced paint-first, layout-last. 1–3 are each a
small PR off `feat/office-space-overhaul`; 4 is a three-PR series (remove/downsize → new desk
species → count 20). Canvas work lives in `office-scene/render.ts` + `layout.ts`, DOM/CSS work in
`office-scene/index.ts` + `Live.css` + `BoardOverlay.tsx`.

**Tech Stack:** TypeScript, React (TanStack Router), canvas 2D, vitest (repo root), vite preview +
CDP for visual verification.

## Global Constraints

- **No blur / backdrop-filter anywhere** — the scene paints on the 1920×1080 broadcast capture.
- Animations on **transform + opacity only**; the office rAF loop keeps suspending when hidden.
- No new dependencies, no new fonts; canvas type via `canvasFont.ts` tokens only.
- `pnpm perf:check` budgets hold; no raises.
- vitest **from repo root only**. `pnpm lint` needs a build first. Never `pnpm format` — only
  `pnpm exec prettier --write <files you touched>`.
- Visual verification via `vite preview` (restart it after EVERY build) + the Browser pane, never
  `vite dev`. `?team=` needed for a connected page.
- Git loop per lane: PR → `gh pr merge --squash --auto --delete-branch` → rebase +
  `--force-with-lease`.
- All logical coords are floor units (FLOOR=900, `iso.ts`); wall geometry in `WALL_BOARD` units.

## File Structure (whole arc)

| File | Role in this arc |
| --- | --- |
| `packages/web/src/live/office-scene/layout.ts` | all floor-plan data: WALL_BOARD slide, huddle removal, nook/meeting/reception downsizing, new BENCH/WINDOW_DESKS/duo-pod data |
| `packages/web/src/live/office-scene/render.ts` | pin-board painter (replaces whiteboard face + tray), bench + window-desk painters, downsized furniture painters |
| `packages/web/src/live/office-scene/nav.ts` | solid rects for changed/new furniture |
| `packages/web/src/live/office-scene/index.ts` | nameplate DOM (`syncLabels`), boardspot hover class |
| `packages/web/src/live/Live.css` | nameplate enamel treatment, boardspot hover, overlay size/choreography |
| `packages/web/src/live/BoardOverlay.tsx` | tilt/overshoot open, reversed close |
| `packages/web/src/live/boardOverlayMath.ts` | `zoomTransform` gains tilt; new `panelSize` clamp |
| `tests` | `layout.test.ts`, `nav.test.ts`, `boardOverlayMath.test.ts` extended |

---

## Task 1: Pin board — cork face, washi tape, thin oak frame, slide off the window

**Files:**
- Modify: `packages/web/src/live/office-scene/layout.ts:506` (`WALL_BOARD`)
- Modify: `packages/web/src/live/office-scene/render.ts:753-880` (`wallLaneBoard`), `:1051-1052`
  (call sites), and delete `whiteboardTray` + its call
- Test: `packages/web/src/live/office-scene/layout.test.ts` (existing wall-collision guards)

**Interfaces:**
- Consumes: `WALL_BOARD {wall,tc,uc,w,h}`, `wallPt/quad/stroke` helpers, `WALLBOARD_TONES`,
  `boardAnchor` (unchanged), `WallBoard` data from `wallboard.ts` (unchanged).
- Produces: same `wallLaneBoard(ctx, fit, edge, data)` signature; `WALL_BOARD.tc` moves right.
  Task 2 relies on `boardAnchor` still bracketing the drawn board.

- [ ] **Step 1: Slide the board.** In `layout.ts`, compute the new centre: window 2 ends at
  `t1=0.78` → right edge at `0.78*900=702`. Today `tc=0.87` puts the board's left edge at
  `783-75=708` (~6 units clear). Target ~22 units: left edge ≥ 724 → `tc: 0.885` (left edge
  `796.5-75=721.5`, right edge `871.5`, ~28 from the wall's end). Update the constant and its
  comment (mention the pin-board redesign + the 22-unit window gap).

- [ ] **Step 2: Run the layout guards.** From repo root: `pnpm vitest run packages/web/src/live/office-scene/layout.test.ts`
  Expected: PASS (the wall-object collision guards accept the new slot; if a guard names the old
  `tc`, update the expectation to the new value in the same commit).

- [ ] **Step 3: Repaint the face.** In `wallLaneBoard`:
  - Replace the flat `WHITEBOARD.face` fill with a cork field + thin oak frame, keeping the same
    quad helpers (`p`, `rect`, `stroke`):

```ts
// Frame: pale oak, LIGHTER than the cork — a bright edge, not a heavy surround (spec §3).
const OAK = { face: '#dcbf8e', lit: '#f0dcb4', shade: '#b9915f' };
const CORK = { face: '#c98f52', fleck1: '#b87c42', fleck2: '#d9a468', fleck3: '#ab7038' };
const FR = 3; // frame width, logical — THIN by decision
rect(-W / 2 + 4, -H / 2 - 4, W / 2 + 4, H / 2 - 4, WHITEBOARD.shadow); // cast stays
rect(-W / 2, -H / 2, W / 2, H / 2, OAK.face);                          // frame body
stroke([[-W / 2, H / 2], [W / 2, H / 2]], 1, OAK.lit);                 // lit top edge (wall-space: +b is up)
rect(-W / 2 + FR, -H / 2 + FR, W / 2 - FR, H / 2 - FR, CORK.face);     // cork field
// Cork speckle: seeded flecks, ~1 per 40 units², jittered from a hash of (i) — cheap, stable.
for (let i = 0; i < 260; i++) {
  const h = (i * 2654435761) >>> 0;
  const a = -W / 2 + FR + 2 + (h % 1000) / 1000 * (W - FR * 2 - 4);
  const b = -H / 2 + FR + 2 + ((h >>> 10) % 1000) / 1000 * (H - FR * 2 - 4);
  const c = [CORK.fleck1, CORK.fleck2, CORK.fleck3][h % 3]!;
  rect(a, b, a + 0.9 + (h % 3) * 0.35, b + 0.9 + ((h >>> 2) % 3) * 0.35, c);
}
// Inner shadow where cork meets frame: one darker hairline along the top of the cork.
stroke([[-W / 2 + FR, H / 2 - FR], [W / 2 - FR, H / 2 - FR]], 1, 'rgba(80,45,15,.35)');
```

  - Column dividers: drop the hairline rules (cork has no ruled lines); keep the **cap strips**
    exactly as they are — they become pinned column headers.
  - Sticky notes: keep geometry/jitter/order; replace the darker header-edge rect with a **washi
    tape tab**: centred on the note's top edge, 8 wide × 3 tall, fill = `tone.cap` at 75% alpha via
    an rgba conversion, plus a 1-unit lighter sheen line along the tab's top. Add a soft note
    shadow first (offset +0.8,-0.8 rect in `rgba(60,35,10,.26)`).
  - Keep the `+N` overflow badge (`wallText`) untouched.

- [ ] **Step 4: Delete the tray.** Remove `whiteboardTray` (render.ts:~838-880+) and its call at
  render.ts:1052. Remove now-unused `WHITEBOARD.tray/trayLip/markerBlack/markerBlue/cap` fields if
  nothing else reads them (grep first: `grep -n "WHITEBOARD\." packages/web/src/live/office-scene/render.ts`).

- [ ] **Step 5: Build + typecheck + visual check.**
  `pnpm --filter @musterd/web build` then restart `vite preview` (memory trap: preview caches
  dist), open `/live?team=revive` in the Browser pane, screenshot, zoom on the board. Verify: oak
  frame lighter than cork, tape tabs visible, no tray, ~22-unit window gap.

- [ ] **Step 6: Commit.**
  `git add -A packages/web/src/live/office-scene && git commit -m "feat(office): wall board becomes a taped-cork pin board in a thin oak frame"`

---

## Task 2: Board overlay — 62%, unpin & float

**Files:**
- Modify: `packages/web/src/live/boardOverlayMath.ts` (tilted transform)
- Modify: `packages/web/src/live/BoardOverlay.tsx` (use it; close reverses)
- Modify: `packages/web/src/live/Live.css:2957-3075` (panel size, curves, scrim, oak chrome)
- Test: `packages/web/src/live/boardOverlayMath.test.ts`

**Interfaces:**
- Consumes: `zoomTransform(origin, panel)`, `.lc-boardoverlay__panel` CSS, `CLOSE_MS`.
- Produces: `zoomTransform(origin, panel, tiltDeg?: number)` — third optional param, default 0,
  appends ` rotate(<deg>deg)`. Existing callers without the param are unchanged.

- [ ] **Step 1: Failing test.** In `boardOverlayMath.test.ts` add:

```ts
it('zoomTransform appends a rotation when tilted', () => {
  const origin = { x: 700, y: 80, width: 74, height: 38 };
  const panel = { x: 300, y: 150, width: 800, height: 500 };
  expect(zoomTransform(origin, panel, -4)).toBe(
    'translate(400.0px, -70.0px) scale(0.0925, 0.0760) rotate(-4deg)',
  );
  expect(zoomTransform(origin, panel)).not.toContain('rotate');
});
```

- [ ] **Step 2: Run it — FAIL** (`pnpm vitest run packages/web/src/live/boardOverlayMath.test.ts`,
  "expected … to be …" — extra arg ignored today).

- [ ] **Step 3: Implement.**

```ts
export function zoomTransform(origin: Rect, panel: Rect, tiltDeg = 0): string {
  const sx = panel.width > 0 ? origin.width / panel.width : 1;
  const sy = panel.height > 0 ? origin.height / panel.height : 1;
  const base = `translate(${(origin.x - panel.x).toFixed(1)}px, ${(origin.y - panel.y).toFixed(1)}px) scale(${sx.toFixed(4)}, ${sy.toFixed(4)})`;
  return tiltDeg === 0 ? base : `${base} rotate(${tiltDeg}deg)`;
}
```

- [ ] **Step 4: Run it — PASS.**

- [ ] **Step 5: Component.** In `BoardOverlay.tsx`, pass the tilt at both call sites
  (`zoomTransform(origin, rect, -4)` on mount at :66 and on close at :88). Bump `CLOSE_MS` to 320.

- [ ] **Step 6: CSS.** In `Live.css`:
  - Panel size: `width: min(62vw, 1100px); height: min(62vh, 720px);` with
    `min-width: 720px; min-height: 480px;` (clamped small screens: `width: min(96vw, …)` retained
    via `max-width: 96vw; max-height: 92vh;`). `transform-origin` stays top-left (zoom math).
  - Open curve = the unpin: `transition: transform 620ms cubic-bezier(0.2, 0.9, 0.25, 1.08), opacity 260ms var(--lc-ease);`
    — the >1 tail of the bezier IS the overshoot, no keyframes needed; the mount transform now
    carries `rotate(-4deg)` so the identity flip un-tilts through the same curve.
  - Scrim: warm radial, not flat —
    `background: radial-gradient(120% 100% at 72% 18%, color-mix(in srgb, var(--lc-ground) 30%, transparent), color-mix(in srgb, var(--lc-ground) 68%, transparent));`
    on `.is-in` (transparent at rest, transitioned via opacity on a pseudo-element to stay on the
    transform/opacity budget: put the gradient on `.lc-boardoverlay::before { opacity: 0 }` →
    `.is-in::before { opacity: 1 }`).
  - Chrome: header bar gets the oak: `background: linear-gradient(#e9d3ab, #dcbf8e);` +
    `border-bottom-color: rgba(120,78,42,.4);` and the panel border →
    `border: 3px solid #dcbf8e; box-shadow: … , inset 0 1px 0 rgba(255,244,220,.7);`.
  - Reduced motion block already swaps to opacity-only — verify it still matches (no travel).

- [ ] **Step 7: Boardspot hover.** In `Live.css:1312-1355` add to `.lc-boardspot:hover, .lc-boardspot:focus-visible`:
  `transform: translateY(-2px); filter: none;` plus a warm glow via `box-shadow: 0 0 18px -4px rgba(255,190,110,.85);`
  and `transition: transform 180ms cubic-bezier(.2,.9,.3,1.4), box-shadow 180ms;`. (DOM hotspot
  layer — the canvas does not repaint on hover.)

- [ ] **Step 8: Verify.** Build, restart preview, `/live?team=revive`: hover the board (lift+glow),
  click → panel flies from the wall with tilt, settles at 62% with office visible around it; scrim
  is warm; Escape and scrim-click reverse into the wall. Screenshot both states. Check
  `read_console_messages` clean.

- [ ] **Step 9: Commit.**
  `git commit -am "feat(office): board overlay unpins from the wall — 62% panel, tilt + overshoot, oak chrome"`

---

## Task 3: Nameplates — new anatomy + enamel pin

**Files:**
- Modify: `packages/web/src/live/office-scene/index.ts:446-560` (`syncLabels` DOM order)
- Modify: `packages/web/src/live/Live.css:939-1175` (plate block)

**Interfaces:**
- Consumes: `plateDetailParts` (unchanged — yields model/harness/role in order), `DOT_STATE`,
  `modelProvider`/`providerIconHtml`, `plateExpand` toggle machinery.
- Produces: DOM order `dot · who · [rule · provider · detail]` — chevron **deleted**; the plate
  click/keyboard toggle remains the expand affordance (`aria-expanded` moves to the plate).

- [ ] **Step 1: DOM.** In `syncLabels`:
  - Delete the `toggle` button block (index.ts:~485-497). Move `aria-expanded` + an
    `aria-label` (`\`${name} identity\``) onto `plate`, add `role="button"` when
    `interactiveLabels` (plate already has click + the label has keydown Enter/Space).
  - Order for present members: `dot`, `who`, then `plateRule` (the divider that appears on
    expand), then `icon`, then `detail`. Collapsed hides rule + detail; **icon shows collapsed
    too** — after `who` (right side), per the approved anatomy.
  - Broadcast path unchanged in content (icon + short model, no toggle).

- [ ] **Step 2: CSS — collapsed/expanded metrics.**
  - `.lc-gl-label__plate`: `padding: 1.5px 5px 1.5px 6px;` `font-size: 8px;`
  - `.lc-gl-label__rule`: `margin: 0 0.38em; height: 0.85em;` and **hidden when collapsed**:
    `.lc-gl-label:not(.is-expanded):not(.is-broadcast) .lc-gl-label__plate > .lc-gl-label__rule { display: none; }`
  - `.lc-gl-label__provider`: `width: 11px; height: 11px; margin-left: 4px;` svg `8px`.
  - `.lc-gl-label__dot`: keep leading, `margin-right: 4.5px` (in its existing block below :1175).

- [ ] **Step 3: CSS — enamel treatment.**

```css
/* Enamel-pin provider badge: domed, colour-filled, specular cap (spec §2). No filters. */
.lc-gl-label__provider {
  position: relative;
  border-radius: 4px;
  box-shadow:
    inset 0 1px 1px rgba(255, 255, 255, 0.85),
    inset 0 -1.5px 2px color-mix(in srgb, var(--lc-paper-ink) 34%, transparent),
    0 1px 2px -0.5px var(--lc-paper-drop);
  overflow: hidden;
}
.lc-gl-label__provider::after {
  content: '';
  position: absolute;
  inset: 1px 1px 55% 1px;
  border-radius: 3px 3px 6px 6px;
  background: linear-gradient(rgba(255, 255, 255, 0.55), rgba(255, 255, 255, 0));
  pointer-events: none;
}
/* The status dot gets the same glossy bead. */
.lc-gl-label__dot {
  box-shadow:
    0 0 0 1.2px var(--lc-paper-sheen),
    inset 0 0.5px 0 rgba(255, 255, 255, 0.75),
    0 0 6px -1px currentColor;
}
```

  (The dot modifiers already set `background`; add `color: <same tone>` alongside each
  `--lc-gl-label__dot--*` rule so `currentColor` glows correctly.)

- [ ] **Step 4: Contrast + width check.** Measure collapsed plate width in the preview via
  `javascript_tool` (`document.querySelector('.lc-gl-label__plate').getBoundingClientRect().width`)
  against main; target ≥25% narrower. Spot-check `--lc-paper-muted` segs still ≥4.5:1 on the stock
  (no ink colours changed — only metrics — so this is a confirmation, not a re-derivation).

- [ ] **Step 5: Verify.** Preview `/live?team=revive`: collapsed = dot·name·badge; click →
  divider appears, badge slides right of it, model│harness│role reveal; hover tooltip intact;
  offline plates still dim correctly; broadcast route (`/broadcast`) still shows icon+model.
  Keyboard: Tab to a plate, Enter expands, `aria-expanded` toggles.

- [ ] **Step 6: Commit.**
  `git commit -am "feat(office): enamel-pin nameplates — icon right of name, divider on expand, no chevron"`

---

## Task 4: Gate — PR the paint arc

- [ ] **Step 1:** `pnpm build && pnpm lint && pnpm vitest run && pnpm format:check` (build before
  lint/typecheck; format:check runs the doc gates too).
- [ ] **Step 2:** Push, open PR "office: pin board + overlay + nameplates (spec 2026-08-02)",
  `gh pr merge --squash --auto --delete-branch`. If bugbot never registers, comment `bugbot run`.
- [ ] **Step 3:** `lane_update` note: paint arc merged; floor plan next. Post a one-line
  `status_update`.

---

## Task 5: Floor plan I — remove the huddle, downsize nook / meeting / reception

New branch off fresh main: `feat/office-floorplan-1` (same lane).

**Files:**
- Modify: `packages/web/src/live/office-scene/layout.ts` (HUDDLES→[], LOUNGE, MEETING, RECEPTION,
  FRONT_DESK, NOOK_RUG_R, NOOK_SPOTS, LEISURE_SPOTS)
- Modify: `packages/web/src/live/office-scene/render.ts` (huddle painter call, armchair draws,
  meeting table size, reception waiting-nook painter)
- Modify: `packages/web/src/live/office-scene/nav.ts:54-90` (`solidRects`)
- Test: `layout.test.ts`, `nav.test.ts`

**Interfaces:**
- Consumes: all constants named above.
- Produces: `RECEPTION` gains `chairA/chairB/endTable` (each `{lx,ly}` + size consts
  `WAIT_CHAIR = 34`, `END_TABLE = 26`); loses `couch`/`table`. `HUDDLES = []` (type kept so the
  painter loop simply draws nothing). Task 6 relies on the freed rects: huddle centre (355–545,
  255–445) and the nook's right flank.

- [ ] **Step 1: Huddle out.** `HUDDLES: Huddle[] = []`. Grep consumers
  (`grep -rn "HUDDLE" packages/web/src`): the painter loop, nav rects and leisure spots all
  iterate the array — verify each tolerates empty (they do; they're `for…of`). Delete
  `HUDDLE_POUFS` / `HUDDLE_TABLE` only if unreferenced after this.
- [ ] **Step 2: Nook downsized.** `NOOK_RUG_R: 192 → 140`. Remove `chairE`/`chairW` from `LOUNGE`
  and their draws + nav rects. Re-place `NOOK_SPOTS` (6 spots) inside r=140, clear of couch/
  kitchenette (iterate against `nav.test.ts` + `layout.test.ts` MIN_SPOT_GAP).
- [ ] **Step 3: Meeting downsized.** `MEETING.w: 170 → 130`, rug `300×196 → 240×170`, chairs:
  keep 4 (side pair `dx ±32`, heads `dx ±104`). Run the tests; adjust until green.
- [ ] **Step 4: Reception waiting nook.** `FRONT_DESK.long: 108 → 84, deep: 62 → 44` (comment: the
  hall-table scale is now deliberate — it is a check-in point, not a workstation).
  Replace couch/table with:

```ts
export const WAIT_CHAIR = 34;
export const END_TABLE = 26;
export const RECEPTION = {
  rug: { lx: 150, ly: 795, w: 260, d: 165, shape: 'rect', weave: 'border', fill: '#c07a55', mark: '#9c5c3c' },
  chairA: { lx: 250, ly: 762, dir: 'W' as Dir },  // both face the door, side by side
  chairB: { lx: 250, ly: 812, dir: 'W' as Dir },
  endTable: { lx: 250, ly: 787 },
  plant: { lx: 300, ly: 700 },
} as const;
```

  Paint the chairs with the existing task-chair painter at `WAIT_CHAIR` size, the end table as a
  small `box()`. Update `nav.ts:81-83` to the three new rects. Keep `CHECK_IN_MARKS` walkable
  (nav.test.ts holds all three).
- [ ] **Step 5: Tests green** (`pnpm vitest run` from root), build, preview screenshot: reception
  reads as desk + two waiting chairs + end table, ≥30 units of bare floor to pod 2's rug; no
  huddle; nook has couch + kitchenette only.
- [ ] **Step 6: Commit + PR** (`feat(office): huddle out, nook/meeting downsized, waiting-room reception`),
  auto-merge, status_update.

---

## Task 6: Floor plan II — bench + window desk species

Branch `feat/office-floorplan-2` off fresh main.

**Files:**
- Modify: `layout.ts` (new `BENCH`, `WINDOW_DESKS` data)
- Modify: `render.ts` (two painters), `nav.ts` (rects), `character/actor seat assignment` (see
  Step 4)
- Test: `layout.test.ts`, `nav.test.ts`

**Interfaces:**
- Produces:

```ts
/** Back-wall bench: one long counter, N seats, sitters FACE THE WALL (dir 'N'). */
export const BENCH = { lx: 330, ly: 66, long: 300, deep: 34, seats: 4, dir: 'N' as Dir };
/** Standalone window desks — face INTO the room. */
export const WINDOW_DESKS: ReadonlyArray<{ lx: number; ly: number; dir: Dir }> = [
  { lx: 828, ly: 300, dir: 'W' }, // right wall, under the nook shelf window
  { lx: 828, ly: 640, dir: 'W' },
];
export interface Seat { id: number; lx: number; ly: number; dir: Dir; kind: 'pod' | 'bench' | 'window'; }
export const SEATS: Seat[] = [/* DESK_SLOTS mapped + bench seats derived + window desks */];
```

  Bench seat `i` of `seats`: `lx = BENCH.lx - BENCH.long/2 + (i + 0.5) * (BENCH.long / seats)`,
  `ly = BENCH.ly + SEAT_BACK` (seat south of the counter, facing N). `SEATS` becomes the single
  seat roster Task 7 and the actor system consume (today that's `DESK_SLOTS`; keep `DESK_SLOTS`
  exported and make `SEATS` include it so the diff stays reviewable).
- [ ] **Step 1: Data + failing tests.** Add the constants; extend `layout.test.ts` with: every
  `SEATS` entry ≥ `MIN_SPOT_GAP` from every other seat/stand point; bench footprint collides with
  no wall object (windows/printer/shelves — printer moves right if needed: `PRINTER.lx 390 → 560`,
  it currently sits inside the bench run). Run → FAIL (constants exist, printer collision).
- [ ] **Step 2: Fix data until green** (move `PRINTER`, tune bench `lx/long`).
- [ ] **Step 3: Painters.** Bench: one long `box()` counter at `DESK_UP` height against the wall +
  per-seat monitor (existing monitor painter, facing N — glow toward the wall reads as a lit rim
  over the sitter's shoulders) + task chairs (existing painter). Window desk: reuse the pod desk
  painter parameterised by `dir:'W'` (slab + monitor + chair mirrored); no privacy screen.
- [ ] **Step 4: Seat assignment.** Find the consumer of `DESK_SLOTS` that maps members → desks
  (grep `DESK_SLOTS` in `office-scene/`); point it at `SEATS`. Ordering: pods first, bench, then
  window desks — so today's 12 members land exactly where they already sit (zero visual diff at
  n=12; the new seats only take members 13–18).
- [ ] **Step 5: nav rects** for bench + window desks (counter + each chair). `nav.test.ts` green:
  every seat approachable.
- [ ] **Step 6: Build, preview, screenshot** (12 live members: nothing moved). Commit + PR
  (`feat(office): back-wall bench and window-desk species`), auto-merge, status_update.

---

## Task 7: Floor plan III — the 20-desk arrangement

Branch `feat/office-floorplan-3` off fresh main.

**Files:**
- Modify: `layout.ts` (`PODS` → mixed clusters incl. duos; `Pod` gains `size: 2 | 4`)
- Modify: `render.ts` (pod painter honours `size`), `nav.ts` (derived — no change if rects derive
  from `SEATS`/pod data)
- Test: `layout.test.ts`

**Interfaces:**
- Consumes: `SEATS` roster from Task 6.
- Produces: final inventory = quad (top-left) + quad (centre) + duo (mid-left) + duo
  (upper-centre) + front duo + bench 4 + window 2 = **20**; `podDesks` returns 2 desks for
  `size: 2` (one facing pair, no second row).

- [ ] **Step 1: Failing test.** `layout.test.ts`: `expect(SEATS.length).toBe(20)` + the existing
  overlap/gap/walkability invariants over the new arrangement. FAIL (12 + bench/window = 18 after
  Task 6... actual count: 12 pod + 4 bench + 2 window = 18; this task re-shapes pods to
  4+4+2+2+2 = 14 pod seats → 20 total).
- [ ] **Step 2: Data.** Target centres (iterate against tests + preview; mockup fixes the
  arrangement, not the numbers):

```ts
export const PODS: Pod[] = [
  { id: 0, cx: 185, cy: 235, axis: 'ns', size: 4, rug: {…existing teal…} },   // quad, top-left
  { id: 1, cx: 455, cy: 530, axis: 'ew', size: 4, rug: {…existing blue…} },   // quad, centre
  { id: 2, cx: 165, cy: 545, axis: 'ew', size: 2, rug: {…existing mauve…} },  // duo, mid-left
  { id: 3, cx: 480, cy: 250, axis: 'ns', size: 2, rug: {…new sage…} },        // duo, upper-centre
  { id: 4, cx: 560, cy: 770, axis: 'ew', size: 2, rug: {…new slate…} },       // front duo
];
```

  `podDesks` for `size: 2`: return only the two `-POD_ALONG` row entries (the facing pair sits
  across the pod centre: one at `-POD_ALONG` facing in, one at `+POD_ALONG` facing back — i.e.
  entries 0 and 2 of the current four, re-idded). `POD_RUG` for duos: `along: 230, across: 140`.
  Keep exactly one `ns` quad so a pair of faces points at the camera (existing rule, spec §1).
- [ ] **Step 3: Iterate to green**, checking rug gaps (bare floor between all rugs), walk lanes,
  `MIN_SPOT_GAP`, and the meeting/reception clearances from Task 5.
- [ ] **Step 4: Preview at n=12 and synthetic n=20** (`?beat=` fixtures or a local roster stub —
  check `window.__office` helpers from the animation arc). Screenshot both. Nameplate collision
  check at 20: no overlapping collapsed plates at rest.
- [ ] **Step 5: Commit + PR** (`feat(office): 20 seats — mixed quads, duos, bench, window desks`),
  auto-merge.

---

## Task 8: Close the lane

- [ ] Full gates on main after the last merge (`pnpm build && pnpm lint && pnpm vitest run && pnpm format:check && pnpm perf:check`).
- [ ] `lane_submit` with a closing note naming the spec + the four PRs; `team_send status_update`;
  memory save (topic file update: office overhaul arc) per seat-memory practice.

## Self-review notes

- Spec §1 facing rules → Tasks 6/7 (bench N, window W, one ns quad). §2 → Task 3. §3 → Task 1.
  §4 → Task 2. §5 constraints → Global Constraints + per-task gates. Reception/nook/meeting → Task 5.
- Printer relocation is new information surfaced by planning (it sits at lx 390 inside the bench
  run) — folded into Task 6 rather than left as a surprise.
- Type consistency: `SEATS`/`Seat.kind`, `zoomTransform(origin, panel, tiltDeg?)`, `WAIT_CHAIR`,
  `BENCH`, `WINDOW_DESKS`, `Pod.size` are each defined once and referenced by those names throughout.
