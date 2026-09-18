import { describe, expect, it } from 'vitest';
import { deviceBox, makeSpriteCache, measureBounds, resetCtxState, SPRITE_PAD, type SpriteBox } from './sprite-cache';

/** A fake canvas whose context records every call and property set, so the cache is testable in node. */
function fakeCanvasFactory() {
  const made: { w: number; h: number; ops: string[]; state: Record<string, unknown> }[] = [];
  const createCanvas = (w: number, h: number): HTMLCanvasElement => {
    const rec = { w, h, ops: [] as string[], state: {} as Record<string, unknown> };
    made.push(rec);
    const ctx = new Proxy({} as Record<string, unknown>, {
      get(_t, prop) {
        if (prop === 'canvas') return canvas;
        return (...args: unknown[]) => {
          rec.ops.push(`${String(prop)}(${args.join(',')})`);
        };
      },
      set(_t, prop, v) {
        rec.state[String(prop)] = v;
        rec.ops.push(`${String(prop)}=${String(v)}`);
        return true;
      },
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
    const draw = () => {
      draws++;
    };
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
      get:
        (_t, p) =>
        (...a: unknown[]) => {
          ops.push(`${String(p)}(${a.join(',')})`);
        },
      set: (_t, p, v) => {
        state[String(p)] = v;
        return true;
      },
    }) as unknown as CanvasRenderingContext2D;
    resetCtxState(ctx);
    expect(state.globalAlpha).toBe(1);
    expect(ops).toContain('setLineDash()');
  });
});

describe('measureBounds', () => {
  it('returns null when nothing is drawn', () => {
    expect(measureBounds(() => {})).toBeNull();
  });
  it('covers rects, paths and arcs', () => {
    const b = measureBounds((c) => {
      c.fillRect(10, 20, 5, 5);
      c.beginPath();
      c.moveTo(0, 0);
      c.lineTo(50, 60);
      c.stroke();
      c.beginPath();
      c.arc(100, 100, 10, 0, Math.PI * 2);
      c.fill();
      c.beginPath();
      c.ellipse(-20, -20, 4, 8, 0, 0, Math.PI * 2);
      c.fill();
    });
    expect(b).toEqual({ x0: -28, y0: -28, x1: 110, y1: 110 });
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
    const r = measureBounds((c) => {
      c.rotate(Math.PI / 2);
      c.fillRect(0, 0, 10, 0);
    });
    expect(r!.x1).toBeCloseTo(0, 6);
    expect(r!.y1).toBeCloseTo(10, 6);
  });
  it('estimates text from the font size, covering both sides of the anchor', () => {
    const b = measureBounds((c) => {
      c.font = '20px sans-serif';
      c.fillText('abcd', 10, 50);
    });
    const w = 0.6 * 20 * 4;
    expect(b).toEqual({ x0: 10 - w, y0: 30, x1: 10 + w, y1: 56 });
  });
});
