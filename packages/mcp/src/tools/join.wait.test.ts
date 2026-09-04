import { describe, expect, it } from 'vitest';
import { resolveWaitMs } from './join.js';

/**
 * ADR 095 decision 1: the claim block is a control, not a constant. The default must stay
 * byte-for-byte today's 120s — an interactive seat's spin-then-seat DX is the thing this must not
 * disturb — while an autonomous seat can ask for zero.
 */
describe('resolveWaitMs (ADR 095)', () => {
  it('defaults to the 120s budget when omitted — the interactive DX is unchanged', () => {
    expect(resolveWaitMs(undefined)).toBe(120_000);
  });

  it('is non-blocking on 0', () => {
    expect(resolveWaitMs(0)).toBe(0);
  });

  it('takes an explicit budget in seconds', () => {
    expect(resolveWaitMs(5)).toBe(5_000);
    expect(resolveWaitMs(0.25)).toBe(250);
    expect(resolveWaitMs(600)).toBe(600_000);
  });

  it('refuses a negative or non-finite budget rather than guessing one', () => {
    expect(() => resolveWaitMs(-1)).toThrow(/non-negative/);
    expect(() => resolveWaitMs(Number.NaN)).toThrow(/non-negative/);
    expect(() => resolveWaitMs(Number.POSITIVE_INFINITY)).toThrow(/non-negative/);
  });
});
