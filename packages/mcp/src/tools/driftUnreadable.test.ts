import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { driftUnreadableOf, DRIFT_STALE_AFTER_MS } from './format.js';

/**
 * "I cannot tell" is a different fact from "nothing is wrong" (lane 01M2NYV805).
 *
 * `provisioningDriftOf` returns null for an absent cache, an unparseable one, and a genuinely clean
 * one alike, so a seat whose drift record is missing reports exactly like a seat with no drift. The
 * population that hits it is the one it exists for: the cache is written on the interrupt-check
 * cadence, so a seat whose PostToolUse hook is stale or missing never writes it — measured across
 * big-body, kimi and ghost on 2026-09-16.
 *
 * The hard half is not detecting absence, it is NOT crying wolf on a folder that was never a seat
 * workspace. `resolveBindingDir` falls back to `process.cwd()` when its walk-up finds nothing
 * (binding.ts:204), so `workspaceDir` is always defined and cannot be the discriminator. These tests
 * pin the resolver's OWN predicate as the gate: a seat workspace is one carrying `.musterd/binding.json`
 * or `.musterd/workspace.json`, which is exactly what the walk-up looks for.
 */

function seat(files: Record<string, string> = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'musterd-du-'));
  mkdirSync(join(root, '.musterd'), { recursive: true });
  for (const [name, body] of Object.entries(files)) {
    writeFileSync(join(root, '.musterd', name), body);
  }
  return root;
}

const cache = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    inspected_at: Date.now(),
    build: '',
    guidance: 0,
    hooks: 0,
    permissions: 0,
    declined: false,
    ...over,
  });

describe('a drift record that cannot be read is not a clean workspace', () => {
  it('reports ABSENT on a seat workspace with no drift.json', () => {
    const w = driftUnreadableOf(seat({ 'binding.json': '{}' }));
    expect(w, 'a bound seat with no drift record read as clean').not.toBeNull();
    expect(w!.kind).toBe('drift_unreadable');
    expect(w!.reason).toBe('absent');
    // The sentence has one job: assert neither health (a lie) nor drift (not known). Asserting on
    // the PROPERTY rather than on a phrase — an earlier version of this test pinned the exact words
    // and failed a message that said the honest thing better.
    expect(w!.text).toMatch(/unknown/i);
    expect(w!.text).toMatch(/not clean/i);
    expect(w!.text).not.toMatch(/\bis drifted\b|\bup to date\b|\bcoherent\b/i);
    // And it must point at the likeliest cause, because that is what decides the reader's next move.
    expect(w!.text).toMatch(/hook/i);
  });

  it('reports UNPARSEABLE on a cache that is not valid JSON, and on one that fails the schema', () => {
    expect(
      driftUnreadableOf(seat({ 'binding.json': '{}', 'drift.json': 'not json{{' }))!.reason,
    ).toBe('unparseable');
    expect(
      driftUnreadableOf(seat({ 'binding.json': '{}', 'drift.json': '{"guidance":"lots"}' }))!
        .reason,
    ).toBe('unparseable');
  });

  describe('STALE — a quiet seat is not a dead hook (ADR 421)', () => {
    // The writer is the PostToolUse hook, and a hook runs only at a tool boundary. A seat that made
    // no tool call for three hours — waiting on a review — has a record exactly as old as its
    // silence, and the first inbox check after the idle reads it BEFORE the hook riding that very
    // call rewrites it. Measured on izzo 2026-09-18: written 13:25:44, no tool call 13:29→16:12,
    // "167m old — the hook is not running" at 16:12:55, rewritten by that hook at 16:12:57. So the
    // adapter remembers the first stale sighting and speaks only when a LATER sighting finds the
    // record still older than that — a tool boundary passed and nothing wrote, which is the one
    // observation that separates a dead hook from a quiet seat.
    const stale = () => Date.now() - DRIFT_STALE_AFTER_MS - 60_000;

    it('is SILENT on the first sighting — the hook riding this call rewrites it if it lives', () => {
      const seen = new Map<string, number>();
      const w = seat({ 'binding.json': '{}', 'drift.json': cache({ inspected_at: stale() }) });
      expect(driftUnreadableOf(w, Date.now(), seen)).toBeNull();
      expect(seen.get(w), 'the first sighting was not remembered').toBeDefined();
    });

    it('reports STALE on the next sighting when the record was NOT rewritten across the boundary', () => {
      const seen = new Map<string, number>();
      const t0 = Date.now();
      const w = seat({ 'binding.json': '{}', 'drift.json': cache({ inspected_at: stale() }) });
      expect(driftUnreadableOf(w, t0, seen)).toBeNull();
      const res = driftUnreadableOf(w, t0 + 2_000, seen);
      expect(
        res,
        'a record the hook had a boundary to rewrite, and did not, read as clean',
      ).not.toBeNull();
      expect(res!.reason).toBe('stale');
      expect(res!.age_ms).toBeGreaterThan(DRIFT_STALE_AFTER_MS);
      // Now the cause is EARNED, and the sentence may name it.
      expect(res!.text).toMatch(/hook/i);
      expect(res!.text).toMatch(/unknown/i);
      expect(res!.text).toMatch(/not clean/i);
    });

    it('stays SILENT when the hook rewrote the record after the first sighting, and re-arms', () => {
      const seen = new Map<string, number>();
      const t0 = Date.now();
      const w = seat({ 'binding.json': '{}', 'drift.json': cache({ inspected_at: stale() }) });
      expect(driftUnreadableOf(w, t0, seen)).toBeNull();
      // The hook wrote 2s after the first sighting; the seat then idled past the threshold again.
      writeFileSync(join(w, '.musterd', 'drift.json'), cache({ inspected_at: t0 + 2_000 }));
      const t1 = t0 + 2_000 + DRIFT_STALE_AFTER_MS + 60_000;
      expect(
        driftUnreadableOf(w, t1, seen),
        'a second idle stretch was read as a dead hook',
      ).toBeNull();
      expect(seen.get(w), 'the memory did not re-arm on the newer record').toBe(t1);
      // …and a boundary after THAT with no write is a dead hook again.
      expect(driftUnreadableOf(w, t1 + 2_000, seen)!.reason).toBe('stale');
    });

    it('forgets the sighting once the record is fresh', () => {
      const seen = new Map<string, number>();
      const t0 = Date.now();
      const w = seat({ 'binding.json': '{}', 'drift.json': cache({ inspected_at: stale() }) });
      expect(driftUnreadableOf(w, t0, seen)).toBeNull();
      writeFileSync(join(w, '.musterd', 'drift.json'), cache({ inspected_at: t0 + 1_000 }));
      expect(driftUnreadableOf(w, t0 + 2_000, seen)).toBeNull();
      expect(seen.has(w), 'a fresh record left the stale memory armed').toBe(false);
    });

    it("remembers per workspace — one seat's sighting is not another's boundary", () => {
      const seen = new Map<string, number>();
      const t0 = Date.now();
      const a = seat({ 'binding.json': '{}', 'drift.json': cache({ inspected_at: stale() }) });
      const b = seat({ 'binding.json': '{}', 'drift.json': cache({ inspected_at: stale() }) });
      expect(driftUnreadableOf(a, t0, seen)).toBeNull();
      expect(driftUnreadableOf(b, t0 + 2_000, seen), "b warned on a's sighting").toBeNull();
      expect(driftUnreadableOf(a, t0 + 3_000, seen)!.reason).toBe('stale');
    });

    it('uses one shared memory by default, so two inbox checks in one adapter process see each other', () => {
      const w = seat({ 'binding.json': '{}', 'drift.json': cache({ inspected_at: stale() }) });
      expect(driftUnreadableOf(w)).toBeNull();
      expect(driftUnreadableOf(w, Date.now() + 2_000)!.reason).toBe('stale');
    });
  });

  it('stays SILENT on a fresh cache, whatever it says — that is provisioningDriftOf s job', () => {
    expect(driftUnreadableOf(seat({ 'binding.json': '{}', 'drift.json': cache() }))).toBeNull();
    expect(
      driftUnreadableOf(seat({ 'binding.json': '{}', 'drift.json': cache({ guidance: 4 }) })),
    ).toBeNull();
  });

  it('stays SILENT on a folder that was never a seat workspace — the anti-wolf case', () => {
    // resolveBindingDir fell back to cwd here. No binding, no committed spec: a fresh clone, a
    // scratch worktree, someone running the adapter from their home directory. It has no drift
    // record because it never should have one, and a warning here is pure noise.
    expect(driftUnreadableOf(seat())).toBeNull();
    expect(driftUnreadableOf(mkdtempSync(join(tmpdir(), 'musterd-bare-')))).toBeNull();
  });

  it('counts a committed workspace spec as a seat workspace, like the resolver does', () => {
    // .musterd/workspace.json is the second thing resolveBindingDir's walk-up accepts, so a folder
    // carrying only it is a seat workspace whose binding has not been written yet.
    expect(driftUnreadableOf(seat({ 'workspace.json': '{}' }))!.reason).toBe('absent');
  });

  it('never throws and never guesses', () => {
    expect(driftUnreadableOf(undefined)).toBeNull();
    expect(driftUnreadableOf(join(tmpdir(), 'musterd-du-does-not-exist'))).toBeNull();
  });
});
