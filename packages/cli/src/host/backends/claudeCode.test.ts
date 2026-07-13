import { EventEmitter } from 'node:events';
import type { WakeOrder } from '@musterd/protocol';
import { describe, expect, it } from 'vitest';
import type { BackendContext, WakeSpec } from '../backend.js';
import { buildWakeArgs, claudeCodeBackend, parseRunSummary } from './claudeCode.js';

/**
 * The invariants this backend carries (ADR 131 §6) are asserted here so a refactor can't quietly
 * drop one: the composed line verbatim and alone, reply-only tools, never a skip-permissions flag,
 * `wake` provenance in the env (not argv), the mandatory watchdog, roster-only verification.
 * Everything runs against a fake child — tests never spawn a real harness.
 */

class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  pid: number | undefined = undefined; // undefined ⇒ killTree signals the child directly
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  signals: string[] = [];
  kill(sig?: NodeJS.Signals): boolean {
    this.signals.push(sig ?? 'SIGTERM');
    return true;
  }
  exit(code: number): void {
    this.exitCode = code;
    this.emit('exit', code);
  }
}

const order = (over: Partial<WakeOrder> = {}): WakeOrder => ({
  lease_id: 'L1',
  seat: 'scout',
  act_id: 'A1',
  act: 'steer',
  sender: 'lin',
  lane: 'immediate',
  composed_line: 'musterd wake — you are seat "scout" on team "dawn": …',
  expires_at: Date.now() + 120_000,
  ...over,
});

const spec = (over: Partial<WakeSpec> = {}): WakeSpec => ({
  order: order(),
  team: 'dawn',
  server: 'http://s1',
  workspace: '/ws/scout',
  bounds: { timeout_ms: 60_000 },
  ...over,
});

const ctx = (
  verify: () => Promise<{ occupied: boolean; provenance?: string | null }>,
): BackendContext & { lines: string[] } => {
  const lines: string[] = [];
  return { verifyOccupied: verify, log: (l) => lines.push(l), lines };
};

interface SpawnCall {
  bin: string;
  args: string[];
  opts: { cwd?: string; env?: NodeJS.ProcessEnv; detached?: boolean };
}

function harness(child: FakeChild) {
  const calls: SpawnCall[] = [];
  const backend = claudeCodeBackend({
    resolveBin: async () => '/fake/claude',
    // reason: the fake child mirrors only the ChildProcess surface the backend touches.

    spawn: ((bin: string, args: string[], opts: SpawnCall['opts']) => {
      calls.push({ bin, args, opts });
      return child as any;
    }) as any,
    mintSessionId: () => '00000000-0000-4000-8000-000000000000',
    killGraceMs: 5,
  });
  return { backend, calls };
}

describe('buildWakeArgs (the spawn argv invariants)', () => {
  const args = buildWakeArgs('musterd wake — line', 'uuid-1');

  it('the prompt is the composed line, verbatim, via -p', () => {
    expect(args[args.indexOf('-p') + 1]).toBe('musterd wake — line');
  });
  it('fresh-first: the session id is pre-minted', () => {
    expect(args[args.indexOf('--session-id') + 1]).toBe('uuid-1');
  });
  it('reply-only: allowed tools scoped to the musterd MCP server, default permission mode', () => {
    expect(args[args.indexOf('--allowedTools') + 1]).toBe('mcp__musterd');
  });
  it('NEVER a skip-permissions flag on the wake path (ADR 131 §6)', () => {
    expect(args.join(' ')).not.toMatch(/skip-permissions|dangerously/i);
  });
  it('no permission-mode override: the workspace’s own settings govern', () => {
    expect(args).not.toContain('--permission-mode');
  });
});

describe('claudeCodeBackend.wake', () => {
  it('spawns in the seat workspace with MUSTERD_PROVENANCE=wake in the env, detached', async () => {
    const child = new FakeChild();
    const { backend, calls } = harness(child);
    const p = backend.wake(
      spec(),
      ctx(async () => ({ occupied: true, provenance: 'wake' })),
    );
    const actuation = await p;
    expect(calls).toHaveLength(1);
    expect(calls[0]!.bin).toBe('/fake/claude');
    expect(calls[0]!.opts.cwd).toBe('/ws/scout');
    expect(calls[0]!.opts.detached).toBe(true);
    expect(calls[0]!.opts.env?.['MUSTERD_PROVENANCE']).toBe('wake');
    // provenance rides the env, never the argv
    expect(calls[0]!.args.join(' ')).not.toContain('MUSTERD_PROVENANCE');
    expect(actuation.outcome).toEqual({ occupied: true, session: 'fresh' });
    child.exit(0);
    await actuation.settled;
  });

  it('verified occupancy with non-wake provenance still occupies but names the stale adapter', async () => {
    const child = new FakeChild();
    const { backend } = harness(child);
    const context = ctx(async () => ({ occupied: true, provenance: 'session' }));
    const actuation = await backend.wake(spec(), context);
    expect(actuation.outcome.occupied).toBe(true);
    expect(context.lines.join('\n')).toMatch(/predate|rebuild/);
    child.exit(0);
    await actuation.settled;
  });

  it('no roster occupancy: the run is killed and reported failed — never silently occupied', async () => {
    const child = new FakeChild();
    const { backend } = harness(child);
    const actuation = await backend.wake(
      spec(),
      ctx(async () => ({ occupied: false })),
    );
    expect(actuation.outcome.occupied).toBe(false);
    expect(actuation.outcome.reason).toMatch(/verify window|exited/);
    expect(child.signals).toContain('SIGTERM');
    child.exit(143);
    await actuation.settled;
  });

  it('watchdog: a run past timeout_ms is killed and the reason names the watchdog', async () => {
    const child = new FakeChild();
    // The fake honors SIGTERM like a real child: exits shortly after the kill.
    child.kill = (sig?: NodeJS.Signals) => {
      child.signals.push(sig ?? 'SIGTERM');
      setTimeout(() => child.exit(143), 1);
      return true;
    };
    const { backend } = harness(child);
    const slowVerify = () =>
      new Promise<{ occupied: boolean }>((r) => setTimeout(() => r({ occupied: false }), 200));
    const actuation = await backend.wake(spec({ bounds: { timeout_ms: 50 } }), ctx(slowVerify));
    expect(actuation.outcome.occupied).toBe(false);
    expect(child.signals).toContain('SIGTERM');
    expect(actuation.outcome.reason).toMatch(/watchdog timeout \(50ms\)|exited/);
    await actuation.settled;
  });

  it('claude not found: fails with a named reason, nothing spawned', async () => {
    const backend = claudeCodeBackend({ resolveBin: async () => null });
    const actuation = await backend.wake(
      spec(),
      ctx(async () => ({ occupied: true })),
    );
    expect(actuation.outcome.occupied).toBe(false);
    expect(actuation.outcome.reason).toMatch(/claude CLI not found/);
  });
});

describe('parseRunSummary (completion telemetry, never verification)', () => {
  it('reads cost/duration from --output-format json stdout', () => {
    const out = JSON.stringify({
      type: 'result',
      total_cost_usd: 0.0123,
      duration_ms: 41_500,
      is_error: false,
    });
    expect(parseRunSummary(out)).toEqual({
      cost_usd: 0.0123,
      duration_ms: 41_500,
      is_error: false,
    });
  });
  it('garbage stdout reads as null (a hung headless run must cost nothing here)', () => {
    expect(parseRunSummary('not json at all')).toBeNull();
  });
});
