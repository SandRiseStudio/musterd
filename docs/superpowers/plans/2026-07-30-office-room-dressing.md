# Office Room Dressing Implementation Plan

> **For agentic workers:** Steps use checkbox (`- [ ]`) syntax for tracking. On this machine
> subagent-driven execution is disabled — musterd is the coordination layer. Implement inline in
> your own seat, or hand a task to another seat with `team_send {act:'handoff'}`.

**Goal:** Kill the uniformity in the office set dressing — one varied room instead of a matched set —
and narrow the nameplate.

**Architecture:** Every item is a canvas painter in `office-scene/render.ts` reading geometry from
`office-scene/layout.ts`, plus one DOM change in `office-scene/index.ts` + `Live.css`. Variation is
driven by **seeded** hashes, never `Math.random()` — this content is baked once onto the still layer
and must be byte-identical across repaints. No new dependencies, no per-frame work.

**Tech Stack:** TypeScript, Canvas 2D, Vitest, Vite.

**Spec:** [2026-07-30 office room dressing](../specs/2026-07-30-office-room-dressing-design.md)

## Global Constraints

- **Scale floor:** the office fits at **≈0.52 on `/live`**. **Nothing under ~10 logical units may
  carry meaning.** Detail below that is texture only.
- **Baked still layer only.** Nothing in this plan may enter the per-frame render loop.
- **Determinism:** all variation seeded from stable indices. `Math.random()` in a painter is a bug.
- **No new dependencies.** Existing primitives only: `box`, `quad`, `ellipse`, `roundRect`,
  `wallRect`, `wallDisc`, `wallPt`, `wallText`, `dim`, `mul`, `shade`.
- **Fonts:** canvas type goes through `src/live/canvasFont.ts` tokens. Never hard-code a family.
- **Perf gate:** `pnpm perf:check` after build. A budget raise is a reviewed act (ADR 151).
- **Tests run from the repo root only:** `pnpm vitest run <path>`.
- **Visual check:** `vite preview` + CDP, never `vite dev`. **Restart preview after every build** or
  pages 404 their chunks. The Browser pane always reports `document.hidden === true`.
- **Wall constraint:** `+t` runs screen-LEFT on the back-left wall (text mirrors there). Only the
  back-right wall can carry type.
- Commit after every task. Branch: `feat/office-presence-chrome`.

---

## File Structure

| File | Responsibility | Change |
| --- | --- | --- |
| `packages/web/src/live/presenceLabel.ts` | short display labels | add `plateModel()` |
| `packages/web/src/live/presenceLabel.test.ts` | ditto | add cases |
| `packages/web/src/live/office-scene/index.ts` | DOM nameplate build | restructure plate |
| `packages/web/src/live/Live.css` | nameplate styling | two-line plate, ink fix |
| `packages/web/src/live/office-scene/layout.ts` | geometry data | per-shelf dims, art, windows, decor |
| `packages/web/src/live/office-scene/render.ts` | all painters | items 2–11 |
| `packages/web/src/live/office-scene/render.test.ts` | painter assertions | one describe per task |
| `packages/web/src/live/office-scene/layout.test.ts` | geometry assertions | shelf/window variation |

---

## Task 1: Narrow the nameplate

**Files:**
- Modify: `packages/web/src/live/presenceLabel.ts`
- Modify: `packages/web/src/live/office-scene/index.ts:340-370`
- Modify: `packages/web/src/live/Live.css:999-1046`
- Test: `packages/web/src/live/presenceLabel.test.ts`

**Interfaces:**
- Consumes: `shortModel`, `identityMeta` (existing).
- Produces: `plateModel(model: string | null | undefined): string | null` — the model label for the
  always-on plate, or `null` when there is nothing worth showing.

- [ ] **Step 1: Write the failing test**

In `presenceLabel.test.ts`:

```ts
describe('plateModel', () => {
  it('gives the short model for the always-on plate', () => {
    expect(plateModel('claude-opus-4-5')).toBe('opus 4.5');
  });

  it('is null when there is no model worth showing', () => {
    expect(plateModel(null)).toBeNull();
    expect(plateModel('')).toBeNull();
    expect(plateModel('unknown')).toBeNull();
  });

  it('never carries the harness — that moved to hover', () => {
    expect(plateModel('claude-opus-4-5')).not.toContain('claude code');
  });
});
```

Add the import to the existing import line at the top of the file.

- [ ] **Step 2: Run it and watch it fail**

```bash
pnpm vitest run packages/web/src/live/presenceLabel.test.ts
```

Expected: FAIL — `plateModel is not a function`.

- [ ] **Step 3: Implement**

In `presenceLabel.ts`, after `shortModel`:

```ts
/**
 * The model label for the always-on nameplate. Deliberately model-only: the harness moved to hover
 * (room-dressing design §1) because it is the least surprising field — nearly every seat runs the
 * same one, so it cost width over every head and bought nothing at a glance.
 */
export function plateModel(model: string | null | undefined): string | null {
  const short = shortModel(model);
  return short ? short : null;
}
```

- [ ] **Step 4: Run the test**

```bash
pnpm vitest run packages/web/src/live/presenceLabel.test.ts
```

Expected: PASS.

- [ ] **Step 5: Restructure the plate DOM**

In `index.ts`, replace the `if (present && meta.line) { … }` block (the `sep` + `metaEl` build) with a
second line **outside** the plate span. The plate keeps dot + name; the model becomes its own element
appended to `el` after the plate:

```ts
el.appendChild(plate);

const model = present ? plateModel(node.model) : null;
if (model) {
  const modelEl = document.createElement('span');
  modelEl.className = 'lc-gl-label__model';
  modelEl.textContent = model;
  el.appendChild(modelEl);
}
```

Import `plateModel` alongside the existing `identityMeta` import. Leave `meta` in place — the hover
tip still uses `meta.title`, which is where the harness now lives.

- [ ] **Step 6: Fix the CSS**

In `Live.css`: drop `max-width: 16rem` on `.lc-gl-label__plate` to `max-width: 11rem`. **Delete** the
`.lc-gl-label__sep` and `.lc-gl-label__meta` rules entirely. Add:

```css
/* Second line: model only. Same hue as the plate ink at lower alpha — a different hue (the old
   #8a6508) reads dirty on warm paper, which is the rule the palette block above already states. */
.lc-gl-label__model {
  max-width: 11rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--font-mono, monospace);
  font-size: 8.5px;
  font-weight: 600;
  letter-spacing: 0.03em;
  text-transform: lowercase;
  color: color-mix(in srgb, var(--lc-paper-ink) 62%, transparent);
  text-shadow: 0 1px 0 var(--lc-paper-sheen);
}
```

- [ ] **Step 7: Verify visually**

```bash
pnpm --filter @musterd/web build && pnpm --filter @musterd/web preview
```

Restart preview, open `/live`. Confirm: plate is dot + name only, model sits under it, no mustard
`·`, plate no wider than a desk.

- [ ] **Step 8: Commit**

```bash
git add packages/web/src/live/presenceLabel.ts packages/web/src/live/presenceLabel.test.ts packages/web/src/live/office-scene/index.ts packages/web/src/live/Live.css
git commit -m "Narrow the nameplate to name over model; drop the muddy meta ink."
```

---

## Task 2: Declutter the whiteboard

**Files:**
- Modify: `packages/web/src/live/office-scene/render.ts` (`wallWhiteboard`, ~line 667)
- Test: `packages/web/src/live/office-scene/render.test.ts`

**Interfaces:**
- Consumes: `wallPt`, `quad`, `WHITEBOARD` const (existing).
- Produces: nothing new — `wallWhiteboard` keeps its signature.

**Baseline:** portrait `W = 92`, `H = 80`, framed, five objects (two boxes, a connector arrow, a
cylinder, a cloud), no labels, no tray. **Keep portrait, keep the frame** — see spec §2.

- [ ] **Step 1: Write the failing test**

In `render.test.ts`, inside the existing `describe('the wall whiteboard', …)`:

```ts
it('draws at most three ink shapes — a crowded board turns to hash at /live scale', () => {
  const strokes: number[] = [];
  const ctx = strokeCountingCtx(strokes);
  renderScene(ctx, fit, new Map(), roster([node('ada', 'working')]), new Map());
  // Board face + frame are quads; the ink is stroked. Three shapes + two arrow strokes = 5 max.
  expect(strokes.length).toBeLessThanOrEqual(5);
});
```

Add a `strokeCountingCtx` helper next to the existing `textCtx` helper — same shape, but pushing a
marker on each `stroke()` call rather than collecting `fillText` strings.

- [ ] **Step 2: Run it and watch it fail**

```bash
pnpm vitest run packages/web/src/live/office-scene/render.test.ts
```

Expected: FAIL — the current painter strokes more than five times (two boxes, an arrow shaft, an
arrowhead, four cylinder strokes, a cloud).

- [ ] **Step 3: Cut the doodle to three shapes**

In `wallWhiteboard`, keep the shadow / frame / face rects and the `stroke` helper. Replace the doodle
body with exactly three shapes and two arrows, every mark ≥ 10 logical units, at heavier weight:

```ts
  // Three shapes, two arrows — and nothing else. This board renders at ~half size under wall shear,
  // so a fourth object does not add information, it removes it: the earlier six-object version was
  // unreadable hash at /live, which is the whole reason this painter was rewritten (design §2).
  // Every mark is >= 10 logical units. Anything smaller cannot be seen at all.
  const INK_W = 2.2; // heavier than the old 1.5 so lines survive the downscale

  // Upper box
  stroke([[-26, 30], [-26, 12], [24, 12], [24, 30], [-26, 30]], INK_W, WHITEBOARD.ink);
  // Lower-left box
  stroke([[-30, -6], [-30, -26], [-4, -26], [-4, -6], [-30, -6]], INK_W, WHITEBOARD.ink);
  // Lower-right box
  stroke([[6, -6], [6, -26], [30, -26], [30, -6], [6, -6]], INK_W, WHITEBOARD.ink);
  // Two arrows down from the upper box into each lower one
  stroke([[-16, 12], [-16, -6]], INK_W, WHITEBOARD.ink);
  stroke([[16, 12], [16, -6]], INK_W, WHITEBOARD.ink);
```

Delete the cylinder and cloud blocks entirely.

- [ ] **Step 4: Run the tests**

```bash
pnpm vitest run packages/web/src/live/office-scene/render.test.ts
```

Expected: PASS, including the existing "no roster data" and "no `N/M`" assertions.

- [ ] **Step 5: Verify visually and count**

Build, restart preview, open `/live`. **Count the shapes.** If you cannot count them at `/live`
scale, cut one more and re-run. That is the acceptance test.

- [ ] **Step 6: Commit**

```bash
git add packages/web/src/live/office-scene/render.ts packages/web/src/live/office-scene/render.test.ts
git commit -m "Cut the whiteboard doodle to three shapes — countable at /live scale."
```

---

## Task 3: Vary the bookshelf carcasses

**Files:**
- Modify: `packages/web/src/live/office-scene/layout.ts:375-392`
- Modify: `packages/web/src/live/office-scene/render.ts` (`bookshelf`, ~line 1446)
- Test: `packages/web/src/live/office-scene/layout.test.ts`

**Interfaces:**
- Produces: `Bookshelf` gains `long`, `deep`, `high`, `rows`, `tone`, `reversed`, `decor`. The module
  constants `SHELF_LONG` / `SHELF_DEEP` / `SHELF_H` stay exported as the **defaults**, because
  `nav.ts` and the leisure-spot code read them.

- [ ] **Step 1: Write the failing test**

In `layout.test.ts`:

```ts
describe('BOOKSHELVES', () => {
  it('is not a matched set — the units differ in size', () => {
    const widths = new Set(BOOKSHELVES.map((s) => s.long));
    const heights = new Set(BOOKSHELVES.map((s) => s.high));
    expect(widths.size).toBeGreaterThan(1);
    expect(heights.size).toBeGreaterThan(1);
  });

  it('has exactly one shelved backwards, on the right wall', () => {
    const reversed = BOOKSHELVES.filter((s) => s.reversed);
    expect(reversed).toHaveLength(1);
    expect(reversed[0]!.dir).toBe('W'); // the right wall faces west into the room
  });

  it('gives every unit a decor object for its top', () => {
    for (const s of BOOKSHELVES) expect(s.decor).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
pnpm vitest run packages/web/src/live/office-scene/layout.test.ts
```

Expected: FAIL — `s.long` is `undefined`.

- [ ] **Step 3: Widen the type and the data**

In `layout.ts`:

```ts
/** What sits on top of a unit. A shelf top at credenza height is a real surface — use it. */
export type ShelfDecor = 'plant' | 'photo' | 'books' | 'trophy';

export interface Bookshelf {
  lx: number;
  ly: number;
  dir: Dir;
  /** Along the wall. */
  long: number;
  /** Into the room. */
  deep: number;
  high: number;
  /** Book bands up the carcass — scales with height. */
  rows: number;
  /** Carcass tone multiplier off `PAL.wood`. A room accumulates furniture; it never buys a set. */
  tone: number;
  /** Shelved spine-in — page-edges to the room. Exactly one unit, and it is deliberate. */
  reversed?: boolean;
  decor: ShelfDecor;
}

export const BOOKSHELVES: Bookshelf[] = [
  // back wall, corner behind pod 0 — tall narrow
  { lx: 130, ly: SHELF_DEEP / 2, dir: 'S', long: 44, deep: 20, high: 88, rows: 4, tone: 1.0, decor: 'plant' },
  // right wall below the lounge — low wide, and the one shelved backwards
  { lx: FLOOR - SHELF_DEEP / 2, ly: 320, dir: 'W', long: 76, deep: 22, high: 46, rows: 2, tone: 0.94, reversed: true, decor: 'photo' },
  // left wall beside pod 0 — standard
  { lx: SHELF_DEEP / 2, ly: 240, dir: 'E', long: 58, deep: 20, high: 66, rows: 3, tone: 1.05, decor: 'books' },
  // left wall beside pod 2 — low wide
  { lx: SHELF_DEEP / 2, ly: 560, dir: 'E', long: 70, deep: 22, high: 48, rows: 2, tone: 0.97, decor: 'trophy' },
];
```

- [ ] **Step 4: Make the painter read the per-shelf dims**

In `render.ts`, `bookshelf()`: replace `SHELF_LONG` → `s.long`, `SHELF_DEEP` → `s.deep`, `SHELF_H` →
`s.high`, the hard-coded `row < 3` → `row < s.rows`, and the carcass fill → `mul(PAL.wood, s.tone)`.
Space the bands over the height rather than at the fixed `8 + row * 18`:

```ts
  const bandGap = (s.high - 10) / s.rows;
  for (let row = 0; row < s.rows; row++) {
    const baseUp = 8 + row * bandGap;
```

- [ ] **Step 5: Run the tests**

```bash
pnpm vitest run packages/web/src/live/office-scene/layout.test.ts packages/web/src/live/office-scene/render.test.ts
```

Expected: PASS. If a nav or seating test fails, a shelf footprint grew into a walkable cell — shrink
that unit's `long`, do not widen the corridor.

- [ ] **Step 6: Commit**

```bash
git add packages/web/src/live/office-scene/layout.ts packages/web/src/live/office-scene/render.ts packages/web/src/live/office-scene/layout.test.ts
git commit -m "Give the bookshelves three archetypes instead of one repeated unit."
```

---

## Task 4: Vary the books

**Files:**
- Modify: `packages/web/src/live/office-scene/render.ts` (`bookshelf`)
- Test: `packages/web/src/live/office-scene/render.test.ts`

**Interfaces:**
- Produces: `shelfRnd(shelf: number, book: number, salt: number): number` — a stable hash in `[0,1)`,
  and `BOOK_COLORS: readonly string[]` including a white and a black.

This is the highest-value task in the plan: uniform verticals are what make the current shelves read
as a texture swatch rather than as books.

- [ ] **Step 1: Write the failing test**

```ts
describe('the books', () => {
  it('varies spine width, height and colour across a shelf', () => {
    const boxes = capturedBoxes(() =>
      renderScene(recordingCtx(), fit, new Map(), roster([node('ada', 'working')]), new Map()),
    );
    const spines = boxes.filter((b) => b.tag === 'book');
    expect(new Set(spines.map((b) => b.w)).size).toBeGreaterThan(1);
    expect(new Set(spines.map((b) => b.h)).size).toBeGreaterThan(1);
    expect(new Set(spines.map((b) => b.fill)).size).toBeGreaterThan(3);
  });

  it('includes a white and a black spine — a shelf of mid-tones reads as a picked palette', () => {
    expect(BOOK_COLORS).toContain('#f4f1ea');
    expect(BOOK_COLORS).toContain('#22201d');
  });

  it('leans a few books but leaves most upright', () => {
    const leans = BOOK_LAYOUT.map((b) => b.lean);
    expect(leans.some((l) => l !== 0)).toBe(true);
    expect(leans.filter((l) => l === 0).length).toBeGreaterThan(leans.length / 2);
  });

  it('is deterministic — the same seed twice gives the same geometry', () => {
    expect(shelfRnd(1, 2, 3)).toBe(shelfRnd(1, 2, 3));
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
pnpm vitest run packages/web/src/live/office-scene/render.test.ts
```

Expected: FAIL — `shelfRnd` and `BOOK_COLORS` are not exported.

- [ ] **Step 3: Implement the seeded variation**

In `render.ts`, above `bookshelf()`:

```ts
/**
 * Stable per-book noise. Seeded, never `Math.random()`: the shelves are painted onto the baked still
 * layer and repainted on every resize, and a book that changes width between repaints flickers.
 */
export function shelfRnd(shelf: number, book: number, salt: number): number {
  let h = (shelf * 73856093) ^ (book * 19349663) ^ (salt * 83492791);
  h = Math.imul(h ^ (h >>> 15), 2246822507);
  h = Math.imul(h ^ (h >>> 13), 3266489909);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/**
 * Spine colours. The white and the black are the point: a shelf of only saturated mid-tones is the
 * tell that a palette was picked rather than accumulated. They are punctuation, not the body — one
 * of each against ten warm spines.
 */
export const BOOK_COLORS: readonly string[] = [
  '#c95c4a', '#e0a72b', '#5aa0c9', '#6aa86a', '#b06fc9', '#d98b4a',
  '#8c4a3a', '#3f7a8c', '#a8422f', '#7a6ab0',
  '#f4f1ea', // the white one
  '#22201d', // the black one
];
```

Inside `bookshelf()`, replace the fixed 5-book loop with a width-packed run. Vary width, height,
colour and lean; a leaning book needs a gap on its lean side:

```ts
    // Pack the row by width rather than by count, so varied spines still fill the shelf.
    const span = s.long * 0.82;
    let along = -span / 2;
    for (let i = 0; along < span / 2 - 6; i++) {
      const bw = 5 + shelfRnd(si, row * 32 + i, 1) * 6; // 5..11
      const bh = 10 + shelfRnd(si, row * 32 + i, 2) * 6; // 10..16
      const col = BOOK_COLORS[Math.floor(shelfRnd(si, row * 32 + i, 3) * BOOK_COLORS.length)]!;
      // Most stand up. A leaner tips against its neighbour and needs the gap to fall into — which is
      // why the lean is applied as a height squash plus a shove, not a rotation: `box()` is axis
      // aligned, and a real rotation would need a whole new primitive for a two-pixel effect.
      const lean = shelfRnd(si, row * 32 + i, 4) < 0.18 ? 0.82 : 1;
      const bx = s.lx + (sn ? along + bw / 2 : f[0] * (s.deep / 2 - 2));
      const by = s.ly + (sn ? f[1] * (s.deep / 2 - 2) : along + bw / 2);
      box(ctx, fit, bx, by, sn ? bw : 3, sn ? 3 : bw, bh * lean, col, baseUp);
      spineMarks(ctx, fit, bx, by, sn, bw, bh * lean, baseUp, col, si, row * 32 + i);
      along += bw + (lean < 1 ? 2.5 : 0.6); // the leaner's gap
    }
```

`si` is the shelf's index — change `bookshelf(ctx, fit, s)` to `bookshelf(ctx, fit, s, si)` and pass
the index from the `BOOKSHELVES.forEach` in `renderScene`.

- [ ] **Step 4: Implement the spine marks**

```ts
/**
 * A title on a spine, at `/live` scale, is about 4 x 7 screen px. Real glyphs are not on the table:
 * they render as a grey smear, and `canvasFont` cannot help — the problem is the pixels, not the
 * family. So a title is drawn as what a title *looks like* across a room: one or two short bars at a
 * consistent cap height, in an ink that separates from the spine.
 *
 * DO NOT "fix" these into real strings. That was measured and it does not read.
 */
function spineMarks(
  ctx: CanvasRenderingContext2D, fit: Fit, bx: number, by: number, sn: boolean,
  bw: number, bh: number, baseUp: number, spine: string, si: number, bi: number,
): void {
  if (bw < 6.5) return; // too narrow to letter at all
  const bars = shelfRnd(si, bi, 5) < 0.45 ? 2 : 1;
  // Light spines get dark lettering and vice versa, so the mark always separates.
  const light = spine === '#f4f1ea' || spine === '#e0a72b';
  const ink = light ? 'rgba(40,36,32,0.55)' : 'rgba(245,242,236,0.5)';
  for (let b = 0; b < bars; b++) {
    const up = baseUp + bh * (0.62 - b * 0.16);
    box(ctx, fit, bx, by, sn ? bw * 0.5 : 3.2, sn ? 3.2 : bw * 0.5, 0.9, ink, up);
  }
}
```

Export a `BOOK_LAYOUT` describing one representative shelf's packed run so the lean test can assert
on data rather than on pixels — build it with the same `shelfRnd` calls at module load.

- [ ] **Step 5: Run the tests**

```bash
pnpm vitest run packages/web/src/live/office-scene/render.test.ts
```

Expected: PASS.

- [ ] **Step 6: Verify visually at both scales**

Build, restart preview. Check `/office-preview` first (spine marks should read as lettering) then
`/live` (should read as books, not a swatch).

- [ ] **Step 7: Commit**

```bash
git add packages/web/src/live/office-scene/render.ts packages/web/src/live/office-scene/render.test.ts
git commit -m "Vary the books: size, colour, lean, and spine lettering that survives /live scale."
```

---

## Task 5: The reversed shelf and the shelf-top decor

**Files:**
- Modify: `packages/web/src/live/office-scene/render.ts` (`bookshelf`)
- Test: `packages/web/src/live/office-scene/render.test.ts`

**Interfaces:**
- Consumes: `Bookshelf.reversed`, `Bookshelf.decor` (Task 3), `shelfRnd` (Task 4).

- [ ] **Step 1: Write the failing test**

```ts
it('shelves one unit backwards — a pale block of page edges, not spines', () => {
  const boxes = capturedBoxes(() =>
    renderScene(recordingCtx(), fit, new Map(), roster([node('ada', 'working')]), new Map()),
  );
  const pages = boxes.filter((b) => b.fill === PAGE_EDGE);
  expect(pages.length).toBeGreaterThan(4);
});

it('puts something on top of every shelf', () => {
  const boxes = capturedBoxes(() =>
    renderScene(recordingCtx(), fit, new Map(), roster([node('ada', 'working')]), new Map()),
  );
  const decor = boxes.filter((b) => b.tag === 'shelf-decor');
  expect(decor.length).toBe(BOOKSHELVES.length);
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
pnpm vitest run packages/web/src/live/office-scene/render.test.ts
```

Expected: FAIL — `PAGE_EDGE` undefined.

- [ ] **Step 3: Implement the reversed run**

```ts
/** Page-edges, seen from the room. Cream and near-uniform — that flatness is the whole joke. */
export const PAGE_EDGE = '#e8dcc4';
```

In the book loop, when `s.reversed`, keep the same packed geometry but paint every spine `PAGE_EDGE`
(varying only slightly via `shade`), and **skip `spineMarks` entirely** — the point of a backwards
shelf is that there is nothing to read:

```ts
      const col = s.reversed
        ? shade(PAGE_EDGE, 0.97 + shelfRnd(si, row * 32 + i, 6) * 0.06)
        : BOOK_COLORS[Math.floor(shelfRnd(si, row * 32 + i, 3) * BOOK_COLORS.length)]!;
      …
      if (!s.reversed) spineMarks(…);
```

- [ ] **Step 4: Implement the decor**

```ts
/** One object on each shelf top. A credenza-height top is a real surface — leaving it bare is the
 *  same uniformity problem one shelf up. */
function shelfDecor(ctx: CanvasRenderingContext2D, fit: Fit, s: Bookshelf, si: number): void {
  const up = s.high;
  switch (s.decor) {
    case 'plant':
      return drawPlant(ctx, fit, s.lx, s.ly, 'snake', up);
    case 'photo': {
      // Leaning, not standing — leaning is what makes it read as *placed* rather than installed.
      box(ctx, fit, s.lx, s.ly, 16, 3, 20, DRESS.frame, up);
      box(ctx, fit, s.lx, s.ly - 1, 13, 1.5, 16, DRESS.mat, up + 2);
      return;
    }
    case 'books':
      box(ctx, fit, s.lx, s.ly, 22, 14, 4, BOOK_COLORS[0]!, up);
      box(ctx, fit, s.lx + 1, s.ly, 20, 13, 3.5, BOOK_COLORS[3]!, up + 4);
      return;
    case 'trophy':
      box(ctx, fit, s.lx, s.ly, 9, 9, 4, '#8a6a2c', up);
      box(ctx, fit, s.lx, s.ly, 4, 4, 9, '#c9a44a', up + 4);
      return;
  }
}
```

Call it at the end of `bookshelf()`. `drawPlant` needs an optional `up` parameter added (defaulting
to `0`) so it can stand on a surface rather than the floor.

- [ ] **Step 5: Run the tests, verify visually, commit**

```bash
pnpm vitest run packages/web/src/live/office-scene/render.test.ts
git add packages/web/src/live/office-scene/render.ts packages/web/src/live/office-scene/render.test.ts
git commit -m "Shelve one unit backwards; put something on top of every shelf."
```

---

## Task 6: Scale up the kitchenette

**Files:**
- Modify: `packages/web/src/live/office-scene/layout.ts` (`LOUNGE`, `SINK`, stands)
- Modify: `packages/web/src/live/office-scene/render.ts` (`counterSink`, `coffeeMachine`)
- Test: `packages/web/src/live/office-scene/layout.test.ts`, `seating.test.ts`, `nav.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
it('reads as a galley beside a 100-unit desk, not a table with a bowl on it', () => {
  expect(LOUNGE.counter.len).toBeGreaterThan(DESK_W);
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
pnpm vitest run packages/web/src/live/office-scene/layout.test.ts
```

- [ ] **Step 3: Scale the run**

Raise `LOUNGE.counter.len` past `DESK_W` (100) and deepen it; deepen the sink basin in
`counterSink`; raise the `coffeeMachine` height. Add an **upper cabinet band** on the wall above the
counter — that is the single strongest "this is a kitchen" cue and it costs one `wallRect`.

- [ ] **Step 4: Re-check the stands**

`NOOK_SPOTS`, `SINK_STAND`, `COFFEE_STAND`, `FRIDGE_STAND`, `COOLER_STAND` are positions where a
member **stands**. After the counter grows, run:

```bash
pnpm vitest run packages/web/src/live/office-scene/
```

A failure here means somebody is standing inside a counter. Move the stand out, not the counter back.

- [ ] **Step 5: Verify visually and commit**

```bash
git add packages/web/src/live/office-scene/layout.ts packages/web/src/live/office-scene/render.ts packages/web/src/live/office-scene/layout.test.ts
git commit -m "Scale the kitchenette to read as a galley next to the desks."
```

---

## Task 7: Give the hanging planter a rim

**Files:**
- Modify: `packages/web/src/live/office-scene/render.ts` (`wallHanger`, ~line 955)
- Test: `packages/web/src/live/office-scene/render.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
it('draws a rim ellipse — the mark that states "container with an opening"', () => {
  const ellipses = capturedEllipses(() =>
    renderScene(recordingCtx(), fit, new Map(), roster([node('ada', 'working')]), new Map()),
  );
  expect(ellipses.some((e) => e.tag === 'hanger-rim')).toBe(true);
});
```

- [ ] **Step 2: Run it and watch it fail**

- [ ] **Step 3: Implement**

Four marks, in this order — the rim is the one that kills the flatness:

1. Tapered vessel (narrower at the base than the mouth).
2. **Rim ellipse** at the mouth.
3. Interior shadow just inside the rim.
4. Cords **converging** to a single ceiling point, and trailing leaves split into a group drawn
   *behind* the vessel and a group drawn *in front*, the rear group shaded with `dim(…, 0.82)`.

- [ ] **Step 4: Run tests, verify visually, commit**

```bash
git commit -am "Give the hanging planter a rim, an interior, and leaves on both sides of the pot."
```

---

## Task 8: Six pieces of art

**Files:**
- Modify: `packages/web/src/live/office-scene/layout.ts` (new `ART` table)
- Modify: `packages/web/src/live/office-scene/render.ts` (`drawWalls`, `wallArt`)
- Test: `packages/web/src/live/office-scene/layout.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
describe('ART', () => {
  it('hangs six pieces, varied in size and shape', () => {
    expect(ART).toHaveLength(6);
    expect(new Set(ART.map((a) => `${a.w}x${a.h}`)).size).toBeGreaterThan(3);
    expect(ART.some((a) => a.w > a.h)).toBe(true); // landscape
    expect(ART.some((a) => a.h > a.w)).toBe(true); // portrait
    expect(ART.some((a) => a.w === a.h)).toBe(true); // square
  });

  it('uses more than one motif and more than one frame treatment', () => {
    expect(new Set(ART.map((a) => a.motif)).size).toBeGreaterThan(2);
    expect(ART.some((a) => a.frame === 'none')).toBe(true);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

- [ ] **Step 3: Implement**

Move the two hard-coded `wallArt(…)` calls in `drawWalls` into an `ART` table in `layout.ts` carrying
`{ wall, tc, uc, w, h, motif, frame }`. Six entries: a salon cluster of three small pieces at close
`tc` values, one large landscape, one portrait, one square unframed. Give `wallArt` a `frame`
parameter (`'thin' | 'thick' | 'none'`) controlling the outer `wallRect`.

The leaning canvas on a bookshelf top is **Task 5's `photo` decor** — already done, do not duplicate
it here.

- [ ] **Step 4: Run tests, verify visually, commit**

```bash
git commit -am "Hang six varied pieces of art instead of two identical ones."
```

---

## Task 9: Unweld the lounge

**Files:**
- Modify: `packages/web/src/live/office-scene/layout.ts` (`LOUNGE`, `RECEPTION`)
- Modify: `packages/web/src/live/office-scene/render.ts` (`couch`, `armchair`, `ctable`)
- Test: `packages/web/src/live/office-scene/seating.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
it('leaves a stride between the couch and the coffee table', () => {
  const gap = Math.hypot(LOUNGE.couch.lx - LOUNGE.table.lx, LOUNGE.couch.ly - LOUNGE.table.ly);
  expect(gap).toBeGreaterThan(LOUNGE.couch.dep / 2 + 24);
});
```

- [ ] **Step 2: Run it and watch it fail**

- [ ] **Step 3: Implement**

Push the table out from the couch. Angle the two armchairs toward each other rather than axis-locking
them — furniture arranged for conversation points inward. Add cushions and a throw breaking the
couch's top edge, and a tray plus books on the table.

- [ ] **Step 4: Re-check occupancy**

```bash
pnpm vitest run packages/web/src/live/office-scene/
```

`LEISURE_SPOTS` and `depthAt` must still put sitters on the furniture they sort with — a couch that
moved without its spots leaves people sitting in mid-air.

- [ ] **Step 5: Verify visually and commit**

```bash
git commit -am "Unweld the lounge: real gaps, angled chairs, cushions and a tray."
```

---

## Task 10: Unweld the huddle

**Files:**
- Modify: `packages/web/src/live/office-scene/render.ts` (`huddleItems`, ~line 1470)
- Test: `packages/web/src/live/office-scene/seating.test.ts`

The poufs sit at ±52/±54 around a 66-wide table — touching. That is why it reads as one welded
object.

- [ ] **Step 1: Write the failing test**

```ts
it('leaves a gap between each pouf and the huddle table', () => {
  const TABLE = 66, POUF = 42;
  for (const [dx, dy] of HUDDLE_POUF_OFFSETS) {
    expect(Math.hypot(dx, dy)).toBeGreaterThan(TABLE / 2 + POUF / 2 + 8);
  }
});
```

- [ ] **Step 2: Run it and watch it fail**

- [ ] **Step 3: Implement**

Export `HUDDLE_POUF_OFFSETS` from `render.ts` (or better, move it to `layout.ts` beside `HUDDLES`),
push each offset out past the gap, and give each pouf a small individual rotation — different amounts
per pouf. A perfect triangle of chairs is a CAD assembly, not a meeting. Widen `h.rugSize` if the
cluster overruns its rug.

- [ ] **Step 4: Run tests, verify visually, commit**

```bash
git commit -am "Push the huddle poufs off the table and knock each off-axis."
```

---

## Task 11: The conference speakerphone

**Files:**
- Modify: `packages/web/src/live/office-scene/render.ts` (`meetingTable`, ~line 1242)
- Test: `packages/web/src/live/office-scene/render.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
it('puts a speakerphone on the meeting table', () => {
  const boxes = capturedBoxes(() =>
    renderScene(recordingCtx(), fit, new Map(), roster([node('ada', 'working')]), new Map()),
  );
  expect(boxes.some((b) => b.tag === 'speakerphone')).toBe(true);
});
```

- [ ] **Step 2: Run it and watch it fail**

- [ ] **Step 3: Implement**

```ts
/** The starfish hub — the object that tells you a table is a conference table. Three lobes, a darker
 *  grille, one LED. Static: a blinking LED would put the whole still layer on the animated one. */
function speakerphone(ctx: CanvasRenderingContext2D, fit: Fit, lx: number, ly: number, up: number): void {
  for (const [dx, dy] of [[0, -9], [8, 5], [-8, 5]] as const) {
    box(ctx, fit, lx + dx, ly + dy, 13, 13, 3, '#3a3a3e', up);
  }
  box(ctx, fit, lx, ly, 17, 17, 4.5, '#2c2c30', up);
  ellipse(ctx, project(lx, ly, fit), 5 * fit.scale, 2.4 * fit.scale, '#4a4a50');
  box(ctx, fit, lx + 5, ly - 4, 1.8, 1.8, 0.6, '#6ee7a0', up + 4.5); // the LED
}
```

Call it from `meetingTable` at the table centre, at the slab's top height.

- [ ] **Step 4: Run tests, verify visually, commit**

```bash
git commit -am "Put a speakerphone hub on the meeting table."
```

---

## Task 12: Make the windows warm and varied

**Files:**
- Modify: `packages/web/src/live/office-scene/layout.ts` (`WINDOWS`)
- Modify: `packages/web/src/live/office-scene/render.ts` (window painter in `drawWalls`)
- Test: `packages/web/src/live/office-scene/layout.test.ts`

**Constraint from nick: warmer and more magical, but they must stay believable windows with real
utility.** Every change below is something that happens in a real room.

- [ ] **Step 1: Write the failing test**

```ts
describe('WINDOWS', () => {
  it('is not four copies of one window', () => {
    expect(new Set(WINDOWS.map((w) => w.mullions)).size).toBeGreaterThan(1);
    expect(WINDOWS.some((w) => w.sill)).toBe(true);
  });

  it('brightens toward one light direction — not at random', () => {
    const bright = WINDOWS.map((w) => w.bright);
    expect(new Set(bright).size).toBeGreaterThan(1);
    expect([...bright]).toEqual([...bright].sort((a, b) => b - a)); // monotone along the wall
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

- [ ] **Step 3: Implement**

Widen `Win` with `mullions: 2 | 3`, `sill: 'plant' | 'mug' | null`, and `bright: number`. Alternate
the mullion count. Give each a warm sill (one plant, one mug). **The `bright` ramp is the change that
does the most for "warm" at zero cost in realism, because it is what actually happens** — windows
nearer the sun are brighter, so it must be monotone along the wall, never random.

Add a soft bloom where each window's light spills onto the wall above it.

- [ ] **Step 4: Re-check the beams**

`drawWindowBeams` derives floor beams from `WINDOWS`. Confirm the beams still line up and that the
brighter windows throw the stronger beams — a bright window with a weak beam breaks the illusion the
ramp just bought.

- [ ] **Step 5: Run tests, verify visually, commit**

```bash
git commit -am "Vary the windows: two mullion patterns, warm sills, a single-sun brightness ramp."
```

---

## Task 13: Hand-lettered clock numerals

**Files:**
- Modify: `packages/web/src/live/office-scene/render.ts` (`wallClock`, ~line 623)
- Test: `packages/web/src/live/office-scene/render.test.ts`

**Constraint:** `R = 25` → about 26 px across on `/live`. Nick's call was **keep the size and design
the numerals as texture**. Individual numerals are below the legibility floor there; the eye reads
the *pattern* of four heavy marks and eight light ones as a clock face. That is the trick, and it is
why this works at all.

- [ ] **Step 1: Write the failing test**

```ts
describe('the wall clock', () => {
  it('sets twelve numerals with the quarters heavier', () => {
    expect(CLOCK_NUMERALS).toHaveLength(12);
    const heavy = CLOCK_NUMERALS.filter((n) => n.big);
    expect(heavy.map((n) => n.hour).sort((a, b) => a - b)).toEqual([3, 6, 9, 12]);
  });

  it('draws numerals as strokes, not canvas text — 4px glyphs are a smear', () => {
    const texts: string[] = [];
    renderScene(textCtx([], texts), fit, new Map(), roster([node('ada', 'working')]), new Map());
    expect(texts).not.toContain('12');
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

- [ ] **Step 3: Implement**

Replace the 12 `wallDisc` ticks with hand-drawn numeral strokes in the same wobbled marker character
as the whiteboard. Define each numeral as a short polyline in a unit box, drawn through `wallPt` so
it shears with the wall:

```ts
/** Numerals as stroke paths in a unit box, not glyphs: at /live a numeral is ~4px, where canvas text
 *  renders as a grey smear and no font token can help. Hand-drawn strokes stay marks at that size and
 *  resolve into hand-lettered characters at /broadcast and /office-preview scale — which is the whole
 *  design. The quarters are set larger so the ring has four heavy marks and eight light ones; that
 *  rhythm is what reads as "a numbered dial" when the numerals themselves cannot be made out. */
export const CLOCK_NUMERALS: ReadonlyArray<{ hour: number; big: boolean; strokes: [number, number][][] }> = [ … ];
```

- [ ] **Step 4: Run tests**

- [ ] **Step 5: Verify at BOTH scales**

This task fails or passes on the visual. On `/live`: a clock with a numbered dial — not a blank disc,
not mush. On `/office-preview`: individually readable numerals with visible hand character. If the
`/live` read is mush, increase the quarter/minor size ratio before touching anything else.

- [ ] **Step 6: Commit**

```bash
git commit -am "Give the clock hand-lettered numerals that read as a ring at /live."
```

---

## Task 14: Full-suite gate and perf check

- [ ] **Step 1: Run everything**

```bash
pnpm vitest run
pnpm --filter @musterd/web build
pnpm perf:check
pnpm lint
pnpm exec prettier --check "packages/web/src/live/**/*.{ts,css}"
```

`pnpm lint` is a separate gate from `format:check` — run both. **Never run `pnpm format`** (it
rewrites the whole tree); use `pnpm exec prettier --write <your files>`.

- [ ] **Step 2: If a byte budget moved**

Read the failure message — `initialJsGzipBytes` and `totalJsGzipBytes` have different remedies. This
plan adds only painter code, so any movement lands on `total`, whose remedy is deleting code, not
lazy-loading. Log any raise in `docs/perf/web-live-baseline.md` in the same PR (ADR 151).

- [ ] **Step 3: Final visual pass**

Build, restart preview, walk `/office-preview` and `/live`. Check the empty-office state too.

- [ ] **Step 4: Commit and open the PR**

```bash
git commit -am "Gate the room dressing pass: full suite, perf, lint."
gh pr create --fill
gh pr merge --squash --auto --delete-branch
```

---

## Self-review

**Spec coverage:** §1 nameplate → Task 1. §2 whiteboard → Task 2. §3.1 carcasses → Task 3; §3.2 decor
→ Task 5; §3.3 reversed → Task 5; §3.4 books → Task 4. §4 kitchenette → Task 6. §5 planter → Task 7.
§6 art → Task 8. §7 lounge → Task 9. §8 huddle → Task 10. §9 speakerphone → Task 11. §10 windows →
Task 12. §11 clock → Task 13. Testing/perf → Task 14. **No gaps.**

**Type consistency:** `shelfRnd(shelf, book, salt)` is used with that signature in Tasks 4 and 5.
`Bookshelf.long/deep/high/rows/tone/reversed/decor` are defined in Task 3 and consumed in 4 and 5.
`BOOK_COLORS` and `PAGE_EDGE` are defined once each. `drawPlant` gains its `up` parameter in Task 5
and is relied on by nothing earlier.

**Known soft spots for the implementer:** the recording-context test helpers (`capturedBoxes`,
`recordingCtx`, `capturedEllipses`, `strokeCountingCtx`, and the `tag` field on captured primitives)
do not exist yet. Build them in Task 2 alongside the existing `textCtx` helper and extend as needed —
tagging requires threading an optional `tag` argument through `box`/`ellipse`, which is a
test-visibility change, not a rendering one.
