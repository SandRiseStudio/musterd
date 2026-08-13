import { describe, expect, it } from 'vitest';
import { PolicySchema } from './credentials.js';
import { resolveAttestedProvenance } from './model.js';
import {
  LOOP_EDGES,
  LoopEdgeSchema,
  WakeContextPacketSchema,
  WakeContextRequestSchema,
  WakeContextResponseSchema,
  WakeProgressBodySchema,
  WakeReportBodySchema,
  WakeTurnBodySchema,
  ResidencyPolicyOverrideSchema,
  ResidencyPolicySchema,
} from './residency.js';

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
      transcript_max_bytes: 256 * 1024,
      portable_inbox_replies: false,
      exact_match_resume: false,
      resume_eligible_ms: 300_000,
      flow: 'manual',
      // ADR 214: a raised deferral is not a wake reason until a seat opts in.
      raised_deferral_wakes: false,
      work_timeout_ms: 30 * 60_000,
    });
  });

  it('ships exact-match resume OFF — ADR 210 enables it per cohort, never by default', () => {
    expect(ResidencyPolicySchema.parse({}).exact_match_resume).toBe(false);
  });

  it('holds the resume-eligibility horizon inside 1min–15min', () => {
    expect(ResidencyPolicySchema.safeParse({ resume_eligible_ms: 59_999 }).success).toBe(false);
    expect(ResidencyPolicySchema.safeParse({ resume_eligible_ms: 900_001 }).success).toBe(false);
    expect(ResidencyPolicySchema.parse({ resume_eligible_ms: 60_000 }).resume_eligible_ms).toBe(
      60_000,
    );
  });

  it('the hygiene bound sits below the measured resume/fresh crossover (2026-07-29)', () => {
    const { transcript_max_bytes: bound } = ResidencyPolicySchema.parse({});
    // The 11-row `residency.wake_cost` ledger, joined to pre-wake transcript size: resume cost
    // $0.76–$1.23 at 231–373 KiB (at or under the $0.91–1.51 fresh range) and $2.53 at 450 KiB.
    // The bound must roll the 450 KiB case to fresh and keep the 231 KiB one resumable.
    expect(bound).toBeLessThan(449.8 * 1024);
    expect(bound).toBeGreaterThanOrEqual(231.0 * 1024);
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

describe('portable wake context (ADR 209)', () => {
  const packet = {
    version: 1,
    wake: { kind: 'reply' as const, act_id: 'A1' },
    objective: { action: 'reply' as const },
    state: {
      memory: { headline: 'resume checkout review', saved_at: 1, size_bytes: 42 },
    },
    fetch: ['inbox_thread', 'seat_memory'] as const,
    delivery: { requirement: 'portable' as const, intended: 'fresh' as const },
  };

  it('requires exactly one canonical context target', () => {
    expect(WakeContextRequestSchema.safeParse({ act_id: 'A1' }).success).toBe(true);
    expect(WakeContextRequestSchema.safeParse({ lane_id: 'L1' }).success).toBe(true);
    expect(WakeContextRequestSchema.safeParse({}).success).toBe(false);
    expect(WakeContextRequestSchema.safeParse({ act_id: 'A1', lane_id: 'L1' }).success).toBe(false);
  });

  it('accepts the bounded memory envelope and response wrapper', () => {
    expect(WakeContextPacketSchema.parse(packet).state.memory).toEqual({
      headline: 'resume checkout review',
      saved_at: 1,
      size_bytes: 42,
    });
    expect(WakeContextResponseSchema.parse({ context: packet }).context.delivery).toEqual({
      requirement: 'portable',
      intended: 'fresh',
    });
  });

  it('rejects a free-form body in its strict bounded packet shapes', () => {
    expect(() =>
      WakeContextPacketSchema.parse({
        ...packet,
        state: { thread: { id: 'T1', participant_count: 2, unread_count: 1, body: 'leak' } },
      }),
    ).toThrow();
  });

  it('accepts non-content delivery outcome measurements', () => {
    expect(
      WakeReportBodySchema.parse({
        lease_id: 'L1',
        occupied: true,
        delivery_outcome: 'fresh_fallback',
        transcript_bytes: 262_144,
        transcript_age_ms: 3_000,
      }).delivery_outcome,
    ).toBe('fresh_fallback');
  });
});

describe('WakeTurnBodySchema (ADR 251 §7 — per-turn telemetry + transcript capture)', () => {
  const turn = {
    lease_id: 'L1',
    turn: 1,
    usage: { input_tokens: 1000, output_tokens: 50 },
    cost_usd: 0.0063,
    stop_reason: 'tool_use',
    transcript: { assistant: [{ type: 'text', text: 'checking inbox' }], tool_results: null },
  };

  it('accepts a full turn row and a minimal one (usage only)', () => {
    expect(WakeTurnBodySchema.parse(turn).turn).toBe(1);
    expect(
      WakeTurnBodySchema.parse({
        lease_id: 'L1',
        turn: 2,
        usage: { input_tokens: 1, output_tokens: 1 },
      }).cost_usd,
    ).toBeUndefined();
  });

  it('rejects a non-positive turn index and negative cost', () => {
    expect(() => WakeTurnBodySchema.parse({ ...turn, turn: 0 })).toThrow();
    expect(() => WakeTurnBodySchema.parse({ ...turn, cost_usd: -1 })).toThrow();
  });

  it('rejects a transcript over the capture byte bound — DB growth is accepted, unbounded rows are not', () => {
    expect(() =>
      WakeTurnBodySchema.parse({ ...turn, transcript: { blob: 'x'.repeat(300_000) } }),
    ).toThrow();
  });
});

describe('LOOP_EDGES (ADR 262)', () => {
  it('is exactly the three work-order edges', () => {
    expect([...LOOP_EDGES]).toEqual(['review', 'dispatch_handoff', 'dispatch_continuation']);
  });

  it('rejects inbox derivations as edges', () => {
    expect(LoopEdgeSchema.safeParse('work_order').success).toBe(false);
    expect(LoopEdgeSchema.safeParse('batched').success).toBe(false);
    expect(LoopEdgeSchema.safeParse('immediate').success).toBe(false);
  });
});

describe('WakeProgressBodySchema (ADR 262)', () => {
  it('accepts { lease_id } and nothing else', () => {
    expect(WakeProgressBodySchema.parse({ lease_id: '01KZY20ZRJ0SBH8WJ3CTFPKDP3' })).toEqual({
      lease_id: '01KZY20ZRJ0SBH8WJ3CTFPKDP3',
    });
  });

  it('rejects missing lease_id, empty, and extra keys', () => {
    expect(WakeProgressBodySchema.safeParse({}).success).toBe(false);
    expect(WakeProgressBodySchema.safeParse({ lease_id: '' }).success).toBe(false);
    expect(WakeProgressBodySchema.safeParse({ lease_id: 'L1', spawned: true }).success).toBe(false);
  });
});
