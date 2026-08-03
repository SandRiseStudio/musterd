import { describe, expect, it } from 'vitest';
import {
  ContinuityRegistrySchema,
  matchBinding,
  pruneRegistry,
  type ContinuityBinding,
  type ContinuityRegistry,
} from './continuity.js';
import { WakeOrderSchema, WakeReportBodySchema } from './residency.js';

const binding = (over: Partial<ContinuityBinding> = {}): ContinuityBinding => ({
  thread_id: 'T1',
  harness: 'claude-code',
  session_id: 'sess-1',
  transcript_path: '/tmp/t1.jsonl',
  bound_at: 1_000,
  captured_at: 1_000,
  ...over,
});

const registry = (bindings: ContinuityBinding[]): ContinuityRegistry => ({
  version: 1,
  team: 'revive',
  seat: 'stanley',
  bindings,
});

describe('continuity registry contract (ADR 210)', () => {
  it('round-trips a registry holding several threads', () => {
    const reg = registry([binding(), binding({ thread_id: 'T2', session_id: 'sess-2' })]);
    expect(ContinuityRegistrySchema.parse(reg)).toEqual(reg);
  });

  it('rejects an unknown field rather than silently trusting a hand-edited file', () => {
    const reg = { ...registry([binding()]), workspace_path: '/Users/nick/agents-stanley' };
    expect(ContinuityRegistrySchema.safeParse(reg).success).toBe(false);
  });

  it('rejects a binding with no session id — the registry never invents a resume target', () => {
    const reg = registry([{ ...binding(), session_id: '' }]);
    expect(ContinuityRegistrySchema.safeParse(reg).success).toBe(false);
  });
});

describe('matchBinding — exact match only (ADR 210)', () => {
  const b1 = binding();
  const b2 = binding({ thread_id: 'T2', session_id: 'sess-2' });
  const reg = registry([b1, b2]);
  const exact = {
    team: 'revive',
    seat: 'stanley',
    thread_id: 'T1',
    harness: 'claude-code',
  } as const;

  it('matches on team + seat + thread + harness', () => {
    expect(matchBinding(reg, exact)).toEqual(b1);
    expect(matchBinding(reg, { ...exact, thread_id: 'T2' })).toEqual(b2);
  });

  it('misses on a different seat — a registry found under the wrong seat is never adopted', () => {
    expect(matchBinding(reg, { ...exact, seat: 'izzo' })).toBeNull();
  });

  it('misses on a different team', () => {
    expect(matchBinding(reg, { ...exact, team: 'dawn' })).toBeNull();
  });

  it('misses on a different harness class', () => {
    expect(matchBinding(reg, { ...exact, harness: 'codex' })).toBeNull();
  });

  it('misses on an unknown thread and never falls back to the most recent binding', () => {
    expect(matchBinding(reg, { ...exact, thread_id: 'T-unknown' })).toBeNull();
  });

  it('misses on an empty registry', () => {
    expect(matchBinding(registry([]), exact)).toBeNull();
  });
});

describe('pruneRegistry (ADR 210)', () => {
  const base = {
    now: 10_000,
    maxAgeMs: 5_000,
    transcriptExists: () => true,
    resolvedThreads: new Set<string>(),
  };

  it('keeps a live, matching, in-horizon binding through every drop reason', () => {
    const b = binding({ bound_at: 8_000, captured_at: 8_000 });
    expect(pruneRegistry(registry([b]), base).bindings).toEqual([b]);
  });

  it('drops a binding whose transcript is gone', () => {
    const b = binding({ bound_at: 8_000, captured_at: 8_000 });
    expect(
      pruneRegistry(registry([b]), { ...base, transcriptExists: () => false }).bindings,
    ).toEqual([]);
  });

  it('drops a binding whose thread has resolved', () => {
    const b = binding({ bound_at: 8_000, captured_at: 8_000 });
    expect(
      pruneRegistry(registry([b]), { ...base, resolvedThreads: new Set(['T1']) }).bindings,
    ).toEqual([]);
  });

  it('drops a binding past the age horizon', () => {
    const b = binding({ bound_at: 1_000, captured_at: 1_000 });
    expect(pruneRegistry(registry([b]), base).bindings).toEqual([]);
  });

  it('drops only the unusable bindings, keeping the rest', () => {
    const live = binding({ thread_id: 'T-live', bound_at: 9_000, captured_at: 9_000 });
    const stale = binding({ thread_id: 'T-stale', bound_at: 1, captured_at: 1 });
    expect(pruneRegistry(registry([live, stale]), base).bindings).toEqual([live]);
  });

  it('treats a binding with no transcript path as unusable', () => {
    const b = binding({ bound_at: 9_000, captured_at: 9_000, transcript_path: undefined });
    expect(pruneRegistry(registry([b]), base).bindings).toEqual([]);
  });
});

describe('the registry is never a wire type (ADR 210 custody boundary)', () => {
  // Behavioural, not structural: these assert that local identity cannot RIDE the wire even when a
  // caller tries to attach it, which is the invariant ADR 210 actually depends on.
  it('strips local session identity from a wake order rather than forwarding it', () => {
    const order = WakeOrderSchema.parse({
      lease_id: 'L1',
      seat: 'stanley',
      act_id: 'A1',
      act: 'message',
      sender: 'nick',
      lane: 'immediate',
      composed_line: 'stanley: reply to nick',
      expires_at: 2_000,
      session_id: 'sess-1',
      transcript_path: '/tmp/t1.jsonl',
    });
    expect(order).not.toHaveProperty('session_id');
    expect(order).not.toHaveProperty('transcript_path');
  });

  it('strips local session identity from a wake report rather than forwarding it', () => {
    const report = WakeReportBodySchema.parse({
      lease_id: 'L1',
      occupied: true,
      delivery_outcome: 'resumed',
      transcript_bytes: 1_024,
      transcript_age_ms: 5_000,
      session_id: 'sess-1',
      transcript_path: '/tmp/t1.jsonl',
    });
    expect(report).not.toHaveProperty('session_id');
    expect(report).not.toHaveProperty('transcript_path');
    // The non-content measurements it MAY carry are still there — this is a boundary, not a blanket.
    expect(report.transcript_bytes).toBe(1_024);
  });
});
