import { describe, expect, it } from 'vitest';
import { BindingSchema, WorkspaceSpecSchema } from './binding.js';

describe('WorkspaceSpec / Binding schemas', () => {
  const spec = {
    server: 'http://localhost:4849',
    team: 'bravo',
    surface: 'claude-code' as const,
    claim: { mode: 'seat' as const, name: 'Sonnet' },
  };

  it('WorkspaceSpec accepts the secret-free launch fields', () => {
    const parsed = WorkspaceSpecSchema.parse(spec);
    expect(parsed.team).toBe('bravo');
    expect(parsed.claim).toEqual({ mode: 'seat', name: 'Sonnet' });
  });

  it('WorkspaceSpec strips any secret fields — the file can never carry a key/grant', () => {
    // zod object schemas drop unknown keys, so a spec object built from a Binding is secret-free.
    const parsed = WorkspaceSpecSchema.parse({
      ...spec,
      agent_key: 'mskey_should_be_dropped',
      grant: 'msgr_should_be_dropped',
    }) as Record<string, unknown>;
    expect(parsed['agent_key']).toBeUndefined();
    expect(parsed['grant']).toBeUndefined();
  });

  it('Binding is the spec plus the optional secrets, and still parses a keyless spec', () => {
    const full = BindingSchema.parse({ ...spec, agent_key: 'mskey_x', grant: 'msgr_y' });
    expect(full.agent_key).toBe('mskey_x');
    expect(full.grant).toBe('msgr_y');
    // A binding with no secrets (e.g. the committed spec loaded as a Binding) is valid.
    expect(BindingSchema.parse(spec).agent_key).toBeUndefined();
  });

  it('the captured session round-trips on Binding and is STRIPPED from WorkspaceSpec (never committed)', () => {
    const session = {
      harness: 'claude-code',
      id: 'sid-1',
      transcript_path: '/w/.claude/t.jsonl',
      started_at: 1,
    };
    const full = BindingSchema.parse({ ...spec, session });
    expect(full.session).toEqual(session);
    // The committable workspace.json can structurally never carry a session id or transcript path.
    const committed = WorkspaceSpecSchema.parse({ ...spec, session }) as Record<string, unknown>;
    expect(committed['session']).toBeUndefined();
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

    it('is optional — an existing binding without it still parses', () => {
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

    it('is STRIPPED from WorkspaceSpec — an observation is per-machine, never committed', () => {
      const committed = WorkspaceSpecSchema.parse({
        ...spec,
        model_observed: observation,
      }) as Record<string, unknown>;
      expect(committed['model_observed']).toBeUndefined();
    });
  });
});
