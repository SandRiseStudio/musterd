import { describe, expect, it } from 'vitest';
import { memoryFs, type HarnessContext, type MemoryFs } from '../reconcile/context.js';
import { canonicalFingerprint } from '../reconcile/fragments.js';
import { readServer } from './codexToml.js';
import { grokAdapter } from './grok.js';

const ROOT = '/w/a';
const CFG = '/w/a/.grok/config.toml';

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
  return grokAdapter.desiredFragments(ctx, await grokAdapter.target(ctx));
}

describe('grokAdapter — managed fragments', () => {
  it('exposes the single musterd MCP entry as one fragment carrying only the launch marker', async () => {
    const intents = await intentsOf(ctxOf(memoryFs()));
    expect(intents.map((i) => i.fragmentKey)).toEqual(['mcp.musterd']);
    const payload = intents[0]!.payload as { env: Record<string, string> };
    expect(payload.env).toEqual({ MUSTERD_LAUNCH_SURFACE: 'grok' });
  });

  it('observe fingerprints command+args+env so a write observes as itself', async () => {
    const fs = memoryFs();
    fs.writeFile(CFG, '[mcp_servers.other]\ncommand = "npx"\nargs = ["other-mcp"]\n', 0o600);
    const ctx = ctxOf(fs);
    const mcp = (await intentsOf(ctx))[0]!;
    expect(await grokAdapter.observe(ctx, mcp)).toEqual({ state: 'absent' });

    await grokAdapter.apply(ctx, { kind: 'write', intent: mcp });
    const after = fs.readFile(CFG)!;
    expect(after).toContain('command = "npx"');
    expect(after).toContain('[compat.cursor]');
    expect(after).toMatch(/hooks\s*=\s*false/);
    expect(await grokAdapter.observe(ctx, mcp)).toEqual({
      state: 'present',
      fingerprint: mcp.fingerprint,
    });

    await grokAdapter.apply(ctx, { kind: 'remove', intent: mcp });
    const removed = fs.readFile(CFG)!;
    expect(removed).toContain('[mcp_servers.other]');
    expect(removed).not.toContain('[mcp_servers.musterd]');
    expect(await grokAdapter.observe(ctx, mcp)).toEqual({ state: 'absent' });
  });

  it('matching env with a different command is not equivalent to the desired fragment', async () => {
    const fs = memoryFs();
    const ctx = ctxOf(fs);
    const mcp = (await intentsOf(ctx))[0]!;
    fs.writeFile(
      CFG,
      [
        '[mcp_servers.musterd]',
        'command = "/not/the/desired/node"',
        'args = ["/not/the/desired/adapter.js"]',
        '',
        '[mcp_servers.musterd.env]',
        'MUSTERD_LAUNCH_SURFACE = "grok"',
        '',
      ].join('\n'),
      0o600,
    );
    const observed = await grokAdapter.observe(ctx, mcp);
    expect(observed.state).toBe('present');
    if (observed.state === 'present') {
      expect(observed.fingerprint).not.toBe(mcp.fingerprint);
      expect(observed.fingerprint).not.toBe(
        canonicalFingerprint((mcp.payload as { env: Record<string, string> }).env),
      );
    }
  });

  it('a musterd entry carrying MUSTERD_SURFACE observes as legacy-launch-marker; repair swaps only the marker', async () => {
    const fs = memoryFs();
    fs.writeFile(
      CFG,
      [
        '[mcp_servers.musterd]',
        'command = "/their/node"',
        'args = ["/their/adapter.js"]',
        '',
        '[mcp_servers.musterd.env]',
        'MUSTERD_SURFACE = "grok"',
        'MUSTERD_GRANT = "msgr_keep"',
        '',
      ].join('\n'),
      0o600,
    );
    const ctx = ctxOf(fs);
    const mcp = (await intentsOf(ctx))[0]!;
    expect((await grokAdapter.observe(ctx, mcp)).state).toBe('legacy-launch-marker');

    await grokAdapter.apply(ctx, { kind: 'repair-launch-marker', intent: mcp });
    const entry = readServer(fs.readFile(CFG)!, 'musterd');
    expect(entry?.command).toBe('/their/node');
    expect(entry?.args).toEqual(['/their/adapter.js']);
    expect(entry?.env['MUSTERD_LAUNCH_SURFACE']).toBe('grok');
    expect(entry?.env['MUSTERD_SURFACE']).toBeUndefined();
    expect(entry?.env['MUSTERD_GRANT']).toBe('msgr_keep');
  });
});
