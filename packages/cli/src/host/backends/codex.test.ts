import { EventEmitter } from 'node:events';
import type { WakeOrder } from '@musterd/protocol';
import { describe, expect, it } from 'vitest';
import type { BackendContext, WakeSpec } from '../backend.js';
import {
  buildCodexFreshArgs,
  buildCodexResumeArgs,
  codexBackend,
  codexWakeEnv,
  parseCodexThreadLine,
} from './codex.js';

class Child extends EventEmitter {
  stdout = new EventEmitter();
  pid: number | undefined;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  kill(): boolean {
    return true;
  }
  out(line: string) {
    this.stdout.emit('data', Buffer.from(line + '\n'));
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
};
const spec: WakeSpec = {
  order,
  team: 'dawn',
  server: 'http://s',
  workspace: '/ws',
  bounds: { timeout_ms: 200 },
};
const ctx: BackendContext = {
  // ADR 241: the happy path is a row attesting THIS lease — `lease_matched`, not the `wake`
  // description every wake session in history also satisfies.
  verifyOccupied: async () => ({ occupied: true, provenance: 'wake', lease_matched: true }),
  log: () => {},
};

describe('Codex residency argv', () => {
  it('uses the workspace flag only for fresh exec and never passes a bypass', () => {
    expect(buildCodexFreshArgs('line', '/ws')).toEqual(['exec', '--json', '-C', '/ws', 'line']);
    expect(buildCodexResumeArgs('line', 'thread')).toEqual([
      'exec',
      'resume',
      '--json',
      'thread',
      'line',
    ]);
    for (const args of [buildCodexFreshArgs('line', '/ws'), buildCodexResumeArgs('line', 'thread')])
      expect(args.join(' ')).not.toMatch(/dangerously|bypass|approval|ignore-user-config/i);
  });
  it('accepts only a typed thread.started JSONL record', () => {
    expect(parseCodexThreadLine('{"type":"thread.started","thread_id":"t"}')).toBe('t');
    expect(parseCodexThreadLine('{"type":"item.completed","thread_id":"t"}')).toBeUndefined();
  });
  it('does not pass ambient musterd credentials into the child', () => {
    const env = codexWakeEnv({
      HOME: '/h',
      PATH: '/p',
      MUSTERD_AGENT_KEY: 'secret',
      MUSTERD_GRANT: 'secret',
    });
    expect(env).toMatchObject({ HOME: '/h', PATH: '/p', MUSTERD_PROVENANCE: 'wake' });
    expect(env.MUSTERD_AGENT_KEY).toBeUndefined();
    expect(env.MUSTERD_GRANT).toBeUndefined();
  });

  it('carries the wake lease to the child (ADR 241), and nothing when there is none', () => {
    // The token is what makes the child's presence row identifiably THIS wake's. Absent when no
    // lease is given — an unstamped child must attest nothing rather than a placeholder, or the
    // verifier is back to matching a description.
    expect(codexWakeEnv({ HOME: '/h' }, 'L42').MUSTERD_WAKE_LEASE).toBe('L42');
    expect(codexWakeEnv({ HOME: '/h' }).MUSTERD_WAKE_LEASE).toBeUndefined();
  });
});

describe('codexBackend', () => {
  // Same rule as the claude backend (ADR 221): a host that cannot resolve the binary has not
  // failed the wake, it cannot attempt it. Failing here spends an attempt against attempt_cap and
  // marches the act toward terminal exhaustion for a condition on THIS MACHINE. gptbot hit exactly
  // this on 2026-08-04 with `codex CLI not found`.
  it('codex not found: DEFERS with a named reason, nothing spawned, no attempt spent', async () => {
    const backend = codexBackend({ resolveBin: async () => null });
    const result = await backend.wake(spec, ctx);
    expect(result.outcome.occupied).toBe(false);
    expect(result.outcome.deferred).toBe(true);
    expect(result.outcome.reason).toMatch(/codex CLI not found/);
    await result.settled;
  });

  it('requires exact streamed identity and fresh wake Presence before crediting a fresh session', async () => {
    const child = new Child();
    let recorded: string | undefined;
    const backend = codexBackend({
      resolveBin: async () => '/codex',
      recordFreshThread: (_w, id) => {
        recorded = id;
      },
      spawn: (() => child) as never,
    });
    const wake = backend.wake(spec, ctx);
    await Promise.resolve();
    child.out('{"type":"thread.started","thread_id":"new"}');
    const result = await wake;
    expect(result.outcome).toEqual({ occupied: true, session: 'fresh' });
    expect(recorded).toBe('new');
    child.exit();
    await result.settled;
  });
  /**
   * ADR 238. A seat already held by a non-wake session is not a failure of this wake — nothing about
   * the act went wrong, and retrying later is right. It burned attempt budget instead: three of
   * gptbot's acceptance wakes died this way on 2026-08-05 against a seat that was healthy throughout,
   * and the ten asks queued behind them stalled.
   */
  it('a seat held by a non-wake session DEFERS — it does not burn the act (ADR 238)', async () => {
    const child = new Child();
    const backend = codexBackend({
      resolveBin: async () => '/codex',
      recordFreshThread: () => undefined,
      spawn: (() => child) as never,
    });
    const heldByOther: BackendContext = {
      verifyOccupied: async () => ({ occupied: true, provenance: 'session', lease_matched: false }),
      log: () => {},
    };
    const wake = backend.wake(spec, heldByOther);
    await Promise.resolve();
    child.out('{"type":"thread.started","thread_id":"new"}');
    const result = await wake;
    expect(result.outcome.occupied).toBe(false);
    expect(result.outcome.deferred).toBe(true);
    expect(result.outcome.reason).toMatch(/session/);
    child.exit();
    await result.settled;
  });

  /**
   * ADR 241, at the backend seam. Under ADR 238's rule this row read `provenance: 'wake'`, so it was
   * NOT held-by-other, so it fell through to a charged failure — and the seat was healthy the whole
   * time, held by a prior wake session still inside its 30m work-order timeout. The deferral must
   * key on lease identity, not on the description the two sessions share.
   */
  it('a seat held by ANOTHER WAKE defers too — the provenance test could not see this (ADR 241)', async () => {
    const child = new Child();
    const backend = codexBackend({
      resolveBin: async () => '/codex',
      recordFreshThread: () => undefined,
      spawn: (() => child) as never,
    });
    const heldByPriorWake: BackendContext = {
      verifyOccupied: async () => ({ occupied: true, provenance: 'wake', lease_matched: false }),
      log: () => {},
    };
    const wake = backend.wake(spec, heldByPriorWake);
    await Promise.resolve();
    child.out('{"type":"thread.started","thread_id":"new"}');
    const result = await wake;
    expect(result.outcome.occupied).toBe(false);
    expect(result.outcome.deferred).toBe(true);
    expect(result.outcome.reason).toMatch(/held by another session/);
    child.exit();
    await result.settled;
  });

  it("the child is spawned with this lease's token in its env (ADR 241)", async () => {
    const child = new Child();
    let spawnedEnv: NodeJS.ProcessEnv | undefined;
    const backend = codexBackend({
      resolveBin: async () => '/codex',
      recordFreshThread: () => undefined,
      spawn: ((_bin: string, _args: string[], opts: { env: NodeJS.ProcessEnv }) => {
        spawnedEnv = opts.env;
        return child;
      }) as never,
    });
    const wake = backend.wake(spec, ctx);
    await Promise.resolve();
    child.out('{"type":"thread.started","thread_id":"new"}');
    const result = await wake;
    expect(spawnedEnv?.MUSTERD_WAKE_LEASE).toBe(order.lease_id);
    child.exit();
    await result.settled;
  });

  it('a wake that genuinely produced nothing still FAILS — deferral is not the catch-all', async () => {
    // The guard on the guard: an empty roster is a real failure and must keep consuming budget,
    // or a host that spawns nothing retries forever (ADR 236's ceiling reasoning, one layer out).
    const child = new Child();
    const backend = codexBackend({
      resolveBin: async () => '/codex',
      recordFreshThread: () => undefined,
      spawn: (() => child) as never,
    });
    const nobody: BackendContext = {
      verifyOccupied: async () => ({ occupied: false, lease_matched: false }),
      log: () => {},
    };
    const wake = backend.wake(spec, nobody);
    await Promise.resolve();
    child.out('{"type":"thread.started","thread_id":"new"}');
    const result = await wake;
    expect(result.outcome.occupied).toBe(false);
    expect(result.outcome.deferred).toBeUndefined();
    child.exit();
    await result.settled;
  });

  it('resumes the captured thread only when its JSONL identity agrees', async () => {
    const child = new Child();
    const calls: string[][] = [];
    const backend = codexBackend({
      resolveBin: async () => '/codex',
      readSession: () => ({
        state: 'resumable',
        session: { harness: 'codex', id: 'old', started_at: 1 },
      }),
      spawn: ((_bin: string, args: string[]) => {
        calls.push(args);
        return child;
      }) as never,
    });
    const wake = backend.wake(spec, ctx);
    await Promise.resolve();
    child.out('{"type":"thread.started","thread_id":"old"}');
    const result = await wake;
    expect(calls[0]).toEqual(buildCodexResumeArgs('wake line', 'old'));
    expect(result.outcome.session).toBe('resumed');
    child.exit();
    await result.settled;
  });
  it('portable fresh orders bypass resume even with a valid local capture', async () => {
    const child = new Child();
    const calls: string[][] = [];
    const lines: string[] = [];
    const backend = codexBackend({
      resolveBin: async () => '/codex',
      readSession: () => ({
        state: 'resumable',
        source: 'slot',
        session: { harness: 'codex', id: 'old', started_at: 1 },
        transcriptBytes: 4096,
        transcriptMtime: Date.now() - 1_000,
      }),
      recordFreshThread: () => undefined,
      spawn: ((_bin: string, args: string[]) => {
        calls.push(args);
        return child;
      }) as never,
    });
    const wake = backend.wake(
      {
        ...spec,
        order: {
          ...order,
          intended_delivery: 'fresh',
          continuity_requirement: 'portable',
        },
      },
      { ...ctx, log: (line) => lines.push(line) },
    );
    await Promise.resolve();
    child.out('{"type":"thread.started","thread_id":"new"}');
    const result = await wake;
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual(buildCodexFreshArgs('wake line', '/ws'));
    expect(result.outcome).toMatchObject({
      occupied: true,
      session: 'fresh',
      delivery_outcome: 'fresh',
      transcript_bytes: 4096,
    });
    expect(lines.join('\n')).toMatch(/portable delivery .* fresh spawn \(resume bypassed\)/);
    child.exit();
    await result.settled;
  });
  it('never credits a nonzero child exit, even if a stale roster probe says occupied', async () => {
    const child = new Child();
    const backend = codexBackend({
      resolveBin: async () => '/codex',
      spawn: (() => child) as never,
      recordFreshThread: () => undefined,
    });
    const wake = backend.wake(spec, ctx);
    await Promise.resolve();
    child.out('{"type":"thread.started","thread_id":"new"}');
    child.exit(2);
    const result = await wake;
    expect(result.outcome).toMatchObject({ occupied: false, session: 'fresh' });
    expect(result.outcome.reason).toContain('code 2');
    await result.settled;
  });
});
