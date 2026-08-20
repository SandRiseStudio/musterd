import { describe, expect, it } from 'vitest';
import { memoryFs, type HarnessContext, type MemoryFs } from '../reconcile/context.js';
import { cursorAdapter } from './cursor.js';

const ROOT = '/w/a';
const MCP = '/w/a/.cursor/mcp.json';
const HOOKS = '/w/a/.cursor/hooks.json';

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
  return cursorAdapter.desiredFragments(ctx, await cursorAdapter.target(ctx));
}

describe('cursorAdapter — managed fragments', () => {
  it('gives .cursor/mcp.json, hooks, and guidance independent fragment keys and containers', async () => {
    const ctx = ctxOf(memoryFs());
    const intents = await intentsOf(ctx);
    expect(intents.map((i) => i.fragmentKey).sort()).toEqual(['guidance', 'hooks', 'mcp.musterd']);
    expect(new Set(intents.map((i) => i.containerKey)).size).toBe(3);
    for (const intent of intents) expect(intent.scope).toBe('folder');
  });

  it('the desired MCP entry carries exactly MUSTERD_LAUNCH_SURFACE=cursor', async () => {
    const intents = await intentsOf(ctxOf(memoryFs()));
    const mcp = intents.find((i) => i.fragmentKey === 'mcp.musterd')!;
    const env = (mcp.payload as { env: Record<string, string> }).env;
    expect(env).toEqual({ MUSTERD_LAUNCH_SURFACE: 'cursor' });
  });

  it('parses and validates the complete JSON container; unrelated entries survive semantically', async () => {
    const fs = memoryFs();
    fs.writeFile(
      MCP,
      JSON.stringify({
        mcpServers: {
          figma: { command: 'npx', args: ['figma-mcp'], env: { KEY: '${FIGMA_KEY}' } },
        },
        theirSetting: 42,
      }),
      0o600,
    );
    const ctx = ctxOf(fs);
    const intents = await intentsOf(ctx);
    const mcp = intents.find((i) => i.fragmentKey === 'mcp.musterd')!;
    expect(await cursorAdapter.observe(ctx, mcp)).toEqual({ state: 'absent' });

    await cursorAdapter.apply(ctx, { kind: 'write', intent: mcp });
    let parsed = JSON.parse(fs.readFile(MCP)!);
    expect(parsed.mcpServers.figma.env.KEY).toBe('${FIGMA_KEY}');
    expect(parsed.theirSetting).toBe(42);
    expect(parsed.mcpServers.musterd.env).toEqual({ MUSTERD_LAUNCH_SURFACE: 'cursor' });
    expect(await cursorAdapter.observe(ctx, mcp)).toEqual({
      state: 'present',
      fingerprint: mcp.fingerprint,
    });

    await cursorAdapter.apply(ctx, { kind: 'remove', intent: mcp });
    parsed = JSON.parse(fs.readFile(MCP)!);
    expect(parsed.mcpServers.figma).toBeTruthy();
    expect(parsed.mcpServers.musterd).toBeUndefined();
  });

  it('an unparseable container is invalid-container to observe and refused at apply time', async () => {
    const fs = memoryFs();
    fs.writeFile(MCP, '{ not json', 0o600);
    const ctx = ctxOf(fs);
    const intents = await intentsOf(ctx);
    const mcp = intents.find((i) => i.fragmentKey === 'mcp.musterd')!;
    expect((await cursorAdapter.observe(ctx, mcp)).state).toBe('invalid-container');
    await expect(cursorAdapter.apply(ctx, { kind: 'write', intent: mcp })).rejects.toThrow(
      /invalid/,
    );
    expect(fs.readFile(MCP)).toBe('{ not json'); // bytes untouched
  });

  it('a musterd entry with the retired MUSTERD_SURFACE observes as legacy-launch-marker, and its repair swaps only the marker', async () => {
    const fs = memoryFs();
    fs.writeFile(
      MCP,
      JSON.stringify({
        mcpServers: {
          musterd: {
            command: '/their/node',
            args: ['/their/adapter.js'],
            env: { MUSTERD_SURFACE: 'cursor', MUSTERD_GRANT: 'msgr_keep' },
          },
        },
      }),
      0o600,
    );
    const ctx = ctxOf(fs);
    const intents = await intentsOf(ctx);
    const mcp = intents.find((i) => i.fragmentKey === 'mcp.musterd')!;
    expect((await cursorAdapter.observe(ctx, mcp)).state).toBe('legacy-launch-marker');

    await cursorAdapter.apply(ctx, { kind: 'repair-launch-marker', intent: mcp });
    const entry = JSON.parse(fs.readFile(MCP)!).mcpServers.musterd;
    expect(entry.env.MUSTERD_LAUNCH_SURFACE).toBe('cursor');
    expect(entry.env.MUSTERD_SURFACE).toBeUndefined();
    expect(entry.env.MUSTERD_GRANT).toBe('msgr_keep'); // unrelated env preserved
    expect(entry.command).toBe('/their/node'); // the rest of the entry is NOT adopted
  });

  it('hook fragments preserve the user’s own hooks across write and remove', async () => {
    const fs = memoryFs();
    fs.writeFile(
      HOOKS,
      JSON.stringify({
        version: 1,
        hooks: { sessionStart: [{ command: 'their-hook.sh' }] },
      }),
      0o600,
    );
    const ctx = ctxOf(fs);
    const intents = await intentsOf(ctx);
    const hooks = intents.find((i) => i.fragmentKey === 'hooks')!;

    await cursorAdapter.apply(ctx, { kind: 'write', intent: hooks });
    let parsed = JSON.parse(fs.readFile(HOOKS)!);
    expect(
      parsed.hooks.sessionStart.some((h: { command: string }) => h.command === 'their-hook.sh'),
    ).toBe(true);
    expect(parsed.hooks.afterMCPExecution).toBeDefined();
    expect(await cursorAdapter.observe(ctx, hooks)).toEqual({
      state: 'present',
      fingerprint: hooks.fingerprint,
    });

    await cursorAdapter.apply(ctx, { kind: 'remove', intent: hooks });
    parsed = JSON.parse(fs.readFile(HOOKS)!);
    expect(parsed.hooks.sessionStart).toEqual([{ command: 'their-hook.sh' }]);
    expect(parsed.hooks.afterMCPExecution).toBeUndefined();
    expect(await cursorAdapter.observe(ctx, hooks)).toEqual({ state: 'absent' });
  });

  it('guidance renders the cursor rules and commands as one stamped file-map fragment', async () => {
    const fs = memoryFs();
    const ctx = ctxOf(fs);
    const intents = await intentsOf(ctx);
    const guidance = intents.find((i) => i.fragmentKey === 'guidance')!;
    await cursorAdapter.apply(ctx, { kind: 'write', intent: guidance });
    expect(fs.readFile('/w/a/.cursor/rules/musterd.mdc')).toContain('musterd:content');
    expect(fs.readFile('/w/a/.cursor/rules/musterd-label-session.mdc')).not.toBeNull();
    expect(await cursorAdapter.observe(ctx, guidance)).toEqual({
      state: 'present',
      fingerprint: guidance.fingerprint,
    });
  });
});
