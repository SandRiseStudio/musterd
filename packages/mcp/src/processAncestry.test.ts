import { describe, expect, it } from 'vitest';
import { processAncestry, readParentPid } from './processAncestry.js';

/** A fake process table: pid → parent. */
const table = (edges: Record<number, number>) => (pid: number) => edges[pid];

describe('processAncestry — nearest first, bounded, stops at init or a gap', () => {
  it('walks parent → grandparent → … from the start pid', () => {
    // 100 (native codex) ← 90 (codex.js wrapper) ← 80 (actuator) ← 1
    expect(processAncestry(100, 6, table({ 100: 90, 90: 80, 80: 1 }))).toEqual([100, 90, 80]);
  });

  it('is bounded by maxHops even on a deep tree', () => {
    expect(processAncestry(5, 3, table({ 5: 4, 4: 3, 3: 2, 2: 1 }))).toEqual([5, 4, 3]);
  });

  it('stops when a parent cannot be read — a gone process ends the walk, never throws', () => {
    expect(processAncestry(100, 6, table({ 100: 90 }))).toEqual([100, 90]);
  });

  it('never includes init', () => {
    expect(processAncestry(7, 6, table({ 7: 1 }))).toEqual([7]);
  });
});

describe('readParentPid — the real ps', () => {
  it('reports this process’s own parent, matching process.ppid', () => {
    expect(readParentPid(process.pid)).toBe(process.ppid);
  });

  it('is undefined for a pid that does not exist', () => {
    expect(readParentPid(2_147_483_000)).toBeUndefined();
  });
});
