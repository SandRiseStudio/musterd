import { describe, expect, it } from 'vitest';
import { FLOOR } from './iso';
import { BOOKSHELVES, SHELF_DEEP } from './layout';

describe('BOOKSHELVES — flush to floor edges', () => {
  it('pins each shelf so its back sits on the perimeter (door-flush pattern)', () => {
    const half = SHELF_DEEP / 2;
    for (const s of BOOKSHELVES) {
      switch (s.dir) {
        case 'S':
          expect(s.ly).toBe(half);
          break;
        case 'N':
          expect(s.ly).toBe(FLOOR - half);
          break;
        case 'E':
          expect(s.lx).toBe(half);
          break;
        case 'W':
          expect(s.lx).toBe(FLOOR - half);
          break;
        default: {
          const _exhaustive: never = s.dir;
          throw new Error(`unexpected dir ${_exhaustive}`);
        }
      }
    }
  });
});
