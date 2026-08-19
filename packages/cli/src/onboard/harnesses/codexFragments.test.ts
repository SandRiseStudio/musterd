import { describe, expect, it } from 'vitest';
import { memoryFs, type HarnessContext, type MemoryFs } from '../reconcile/context.js';
import type { CodexServer } from './codexToml.js';
import { codexAdapter } from './codex.js';

const ROOT = '/w/a';
const TOML = '/w/a/.codex/config.toml';
const HOOKS = '/w/a/.codex/hooks.json';

function ctxOf(fs: MemoryFs): HarnessContext {
  return {
    worktreeRoot: ROOT,
    machineConfigRoot: '/machine/.musterd',
    env: { HOME: '/home/u' },
    fs,
    proc: { pid: 1, startedAt: () => 's1', liveness: () => false },
    clock: { now: () => 1 },
    team: 'dawn',
  };
}

async function intentsOf(ctx: HarnessContext) {
  return codexAdapter.desiredFragments(ctx, await codexAdapter.target(ctx));
}

const THEIR_TOML = [
  '# the user’s own comment,   spacing and all',
  'model = "o5"',
  '',
  '[projects."/w/a"]',
  'trust_level = "trusted"',
  '',
  '[mcp_servers.figma]',
  'command = "npx"',
  'args = ["figma-mcp"]',
  '',
].join('\n');

describe('codexAdapter — managed fragments', () => {
  it('exposes the musterd MCP table and the hooks as distinct fragments', async () => {
    const intents = await intentsOf(ctxOf(memoryFs()));
    expect(intents.map((i) => i.fragmentKey).sort()).toEqual(['hooks', 'mcp.musterd']);
    expect(new Set(intents.map((i) => i.containerKey)).size).toBe(2);
    const env = (intents.find((i) => i.fragmentKey === 'mcp.musterd')!.payload as CodexServer).env;
    expect(env).toEqual({ MUSTERD_LAUNCH_SURFACE: 'codex' });
  });

  it('unrelated TOML sections and bytes remain unchanged, including comments and ordering', async () => {
    const fs = memoryFs();
    fs.writeFile(TOML, THEIR_TOML, 0o600);
    const ctx = ctxOf(fs);
    const intents = await intentsOf(ctx);
    const mcp = intents.find((i) => i.fragmentKey === 'mcp.musterd')!;
    expect(await codexAdapter.observe(ctx, mcp)).toEqual({ state: 'absent' });

    await codexAdapter.apply(ctx, { kind: 'write', intent: mcp });
    const after = fs.readFile(TOML)!;
    expect(after.startsWith(THEIR_TOML.trimEnd())).toBe(true); // their bytes verbatim, comments included
    expect(after).toContain('[mcp_servers.musterd]');
    expect(after).toContain('MUSTERD_LAUNCH_SURFACE = "codex"');
    expect(await codexAdapter.observe(ctx, mcp)).toEqual({
      state: 'present',
      fingerprint: mcp.fingerprint,
    });

    await codexAdapter.apply(ctx, { kind: 'remove', intent: mcp });
    const removed = fs.readFile(TOML)!;
    expect(removed).toContain('[mcp_servers.figma]');
    expect(removed).not.toContain('mcp_servers.musterd');
    expect(removed).toContain('# the user’s own comment,   spacing and all');
  });

  it('refuses an invalid intended table shape before opening the write path — prior bytes unchanged', async () => {
    const fs = memoryFs();
    fs.writeFile(TOML, THEIR_TOML, 0o600);
    const ctx = ctxOf(fs);
    const intents = await intentsOf(ctx);
    const mcp = intents.find((i) => i.fragmentKey === 'mcp.musterd')!;
    const poisoned = {
      ...mcp,
      payload: { command: '', args: 'not-a-list', env: { X: 42 } },
    };
    await expect(codexAdapter.apply(ctx, { kind: 'write', intent: poisoned })).rejects.toThrow(
      /refusing to write an invalid Codex mcp_servers\.musterd/,
    );
    expect(fs.readFile(TOML)).toBe(THEIR_TOML);
  });

  it('a musterd table carrying MUSTERD_SURFACE observes as legacy-launch-marker; repair swaps only the marker', async () => {
    const fs = memoryFs();
    fs.writeFile(
      TOML,
      [
        THEIR_TOML.trimEnd(),
        '',
        '[mcp_servers.musterd]',
        'command = "/their/node"',
        'args = ["/their/adapter.js"]',
        '',
        '[mcp_servers.musterd.env]',
        'MUSTERD_SURFACE = "codex"',
        'MUSTERD_GRANT = "msgr_keep"',
        '',
      ].join('\n'),
      0o600,
    );
    const ctx = ctxOf(fs);
    const intents = await intentsOf(ctx);
    const mcp = intents.find((i) => i.fragmentKey === 'mcp.musterd')!;
    expect((await codexAdapter.observe(ctx, mcp)).state).toBe('legacy-launch-marker');

    await codexAdapter.apply(ctx, { kind: 'repair-launch-marker', intent: mcp });
    const after = fs.readFile(TOML)!;
    expect(after).toContain('MUSTERD_LAUNCH_SURFACE = "codex"');
    expect(after).not.toMatch(/MUSTERD_SURFACE =/);
    expect(after).toContain('MUSTERD_GRANT = "msgr_keep"'); // unrelated env preserved
    expect(after).toContain('command = "/their/node"'); // the entry is repaired, not adopted
    expect(after).toContain('[mcp_servers.figma]');
  });

  it('hook fragments add and remove only marker-owned handlers', async () => {
    const fs = memoryFs();
    fs.writeFile(
      HOOKS,
      JSON.stringify({
        hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'their-hook.sh' }] }] },
        theirTopLevel: true,
      }),
      0o600,
    );
    const ctx = ctxOf(fs);
    const intents = await intentsOf(ctx);
    const hooks = intents.find((i) => i.fragmentKey === 'hooks')!;

    await codexAdapter.apply(ctx, { kind: 'write', intent: hooks });
    let parsed = JSON.parse(fs.readFile(HOOKS)!);
    expect(parsed.theirTopLevel).toBe(true);
    expect(
      parsed.hooks.SessionStart.some((g: { hooks: { command: string }[] }) =>
        g.hooks.some((h) => h.command === 'their-hook.sh'),
      ),
    ).toBe(true);
    expect(parsed.hooks.PostToolUse).toBeDefined();
    expect(await codexAdapter.observe(ctx, hooks)).toEqual({
      state: 'present',
      fingerprint: hooks.fingerprint,
    });

    await codexAdapter.apply(ctx, { kind: 'remove', intent: hooks });
    parsed = JSON.parse(fs.readFile(HOOKS)!);
    expect(parsed.hooks.SessionStart).toEqual([
      { hooks: [{ type: 'command', command: 'their-hook.sh' }] },
    ]);
    expect(parsed.hooks.PostToolUse).toBeUndefined();
    expect(await codexAdapter.observe(ctx, hooks)).toEqual({ state: 'absent' });
  });
});
