import { describe, expect, it } from 'vitest';
import { fmtBytes } from './args.js';

/**
 * `fmtBytes` exists because the resume hygiene bound went sub-MiB in the 2026-07-29 recalibration
 * (10 MiB → 256 KiB). Every surface that rendered it in MiB started saying "0MiB" or comparing
 * "0.4 MiB" against "0.2 MiB", so the number an operator reads has to switch units with the value.
 */
describe('fmtBytes — the render twin of the byte-valued policy knobs', () => {
  it('renders sub-MiB values in KiB, so the recalibrated bound is not "0MiB"', () => {
    expect(fmtBytes(256 * 1024)).toBe('256 KiB');
    expect(fmtBytes(460_597)).toBe('449.8 KiB');
  });

  it('renders MiB and above in MiB', () => {
    expect(fmtBytes(10 * 1024 * 1024)).toBe('10 MiB');
    expect(fmtBytes(3_612_998)).toBe('3.4 MiB');
  });

  it('drops a trailing .0 — an exact bound reads as a round number', () => {
    expect(fmtBytes(1_048_576)).toBe('1 MiB');
    expect(fmtBytes(65_536)).toBe('64 KiB');
  });
});
