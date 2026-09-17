/**
 * Per-item sprite cache for the office scene
 * (spec: docs/superpowers/specs/2026-09-17-office-scene-sprite-cache-design.md).
 *
 * The broadcast page draws the whole room every frame, and ~39 of its ~56 ms per draw is static
 * furniture re-rasterized through SwiftShader. A static item is rasterized ONCE here, into its own
 * offscreen canvas at its real device position, and blitted with one `drawImage` on every frame
 * after. The depth sort is untouched — only HOW an item paints changes, never WHERE or in what
 * order — so occlusion is preserved by construction.
 *
 * Two rules keep the blit pixel-identical to the direct draw:
 *  - the sprite is rasterized on the SAME pixel grid it is later blitted onto (integer device origin,
 *    the item's fractional position kept), so sub-pixel antialiasing matches;
 *  - the offscreen context starts from the 2D defaults, and every cached item sets the state it reads
 *    (render.test.ts proves it), so nothing inherited from a previous item can leak into a sprite.
 */

/** Device-pixel box, integer. `x,y` is the offscreen canvas' origin on the stage. */
export interface SpriteBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** CSS-pixel extent (the space a draw function's coordinates are in). */
export interface CssBounds {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

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
 * The 2D context defaults (HTML spec). A sprite's context is fresh, but the direct path's items
 * inherit whatever the previous item left — the equivalence tests prove each cached item sets what
 * it reads, so starting from the defaults is exactly equivalent.
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
  /** LRU cap. ~30 items × a few state variants at 1080p is a few MB; 128 is generous. */
  max?: number;
  createCanvas?: (w: number, h: number) => HTMLCanvasElement;
}): SpriteCache {
  const max = opts.max ?? 128;
  const create = opts.createCanvas ?? domCanvas;
  // Map preserves insertion order; delete+set on a hit moves the key to the back, so the front is LRU.
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
      // Same pixel grid as the stage: a CSS coordinate c lands at c*dpr - box.x device px, keeping
      // its fractional part, so sub-pixel antialiasing matches the direct path.
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

type M = [number, number, number, number, number, number]; // a b c d e f — a canvas CTM
const mul = (m: M, n: M): M => [
  m[0] * n[0] + m[2] * n[1],
  m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3],
  m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4],
  m[1] * n[4] + m[3] * n[5] + m[5],
];

/**
 * Dry-run `draw` against a context that only tracks the CTM and the extent of every point it
 * touches, so a sprite's box is MEASURED rather than estimated from footprint geometry. JS only —
 * no rasterization — and it runs once per cache miss, so its cost is amortized to nothing.
 *
 * Text is estimated (0.6 em per glyph, both sides of the anchor, ascent + descent) and gradients
 * are stubbed; `SPRITE_PAD` covers what an estimate misses, and the pixel gate catches what it does
 * not (a clipped sprite is a byte difference, not a judgement call).
 */
export function measureBounds(draw: (ctx: CanvasRenderingContext2D) => void): CssBounds | null {
  let m: M = [1, 0, 0, 1, 0, 0];
  const stack: M[] = [];
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  let fontPx = 10;
  const pt = (x: number, y: number): void => {
    const px = m[0] * x + m[2] * y + m[4];
    const py = m[1] * x + m[3] * y + m[5];
    if (px < x0) x0 = px;
    if (px > x1) x1 = px;
    if (py < y0) y0 = py;
    if (py > y1) y1 = py;
  };
  const box = (x: number, y: number, w: number, h: number): void => {
    pt(x, y);
    pt(x + w, y);
    pt(x, y + h);
    pt(x + w, y + h);
  };
  const grad = { addColorStop(): void {} };
  const methods: Record<string, (...a: number[]) => void> = {
    save: () => {
      stack.push(m);
    },
    restore: () => {
      m = stack.pop() ?? m;
    },
    translate: (x, y) => {
      m = mul(m, [1, 0, 0, 1, x, y]);
    },
    scale: (x, y) => {
      m = mul(m, [x, 0, 0, y, 0, 0]);
    },
    rotate: (r) => {
      const c = Math.cos(r);
      const s = Math.sin(r);
      m = mul(m, [c, s, -s, c, 0, 0]);
    },
    transform: (a, b, c, d, e, f) => {
      m = mul(m, [a, b, c, d, e, f]);
    },
    setTransform: (a, b, c, d, e, f) => {
      m = [a, b, c, d, e, f];
    },
    resetTransform: () => {
      m = [1, 0, 0, 1, 0, 0];
    },
    moveTo: pt,
    lineTo: pt,
    bezierCurveTo: (a, b, c, d, e, f) => {
      pt(a, b);
      pt(c, d);
      pt(e, f);
    },
    quadraticCurveTo: (a, b, c, d) => {
      pt(a, b);
      pt(c, d);
    },
    arc: (x, y, r) => box(x - r, y - r, 2 * r, 2 * r),
    arcTo: (a, b, c, d, r) => {
      box(a - r, b - r, 2 * r, 2 * r);
      box(c - r, d - r, 2 * r, 2 * r);
    },
    ellipse: (x, y, rx, ry) => {
      const r = Math.max(rx, ry);
      box(x - r, y - r, 2 * r, 2 * r);
    },
    rect: box,
    fillRect: box,
    strokeRect: box,
    clearRect: box,
    roundRect: box,
    drawImage: (...a) => {
      if (a.length >= 9) box(a[5]!, a[6]!, a[7]!, a[8]!);
      else if (a.length >= 5) box(a[1]!, a[2]!, a[3]!, a[4]!);
    },
  };
  const text = (s: unknown, x: number, y: number): void => {
    const w = 0.6 * fontPx * String(s).length;
    box(x - w, y - fontPx, 2 * w, fontPx * 1.3); // any textAlign/baseline: both sides, ascent + descent
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
      if (prop === 'font' && typeof v === 'string') {
        const mm = /(\d+(?:\.\d+)?)px/.exec(v);
        if (mm) fontPx = Number(mm[1]);
      }
      return true;
    },
  }) as unknown as CanvasRenderingContext2D;
  draw(ctx);
  return x0 === Infinity ? null : { x0, y0, x1, y1 };
}
