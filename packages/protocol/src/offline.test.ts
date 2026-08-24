import { describe, expect, it } from 'vitest';
import { resolveOfflineReason } from './offline.js';

describe('resolveOfflineReason — ADR 141', () => {
  it('is null while live', () => {
    expect(resolveOfflineReason({ live: true, reclaimable: true })).toBeNull();
  });

  it('prefers reconnecting during reclaim grace', () => {
    expect(
      resolveOfflineReason({
        live: false,
        reclaimable: true,
        lastOfflineReason: 'disconnected',
      }),
    ).toBe('reconnecting');
  });

  it('prefers off_hours over sticky disconnect', () => {
    expect(
      resolveOfflineReason({
        live: false,
        availability: { status: 'off_hours' },
        lastOfflineReason: 'disconnected',
      }),
    ).toBe('off_hours');
  });

  it('surfaces sticky disconnected', () => {
    expect(resolveOfflineReason({ live: false, lastOfflineReason: 'disconnected' })).toBe(
      'disconnected',
    );
  });

  it('defaults to unknown', () => {
    expect(resolveOfflineReason({ live: false })).toBe('unknown');
  });

  it('surfaces the split deliberate-exit stamps (presence-honesty §2.3)', () => {
    expect(resolveOfflineReason({ live: false, lastOfflineReason: 'left_team' })).toBe('left_team');
    expect(resolveOfflineReason({ live: false, lastOfflineReason: 'seat_released' })).toBe(
      'seat_released',
    );
    expect(resolveOfflineReason({ live: false, lastOfflineReason: 'session_ended' })).toBe(
      'session_ended',
    );
  });

  it('normalizes legacy signed_off rows to seat_released on read', () => {
    expect(resolveOfflineReason({ live: false, lastOfflineReason: 'signed_off' })).toBe(
      'seat_released',
    );
  });
});
