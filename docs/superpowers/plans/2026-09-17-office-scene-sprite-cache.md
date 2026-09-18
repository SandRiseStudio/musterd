# Office scene sprite cache — implementation plan

> **For agentic workers:** this plan is executed inline, in the owner's lane (musterd; CLAUDE.md
> forbids writing subagents). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `/broadcast` at 1080p holds ≤ 25 ms per draw by rasterizing each static item of the office
once and blitting it, pixel-identical to the full redraw, dark behind `OfficeOptions.sprites`.

**Architecture:** A small LRU `SpriteCache` rasterizes an item's draw function into an offscreen
canvas at the item's real device position. `renderScene`'s depth-sorted items gain optional `parts`
(sprite / live sequences); the loop runs the parts when a cache is supplied, else the untouched `fn`.
The room shell (shadow, floor, walls minus their live fixtures, beams, rugs) becomes one full-stage
sprite; the wall clock, working-hours sign and lane board are lifted to a live call at the same point
in the sequence. Bounding boxes are *measured* by a dry run through a bounds-tracking context, not
hand-estimated.

**Tech Stack:** TypeScript, canvas 2D, vitest (`environment: 'node'`, recording proxy contexts),
headless Chrome over CDP for the pixel gate (same launch pattern as `scripts/a11y/contrast-sweep.mjs`).

**Spec:** `docs/superpowers/specs/2026-09-17-office-scene-sprite-cache-design.md`

## Global constraints

- Fidelity: the sprite path composites to **exactly** what the full redraw produces (spec §Goal).
  See "Known risk: 8-bit premultiplied intermediates" below — the gate reports, nick decides.
- No depth value or draw order changes. No change to `drawInteriorLight`, actors, pet, queue pads,
  cues, count pills, vignette, labels.
- `bake()` never receives a cache (its output is the pixel test's honest reference).
- Dark by default: `OfficeOptions.sprites?: boolean`; `/broadcast` reads `&sprites=1`.
- `t` is never in a key. `Date.now()`-derived values enter a key only as the quantized string the
  draw actually paints with.
- No new native dependency (`@napi-rs/canvas` etc.). Chrome is already required by the perf scripts.
- pnpm is `/Users/nick/Library/pnpm/pnpm` on this laptop (not on the harness PATH).
- Tests: `cd packages/web && /Users/nick/Library/pnpm/pnpm exec vitest run src/live/office-scene/<file>`.
- Every commit: `Co-Authored-By` + `Claude-Session` trailers from the session reminder.

## Deviations from the spec (decided while planning; nick may veto)

1. **`sprite: {key, box, live?}` → `parts: Part[]`.** A *working* desk cannot be "sprite + live
   overlay": the lit screen's bloom is `globalCompositeOperation = 'lighter'` (additive over whatever
   is under it at that moment), and the dock/keyboard/mouse props sort *after* the monitor and paint
   over the spill. Rasterizing 'lighter' into a transparent sprite and blitting it is not the same
   composite. So a working desk is three parts in one depth slot: sprite(pre-monitor props incl.
   stand + panel casing) → live(screen face + bloom) → sprite(post-monitor props). An idle desk is one
   sprite. The background is sprite(shell) → live(clock, sign, board).
2. **Boxes are measured, not estimated.** A `boundsCtx` dry run (JS only, once per cache miss) gives
   the exact extent of every path/rect/text op; padding 24 device px covers stroke and shadow overhang.
   Removes the "box too small" failure class except for shadows/strokes, which the pixel gate still
   catches.
3. **Keys carry what actually changes pixels.** `fit.ox`/`fit.oy` join every key (they move the
   pixel grid); the background key carries `glassColor(env)`, `env.skyTint`, `env.skyStrength`,
   `env.daylight` (what walls and beams read) instead of `veilAlpha`/`lampsOn` (read only by
   `drawInteriorLight`, which is not cached). `lightEnv` is recomputed once per `LIGHT_TICK_MS`
   (a minute), so exact values cost one cold background per minute.
4. The workstation key adds `node.name`, `teamName` (desk mood props), `steppedAway`, and the
   owned-desk afterglow alpha string `(0.18*warmth).toFixed(3)`.

## Known risk: 8-bit premultiplied intermediates

A sprite stores partial-coverage and translucent pixels premultiplied in 8 bits, then composites
them; the direct path rounds once. Antialiased edges and `rgba(...,0.14)` shadows may differ by ±1
per channel. The gate (Task 9) reports `differing`, `maxDelta` and a delta histogram. If the only
differences are `maxDelta ≤ 1`, that is a decision for nick ("pixel-identical modulo 8-bit rounding"
vs stop), not a scope change — report the histogram, do not loosen the gate silently.

## File structure

| file | responsibility |
|---|---|
| `packages/web/src/live/office-scene/sprite-cache.ts` (new) | `SpriteCache` LRU, device-box maths, context state reset, `boundsCtx` measurer |
| `packages/web/src/live/office-scene/sprite-cache.test.ts` (new) | cache unit tests + bounds measurer tests |
| `packages/web/src/live/office-scene/recording-ctx.ts` (new, test-only) | recording proxy context shared by the equivalence tests |
| `packages/web/src/live/office-scene/render.ts` | `Item.parts`, `renderScene(..., opts)`, phase-aware `drawWorkstation`/`monitor`/`screenPanel`, `drawWalls` static/live split, `drawWallLive`, key helpers |
| `packages/web/src/live/office-scene/render.test.ts` | op-sequence equivalence tests |
| `packages/web/src/live/office-scene/index.ts` | `OfficeOptions.sprites`, cache lifetime, `OfficeHandle.spriteParity()` |
| `packages/web/src/live/office-scene/types.ts` | `OfficeHandle.spriteParity` type |
| `packages/web/src/routes/broadcast.tsx` | `&sprites=1` |
| `packages/web/src/routes/office-preview.tsx` | `?sprites`, `?members=N` fixture knob |
| `scripts/perf/scene-pixel-check.mjs` (new) | the Chrome gate, `pnpm scene:pixel-check` |
| `docs/wiki/broadcast-stream.md` | the measured claim (Task 10) |

---

### Task 1: `SpriteCache` — LRU, device box, state reset

**Files:**
- Create: `packages/web/src/live/office-scene/sprite-cache.ts`
- Create: `packages/web/src/live/office-scene/sprite-cache.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface SpriteBox { x: number; y: number; w: number; h: number } // device px, integers
  export interface CssBounds { x0: number; y0: number; x1: number; y1: number } // CSS px, any reals
  export interface SpriteCache {
    get(key: string, box: SpriteBox, draw: (ctx: CanvasRenderingContext2D) => void): CanvasImageSource;
    size(): number;
    clear(): void;
  }
  export const SPRITE_PAD = 24; // device px
  export function deviceBox(b: CssBounds, dpr: number, pad?: number): SpriteBox;
  export function resetCtxState(ctx: CanvasRenderingContext2D): void;
  export function makeSpriteCache(opts: { dpr: number; max?: number; createCanvas?: (w: number, h: number) => HTMLCanvasElement }): SpriteCache;
  ```

- [ ] **Step 1: Write the failing tests**

```ts
// sprite-cache.test.ts
import { describe, expect, it } from 'vitest';
import { deviceBox, makeSpriteCache, resetCtxState, SPRITE_PAD, type SpriteBox } from './sprite-cache';

/** A fake canvas whose context records every call and property set, so the cache is testable in node. */
function fakeCanvasFactory() {
  const made: { w: number; h: number; ops: string[]; state: Record<string, unknown> }[] = [];
  const createCanvas = (w: number, h: number): HTMLCanvasElement => {
    const rec = { w, h, ops: [] as string[], state: {} as Record<string, unknown> };
    made.push(rec);
    const ctx = new Proxy({} as Record<string, unknown>, {
      get(_t, prop) {
        if (prop === 'canvas') return canvas;
        return (...args: unknown[]) => { rec.ops.push(`${String(prop)}(${args.join(',')})`); };
      },
      set(_t, prop, v) { rec.state[String(prop)] = v; rec.ops.push(`${String(prop)}=${String(v)}`); return true; },
    });
    const canvas = { width: w, height: h, getContext: () => ctx } as unknown as HTMLCanvasElement;
    return canvas;
  };
  return { made, createCanvas };
}

describe('deviceBox', () => {
  it('floors the origin, ceils the far edge, and pads in device px', () => {
    expect(deviceBox({ x0: 10.4, y0: 20.6, x1: 30.2, y1: 40.1 }, 2, 0)).toEqual({ x: 20, y: 41, w: 41, h: 40 });
    const b = deviceBox({ x0: 10.4, y0: 20.6, x1: 30.2, y1: 40.1 }, 2);
    expect(b).toEqual({ x: 20 - SPRITE_PAD, y: 41 - SPRITE_PAD, w: 41 + 2 * SPRITE_PAD, h: 40 + 2 * SPRITE_PAD });
  });
  it('never returns a zero-sized box', () => {
    expect(deviceBox({ x0: 5, y0: 5, x1: 5, y1: 5 }, 1, 0)).toEqual({ x: 5, y: 5, w: 1, h: 1 });
  });
});

describe('makeSpriteCache', () => {
  const box: SpriteBox = { x: 100, y: 200, w: 50, h: 40 };
  it('misses once per key, then hits without redrawing', () => {
    const { made, createCanvas } = fakeCanvasFactory();
    const cache = makeSpriteCache({ dpr: 2, createCanvas });
    let draws = 0;
    const draw = () => { draws++; };
    const a = cache.get('k', box, draw);
    const b = cache.get('k', box, draw);
    expect(a).toBe(b);
    expect(draws).toBe(1);
    expect(made).toHaveLength(1);
    expect(made[0]).toMatchObject({ w: 50, h: 40 });
    expect(cache.size()).toBe(1);
  });
  it('draws under setTransform(dpr,0,0,dpr,-box.x,-box.y) so the sprite keeps the item on its own pixel grid', () => {
    const { made, createCanvas } = fakeCanvasFactory();
    const cache = makeSpriteCache({ dpr: 2, createCanvas });
    cache.get('k', box, (ctx) => ctx.fillRect(1, 2, 3, 4));
    const ops = made[0]!.ops;
    expect(ops[0]).toBe('setTransform(2,0,0,2,-100,-200)');
    expect(ops.at(-1)).toBe('fillRect(1,2,3,4)');
  });
  it('resets every inherited context property before drawing', () => {
    const { made, createCanvas } = fakeCanvasFactory();
    const cache = makeSpriteCache({ dpr: 1, createCanvas });
    cache.get('k', box, () => {});
    expect(made[0]!.state).toMatchObject({
      globalAlpha: 1,
      globalCompositeOperation: 'source-over',
      shadowBlur: 0,
      shadowColor: 'rgba(0, 0, 0, 0)',
      shadowOffsetX: 0,
      shadowOffsetY: 0,
      lineWidth: 1,
      lineCap: 'butt',
      lineJoin: 'miter',
      miterLimit: 10,
      lineDashOffset: 0,
      font: '10px sans-serif',
      textAlign: 'start',
      textBaseline: 'alphabetic',
      fillStyle: '#000000',
      strokeStyle: '#000000',
      filter: 'none',
      imageSmoothingEnabled: true,
    });
    expect(made[0]!.ops).toContain('setLineDash()');
  });
  it('evicts least-recently-used past max', () => {
    const { made, createCanvas } = fakeCanvasFactory();
    const cache = makeSpriteCache({ dpr: 1, max: 2, createCanvas });
    cache.get('a', box, () => {});
    cache.get('b', box, () => {});
    cache.get('a', box, () => {}); // touch a → b is now LRU
    cache.get('c', box, () => {}); // evicts b
    expect(cache.size()).toBe(2);
    cache.get('a', box, () => {});
    expect(made).toHaveLength(3); // a still cached
    cache.get('b', box, () => {});
    expect(made).toHaveLength(4); // b was evicted and redrawn
  });
  it('clear() drops everything', () => {
    const { createCanvas } = fakeCanvasFactory();
    const cache = makeSpriteCache({ dpr: 1, createCanvas });
    cache.get('a', box, () => {});
    cache.clear();
    expect(cache.size()).toBe(0);
  });
});

describe('resetCtxState', () => {
  it('is what the cache applies (single source of the default list)', () => {
    const state: Record<string, unknown> = {};
    const ops: string[] = [];
    const ctx = new Proxy({} as Record<string, unknown>, {
      get: (_t, p) => (...a: unknown[]) => { ops.push(`${String(p)}(${a.join(',')})`); },
      set: (_t, p, v) => { state[String(p)] = v; return true; },
    }) as unknown as CanvasRenderingContext2D;
    resetCtxState(ctx);
    expect(state.globalAlpha).toBe(1);
    expect(ops).toContain('setLineDash()');
  });
});
```

- [ ] **Step 2: Run the tests — expect FAIL (module not found)**

Run: `cd packages/web && /Users/nick/Library/pnpm/pnpm exec vitest run src/live/office-scene/sprite-cache.test.ts`

- [ ] **Step 3: Implement**

```ts
// sprite-cache.ts
/**
 * Per-item sprite cache for the office scene (spec: docs/superpowers/specs/2026-09-17-office-scene-sprite-cache-design.md).
 *
 * A static item is rasterized ONCE into its own offscreen canvas at its real device position, then
 * blitted with one `drawImage` on every frame. The depth sort is untouched — only HOW an item paints
 * changes, never WHERE or in what order — so occlusion is preserved by construction.
 */

/** Device-pixel box, integer. `x,y` is the offscreen canvas' origin on the stage. */
export interface SpriteBox { x: number; y: number; w: number; h: number }
/** CSS-pixel extent (what a draw function's coordinates are in). */
export interface CssBounds { x0: number; y0: number; x1: number; y1: number }

export interface SpriteCache {
  /** Rasterize `draw` once for `key` at device box `box`; return the sprite to blit at `(box.x, box.y)`. */
  get(key: string, box: SpriteBox, draw: (ctx: CanvasRenderingContext2D) => void): CanvasImageSource;
  size(): number;
  clear(): void;
}

/** Device px added on every side of a measured extent — stroke half-widths, contact-shadow blur, AA. */
export const SPRITE_PAD = 24;

export function deviceBox(b: CssBounds, dpr: number, pad = SPRITE_PAD): SpriteBox {
  const x = Math.floor(b.x0 * dpr) - pad;
  const y = Math.floor(b.y0 * dpr) - pad;
  const x1 = Math.ceil(b.x1 * dpr) + pad;
  const y1 = Math.ceil(b.y1 * dpr) + pad;
  return { x, y, w: Math.max(1, x1 - x), h: Math.max(1, y1 - y) };
}

/**
 * The 2D context defaults (HTML spec). A sprite's context is fresh, but a REUSED canvas is not, and
 * the direct path's items inherit whatever the previous item left — the equivalence tests prove each
 * cached item sets what it reads (render.test.ts "sets before it reads"), so starting from defaults
 * is exactly equivalent.
 */
export function resetCtxState(ctx: CanvasRenderingContext2D): void {
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
  ctx.shadowBlur = 0;
  ctx.shadowColor = 'rgba(0, 0, 0, 0)';
  ctx.shadowOffsetX = 0;
  ctx.shadowOffsetY = 0;
  ctx.lineWidth = 1;
  ctx.lineCap = 'butt';
  ctx.lineJoin = 'miter';
  ctx.miterLimit = 10;
  ctx.setLineDash([]);
  ctx.lineDashOffset = 0;
  ctx.font = '10px sans-serif';
  ctx.textAlign = 'start';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = '#000000';
  ctx.strokeStyle = '#000000';
  ctx.filter = 'none';
  ctx.imageSmoothingEnabled = true;
}

function domCanvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

export function makeSpriteCache(opts: {
  dpr: number;
  max?: number;
  createCanvas?: (w: number, h: number) => HTMLCanvasElement;
}): SpriteCache {
  const max = opts.max ?? 128;
  const create = opts.createCanvas ?? domCanvas;
  // Map preserves insertion order; delete+set on hit moves the key to the back → the front is LRU.
  const entries = new Map<string, HTMLCanvasElement>();
  return {
    get(key, box, draw) {
      const hit = entries.get(key);
      if (hit) {
        entries.delete(key);
        entries.set(key, hit);
        return hit;
      }
      const canvas = create(box.w, box.h);
      const ctx = canvas.getContext('2d')!;
      // Same pixel grid as the stage: a CSS coordinate c lands at c*dpr - box.x device px, keeping its
      // fractional part, so sub-pixel antialiasing matches the direct path exactly.
      ctx.setTransform(opts.dpr, 0, 0, opts.dpr, -box.x, -box.y);
      resetCtxState(ctx);
      draw(ctx);
      entries.set(key, canvas);
      if (entries.size > max) entries.delete(entries.keys().next().value as string);
      return canvas;
    },
    size: () => entries.size,
    clear: () => entries.clear(),
  };
}
```

Note the test asserts `ops[0]` is `setTransform`, so call it before `resetCtxState`.

- [ ] **Step 4: Run — expect PASS**
- [ ] **Step 5: Commit** — `feat(office): SpriteCache — LRU of per-item offscreen rasters (spec 2026-09-17)`

---

### Task 2: `boundsCtx` — measure an item's extent with a dry run

**Files:**
- Modify: `packages/web/src/live/office-scene/sprite-cache.ts`
- Modify: `packages/web/src/live/office-scene/sprite-cache.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export function measureBounds(draw: (ctx: CanvasRenderingContext2D) => void): CssBounds | null; // null = drew nothing
  ```
  Tracks the CTM through `save/restore/translate/rotate/scale/transform/setTransform/resetTransform`
  and folds in every point of `moveTo lineTo bezierCurveTo quadraticCurveTo arc arcTo ellipse rect
  roundRect fillRect strokeRect clearRect fillText strokeText drawImage`. Text width: `measureText`
  returns `{ width: 0.6 * fontPx * text.length }` (padding covers the rest — a 24 px pad at 1080p is
  wider than any label glyph run's error). Gradients return a stub with `addColorStop`.

- [ ] **Step 1: Failing tests**

```ts
import { measureBounds } from './sprite-cache';

describe('measureBounds', () => {
  it('returns null when nothing is drawn', () => {
    expect(measureBounds(() => {})).toBeNull();
  });
  it('covers rects, paths and arcs', () => {
    const b = measureBounds((c) => {
      c.fillRect(10, 20, 5, 5);
      c.beginPath(); c.moveTo(0, 0); c.lineTo(50, 60); c.stroke();
      c.beginPath(); c.arc(100, 100, 10, 0, Math.PI * 2); c.fill();
      c.beginPath(); c.ellipse(-20, -20, 4, 8, 0, 0, Math.PI * 2); c.fill();
    });
    expect(b).toEqual({ x0: -24, y0: -28, x1: 110, y1: 110 });
  });
  it('applies translate/scale/rotate and save/restore', () => {
    const b = measureBounds((c) => {
      c.save();
      c.translate(100, 0);
      c.scale(2, 2);
      c.fillRect(0, 0, 10, 10); // → 100..120
      c.restore();
      c.fillRect(0, 0, 1, 1); // → 0..1
    });
    expect(b).toEqual({ x0: 0, y0: 0, x1: 120, y1: 20 });
    const r = measureBounds((c) => { c.rotate(Math.PI / 2); c.fillRect(0, 0, 10, 0); });
    expect(r!.x1).toBeCloseTo(0, 6);
    expect(r!.y1).toBeCloseTo(10, 6);
  });
  it('estimates text from the font size', () => {
    const b = measureBounds((c) => { c.font = '20px sans-serif'; c.fillText('abcd', 10, 50); });
    expect(b).toEqual({ x0: 10, y0: 30, x1: 10 + 0.6 * 20 * 4, y1: 50 + 20 * 0.3 });
  });
});
```

- [ ] **Step 2: Run — expect FAIL**
- [ ] **Step 3: Implement** (append to `sprite-cache.ts`)

```ts
type M = [number, number, number, number, number, number]; // a b c d e f (canvas CTM)
const mul = (m: M, n: M): M => [
  m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5],
];

/** Dry-run `draw` against a context that only tracks the CTM and the extent of every point it touches. */
export function measureBounds(draw: (ctx: CanvasRenderingContext2D) => void): CssBounds | null {
  let m: M = [1, 0, 0, 1, 0, 0];
  const stack: M[] = [];
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  let fontPx = 10;
  const pt = (x: number, y: number): void => {
    const px = m[0] * x + m[2] * y + m[4];
    const py = m[1] * x + m[3] * y + m[5];
    if (px < x0) x0 = px; if (px > x1) x1 = px;
    if (py < y0) y0 = py; if (py > y1) y1 = py;
  };
  const box = (x: number, y: number, w: number, h: number): void => { pt(x, y); pt(x + w, y); pt(x, y + h); pt(x + w, y + h); };
  const grad = { addColorStop(): void {} };
  const methods: Record<string, (...a: number[]) => void> = {
    save: () => { stack.push(m); },
    restore: () => { m = stack.pop() ?? m; },
    translate: (x, y) => { m = mul(m, [1, 0, 0, 1, x, y]); },
    scale: (x, y) => { m = mul(m, [x, 0, 0, y, 0, 0]); },
    rotate: (r) => { const c = Math.cos(r), s = Math.sin(r); m = mul(m, [c, s, -s, c, 0, 0]); },
    transform: (a, b, c, d, e, f) => { m = mul(m, [a, b, c, d, e, f]); },
    setTransform: (a, b, c, d, e, f) => { m = [a, b, c, d, e, f]; },
    resetTransform: () => { m = [1, 0, 0, 1, 0, 0]; },
    moveTo: pt, lineTo: pt,
    bezierCurveTo: (a, b, c, d, e, f) => { pt(a, b); pt(c, d); pt(e, f); },
    quadraticCurveTo: (a, b, c, d) => { pt(a, b); pt(c, d); },
    arc: (x, y, r) => box(x - r, y - r, 2 * r, 2 * r),
    arcTo: (a, b, c, d, r) => { box(a - r, b - r, 2 * r, 2 * r); box(c - r, d - r, 2 * r, 2 * r); },
    ellipse: (x, y, rx, ry) => { const r = Math.max(rx, ry); box(x - r, y - r, 2 * r, 2 * r); },
    rect: box, fillRect: box, strokeRect: box, clearRect: box, roundRect: box,
    drawImage: (...a) => { if (a.length >= 9) box(a[5]!, a[6]!, a[7]!, a[8]!); else if (a.length >= 5) box(a[1]!, a[2]!, a[3]!, a[4]!); },
  };
  const text = (s: unknown, x: number, y: number): void => {
    const w = 0.6 * fontPx * String(s).length;
    box(x - w, y - fontPx, 2 * w, fontPx * 1.3); // any textAlign/baseline: cover both sides and asc+desc
  };
  const ctx = new Proxy({} as Record<string, unknown>, {
    get(_t, prop) {
      const p = String(prop);
      if (p === 'canvas') return { width: 0, height: 0 };
      if (p === 'measureText') return (s: string) => ({ width: 0.6 * fontPx * s.length });
      if (p === 'createLinearGradient' || p === 'createRadialGradient' || p === 'createConicGradient') return () => grad;
      if (p === 'createPattern') return () => null;
      if (p === 'fillText' || p === 'strokeText') return text;
      if (p === 'getTransform') return () => ({ a: m[0], b: m[1], c: m[2], d: m[3], e: m[4], f: m[5] });
      return methods[p] ?? (() => undefined);
    },
    set(_t, prop, v) {
      if (prop === 'font' && typeof v === 'string') { const mm = /(\d+(?:\.\d+)?)px/.exec(v); if (mm) fontPx = Number(mm[1]); }
      return true;
    },
  }) as unknown as CanvasRenderingContext2D;
  draw(ctx);
  return x0 === Infinity ? null : { x0, y0, x1, y1 };
}
```

Adjust the text test expectation to what this box formula yields (`x0 = 10 - w`, `y0 = 50 - 20`,
`x1 = 10 + w`, `y1 = 50 + 6`) — the test above is written for the simpler formula; the two-sided one
is the one to keep (labels may be centred). Fix the test, not the code.

- [ ] **Step 4: Run — expect PASS**
- [ ] **Step 5: Commit** — `feat(office): measureBounds — dry-run extent of a draw fn for sprite boxes`

---

### Task 3: Recording context + `Item.parts` + the loop

**Files:**
- Create: `packages/web/src/live/office-scene/recording-ctx.ts`
- Modify: `packages/web/src/live/office-scene/render.ts` — `Item`, `renderScene` signature and loop
- Modify: `packages/web/src/live/office-scene/render.test.ts`

**Interfaces:**
- Produces (render.ts):
  ```ts
  export type SpritePart =
    | { kind: 'sprite'; key: string; draw: (ctx: CanvasRenderingContext2D) => void }
    | { kind: 'live'; draw: () => void };
  export interface RenderOpts { sprites?: SpriteCache | undefined; dpr?: number }
  export function renderScene(ctx, fit, placements, byName, poses, t, teamName, env, pet, fx, recep, wallBoard, teamWorkingHours, opts?: RenderOpts): SceneAnchors
  ```
  `DepthItem` gains `parts?: SpritePart[]`. A sprite part's box is measured by the loop:
  `deviceBox(measureBounds(part.draw)!, dpr)`; if `measureBounds` returns null the part is skipped
  (it drew nothing). The blit:
  ```ts
  const sprite = cache.get(part.key, box, part.draw);
  ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.drawImage(sprite, box.x, box.y); ctx.restore();
  ```
  (`save/restore` keeps the dpr transform; an integer blit under identity = no resampling.)
- Produces (recording-ctx.ts):
  ```ts
  export interface RecordedOp { name: string; args: unknown[] }
  export function recordingCtx(): { ctx: CanvasRenderingContext2D; ops: RecordedOp[] }
  ```
  Records every method call and every property set (`{ name: 'set:fillStyle', args: [v] }`);
  gradients are recorded as `createLinearGradient(...)` + `addColorStop(...)`; `measureText` → 0.

- [ ] **Step 1: Failing test** (render.test.ts)

```ts
import { recordingCtx } from './recording-ctx';
import { makeSpriteCache, type SpriteCache } from './sprite-cache';

/** A cache that draws straight onto the caller's context (no offscreen) — lets a node test prove
 * the sprite wiring emits the same ops as the direct path, minus the blit bookkeeping. */
function passthroughCache(ctx: CanvasRenderingContext2D): SpriteCache {
  return { get: (_k, _b, draw) => { draw(ctx); return {} as CanvasImageSource; }, size: () => 0, clear: () => {} };
}
const BLIT_OPS = new Set(['save', 'restore', 'setTransform', 'drawImage']);
const sceneOps = (ops: { name: string; args: unknown[] }[]) => ops.filter((o) => !BLIT_OPS.has(o.name)).map((o) => `${o.name}(${o.args.map(String).join(',')})`);

describe('sprite parts', () => {
  it('with a cache, renderScene emits the direct path\'s ops in the same order (blit bookkeeping aside)', () => {
    const fit = fitFloor(1920, 1080);
    const { placements, byName, poses } = scene24(); // existing fixture helper in this file — reuse the one the painter's-order tests use
    const a = recordingCtx();
    renderScene(a.ctx, fit, placements, byName, poses, 3, 'revive', DAY, null);
    const b = recordingCtx();
    renderScene(b.ctx, fit, placements, byName, poses, 3, 'revive', DAY, null, undefined, null, null, null, { sprites: passthroughCache(b.ctx), dpr: 1 });
    expect(sceneOps(b.ops)).toEqual(sceneOps(a.ops));
  });
});
```

(Use whatever the file's existing 24-member fixture builder is called; if none exists, build one from
`assignSeats` + `homePoses` the way `renderScene` tests near line 460 do.) This test passes trivially
until items carry `parts`; it is the standing invariant every later task must keep green.

- [ ] **Step 2: Implement `recording-ctx.ts`**

```ts
export interface RecordedOp { name: string; args: unknown[] }
/** Test-only: a 2D context that records every call and property set, in order. */
export function recordingCtx(): { ctx: CanvasRenderingContext2D; ops: RecordedOp[] } {
  const ops: RecordedOp[] = [];
  const grad = { addColorStop: (s: number, c: string) => { ops.push({ name: 'addColorStop', args: [s, c] }); } };
  const ctx = new Proxy({} as Record<string, unknown>, {
    get(_t, prop) {
      const name = String(prop);
      if (name === 'canvas') return { width: 1920, height: 1080 };
      if (name === 'measureText') return () => ({ width: 0 });
      if (name.startsWith('create') && name.endsWith('Gradient')) return (...args: unknown[]) => { ops.push({ name, args }); return grad; };
      return (...args: unknown[]) => { ops.push({ name, args }); };
    },
    set(_t, prop, value) { ops.push({ name: `set:${String(prop)}`, args: [value] }); return true; },
  });
  return { ctx: ctx as unknown as CanvasRenderingContext2D, ops };
}
```

- [ ] **Step 3: Implement `parts` in render.ts**

Change `DepthItem` (line ~1826) and the local `Item` in `renderScene` to one exported type:

```ts
export type SpritePart =
  | { kind: 'sprite'; key: string; draw: (ctx: CanvasRenderingContext2D) => void }
  | { kind: 'live'; draw: () => void };
export interface DepthItem {
  d: number;
  /** The direct draw — the whole item, unchanged. */
  fn: () => void;
  /** Optional cached form: the same pixels as `fn`, as sprite/live parts in order. Used only when
   * `renderScene` is given a SpriteCache. */
  parts?: SpritePart[];
}
export interface RenderOpts { sprites?: SpriteCache | undefined; dpr?: number | undefined }
```

Replace `interface Item {...}` + `const items: Item[]` with `const items: DepthItem[]`. Add the
trailing `opts: RenderOpts = {}` parameter. Replace the loop:

```ts
  items.sort((a, b) => a.d - b.d);
  const cache = opts.sprites;
  const dpr = opts.dpr ?? 1;
  for (const it of items) {
    if (!cache || !it.parts) { it.fn(); continue; }
    for (const part of it.parts) {
      if (part.kind === 'live') { part.draw(); continue; }
      const bounds = measureBounds(part.draw);
      if (!bounds) continue;
      const box = deviceBox(bounds, dpr);
      const sprite = cache.get(part.key, box, part.draw);
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.drawImage(sprite, box.x, box.y);
      ctx.restore();
    }
  }
```

Import `deviceBox, measureBounds, type SpriteCache` from `./sprite-cache`.

- [ ] **Step 4: Run render.test.ts + typecheck (`pnpm -F @musterd/web typecheck`) — expect PASS**
- [ ] **Step 5: Commit** — `feat(office): DepthItem.parts + renderScene({sprites}) — the loop blits when given a cache`

---

### Task 4: Workstations

**Files:**
- Modify: `render.ts` — `screenPanel`, `monitor`, `drawWorkstation`, `deskStationItems`
- Modify: `render.test.ts`

**Interfaces:**
- `screenPanel(..., t, face: 'all' | 'skip' | 'only' = 'all')` — `'skip'` draws only the casing
  `box(...)`; `'only'` draws only the face block (`if (BL && BR) {...}`), no casing.
- `monitor(..., t, face = 'all')` threads it; under `'only'` the stand is skipped too.
- `drawWorkstation(..., atWork, phase: 'all' | 'pre' | 'screen' | 'post' = 'all')`:
  - `'pre'`: legs, slab, lip, then sorted props with `sum <= monitorSum` where the monitor is drawn
    with `face: 'skip'`.
  - `'screen'`: the monitor only, `face: 'only'`.
  - `'post'`: sorted props with `sum > monitorSum`.
  - `monitorSum = deskPropSort(dir, Df / 2 - 12, 0)`. Two props share that sum (the owned-desk
    afterglow rect); it is pushed after the monitor and `Array.prototype.sort` is stable, so `<=`
    keeps it in `'pre'` — matching direct order (afterglow paints after the monitor, before later
    props). Verify with the equivalence test, not by reasoning.
- `export function workstationKey(...)` builds the key.

- [ ] **Step 1: Failing tests**

```ts
describe('workstation phases', () => {
  const fit = fitFloor(1920, 1080);
  const slot = DESK_SLOTS.find((s) => s.kind !== 'bench')!;
  const owner = node('ava', 'working');
  for (const [label, n, atWork] of [['empty', null, false], ['owner idle', owner, false], ['owner working', owner, true]] as const) {
    it(`${label}: pre ++ screen ++ post == all`, () => {
      const all = recordingCtx();
      drawWorkstation(all.ctx, fit, slot, n, 'revive', false, 3, undefined, true, atWork, 'all');
      const split = recordingCtx();
      for (const phase of ['pre', 'screen', 'post'] as const) drawWorkstation(split.ctx, fit, slot, n, 'revive', false, 3, undefined, true, atWork, phase);
      expect(fmt(split.ops)).toEqual(fmt(all.ops));
    });
  }
  it('the screen phase is the only one that reads t', () => {
    const a = recordingCtx(); drawWorkstation(a.ctx, fit, slot, owner, 'revive', false, 1, undefined, true, true, 'pre');
    const b = recordingCtx(); drawWorkstation(b.ctx, fit, slot, owner, 'revive', false, 9, undefined, true, true, 'pre');
    expect(fmt(a.ops)).toEqual(fmt(b.ops));
    const c = recordingCtx(); drawWorkstation(c.ctx, fit, slot, owner, 'revive', false, 1, undefined, true, true, 'post');
    const d = recordingCtx(); drawWorkstation(d.ctx, fit, slot, owner, 'revive', false, 9, undefined, true, true, 'post');
    expect(fmt(c.ops)).toEqual(fmt(d.ops));
  });
  it('cached phases set every state they read (no inherited context state)', () => {
    for (const phase of ['pre', 'post'] as const) {
      const r = recordingCtx();
      drawWorkstation(r.ctx, fit, slot, owner, 'revive', false, 3, undefined, true, true, phase);
      expect(readsBeforeWrites(r.ops)).toEqual([]);
    }
  });
  it('deskStationItems carries parts for a desk slot and none for a bench seat', () => {
    const r = recordingCtx();
    const desk = deskStationItems(r.ctx, fit, slot, owner, { teamName: 'revive', t: 3, lampsOn: true });
    const ws = desk.items[0]!;
    expect(ws.parts!.map((p) => p.kind)).toEqual(['sprite', 'live', 'sprite']); // owner present, not seated → idle screen is static, but keep the split (see impl note)
    const bench = deskStationItems(r.ctx, fit, DESK_SLOTS.find((s) => s.kind === 'bench')!, owner, { teamName: 'revive' });
    expect(bench.items.every((i) => !i.parts)).toBe(true);
  });
  it('the workstation key changes with every pixel-changing input and not with t', () => {
    const base = workstationKey({ slot, node: owner, teamName: 'revive', owned: false, working: true, lampLit: true, hidden: undefined, fit, dpr: 1, warmAlpha: '' });
    expect(workstationKey({ slot, node: owner, teamName: 'revive', owned: false, working: false, lampLit: true, hidden: undefined, fit, dpr: 1, warmAlpha: '' })).not.toBe(base);
    expect(workstationKey({ slot, node: owner, teamName: 'revive', owned: false, working: true, lampLit: true, hidden: new Set(['coffee']), fit, dpr: 1, warmAlpha: '' })).not.toBe(base);
    expect(workstationKey({ slot, node: owner, teamName: 'revive', owned: false, working: true, lampLit: true, hidden: undefined, fit: { ...fit, ox: fit.ox + 0.5 }, dpr: 1, warmAlpha: '' })).not.toBe(base);
    expect(base).not.toMatch(/·3·|t=/);
  });
});
```

Helpers to add near the top of render.test.ts:

```ts
const fmt = (ops: RecordedOp[]) => ops.map((o) => `${o.name}(${o.args.map((a) => (typeof a === 'number' ? a.toFixed(4) : String(a))).join(',')})`);

/** Ops that READ a context property this draw never SET: fill→fillStyle, stroke→strokeStyle+lineWidth,
 * fillText→font+textAlign+textBaseline+fillStyle. `save`/`restore` are tracked as a stack. */
function readsBeforeWrites(ops: RecordedOp[]): string[] {
  const reads: Record<string, string[]> = {
    fill: ['fillStyle'], fillRect: ['fillStyle'], fillText: ['fillStyle', 'font', 'textAlign', 'textBaseline'],
    stroke: ['strokeStyle', 'lineWidth'], strokeRect: ['strokeStyle', 'lineWidth'], strokeText: ['strokeStyle', 'font'],
  };
  let set = new Set<string>();
  const stack: Set<string>[] = [];
  const bad: string[] = [];
  ops.forEach((o, i) => {
    if (o.name.startsWith('set:')) set.add(o.name.slice(4));
    else if (o.name === 'save') stack.push(new Set(set));
    else if (o.name === 'restore') set = stack.pop() ?? set;
    else for (const p of reads[o.name] ?? []) if (!set.has(p)) bad.push(`${i}:${o.name} reads ${p}`);
  });
  return bad;
}
```

Also export `drawWorkstation` and `workstationKey` from render.ts (it is module-private today).

- [ ] **Step 2: Run — expect FAIL (extra args ignored → phases all draw everything; key fn missing)**
- [ ] **Step 3: Implement**

`screenPanel`: add `face: 'all' | 'skip' | 'only' = 'all'` after `t`. Wrap: `if (face !== 'only') box(...)`; the `lo/hi/BL/BR` block and `if (BL && BR) {...}` run only `if (face !== 'skip')`.

`monitor`: add `face = 'all'` after `t`; `if (face !== 'only') monitorStand(...)` in each branch; pass `face` to every `screenPanel` call.

`drawWorkstation`: add `phase: 'all' | 'pre' | 'screen' | 'post' = 'all'` after `atWork`. Then:

```ts
  const monitorSum = deskPropSort(dir, Df / 2 - 12, 0);
  if (phase === 'screen') {
    const ix = lx + f[0] * (Df / 2 - 12);
    const iy = ly + f[1] * (Df / 2 - 12);
    monitor(ctx, fit, ix, iy, dir, working, up, id, t, 'only');
    return;
  }
  if (phase !== 'post') {
    for (const [sx, sy] of [...]) box(...legs...);
    box(...slab...);
    { ...lip... }
  }
  // props (unchanged pushes) …
  at(Df / 2 - 12, 0, (ix, iy) => monitor(ctx, fit, ix, iy, dir, working, up, id, t, phase === 'all' ? 'all' : 'skip'));
  // …
  props.sort((a, b) => a.sum - b.sum);
  for (const pr of props) {
    if (phase === 'pre' && pr.sum > monitorSum) continue;
    if (phase === 'post' && pr.sum <= monitorSum) continue;
    pr.fn();
  }
```

`workstationKey`:

```ts
export function workstationKey(k: {
  slot: { id: number; dir: Dir }; node: OfficeNode | null; teamName: string; owned: boolean; working: boolean;
  lampLit: boolean; hidden: Set<PropKind> | undefined; fit: Fit; dpr: number; warmAlpha: string;
}): string {
  const steppedAway = k.node != null && k.owned && k.node.presence !== 'offline';
  return [
    'ws', k.slot.id, k.slot.dir, k.node?.name ?? '', k.teamName, k.owned ? 1 : 0, steppedAway ? 1 : 0,
    k.working ? 1 : 0, k.lampLit ? 1 : 0, k.hidden ? [...k.hidden].sort().join('+') : '', k.warmAlpha,
    fitKey(k.fit), k.dpr, paletteKey(),
  ].join('·');
}
export function fitKey(fit: Fit): string { return `${fit.ox}:${fit.oy}:${fit.scale}`; }
export function paletteKey(): string { return `${PAL.floor}|${PAL.floor2}|${PAL.wood}|${PAL.couch}|${PAL.wall}`; }
/** The owned-desk afterglow alpha string EXACTLY as drawWorkstation formats it — '' when it does not paint. */
export function ownedDeskWarmAlpha(node: OfficeNode | null, owned: boolean, now = Date.now()): string {
  if (!node || !owned) return '';
  const steppedAway = node.presence !== 'offline';
  const age = node.last_seen_at != null ? now - node.last_seen_at : Infinity;
  const warmth = steppedAway ? 0.6 : Math.max(0, 1 - age / 3_600_000);
  return warmth > 0 ? (0.18 * warmth).toFixed(3) : '';
}
```

Refactor `drawWorkstation`'s afterglow block to call `ownedDeskWarmAlpha(node, owned)` so the key and the paint share one formula (the alpha string goes into the `rgba(...)`).

`deskStationItems`: in the non-bench branch, the workstation push becomes:

```ts
    const key = workstationKey({ slot, node, teamName, owned: deskOwned, working: seatedWorking, lampLit: !!node && !deskOwned && env.lampsOn, hidden: hide, fit, dpr: opts.dpr ?? 1, warmAlpha: ownedDeskWarmAlpha(node, deskOwned) });
    const ws = (c: CanvasRenderingContext2D, phase: 'all' | 'pre' | 'screen' | 'post') =>
      drawWorkstation(c, fit, slot, node, teamName, deskOwned, t, hide, env.lampsOn, seatedWorking, phase);
    out.push({
      d: depth(slot.lx, slot.ly),
      fn: () => ws(ctx, 'all'),
      parts: [
        { kind: 'sprite', key: `${key}·pre`, draw: (c) => ws(c, 'pre') },
        { kind: 'live', draw: () => ws(ctx, 'screen') },
        { kind: 'sprite', key: `${key}·post`, draw: (c) => ws(c, 'post') },
      ],
    });
```

Add `dpr?: number` to `deskStationItems` opts and thread `opts.dpr` from `renderScene`. The screen
stays live for idle desks too: one code path, and the idle face is a single quad — cheap. (The sprite
`draw` receives the OFFSCREEN ctx `c`; `live` uses the stage `ctx`. Getting this wrong is the bug the
passthrough test catches.)

- [ ] **Step 4: Run render.test.ts — expect PASS; the Task 3 renderScene-equivalence test must still pass.**
- [ ] **Step 5: Commit** — `feat(office): workstations paint as sprite·live-screen·sprite in their depth slot`

---

### Task 5: Plants, shelves, entrance, bench counter

**Files:**
- Modify: `render.ts` (`renderScene` pushes), `render.test.ts`

- [ ] **Step 1: Failing test**

```ts
it('static furniture items carry a single sprite part whose draw equals fn', () => {
  const r = recordingCtx();
  const items = collectItems(r.ctx); // see impl: export a test seam `sceneItems(...)` OR assert via the passthrough equivalence + a key census
  const kinds = new Map<string, number>();
  for (const it of items) for (const p of it.parts ?? []) if (p.kind === 'sprite') kinds.set(p.key.split('·')[0]!, (kinds.get(p.key.split('·')[0]!) ?? 0) + 1);
  expect(kinds.get('plant')).toBe(PLANTS.length);
  expect(kinds.get('shelf')).toBe(BOOKSHELVES.length);
  expect(kinds.get('entrance')).toBe(1);
  expect(kinds.get('bench')).toBe(1);
});
```

Simplest seam: split `renderScene` so the item list is built by an exported
`sceneItems(ctx, fit, placements, byName, poses, t, teamName, env, pet, fx, recep, wallBoard, teamWorkingHours, dpr): { items: DepthItem[]; heads; bases; litLamps }`
and `renderScene` calls it. Pure refactor first (equivalence test stays green), then add the parts.

- [ ] **Step 2: Implement** — each push gains `parts: [{ kind: 'sprite', key, draw: (c) => <same call with c> }]`:

```ts
  const stat = `${fitKey(fit)}·${dpr}·${paletteKey()}`;
  for (const [pi, plant] of PLANTS.entries()) items.push({
    d: depth(plant.lx, plant.ly),
    fn: () => drawPlant(ctx, fit, plant.lx, plant.ly, plant.species),
    parts: [{ kind: 'sprite', key: `plant·${pi}·${plant.species}·${stat}`, draw: (c) => drawPlant(c, fit, plant.lx, plant.ly, plant.species) }],
  });
  BOOKSHELVES.forEach((s, si) => items.push({ d: depth(s.lx, s.ly), fn: () => bookshelf(ctx, fit, s, si), parts: [{ kind: 'sprite', key: `shelf·${si}·${stat}`, draw: (c) => bookshelf(c, fit, s, si) }] }));
  items.push({ d: depth(ENTRANCE.lx, ENTRANCE.ly), fn: () => drawEntrance(ctx, fit), parts: [{ kind: 'sprite', key: `entrance·${stat}`, draw: (c) => drawEntrance(c, fit) }] });
  items.push({ d: depth(BENCH.lx, BENCH.ly), fn: () => benchCounter(ctx, fit), parts: [{ kind: 'sprite', key: `bench·${stat}`, draw: (c) => benchCounter(c, fit) }] });
```

Add to the "sets before it reads" test a loop over one plant of each species, one shelf, entrance,
bench — each must return `[]` from `readsBeforeWrites`. Also grep: `grep -n "Math.random\|Date.now" render.ts` must show only the afterglow (line ~4049) and the seeded-noise comment.

- [ ] **Step 3: Run — PASS. Commit** — `feat(office): plants, shelves, entrance and bench counter as sprites`

---

### Task 6: Background layer + `drawWallLive`

**Files:**
- Modify: `render.ts` — `drawWalls(..., fixtures: 'all' | 'static' | 'live' = 'all')`, new `drawWallLive`, `renderScene` opening, `backgroundKey`
- Modify: `render.test.ts`

**Interfaces:**
- `drawWalls(ctx, fit, env, teamWorkingHours, wallBoard, t, fixtures = 'all')`: inside `dress`,
  the wall-1 branch runs `wallClock`, `workingHoursSign`, `wallLaneBoard` only when
  `fixtures !== 'static'`; everything else (faces, cap, windows, art, hanger, cable) only when
  `fixtures !== 'live'`.
- `export function drawWallLive(ctx, fit, env, teamWorkingHours, wallBoard, t)` = `drawWalls(..., 'live')`.
- `export function backgroundKey(fit, env, dpr): string` =
  `['bg', glassColor(env), env.skyTint, env.skyStrength.toFixed(3), env.daylight.toFixed(3), fitKey(fit), dpr, paletteKey()].join('·')`.
  (Read `drawGroundShadow`, `drawFloor`, `drawRug`, `drawWindowBeams`, and every wall helper before
  finalising: any other `env.` read inside them joins the key. `hours` does not — the clock is live.)
- `renderScene` opening becomes:

```ts
  const drawShell = (c: CanvasRenderingContext2D): void => {
    drawGroundShadow(c, fit);
    drawFloor(c, fit);
    drawWalls(c, fit, env, teamWorkingHours, wallBoard, t, cache ? 'static' : 'all');
    drawWindowBeams(c, fit, env);
    for (const pod of PODS) { ...drawRug(c, ...) }
    drawRug(c, fit, MEETING.rug, ...);
    drawRug(c, fit, RECEPTION.rug, ...);
    nookRug(c);   // nookItems(c, ...).rug — build nook items once with the stage ctx; its rug fn takes the ctx to draw on (small refactor: `rug: (c) => ...`)
  };
  if (cache) {
    const box = { x: 0, y: 0, w: Math.ceil(stageW * dpr), h: Math.ceil(stageH * dpr) }; // full stage: opts.stage {w,h} in CSS px, required when sprites is set
    const bg = cache.get(backgroundKey(fit, env, dpr), box, drawShell);
    ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.drawImage(bg, 0, 0); ctx.restore();
    drawWallLive(ctx, fit, env, teamWorkingHours, wallBoard, t);
  } else {
    drawShell(ctx);
  }
```

`RenderOpts` gains `stage?: { w: number; h: number }` (CSS px; `index.ts` passes `width, height`).
The rug calls move from between the item pushes to `drawShell` — they were already all before the
loop, and rugs and items are pushed to different places, so this is a no-op on order (the
equivalence test proves it: it compares the *whole* op stream).

- [ ] **Step 1: Failing tests**

```ts
describe('background layer', () => {
  const fit = fitFloor(1920, 1080);
  it('drawWalls static ++ live == all', () => {
    const all = recordingCtx(); drawWalls(all.ctx, fit, DAY, WH, board, 3, 'all');
    const s = recordingCtx(); drawWalls(s.ctx, fit, DAY, WH, board, 3, 'static');
    const l = recordingCtx(); drawWalls(l.ctx, fit, DAY, WH, board, 3, 'live');
    // Not a plain concat: the live fixtures sit INSIDE the static sequence today (after wall-1's art,
    // before its cable). Assert set + relative order instead: static ops in order, live ops in order,
    // and — the thing that matters for pixels — no static op drawn AFTER a live fixture overlaps it.
    expect(fmt(s.ops).concat(fmt(l.ops)).sort()).toEqual(fmt(all.ops).sort());
    const liveBox = measureBounds((c) => drawWalls(c, fit, DAY, WH, board, 3, 'live'))!;
    const afterFixtures = opsAfter(all.ops, /* first live op index */);
    const tailBox = measureBounds((c) => replay(c, afterFixtures))!; // replay recorded ops onto a ctx
    expect(overlaps(liveBox, tailBox)).toBe(false);
  });
  it('the static walls, floor, beams and rugs never read t or hours', () => { /* two renders with t=1 vs 9, hours 3 vs 15 under 'static' → identical ops */ });
  it('backgroundKey follows glass, sky and palette, not hours', () => { /* … */ });
});
```

Write `replay(ctx, ops)` (applies recorded method calls / sets to a ctx) and `overlaps(a, b)` (AABB
test) as test helpers. The overlap assertion is the one that licenses lifting the fixtures out of the
wall sequence; if it fails, the cable (or whatever overlaps) moves into the live call too, keeping
its own order — do not shrink the box.

- [ ] **Step 2: Implement** as specified. Also extend the Task 3 equivalence test so the fixture has
  `wallBoard` and `teamWorkingHours` set (so clock, sign and board are all exercised).
- [ ] **Step 3: Run render.test.ts — PASS. Commit** — `feat(office): the room shell is one full-stage sprite; clock, sign and board stay live`

---

### Task 7: Wire `index.ts`, `OfficeOptions.sprites`, `&sprites=1`, `spriteParity()`

**Files:**
- Modify: `packages/web/src/live/office-scene/index.ts`, `types.ts`
- Modify: `packages/web/src/routes/broadcast.tsx`, `packages/web/src/live/OfficeScene.tsx`
- Modify: `packages/web/src/routes/office-preview.tsx`
- Test: `packages/web/src/live/office-scene/broadcast.test.ts` (has URL-param tests to mirror)

- [ ] **Step 1: `OfficeOptions.sprites?: boolean`** (doc: "Per-item sprite cache for the static
  furniture (spec 2026-09-17). Dark by default until the pixel gate and the 25 ms measurement clear.")
- [ ] **Step 2: In `mountOffice`:**

```ts
  const sprites = options.sprites === true ? makeSpriteCache({ dpr }) : undefined;
  // drawDynamic:
  const anchors = renderScene(ctx, fit, placements, actors.nodes(), actors.poses(), clock, teamName, lightEnv, pet, actors.sceneFx(), recep, wallBoard, teamWorkingHours, { sprites, dpr, stage: { w: width, h: height } });
  // on resize (line ~507, after `fit = fitFloor(...)`): sprites?.clear();
  // on dispose: sprites?.clear();
```

`bake()` is untouched (no opts).

- [ ] **Step 3: `OfficeHandle.spriteParity()`** (types.ts + index.ts):

```ts
  /** Dev/gate: render the CURRENT scene state twice into two fresh offscreen canvases — direct and
   * through a fresh SpriteCache — and compare bytes. The pixel gate (scripts/perf/scene-pixel-check.mjs)
   * calls this over CDP. Never called by the app. */
  spriteParity: () => { equal: boolean; differing: number; maxDelta: number; histogram: number[]; first: { x: number; y: number; direct: number[]; sprite: number[] } | null };
```

```ts
  function spriteParity() {
    const render = (c: CanvasRenderingContext2D, opts?: RenderOpts) => {
      c.setTransform(dpr, 0, 0, dpr, 0, 0);
      c.clearRect(0, 0, width, height);
      renderScene(c, fit, placements, actors.nodes(), actors.poses(), clock, teamName, lightEnv, pet, actors.sceneFx(), recep, wallBoard, teamWorkingHours, opts);
    };
    const mk = () => { const c = document.createElement('canvas'); c.width = canvas.width; c.height = canvas.height; return c; };
    const a = mk(), b = mk();
    render(a.getContext('2d')!);
    render(b.getContext('2d')!, { sprites: makeSpriteCache({ dpr }), dpr, stage: { w: width, h: height } });
    const da = a.getContext('2d')!.getImageData(0, 0, a.width, a.height).data;
    const db = b.getContext('2d')!.getImageData(0, 0, b.width, b.height).data;
    const histogram = new Array<number>(256).fill(0);
    let differing = 0, maxDelta = 0, first = null as ReturnType<OfficeHandle['spriteParity']>['first'];
    for (let i = 0; i < da.length; i += 4) {
      let d = 0;
      for (let k = 0; k < 4; k++) d = Math.max(d, Math.abs(da[i + k]! - db[i + k]!));
      if (d === 0) continue;
      differing++; histogram[d]!++; if (d > maxDelta) maxDelta = d;
      if (!first) { const px = i / 4; first = { x: px % a.width, y: Math.floor(px / a.width), direct: [...da.slice(i, i + 4)], sprite: [...db.slice(i, i + 4)] }; }
    }
    return { equal: differing === 0, differing, maxDelta, histogram, first };
  }
```

Same-`t`, same poses, same env: both renders read the same state synchronously, so `t` is not a
confound.

- [ ] **Step 4: `/broadcast` reads `&sprites=1`** — beside `captureFpsFromUrl` in broadcast.tsx:

```ts
/** `&sprites=1` — the static-furniture sprite cache (spec 2026-09-17). Off unless asked, until the gate flips the default. */
function spritesFromUrl(): boolean {
  return typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('sprites') === '1';
}
```

Thread `sprites` through `OfficeScene.tsx` props → `mountOffice` options (same shape as `captureFps`). `office-preview.tsx`: `sprites: search.has('sprites')` and a `?members=N` knob if the fixture has no roster-size control (read `dataRef`'s builder; add a `members` param that slices the fixture roster to N — needed for the 1/8/24 matrix).

- [ ] **Step 5: Tests** — in `broadcast.test.ts` mirror the existing `?fps=` test for `spritesFromUrl` (export it); typecheck; `pnpm -F @musterd/web test`.
- [ ] **Step 6: Commit** — `feat(office): OfficeOptions.sprites, /broadcast &sprites=1, OfficeHandle.spriteParity() — dark by default`

---

### Task 8: Manual smoke in Chrome (no measurement yet)

- [ ] Start the web dev server (see `packages/web/package.json` `dev`), open `/office-preview?sprites&still&light=22` in Chrome (chrome-devtools MCP or the claude-in-chrome extension per the browser-tooling memory), and eyeball: no missing furniture, no doubled props, no seam at sprite edges, night lamps correct.
- [ ] In the console: `__office.spriteParity()` → note `differing`/`maxDelta`/`histogram` for day and night. This is the first look at the 8-bit-intermediate risk; record the numbers in the lane detail before writing the gate.

---

### Task 9: The pixel gate — `pnpm scene:pixel-check`

**Files:**
- Create: `scripts/perf/scene-pixel-check.mjs`
- Modify: root `package.json` scripts: `"scene:pixel-check": "node scripts/perf/scene-pixel-check.mjs"`

Reuse `scripts/a11y/contrast-sweep.mjs`'s Chrome launch (`--headless=new`, `--remote-debugging-port=0`, temp profile, `/json/version` → CDP websocket) and its dev-server assumption; copy the launch/shutdown helpers rather than importing (the sweep's are module-private and carry its own retry state).

- [ ] **Step 1: Write the script**

```js
// scripts/perf/scene-pixel-check.mjs — pixel identity gate for the office sprite cache (spec 2026-09-17).
// For each state in MATRIX: load /office-preview with the knobs, wait for __office, settle, call
// __office.spriteParity(), and fail unless equal. Prints a per-state table + histograms.
const BASE = process.env.SCENE_BASE ?? 'http://localhost:3000';
const MATRIX = [
  { name: 'day-1',       q: 'still&light=12&members=1' },
  { name: 'day-8',       q: 'still&light=12&members=8' },
  { name: 'day-24',      q: 'still&light=12&members=24' },
  { name: 'night-24',    q: 'still&light=23&members=24' },   // lamps on, veil up
  { name: 'night-1',     q: 'still&light=23&members=1' },
  { name: 'sip-8',       q: 'still&light=12&members=8', poke: 'sip' }, // hidden desk mug mid-gesture
  { name: 'dusk-theme',  q: 'still&light=12&members=8&theme=dusk' },
  { name: 'light-theme', q: 'still&light=12&members=8&theme=light' },
];
// per state: Page.navigate; poll Runtime.evaluate('!!window.__office') ; if poke: evaluate
// `__office.pokeGesture(<sip kind>)` then wait 400 ms; evaluate `JSON.stringify(__office.spriteParity())`.
// Exit 1 if any state !equal. Always print: name | differing | maxDelta | histogram[1..3] | first.
```

(Check `office-preview.tsx` for the theme knob's real name before hardcoding `theme=`; add one if
absent, cascading `data-theme` on the host. `pokeGesture` takes the GESTURE kind number — read
`GESTURE.sip` from `types.ts`/`actors.ts` and pass it.)

- [ ] **Step 2: Run it** against the dev server. Record the table in the lane detail.
- [ ] **Step 3: Decision point.** All `equal` → continue. Only `maxDelta ≤ 1` → send nick the histogram (`team_send ask`, species consult, tier standard) and continue to Task 10 while waiting (measurement is independent of the verdict). `maxDelta > 1` anywhere → a real bug (box, order, state): fix, do not proceed.
- [ ] **Step 4: Commit** — `test(office): scene:pixel-check — the sprite path is byte-equal to the direct path across the state matrix`

---

### Task 10: Measure on the box, interleaved

- [ ] Read the A/B harness notes in lane `01M2RKFG60380P695GCP49B1Z6`'s detail and the wiki claims on `miley/broadcast-draw-rate-floor` (PR #1541): one performance-4x, `/broadcast?fps=20&sprites=1` vs `/broadcast?fps=20`, A/B/A/B, `stats().draws` and blocked-ms-per-draw, not draws/s.
- [ ] Record: ms/draw for each arm, both A arms within noise of each other, the B arms ≤ 25 ms. Destroy the probe box after.
- [ ] Exit criterion (spec): if B > 25 ms, stop, report the number to nick with the profile, and do not flip the default.

---

### Task 11: Flip the default, wiki claim, PR

- [ ] `OfficeScene.tsx`/`broadcast.tsx`: `sprites` defaults to `true` on `/broadcast`; `&sprites=0` opts out. `/live` stays off (interactive, DPR up to the cap; not measured) unless nick asks.
- [ ] Wiki: `docs/wiki/broadcast-stream.md` claim "The room was ~39 ms of the 56 ms draw; sprites take it to N ms (2026-09-xx; falsify: `pnpm scene:pixel-check` then A/B `&sprites=0` on one box)" with the measured numbers and the histogram result. `pnpm wiki:check` green.
- [ ] Full gates: `pnpm -F @musterd/web test`, `typecheck`, `pnpm perf:check` (ADR 151 budget — the office bundle grows by sprite-cache.ts; check the headroom before the PR), `pnpm a11y:check` unchanged.
- [ ] PR from `miley/office-sprite-cache` (cross-family reviewer at merge per the seat rules), then `lane_submit`.

---

## Self-review

- **Spec coverage:** SpriteCache (T1), keys (T4–T6, with deviations listed), boxes (T2, measured), item
  descriptors + loop (T3), workstation split incl. the `t`-reading screen (T4), the other four items
  (T5), background + lifted fixtures (T6), opt-in per call and `bake()` untouched (T3/T7), rollout
  flag + URL (T7), layer-1 tests (T3–T6), layer-2 gate (T9), layer-3 measurement (T10), exit
  criterion (T10), flip + wiki (T11). Memory cap: LRU 128 + one stage canvas (T1/T6).
- **Type consistency:** `SpritePart.kind` `'sprite' | 'live'`; sprite `draw(ctx)` takes the offscreen
  ctx, live `draw()` closes over the stage ctx; `RenderOpts { sprites, dpr, stage }`; phases
  `'all' | 'pre' | 'screen' | 'post'`; faces `'all' | 'skip' | 'only'`; wall fixtures
  `'all' | 'static' | 'live'`.
- **Gaps deliberately left:** meeting table/chairs, printer, nook furniture, reception desk, chair
  pieces, `deskNearHalf` and bench gear stay live — outside the spec's item list; candidates for a
  second increment if T10 lands short of 25 ms by a small margin.
