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
});
