import { describe, expect, it } from 'vitest';
import { BindingSchema, WorkspaceSpecSchema } from './binding.js';

describe('WorkspaceSpec / Binding schemas (strict version 2, ADR 281)', () => {
  const spec = {
    version: 2 as const,
    server: 'http://localhost:4849',
    team: 'bravo',
    claim: { mode: 'seat' as const, name: 'Sonnet' },
  };

  const binding = {
    ...spec,
    agent_key: 'mskey_x',
    grant: 'msgr_y',
    model: 'claude-opus-4-8',
    capabilities: {
      is_admin: false,
      can_flag_urgent: false,
      can_observe: true,
      can_message: 'team' as const,
      visibility_level: 'team' as const,
      tool_allowlist: [],
      declared_resource_scopes: [],
    },
    session: {
      harness: 'claude-code',
      id: 'sid-1',
      transcript_path: '/w/.claude/t.jsonl',
      started_at: 1,
    },
    model_observed: {
      model: 'claude-opus-4-8',
      harness: 'claude-code',
      observed_at: 1784911286433,
    },
    autojoin: true,
    driver: 'nick',
  };

  it('WorkspaceSpec parses the exact version-2 fixture', () => {
    const parsed = WorkspaceSpecSchema.parse(spec);
    expect(parsed.version).toBe(2);
    expect(parsed.team).toBe('bravo');
    expect(parsed.claim).toEqual({ mode: 'seat', name: 'Sonnet' });
  });

  it('Binding parses the exact version-2 fixture with every runtime field', () => {
    const parsed = BindingSchema.parse(binding);
    expect(parsed.agent_key).toBe('mskey_x');
    expect(parsed.grant).toBe('msgr_y');
    expect(parsed.model).toBe('claude-opus-4-8');
    expect(parsed.capabilities?.can_message).toBe('team');
    expect(parsed.session?.id).toBe('sid-1');
    expect(parsed.model_observed?.observed_at).toBe(1784911286433);
    expect(parsed.autojoin).toBe(true);
    expect(parsed.driver).toBe('nick');
    // A binding with no secrets (e.g. a chat/human folder) is still valid.
    expect(BindingSchema.parse(spec).agent_key).toBeUndefined();
  });

  it('rejects the version-1 shape — no version field at all', () => {
    const v1 = {
      server: 'http://localhost:4849',
      team: 'bravo',
      surface: 'claude-code',
      claim: { mode: 'seat', name: 'Sonnet' },
    };
    expect(WorkspaceSpecSchema.safeParse(v1).success).toBe(false);
    expect(BindingSchema.safeParse(v1).success).toBe(false);
  });

  it('rejects an explicit version: 1', () => {
    expect(WorkspaceSpecSchema.safeParse({ ...spec, version: 1 }).success).toBe(false);
    expect(BindingSchema.safeParse({ ...binding, version: 1 }).success).toBe(false);
  });

  it('rejects `surface` — identity no longer carries a Surface (ADR 281)', () => {
    expect(WorkspaceSpecSchema.safeParse({ ...spec, surface: 'claude-code' }).success).toBe(false);
    expect(BindingSchema.safeParse({ ...binding, surface: 'claude-code' }).success).toBe(false);
  });

  it('rejects unknown keys instead of silently stripping them', () => {
    expect(WorkspaceSpecSchema.safeParse({ ...spec, extra: true }).success).toBe(false);
    expect(BindingSchema.safeParse({ ...binding, extra: true }).success).toBe(false);
    // The old strip-to-commit path is gone: a spec built from a Binding must be constructed
    // field-by-field, never by parsing the binding through the spec schema.
    expect(WorkspaceSpecSchema.safeParse({ ...spec, agent_key: 'mskey_leak' }).success).toBe(false);
    expect(WorkspaceSpecSchema.safeParse({ ...spec, session: binding.session }).success).toBe(false);
  });

  it('rejects malformed runtime fields', () => {
    expect(
      BindingSchema.safeParse({ ...binding, session: { ...binding.session, started_at: 'now' } })
        .success,
    ).toBe(false);
    expect(BindingSchema.safeParse({ ...binding, model: 'x'.repeat(121) }).success).toBe(false);
    expect(BindingSchema.safeParse({ ...binding, driver: '' }).success).toBe(false);
    expect(
      BindingSchema.safeParse({
        ...binding,
        model_observed: { model: 'm', harness: '', observed_at: 1 },
      }).success,
    ).toBe(false);
  });

  it('rejects fractional integer fields — the #508 unreadable-binding class', () => {
    expect(
      BindingSchema.safeParse({ ...binding, session: { ...binding.session, started_at: 1.5 } })
        .success,
    ).toBe(false);
    expect(
      BindingSchema.safeParse({
        ...binding,
        model_observed: { ...binding.model_observed, observed_at: 1784911286433.7 },
      }).success,
    ).toBe(false);
  });

  describe('model_observed', () => {
    const observation = {
      model: 'claude-opus-4-8',
      harness: 'claude-code',
      observed_at: 1784911286433,
    };

    it('round-trips a full observation on Binding', () => {
      const full = BindingSchema.parse({ ...spec, model_observed: observation });
      expect(full.model_observed).toEqual(observation);
    });

    it('is optional — a binding without it still parses', () => {
      expect(BindingSchema.parse(spec).model_observed).toBeUndefined();
    });

    it('coexists with a contradicting declaration — the tripwire needs both kept apart', () => {
      const full = BindingSchema.parse({
        ...spec,
        model: 'grok-4.5',
        model_observed: observation,
      });
      expect(full.model).toBe('grok-4.5');
      expect(full.model_observed?.model).toBe('claude-opus-4-8');
    });

    it('is REJECTED by WorkspaceSpec — an observation is per-machine, never committed', () => {
      expect(WorkspaceSpecSchema.safeParse({ ...spec, model_observed: observation }).success).toBe(
        false,
      );
    });
  });
});
