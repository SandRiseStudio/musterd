import { describe, expect, it } from 'vitest';

import { isAsksOpen, isPlatesOpen, isStill } from './stillMode';

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

/**
 * `?asks-open` holds the asks sheet open so the contrast gate can measure the cards inside it —
 * they sit at `visibility: hidden` while closed, which the sweep skips. Pinned to the same
 * standard as `?still` beside it, and for the same reason: a page that opens a panel because a
 * viewer's query string happened to contain the letters is a page behaving at random.
 */
describe('isAsksOpen', () => {
  it('is off when the flag is absent', () => {
    expect(isAsksOpen('')).toBe(false);
    expect(isAsksOpen('?light=12&still')).toBe(false);
  });

  it('is on for the bare flag, with or without the leading ?', () => {
    expect(isAsksOpen('?asks-open')).toBe(true);
    expect(isAsksOpen('asks-open')).toBe(true);
  });

  /* The shape the gate actually appends. */
  it('is on alongside the other measurement flags', () => {
    expect(isAsksOpen('?team=paper&light=12&still&asks-open')).toBe(true);
  });

  it('is on when given a value', () => {
    expect(isAsksOpen('?asks-open=1')).toBe(true);
  });

  it('is off for a different parameter that merely starts with the same letters', () => {
    expect(isAsksOpen('?asks-open-later=1')).toBe(false);
    expect(isAsksOpen('?asks=open')).toBe(false);
    expect(isAsksOpen('?light=asks-open')).toBe(false);
  });

  it('answers false rather than throwing on a malformed search', () => {
    expect(isAsksOpen('?%')).toBe(false);
  });

  /* The two flags are independent — neither may imply the other. `?still` freezing the page must
     not also pop a panel open, and opening the panel must not stop the clocks. */
  it('does not turn on `?still`, and `?still` does not turn it on', () => {
    expect(isStill('?asks-open')).toBe(false);
    expect(isAsksOpen('?still')).toBe(false);
  });
});

/**
 * `?plates-open` holds every nameplate's detail open so the contrast gate can measure the harness
 * segment's four inks. Those segments sit at `opacity: 0` inside a `0fr` grid track while the plate
 * is collapsed — both of which the sweep skips — so `--lc-hz-{codex,cursor,grok,opencode}-ink` had
 * never been measured by the gate whose job is to measure shipped ink. Pinned to the same standard
 * as the two flags above: a plate that unpacks itself because a viewer's query string happened to
 * contain the letters is a page behaving at random.
 */
describe('isPlatesOpen', () => {
  it('is off when the flag is absent', () => {
    expect(isPlatesOpen('')).toBe(false);
    expect(isPlatesOpen('?light=12&still')).toBe(false);
  });

  it('is on for the bare flag, with or without the leading ?', () => {
    expect(isPlatesOpen('?plates-open')).toBe(true);
    expect(isPlatesOpen('plates-open')).toBe(true);
  });

  /* The shape the gate actually appends. */
  it('is on alongside the other measurement flags', () => {
    expect(isPlatesOpen('?team=paper&light=12&still&plates-open')).toBe(true);
  });

  it('is on when given a value', () => {
    expect(isPlatesOpen('?plates-open=1')).toBe(true);
  });

  it('is off for a different parameter that merely starts with the same letters', () => {
    expect(isPlatesOpen('?plates-open-later=1')).toBe(false);
    expect(isPlatesOpen('?plates=open')).toBe(false);
    expect(isPlatesOpen('?light=plates-open')).toBe(false);
  });

  it('answers false rather than throwing on a malformed search', () => {
    expect(isPlatesOpen('?%')).toBe(false);
  });

  /* The three flags are independent — none may imply another. Opening the plates must not stop the
     clocks, and neither `?still` nor `?asks-open` may pop the plates. */
  it('is independent of the other two measurement flags', () => {
    expect(isPlatesOpen('?still')).toBe(false);
    expect(isPlatesOpen('?asks-open')).toBe(false);
    expect(isStill('?plates-open')).toBe(false);
    expect(isAsksOpen('?plates-open')).toBe(false);
  });
});
