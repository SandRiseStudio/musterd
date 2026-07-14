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

  it('surfaces sticky disconnected / signed_off', () => {
    expect(resolveOfflineReason({ live: false, lastOfflineReason: 'disconnected' })).toBe(
      'disconnected',
    );
    expect(resolveOfflineReason({ live: false, lastOfflineReason: 'signed_off' })).toBe(
      'signed_off',
    );
  });

  it('defaults to unknown', () => {
    expect(resolveOfflineReason({ live: false })).toBe('unknown');
  });
});
