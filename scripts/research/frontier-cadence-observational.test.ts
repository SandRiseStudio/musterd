import { describe, expect, it } from 'vitest';
import {
  median,
  quantile,
  summarise,
  type Pair,
} from './frontier-cadence-observational.ts';

const p = (model: string, seconds: number, answerer = 's1'): Pair => ({ model, seconds, answerer });

describe('median / quantile', () => {
  it('takes the middle of an odd list and the mean of the two middles of an even one', () => {
    expect(median([5, 1, 3])).toBe(3);
    expect(median([1, 2, 3, 4])).toBe(2.5);
  });

  it('p90 sits at the top of the distribution, not at the mean', () => {
    // The whole reason the report leads with median: one 6.8-day answer must not move the headline.
    const xs = [1, 1, 1, 1, 1, 1, 1, 1, 1, 600_000];
    expect(median(xs)).toBe(1);
    expect(quantile(xs, 0.9)).toBe(1);
    expect(quantile(xs, 1)).toBe(600_000);
  });
});

describe('summarise', () => {
  it('drops `default` and `unknown` — an unattested occupancy is not a model family', () => {
    const rows = summarise([...Array(5)].flatMap(() => [p('default', 10), p('unknown', 10)]));
    expect(rows).toEqual([]);
  });

  it('holds a model back until it has minN pairs, so a single answer never becomes a row', () => {
    const pairs = [p('m-a', 10), p('m-a', 20), p('m-b', 10), p('m-b', 20), p('m-b', 30)];
    expect(summarise(pairs, 3).map((r) => r.model)).toEqual(['m-b']);
  });

  it('counts DISTINCT answering seats — the confound the headline must carry', () => {
    // One model answered by one seat is not the same evidence as one answered by six, and the
    // report prints `seats` beside `n` so a reader cannot miss it.
    const rows = summarise([p('m', 10, 'a'), p('m', 20, 'a'), p('m', 30, 'b')]);
    expect(rows[0]?.seats).toBe(2);
    expect(rows[0]?.n).toBe(3);
  });

  it('splits the within-4h view from the full one, and reports how many survived the filter', () => {
    const pairs = [p('m', 60), p('m', 120), p('m', 180), p('m', 50_000)];
    const row = summarise(pairs)[0]!;
    expect(row.medianSeconds).toBe(150); // (120 + 180) / 2 — the overnight answer is in
    expect(row.medianWithin4h).toBe(120); // it is out
    expect(row.nWithin4h).toBe(3);
    expect(row.n).toBe(4);
  });

  it('reports null rather than 0 when EVERY answer spanned a night', () => {
    // 0 would read as "instant"; null reads as "this column has nothing to say", which is true.
    const row = summarise([p('m', 50_000), p('m', 60_000), p('m', 70_000)])[0]!;
    expect(row.medianWithin4h).toBeNull();
    expect(row.nWithin4h).toBe(0);
  });
});
