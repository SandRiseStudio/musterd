import { EventEmitter } from 'node:events';
import type { WakeOrder } from '@musterd/protocol';
import { describe, expect, it } from 'vitest';
import type { BackendContext, WakeSpec } from '../backend.js';
import { buildGrokFreshArgs, buildGrokResumeArgs, grokBackend } from './grok.js';

class Child extends EventEmitter {
  pid: number | undefined = 4242;
  exitCode: number | null = null;
  kill(): boolean {
    return true;
  }
  exit(code = 0) {
    this.exitCode = code;
    this.emit('exit', code);
  }
}
const order: WakeOrder = {
  lease_id: 'l',
  seat: 'ada',
  act_id: 'a',
  act: 'steer',
  sender: 'lin',
  lane: 'immediate',
  composed_line: 'wake line',
  expires_at: Date.now() + 1_000,
  intended_delivery: 'fresh',
};
const spec: WakeSpec = {
  order,
  team: 't',
  server: 'http://127.0.0.1:1',
  workspace: '/tmp/ws',
  bounds: { timeout_ms: 5_000 },
};

describe('grok wake argv (ADR 352 §7)', () => {
  it('fresh is -p with --cwd, never --yolo', () => {
    const args = buildGrokFreshArgs('hello from the daemon', '/tmp/ws');
    expect(args).toEqual(['-p', 'hello from the daemon', '--cwd', '/tmp/ws']);
    expect(args.join(' ')).not.toMatch(/yolo|always-approve|bypassPermissions/);
  });

  it('resume is -r <id> plus the same fresh shape', () => {
    expect(buildGrokResumeArgs('line', '01abc', '/tmp/ws')).toEqual([
      '-p',
      'line',
      '-r',
      '01abc',
      '--cwd',
      '/tmp/ws',
    ]);
  });
});

describe('grok settle (ADR 436 clause 1 — every wake settles and prices)', () => {
  it('settled carries duration_ms, the settle line, usage when Grok wrote one, and the unpriced reason', async () => {
    const child = new Child();
    const lines: string[] = [];
    const backend = grokBackend({
      resolveBin: async () => '/grok',
      spawn: (() => child) as never,
      readSession: () => ({ state: 'none', source: 'slot' }) as never,
      recordFreshSession: () => undefined,
      ensurePinned: () => undefined,
      readUsage: () => ({ input_tokens: 10, output_tokens: 2 }),
    });
    const ctx: BackendContext = {
      verifyOccupied: async () => ({ occupied: true, provenance: 'wake', lease_matched: true }),
      log: (l) => lines.push(l),
    };
    const result = await backend.wake(spec, ctx);
    expect(result.outcome).toEqual({ occupied: true, session: 'fresh' });
    child.exit(0);
    const completion = await result.settled;
    expect(completion?.duration_ms).toBeTypeOf('number');
    expect(completion?.usage).toEqual({ input_tokens: 10, output_tokens: 2 });
    expect(completion?.unpriced_reason).toBe('harness_price_unverified');
    expect(lines.some((l) => /run for ada \(fresh\) settled: exit=0/.test(l))).toBe(true);
  });
  it('a wake that never verified still settles with a duration (no silent hole)', async () => {
    const child = new Child();
    const backend = grokBackend({
      resolveBin: async () => '/grok',
      spawn: (() => child) as never,
      readSession: () => ({ state: 'none', source: 'slot' }) as never,
      ensurePinned: () => undefined,
      readUsage: () => undefined,
    });
    const ctx: BackendContext = {
      verifyOccupied: async () => ({ occupied: false }),
      log: () => {},
    };
    const result = await backend.wake(spec, ctx);
    expect(result.outcome.occupied).toBe(false);
    child.exit(1);
    const completion = await result.settled;
    expect(completion?.duration_ms).toBeTypeOf('number');
    expect(completion?.usage).toBeUndefined();
  });
});
