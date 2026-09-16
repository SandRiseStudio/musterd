import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DRIFT_CACHE_TTL_MS,
  driftCachePath,
  readDriftCache,
  refreshDriftCache,
} from './driftCache.js';

describe('drift cache', () => {
  const dirs: string[] = [];
  const dir = (): string => {
    const d = mkdtempSync(join(tmpdir(), 'musterd-drift-'));
    mkdirSync(join(d, '.musterd'));
    dirs.push(d);
    return d;
  };
  afterEach(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    dirs.length = 0;
  });
  const drifted = { guidance: ['a'], hooks: [], permissions: ['x'] };

  it('inspects and writes when absent', () => {
    const d = dir();
    const inspect = vi.fn(() => drifted);
    const c = refreshDriftCache(d, {
      daemonBuild: 'abc',
      now: 1000,
      inspect,
      declined: () => false,
    });
    expect(inspect).toHaveBeenCalledTimes(1);
    expect(c).toEqual({
      inspected_at: 1000,
      build: 'abc',
      guidance: 1,
      hooks: 0,
      permissions: 1,
      declined: false,
    });
    expect(JSON.parse(readFileSync(driftCachePath(d), 'utf8'))).toEqual(c);
  });

  it('does not re-inspect inside the TTL with the same build', () => {
    const d = dir();
    const inspect = vi.fn(() => drifted);
    refreshDriftCache(d, { daemonBuild: 'abc', now: 1000, inspect, declined: () => false });
    refreshDriftCache(d, {
      daemonBuild: 'abc',
      now: 1000 + DRIFT_CACHE_TTL_MS - 1,
      inspect,
      declined: () => false,
    });
    expect(inspect).toHaveBeenCalledTimes(1);
  });

  it('re-inspects when the TTL passes, and immediately when the daemon build changes', () => {
    const d = dir();
    const inspect = vi.fn(() => drifted);
    refreshDriftCache(d, { daemonBuild: 'abc', now: 1000, inspect, declined: () => false });
    refreshDriftCache(d, {
      daemonBuild: 'abc',
      now: 1000 + DRIFT_CACHE_TTL_MS,
      inspect,
      declined: () => false,
    });
    refreshDriftCache(d, {
      daemonBuild: 'def',
      now: 1001 + DRIFT_CACHE_TTL_MS,
      inspect,
      declined: () => false,
    });
    expect(inspect).toHaveBeenCalledTimes(3);
  });

  // An unknown daemon build must never invalidate: the probe that cannot reach the daemon would
  // otherwise re-inspect the whole workspace at every tool boundary, which is the cost the cache
  // exists to avoid — and a daemon being down says nothing about this folder's provisioning.
  it('an undefined daemon build leaves a fresh cache alone', () => {
    const d = dir();
    const inspect = vi.fn(() => drifted);
    refreshDriftCache(d, { daemonBuild: 'abc', now: 1000, inspect, declined: () => false });
    refreshDriftCache(d, {
      daemonBuild: undefined,
      now: 2000,
      inspect,
      declined: () => false,
    });
    expect(inspect).toHaveBeenCalledTimes(1);
  });

  // The tombstone is a fact about the folder, not about the inspection: a declined folder still
  // measures its drift, and the flag is what tells a reader the repair will not happen by itself.
  it('carries the declined tombstone', () => {
    const d = dir();
    const c = refreshDriftCache(d, {
      daemonBuild: 'abc',
      now: 1000,
      inspect: () => drifted,
      declined: () => true,
    });
    expect(c.declined).toBe(true);
    expect(readDriftCache(d)?.declined).toBe(true);
  });

  // A folder with no `.musterd` is not a musterd workspace at all. Inspecting it is harmless and
  // reads clean, but CREATING the directory would plant seat state in whatever folder a probe
  // happened to run in — so the cache reports and writes nothing.
  it('never creates .musterd in a folder that has none', () => {
    const d = mkdtempSync(join(tmpdir(), 'musterd-drift-bare-'));
    dirs.push(d);
    const c = refreshDriftCache(d, {
      daemonBuild: 'abc',
      now: 1000,
      inspect: () => drifted,
      declined: () => false,
    });
    expect(c).toMatchObject({ guidance: 1, permissions: 1 });
    expect(existsSync(join(d, '.musterd'))).toBe(false);
    expect(readDriftCache(d)).toBeNull();
  });

  it('readDriftCache is null on absent or garbage', () => {
    const d = dir();
    expect(readDriftCache(d)).toBeNull();
    writeFileSync(driftCachePath(d), '{nope');
    expect(readDriftCache(d)).toBeNull();
  });

  // A clean folder must still write the row: absent and clean are different states, and only a
  // written zero lets a reader say "inspected, nothing wrong" rather than "never looked".
  it('writes a zeroed row for a clean folder', () => {
    const d = dir();
    const c = refreshDriftCache(d, {
      daemonBuild: 'abc',
      now: 1000,
      inspect: () => ({ guidance: [], hooks: [], permissions: [] }),
      declined: () => false,
    });
    expect(c).toMatchObject({ guidance: 0, hooks: 0, permissions: 0 });
    expect(readDriftCache(d)).toEqual(c);
  });
});
