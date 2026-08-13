import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ATTEMPT_WINDOW_MS,
  dueDailyHeartbeat,
  emptyStamp,
  loadStamp,
  recordAttempt,
  recordTick,
  saveStamp,
  shouldAttempt,
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
