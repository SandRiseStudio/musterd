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

  it('bakes NOTHING — the slot is shared by the whole worktree family (ADR 165)', () => {
    // This test used to assert the OPPOSITE: that server/team/surface/key/grant "cannot drift out
    // from under us" and were safe to bake. That premise was wrong in exactly one way that matters:
    // the entry is keyed by repo root, so it is one slot shared by every seat worktree, and a per-seat
    // credential in a shared slot means the last writer's secret is presented by every sibling at
    // claim time. Zero-sum, not stale. Everything now resolves from binding.json / workspace.json.
    const env = buildMcpEnv({ ...base, agent_key: 'mskey_x', grant: 'msgr_y' });
    expect(env).toEqual({});
  });
});
