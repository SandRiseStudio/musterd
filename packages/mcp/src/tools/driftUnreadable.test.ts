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

  it('reports STALE when the writer stopped — the signature of a seat that WAS healthy', () => {
    // The case that matters most: a seat whose hook breaks after writing one clean cache. The file
    // exists and is zeroed, so absence-only detection stays silent forever.
    const old = Date.now() - DRIFT_STALE_AFTER_MS - 60_000;
    const w = driftUnreadableOf(
      seat({ 'binding.json': '{}', 'drift.json': cache({ inspected_at: old }) }),
    );
    expect(w, 'a zeroed cache from hours ago read as current health').not.toBeNull();
    expect(w!.reason).toBe('stale');
    expect(w!.age_ms).toBeGreaterThan(DRIFT_STALE_AFTER_MS);
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
