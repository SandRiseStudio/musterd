import { describe, expect, it } from 'vitest';
import { EnvelopeSchema, makeEnvelope } from './envelope.js';
import { BlockedBySchema, blockedByOf } from './incident.js';

const base = {
  id: 'msg-1',
  team: 'dawn',
  from: 'Ada',
  to: { kind: 'member', name: 'Lin' } as const,
  ts: 1733760000000,
};

describe('BlockedBy', () => {
  it('parses gate-only and full shapes', () => {
    expect(BlockedBySchema.parse({ gate: 'ci:gates/A11y contrast' }).gate).toBe(
      'ci:gates/A11y contrast',
    );
    const full = BlockedBySchema.parse({
      gate: 'ci:gates/A11y contrast',
      ref: 'pr#828',
      sig: 'lc-office__caption /office-preview 2.83',
    });
    expect(full.ref).toBe('pr#828');
    expect(full.sig).toContain('2.83');
  });

  it('rejects an empty gate', () => {
    expect(BlockedBySchema.safeParse({ gate: '' }).success).toBe(false);
    expect(BlockedBySchema.safeParse({}).success).toBe(false);
  });

  it('blockedByOf returns null for absent/malformed meta and the value when valid', () => {
    expect(blockedByOf(null)).toBeNull();
    expect(blockedByOf(undefined)).toBeNull();
    expect(blockedByOf({})).toBeNull();
    expect(blockedByOf({ blocked_by: { gate: '' } })).toBeNull();
    expect(blockedByOf({ blocked_by: 'ci:gates/x' })).toBeNull();
    expect(blockedByOf({ blocked_by: { gate: 'g' } })).toEqual({ gate: 'g' });
  });

  it('envelope validation rejects a malformed blocked_by, accepts a valid one', () => {
    const good = makeEnvelope({
      ...base,
      act: 'status_update',
      body: 'x',
      meta: { blocked_by: { gate: 'ci:gates/A11y contrast', ref: 'pr#828' } },
    });
    expect(EnvelopeSchema.safeParse(good).success).toBe(true);
    const bad = { ...good, meta: { blocked_by: { gate: '' } } };
    expect(EnvelopeSchema.safeParse(bad).success).toBe(false);
  });
});
