import { describe, expect, it } from 'vitest';
import { buildMcpEnv, type AgentBinding } from './mcpEntry.js';

/**
 * The regression guard for the attestation-truth incident: a seat attested `grok-4.5` for weeks
 * while running `claude-opus-4-8`, because provisioning baked `MUSTERD_MODEL` into the harness MCP
 * entry — the TOP rung of the adapter's ladder, where no later observation could correct it.
 */
describe('buildMcpEnv', () => {
  const base: AgentBinding = {
    server: 'http://127.0.0.1:4849',
    team: 'revive',
    surface: 'claude-code',
    claim: { mode: 'seat', name: 'ryder' },
  };

  it('NEVER bakes MUSTERD_MODEL — a wire-time snapshot must not outrank a live observation', () => {
    // Pass a model anyway (callers hand in a full Binding, which still carries the declared tier):
    // it must not reach the env no matter how it arrives.
    const env = buildMcpEnv({ ...base, model: 'grok-4.5' } as AgentBinding & { model: string });
    expect(env).not.toHaveProperty('MUSTERD_MODEL');
  });

  it('does not bake MUSTERD_CLAIM either — binding.json stays the single source of truth', () => {
    expect(buildMcpEnv(base)).not.toHaveProperty('MUSTERD_CLAIM');
  });

  it('still bakes the fields that are NOT observable and cannot drift out from under us', () => {
    const env = buildMcpEnv({ ...base, agent_key: 'mskey_x', grant: 'msgr_y' });
    expect(env.MUSTERD_SERVER).toBe('http://127.0.0.1:4849');
    expect(env.MUSTERD_TEAM).toBe('revive');
    expect(env.MUSTERD_SURFACE).toBe('claude-code');
    expect(env.MUSTERD_AGENT_KEY).toBe('mskey_x');
    expect(env.MUSTERD_GRANT).toBe('msgr_y');
  });

  it('omits the optional secrets when the folder has none (a keyless chat folder)', () => {
    const env = buildMcpEnv(base);
    expect(env).not.toHaveProperty('MUSTERD_AGENT_KEY');
    expect(env).not.toHaveProperty('MUSTERD_GRANT');
  });
});
