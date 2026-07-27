import { describe, expect, it } from 'vitest';
import { buildEntry, buildMcpEnv } from './mcpEntry.js';

/**
 * The ADR 143 / ADR 165 invariant, as an executable rule.
 *
 * Claude Code keys local-scope MCP config by REPO ROOT. Every `agents-*` seat is a git worktree of the
 * same repo, so all of them share ONE `musterd` entry — provisioning any seat overwrites the entry
 * every other seat is using. That is only safe if the entry each seat would write is IDENTICAL.
 *
 * So: build the entry two different seats would produce and require them to be byte-equal. Any future
 * change that reintroduces per-seat state fails here, loudly, with the reason attached.
 */
describe('the repo-root-shared MCP entry is seat-agnostic', () => {
  const izzo = {
    server: 'http://localhost:4849',
    team: 'revive',
    agent_key: 'mskey_izzo',
    grant: 'msgr_izzo',
    surface: 'claude-code' as const,
    claim: { mode: 'seat' as const, name: 'izzo' },
  };
  const miley = {
    server: 'http://localhost:4849',
    team: 'revive',
    agent_key: 'mskey_miley',
    grant: 'msgr_miley',
    surface: 'claude-code' as const,
    claim: { mode: 'seat' as const, name: 'miley' },
  };

  it('two sibling seats produce byte-identical entries', () => {
    expect(JSON.stringify(buildEntry(izzo))).toBe(JSON.stringify(buildEntry(miley)));
  });

  it("leaks neither seat's credentials into the shared slot", () => {
    const serialized = JSON.stringify(buildEntry(izzo));
    expect(serialized).not.toContain('mskey_izzo');
    expect(serialized).not.toContain('msgr_izzo');
  });

  it('a seat differing ONLY by surface still shares the entry', () => {
    // `surface` looks per-seat and is not: it is in binding.json, and baking it made `init` and
    // `agent` write different entries for the same folder.
    expect(buildMcpEnv({ ...izzo, surface: 'cursor' })).toEqual(buildMcpEnv(izzo));
  });
});
