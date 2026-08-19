import { describe, expect, it } from 'vitest';

import { isStill } from './stillMode';

/**
 * `?still` is a measurement contract, so its reader is pinned like one. The interesting cases are
 * all "is this REALLY the flag" — a mode that turns itself on for `?stillwater` would silently
 * freeze a page somebody was trying to watch move.
 */
describe('isStill', () => {
  it('is off when the flag is absent', () => {
    expect(isStill('')).toBe(false);
    expect(isStill('?light=12')).toBe(false);
  });

  it('is on for the bare flag, with or without the leading ?', () => {
    expect(isStill('?still')).toBe(true);
    expect(isStill('still')).toBe(true);
  });

  it('is on alongside the other measurement flags, in either order', () => {
    expect(isStill('?light=12&still')).toBe(true);
    expect(isStill('?still&light=21')).toBe(true);
  });

  /* The gate appends `&still`; a value is not required and must not be, or `&still` itself stops
     working the day someone writes `&still=1`. */
  it('is on when given a value', () => {
    expect(isStill('?still=1')).toBe(true);
    expect(isStill('?still=true')).toBe(true);
  });

  /* A prefix match would turn the mode on for a parameter that merely starts with the same
     letters. `has()` gets this right; a `.includes('still')` would not, and this is the test that
     stops someone "simplifying" it into one. */
  it('is off for a different parameter that merely starts with the same letters', () => {
    expect(isStill('?stillwater=1')).toBe(false);
    expect(isStill('?distill=1')).toBe(false);
    expect(isStill('?light=stillness')).toBe(false);
  });

  /* Never throws: this is read on the mount path of every consumer, and a malformed search is a
     page that renders, not a page that white-screens. */
  it('answers false rather than throwing on a malformed search', () => {
    expect(isStill('?%')).toBe(false);
    expect(isStill('?&&&')).toBe(false);
  });
});
