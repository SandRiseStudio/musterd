import { describe, expect, it } from 'vitest';
import { hasServer, listServers, removeServers, renderServer, upsertServer } from './codexToml.js';

const USER = `# my codex config
model = "o3"

[tui]
theme = "dark"

[mcp_servers.context7]
command = "npx"
args = ["-y", "@upstash/context7-mcp"]
`;

describe('renderServer', () => {
  it('renders a table + env subtable with TOML-quoted strings', () => {
    const out = renderServer('supabase', {
      command: 'npx',
      args: ['-y', '@supabase/mcp'],
      env: { SUPABASE_ACCESS_TOKEN: '${SUPABASE_ACCESS_TOKEN}' },
    });
    expect(out).toContain('[mcp_servers.supabase]');
    expect(out).toContain('command = "npx"');
    expect(out).toContain('args = ["-y", "@supabase/mcp"]');
    expect(out).toContain('[mcp_servers.supabase.env]');
    expect(out).toContain('SUPABASE_ACCESS_TOKEN = "${SUPABASE_ACCESS_TOKEN}"');
  });

  it('omits the env subtable when there is no env', () => {
    expect(renderServer('x', { command: 'c', args: [], env: {} })).not.toContain('.env]');
  });

  it('escapes quotes and backslashes in values', () => {
    const out = renderServer('x', { command: 'a\\b"c', args: [], env: {} });
    expect(out).toContain('command = "a\\\\b\\"c"');
  });
});

describe('upsertServer', () => {
  it('adds a server additively, preserving all other content', () => {
    const out = upsertServer(USER, 'musterd', {
      command: 'node',
      args: ['/abs/index.js'],
      env: { MUSTERD_TOKEN: 'tok' },
    });
    expect(out).toContain('model = "o3"'); // user setting kept
    expect(hasServer(out, 'context7')).toBe(true); // user server kept
    expect(hasServer(out, 'musterd')).toBe(true);
    expect(out).toContain('theme = "dark"'); // [tui] kept
  });

  it('is per-server idempotent — re-adding replaces only that table', () => {
    let out = upsertServer(USER, 'musterd', { command: 'node', args: ['a'], env: {} });
    out = upsertServer(out, 'musterd', { command: 'node', args: ['b'], env: {} });
    expect(listServers(out).filter((s) => s === 'musterd')).toHaveLength(1);
    expect(out).toContain('args = ["b"]');
    expect(out).not.toContain('args = ["a"]');
    expect(hasServer(out, 'context7')).toBe(true);
  });

  it('writes into an empty config', () => {
    const out = upsertServer('', 'musterd', { command: 'node', args: [], env: {} });
    expect(out).toBe('[mcp_servers.musterd]\ncommand = "node"\nargs = []\n');
  });
});

describe('removeServers', () => {
  it('removes a server table (+ its .env) and leaves the rest intact', () => {
    const added = upsertServer(USER, 'musterd', {
      command: 'node',
      args: [],
      env: { K: 'v' },
    });
    const out = removeServers(added, ['musterd']);
    expect(hasServer(out, 'musterd')).toBe(false);
    expect(out).not.toContain('[mcp_servers.musterd.env]');
    expect(hasServer(out, 'context7')).toBe(true);
    expect(out).toContain('model = "o3"');
    expect(out).not.toMatch(/\n{3,}/); // no big gaps left behind
  });

  it('removes several at once and is a no-op for absent names', () => {
    const out = removeServers(USER, ['context7', 'nope']);
    expect(hasServer(out, 'context7')).toBe(false);
    expect(out).toContain('model = "o3"');
  });

  it('is a no-op on empty/whitespace input', () => {
    expect(removeServers('', ['x'])).toBe('');
    expect(removeServers('   \n', ['x'])).toBe('   \n');
  });
});

describe('listServers / hasServer', () => {
  it('lists server names from headers, ignoring .env subtables and other tables', () => {
    expect(listServers(USER)).toEqual(['context7']);
    const two = upsertServer(USER, 'musterd', { command: 'n', args: [], env: { A: 'b' } });
    expect(listServers(two).sort()).toEqual(['context7', 'musterd']);
  });
});
