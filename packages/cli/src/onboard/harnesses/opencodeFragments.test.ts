import { describe, expect, it } from 'vitest';
import { memoryFs, type HarnessContext, type MemoryFs } from '../reconcile/context.js';
import { opencodeAdapter } from './opencode.js';

const ROOT = '/w/a';
const CFG = '/w/a/.opencode/opencode.json';

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
  return opencodeAdapter.desiredFragments(ctx, await opencodeAdapter.target(ctx));
}

const THEIR_CFG = JSON.stringify({
  theme: 'ayu',
  mcp: { context7: { type: 'local', command: ['npx', 'context7'] } },
});

describe('opencodeAdapter — managed fragments', () => {
  it('exposes the single musterd MCP entry as one fragment carrying only the launch marker', async () => {
    const intents = await intentsOf(ctxOf(memoryFs()));
    expect(intents.map((i) => i.fragmentKey)).toEqual(['mcp.musterd']);
    const payload = intents[0]!.payload as { environment: Record<string, string>; type: string };
    expect(payload.type).toBe('local');
    expect(payload.environment).toEqual({ MUSTERD_LAUNCH_SURFACE: 'opencode' });
  });

  it('unrelated keys and entries survive the write and the remove byte-for-key intact', async () => {
    const fs = memoryFs();
    fs.writeFile(CFG, THEIR_CFG, 0o600);
    const ctx = ctxOf(fs);
    const intents = await intentsOf(ctx);
    const mcp = intents[0]!;
    expect(await opencodeAdapter.observe(ctx, mcp)).toEqual({ state: 'absent' });

    await opencodeAdapter.apply(ctx, { kind: 'write', intent: mcp });
    const after = JSON.parse(fs.readFile(CFG)!) as {
      theme?: string;
      mcp: Record<string, unknown>;
    };
    expect(after.theme).toBe('ayu'); // their unknown top-level key untouched
    expect(after.mcp['context7']).toBeDefined(); // their other server untouched
    expect(await opencodeAdapter.observe(ctx, mcp)).toEqual({
      state: 'present',
      fingerprint: mcp.fingerprint,
    });

    await opencodeAdapter.apply(ctx, { kind: 'remove', intent: mcp });
    const removed = JSON.parse(fs.readFile(CFG)!) as {
      theme?: string;
      mcp?: Record<string, unknown>;
    };
    expect(removed.theme).toBe('ayu');
    expect(removed.mcp?.['musterd']).toBeUndefined();
    expect(await opencodeAdapter.observe(ctx, mcp)).toEqual({ state: 'absent' });
  });

  it('an unparseable container observes invalid-container — nothing in it may be touched', async () => {
    const fs = memoryFs();
    fs.writeFile(CFG, '{ not json', 0o600);
    const ctx = ctxOf(fs);
    const intents = await intentsOf(ctx);
    expect(await opencodeAdapter.observe(ctx, intents[0]!)).toMatchObject({
      state: 'invalid-container',
    });
    await expect(
      opencodeAdapter.apply(ctx, { kind: 'write', intent: intents[0]! }),
    ).rejects.toThrow(/invalid at apply time/);
    expect(fs.readFile(CFG)).toBe('{ not json'); // prior bytes stay untouched
  });

  it('a musterd entry carrying MUSTERD_SURFACE observes as legacy-launch-marker; repair swaps only the marker', async () => {
    const fs = memoryFs();
    fs.writeFile(
      CFG,
      JSON.stringify({
        mcp: {
          musterd: {
            type: 'local',
            command: ['/their/node', '/their/adapter.js'],
            environment: { MUSTERD_SURFACE: 'opencode', MUSTERD_GRANT: 'msgr_keep' },
          },
        },
      }),
      0o600,
    );
    const ctx = ctxOf(fs);
    const intents = await intentsOf(ctx);
    const mcp = intents[0]!;
    expect((await opencodeAdapter.observe(ctx, mcp)).state).toBe('legacy-launch-marker');

    await opencodeAdapter.apply(ctx, { kind: 'repair-launch-marker', intent: mcp });
    const after = JSON.parse(fs.readFile(CFG)!) as {
      mcp: Record<string, { command: string[]; environment: Record<string, string> }>;
    };
    const entry = after.mcp['musterd'];
    expect(entry.environment.MUSTERD_LAUNCH_SURFACE).toBe('opencode');
    expect(entry.environment.MUSTERD_SURFACE).toBeUndefined();
    expect(entry.environment.MUSTERD_GRANT).toBe('msgr_keep'); // unrelated env preserved
    expect(entry.command).toEqual(['/their/node', '/their/adapter.js']); // repaired, not adopted
  });
});
