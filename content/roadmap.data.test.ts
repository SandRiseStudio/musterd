import { describe, expect, it } from 'vitest';
import { ROADMAP_RAW, type RawItem, resolveItem } from './roadmap.data.ts';

/**
 * ADR 177 — the anchor invariant. `frozenBy` used to be plain-optional, so an absent value meant both
 * "no ADR freezes this item" and "nobody recorded whether one does". roadmap-truth:check skipped both
 * cases identically and therefore watched 11 of 82 items; the two items that had drifted (#472) were
 * among the unwatched. These tests hold the line at authoring time.
 */
const base: RawItem = {
  id: 'fixture',
  title: 'Fixture',
  category: 'platform',
  blurb: 'a fixture',
  plan: 'reserved',
  unfrozen: 'a fixture',
};

describe('resolveItem — the frozenBy/unfrozen anchor invariant (ADR 177)', () => {
  it('rejects an item that declares neither anchor — the silence this exists to end', () => {
    const { unfrozen: _dropped, ...noAnchor } = base;
    expect(() => resolveItem(noAnchor)).toThrowError(
      /must declare exactly one of `frozenBy` or `unfrozen`/,
    );
  });

  it('rejects an item that declares both — the anchor must be unambiguous', () => {
    expect(() => resolveItem({ ...base, frozenBy: 177 })).toThrowError(
      /must declare exactly one of `frozenBy` or `unfrozen`/,
    );
  });

  it('accepts either anchor alone', () => {
    expect(resolveItem(base).status).toBe('reserved');
    const { unfrozen: _dropped, ...frozen } = base;
    expect(resolveItem({ ...frozen, frozenBy: 177 }).status).toBe('reserved');
  });

  it('rejects `building` without `frozenBy` — a remainder needs an arc to be a remainder of', () => {
    expect(() => resolveItem({ ...base, building: 'increment 2' })).toThrowError(
      /declares `building` without `frozenBy`/,
    );
  });

  it('rejects `building` on a shipped item — a finished item has no remainder', () => {
    const { plan: _dropped, unfrozen: _u, ...rest } = base;
    expect(() =>
      resolveItem({ ...rest, shipped: { prs: [472] }, frozenBy: 177, building: 'increment 2' }),
    ).toThrowError(/is shipped and also declares `building`/);
  });
});

describe('the roadmap itself', () => {
  it('declares an anchor on every item — coverage is the point, not a sample', () => {
    const missing = ROADMAP_RAW.filter(
      (i) => (i.frozenBy !== undefined) === (i.unfrozen !== undefined),
    ).map((i) => i.id);
    expect(missing).toEqual([]);
  });

  it('keeps every `unfrozen` reason short — this file ships in the web bundle', () => {
    const verbose = ROADMAP_RAW.filter((i) => (i.unfrozen?.length ?? 0) > 120).map((i) => i.id);
    expect(verbose).toEqual([]);
  });
});
