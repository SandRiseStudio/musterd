import { describe, expect, it } from 'vitest';
import { PolicySchema } from './credentials.js';
import { resolveAttestedProvenance } from './model.js';
import { ResidencyPolicyOverrideSchema, ResidencyPolicySchema } from './residency.js';

describe('ResidencyPolicySchema (ADR 131 inc 5) — the knobs, defaults in ONE place', () => {
  it('parse({}) yields the launch defaults (owner call 2026-07-11)', () => {
    const p = ResidencyPolicySchema.parse({});
    expect(p).toEqual({
      lane: 'both',
      cooldown_ms: 30 * 60_000,
      hourly_cap: 2,
      attempt_cap: 3,
      tool_policy: 'reply-only',
      timeout_ms: 300_000,
      transcript_max_bytes: 10 * 1024 * 1024,
    });
  });

  it('rejects out-of-range knobs (the write-side strictness the 400 names)', () => {
    expect(ResidencyPolicySchema.safeParse({ cooldown_ms: 30_000 }).success).toBe(false); // <1min
    expect(ResidencyPolicySchema.safeParse({ hourly_cap: 0 }).success).toBe(false);
    expect(ResidencyPolicySchema.safeParse({ attempt_cap: 11 }).success).toBe(false);
    expect(ResidencyPolicySchema.safeParse({ budget_usd: -1 }).success).toBe(false);
    expect(ResidencyPolicySchema.safeParse({ lane: 'off' }).success).toBe(false); // deliberate: no lane=off
  });

  it('the override is sparse: only explicitly-set keys survive; unknown keys strip', () => {
    const o = ResidencyPolicyOverrideSchema.parse({ hourly_cap: 4, mystery: true });
    expect(o).toEqual({ hourly_cap: 4 });
  });

  it('team PolicySchema carries residency defaults without breaking older stored policies', () => {
    // A pre-inc-5 stored policy has no `residency` key — parse fills the full default block.
    const p = PolicySchema.parse({ allow_pre_issued_grants: true });
    expect(p.allow_pre_issued_grants).toBe(true);
    expect(p.residency.cooldown_ms).toBe(30 * 60_000);
  });
});

describe('resolveAttestedProvenance (ADR 131 §6 amendment)', () => {
  it('resolves a known provenance, refuses junk, undefined when unset', () => {
    expect(resolveAttestedProvenance({ MUSTERD_PROVENANCE: 'wake' })).toBe('wake');
    expect(resolveAttestedProvenance({ MUSTERD_PROVENANCE: 'root' })).toBeUndefined();
    expect(resolveAttestedProvenance({})).toBeUndefined();
  });
});
