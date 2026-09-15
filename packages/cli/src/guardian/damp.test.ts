import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ATTEMPT_WINDOW_MS,
  dueDailyHeartbeat,
  emptyStamp,
  loadStamp,
  recordAttempt,
  recordTick,
  saveStamp,
  RAISE_WINDOW_MS,
  recordRaise,
  recordSuppressed,
  shouldAttempt,
  shouldRaise,
} from './damp.js';

const NOW = 10_000_000;

describe('damping (spec §5: one attempt per class per hour, then escalate)', () => {
  it('first attempt is allowed', () => {
    expect(shouldAttempt(emptyStamp(), 'publisher_failed', NOW)).toBe(true);
  });

  it('a second attempt within the hour is refused', () => {
    const s = recordAttempt(emptyStamp(), 'publisher_failed', NOW);
    expect(shouldAttempt(s, 'publisher_failed', NOW + ATTEMPT_WINDOW_MS - 1)).toBe(false);
    expect(shouldAttempt(s, 'publisher_failed', NOW + ATTEMPT_WINDOW_MS)).toBe(true);
  });

  it('an attempt for one class does not block another', () => {
    const s = recordAttempt(emptyStamp(), 'publisher_failed', NOW);
    expect(shouldAttempt(s, 'crashloop', NOW + 1)).toBe(true);
  });
});

describe('stamp file', () => {
  it('round-trips through disk', () => {
    const p = join(mkdtempSync(join(tmpdir(), 'guardian-')), 'stamp.json');
    const s = recordTick(recordAttempt(emptyStamp(), 'crashloop', NOW), NOW);
    saveStamp(p, s);
    expect(loadStamp(p)).toEqual(s);
  });

  it('absent or corrupt stamp loads as empty, never throws', () => {
    const dir = mkdtempSync(join(tmpdir(), 'guardian-'));
    expect(loadStamp(join(dir, 'missing.json'))).toEqual(emptyStamp());
    const bad = join(dir, 'bad.json');
    saveStamp(bad, emptyStamp());
    writeFileSync(bad, '{not json');
    expect(loadStamp(bad)).toEqual(emptyStamp());
  });
});

describe('heartbeat', () => {
  it('recordTick stamps lastTickAt', () => {
    expect(recordTick(emptyStamp(), NOW).lastTickAt).toBe(NOW);
  });

  it('daily heartbeat is due once per 24h', () => {
    const s = emptyStamp();
    expect(dueDailyHeartbeat(s, NOW)).toBe(true);
    const beat = { ...s, lastHeartbeatAt: NOW };
    expect(dueDailyHeartbeat(beat, NOW + 23 * 3_600_000)).toBe(false);
    expect(dueDailyHeartbeat(beat, NOW + 24 * 3_600_000)).toBe(true);
  });
});

/**
 * Raise damping. Measured 2026-08-21: five byte-identical `daemon_down` asks in 33 minutes
 * (12:18:10, 12:20:39, 12:23:02, 12:41:55, 12:51:14), 30 raises all-time carrying 4 distinct
 * bodies. `shouldAttempt` never applied to them — it gated remediation only.
 */
describe('raise damping (a raise repeats only when its reason changes)', () => {
  const REASON = 'daemon_down\nneeds a human\n/health did not answer in 3 attempts (timeout)';
  const OTHER = 'daemon_down\nneeds a human\n/health did not answer in 3 attempts (fetch failed)';

  it('the first raise of a reason always fires', () => {
    expect(shouldRaise(emptyStamp(), 'daemon_down', REASON, NOW)).toBe(true);
  });

  it('an identical reason inside the window is suppressed, and released at the boundary', () => {
    const s = recordRaise(emptyStamp(), 'daemon_down', REASON, NOW);
    expect(shouldRaise(s, 'daemon_down', REASON, NOW + RAISE_WINDOW_MS - 1)).toBe(false);
    expect(shouldRaise(s, 'daemon_down', REASON, NOW + RAISE_WINDOW_MS)).toBe(true);
  });

  it('a CHANGED reason is new information and gets through immediately', () => {
    const s = recordRaise(emptyStamp(), 'daemon_down', REASON, NOW);
    expect(shouldRaise(s, 'daemon_down', OTHER, NOW + 1)).toBe(true);
  });

  it('a raise for one class does not suppress another', () => {
    const s = recordRaise(emptyStamp(), 'daemon_down', REASON, NOW);
    expect(shouldRaise(s, 'schema_drift', REASON, NOW + 1)).toBe(true);
  });

  it('suppressed repeats are counted, and the window runs from the raise that fired', () => {
    let s = recordRaise(emptyStamp(), 'daemon_down', REASON, NOW);
    for (const t of [NOW + 60_000, NOW + 120_000, NOW + 180_000]) {
      expect(shouldRaise(s, 'daemon_down', REASON, t)).toBe(false);
      s = recordSuppressed(s, 'daemon_down', t);
    }
    const memo = s.lastRaise.daemon_down;
    expect(memo?.suppressed).toBe(3);
    expect(memo?.raisedAt).toBe(NOW);
    expect(memo?.lastSeenAt).toBe(NOW + 180_000);
    // Suppression must not slide the window — otherwise a persisting outage goes quiet forever.
    expect(shouldRaise(s, 'daemon_down', REASON, NOW + RAISE_WINDOW_MS)).toBe(true);
  });

  it('re-raising the same reason resets the count and restarts the window', () => {
    let s = recordRaise(emptyStamp(), 'daemon_down', REASON, NOW);
    s = recordSuppressed(s, 'daemon_down', NOW + 60_000);
    s = recordRaise(s, 'daemon_down', REASON, NOW + RAISE_WINDOW_MS);
    expect(s.lastRaise.daemon_down?.suppressed).toBe(0);
    expect(s.lastRaise.daemon_down?.raisedAt).toBe(NOW + RAISE_WINDOW_MS);
  });

  it('a stamp written before raise memory existed loads without one and still raises', () => {
    const p = join(mkdtempSync(join(tmpdir(), 'guardian-')), 'stamp.json');
    writeFileSync(p, JSON.stringify({ lastAttemptAt: {}, lastTickAt: NOW }));
    const s = loadStamp(p);
    expect(s.lastRaise).toEqual({});
    expect(shouldRaise(s, 'daemon_down', REASON, NOW)).toBe(true);
  });
});
