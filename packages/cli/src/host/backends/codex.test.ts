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
  it('uses the workspace flag only for fresh exec, and both forms bypass hook trust (ADR 359)', () => {
    expect(buildCodexFreshArgs('line', '/ws')).toEqual([
      'exec',
      '--json',
      '--dangerously-bypass-hook-trust',
      '-C',
      '/ws',
      'line',
    ]);
    expect(buildCodexResumeArgs('line', 'thread')).toEqual([
      'exec',
      'resume',
      '--json',
      '--dangerously-bypass-hook-trust',
      'thread',
      'line',
    ]);
    // ADR 359: musterd authors the hooks.json being trusted, so bypassing the interactive
    // hook-trust prompt (which a headless wake spawn could never show anyway) is deliberate — a
    // fresh/resume args build that silently drops the flag would go right back to hooks never
    // firing, exactly as invisible as the bug this fixed.
    for (const args of [buildCodexFreshArgs('line', '/ws'), buildCodexResumeArgs('line', 'thread')])
      expect(args).toContain('--dangerously-bypass-hook-trust');
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

  it('puts the pinned actuator build before a Homebrew musterd on PATH', () => {
    expect(
      codexWakeEnv(
        { PATH: '/opt/homebrew/bin:/usr/bin', MUSTERD_AGENT_KEY: 'secret' },
        'L42',
        '/Users/nick/.musterd/bin',
      ),
    ).toMatchObject({
      PATH: '/Users/nick/.musterd/bin:/opt/homebrew/bin:/usr/bin',
      MUSTERD_PROVENANCE: 'wake',
      MUSTERD_WAKE_LEASE: 'L42',
    });
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

  it('spawns Codex with the actuator-pinned musterd before Homebrew on PATH', async () => {
    const child = new Child();
    let spawnedEnv: NodeJS.ProcessEnv | undefined;
    const backend = codexBackend({
      resolveBin: async () => '/codex',
      recordFreshThread: () => undefined,
      ensurePinned: () => '/Users/nick/.musterd/bin',
      spawn: ((_bin: string, _args: string[], opts: { env: NodeJS.ProcessEnv }) => {
        spawnedEnv = opts.env;
        return child;
      }) as never,
    });
    const priorPath = process.env.PATH;
    process.env.PATH = '/opt/homebrew/bin:/usr/bin';
    try {
      const wake = backend.wake(spec, ctx);
      await Promise.resolve();
      child.out('{"type":"thread.started","thread_id":"new"}');
      await wake;
      expect(spawnedEnv?.PATH).toBe('/Users/nick/.musterd/bin:/opt/homebrew/bin:/usr/bin');
      child.exit();
    } finally {
      process.env.PATH = priorPath;
    }
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

  it('GUARD: a demoted conflict (slot live, enumeration disagrees) defers — either side saying live refuses (ADR 166 inc 3)', async () => {
    // The 2026-08-21 inspection of the sweep's 109 demoted observations found every resolvable
    // case was a live session enumeration could not see (unscanned harness, unwritten
    // `.workspace-trusted`) — and the one wake that landed in a demote window came through THIS
    // backend, saved only by a missing codex CLI. The slot's warm transcript is the evidence.
    const spawned: string[][] = [];
    const backend = codexBackend({
      resolveBin: async () => '/codex',
      readSession: () => ({
        state: 'resumable',
        source: 'enumerated',
        slotState: 'live',
        disagreed: true,
        demoted: true,
        session: { harness: 'codex', id: 'old', started_at: 1 },
      }),
      spawn: ((_bin: string, args: string[]) => {
        spawned.push(args);
        return new Child();
      }) as never,
    });
    const result = await backend.wake(spec, ctx);
    expect(spawned).toHaveLength(0);
    expect(result.outcome).toMatchObject({
      occupied: false,
      deferred: true,
      reason: 'local-session-live',
    });
    await result.settled;
  });

  it('resumes the captured thread only when its JSONL identity agrees', async () => {
    const child = new Child();
    const calls: string[][] = [];
    let spawnedEnv: NodeJS.ProcessEnv | undefined;
    const backend = codexBackend({
      resolveBin: async () => '/codex',
      readSession: () => ({
        state: 'resumable',
        session: { harness: 'codex', id: 'old', started_at: 1 },
      }),
      ensurePinned: () => '/Users/nick/.musterd/bin',
      spawn: ((_bin: string, args: string[], opts: { env: NodeJS.ProcessEnv }) => {
        calls.push(args);
        spawnedEnv = opts.env;
        return child;
      }) as never,
    });
    const priorPath = process.env.PATH;
    process.env.PATH = '/opt/homebrew/bin:/usr/bin';
    try {
      const wake = backend.wake(spec, ctx);
      await Promise.resolve();
      child.out('{"type":"thread.started","thread_id":"old"}');
      const result = await wake;
      expect(calls[0]).toEqual(buildCodexResumeArgs('wake line', 'old'));
      expect(spawnedEnv?.PATH).toBe('/Users/nick/.musterd/bin:/opt/homebrew/bin:/usr/bin');
      expect(result.outcome.session).toBe('resumed');
      child.exit();
      await result.settled;
    } finally {
      process.env.PATH = priorPath;
    }
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

/**
 * The wake-lease FILE (lane 01M1HM8EEK, ADR 354). Codex launches its MCP stdio servers with a
 * sanitized environment — twelve variables, measured 2026-09-02 on 0.150.1, none `MUSTERD_*` — so
 * `codexWakeEnv`'s MUSTERD_PROVENANCE/MUSTERD_WAKE_LEASE reach the codex process and stop there.
 * The adapter then attested `provenance: session` with no lease, ADR 241 read the seat as held by
 * another session, and this backend's not-mine path killed the review it had spawned ninety seconds
 * earlier. Every codex wake since 2026-08-27 died this way (13 such deferrals in the three days to
 * 2026-09-02, zero `residency.woke`).
 *
 * The backend now hands the lease over on disk as well: written beside binding.json right after
 * spawn, naming the CHILD's pid so only a process spawned by that codex can honour it, and cleared
 * when the run settles.
 */
describe('the wake-lease file — a second channel for a harness that strips the first', () => {
  const harness = (child: Child) => {
    const writes: Array<{ workspace: string; lease: Record<string, unknown> }> = [];
    const clears: Array<{ workspace: string; lease_id: string }> = [];
    const backend = codexBackend({
      resolveBin: async () => '/codex',
      spawn: (() => child) as never,
      recordFreshThread: () => undefined,
      writeWakeLease: (workspace, lease) => {
        writes.push({ workspace, lease: lease as unknown as Record<string, unknown> });
      },
      clearWakeLease: (workspace, lease_id) => {
        clears.push({ workspace, lease_id });
      },
    });
    return { backend, writes, clears };
  };

  it('writes the lease naming the spawned child’s pid, before verification can conclude', async () => {
    const child = new Child();
    child.pid = 4242;
    const { backend, writes } = harness(child);
    const wake = backend.wake(spec, ctx);
    await Promise.resolve();
    // Written at spawn — the adapter autojoins ~15s in, long before this attempt settles.
    expect(writes).toHaveLength(1);
    expect(writes[0]!.workspace).toBe('/ws');
    expect(writes[0]!.lease).toMatchObject({
      lease_id: 'l',
      provenance: 'wake',
      harness: 'codex',
      spawner_pid: 4242,
    });
    expect(writes[0]!.lease['expires_at']).toBeGreaterThan(Date.now());
    child.out('{"type":"thread.started","thread_id":"new"}');
    const result = await wake;
    expect(result.outcome.occupied).toBe(true);
    child.exit(0);
    await result.settled;
  });

  it('clears the file when the run settles — the next occupant inherits nothing', async () => {
    const child = new Child();
    child.pid = 4242;
    const { backend, clears } = harness(child);
    const wake = backend.wake(spec, ctx);
    await Promise.resolve();
    child.out('{"type":"thread.started","thread_id":"new"}');
    const result = await wake;
    expect(clears).toHaveLength(0);
    child.exit(0);
    await result.settled;
    expect(clears).toEqual([{ workspace: '/ws', lease_id: 'l' }]);
  });

  it('clears on a failed run too — a killed wake must not leave its lease for a human to pick up', async () => {
    const child = new Child();
    child.pid = 4242;
    const { backend, clears } = harness(child);
    const wake = backend.wake(spec, ctx);
    await Promise.resolve();
    child.out('{"type":"thread.started","thread_id":"new"}');
    child.exit(1);
    const result = await wake;
    expect(result.outcome.occupied).toBe(false);
    await result.settled;
    expect(clears).toEqual([{ workspace: '/ws', lease_id: 'l' }]);
  });

  it('a spawn that never produced a pid writes nothing — there is no process to bind to', async () => {
    const child = new Child(); // pid undefined
    const { backend, writes } = harness(child);
    const wake = backend.wake(spec, ctx);
    await Promise.resolve();
    expect(writes).toHaveLength(0);
    child.out('{"type":"thread.started","thread_id":"new"}');
    const result = await wake;
    child.exit(0);
    await result.settled;
  });
});

/**
 * The completion record (lane 01M1G310Y7). Until 2026-09-02 this backend's `settled` was typed
 * `Promise<undefined>` — it resolved with nothing, on every run, so the loop's supplementary
 * wake-cost report had nothing to post and the daemon never wrote a `residency.wake_cost` row for a
 * codex seat. Measured on the live host log: gptbot 130 spawns, 0 cost rows, against four
 * claude-code seats that priced. A wake loop on that seat (six leases in 40 minutes, 2026-09-01)
 * was invisible to the exact rail ADR 252 built to show it.
 *
 * Codex prints no cost summary the host can attest, so `cost_usd` stays absent. But wall-clock is
 * the HOST's measurement, not the child's report — the same principle the native backend states —
 * and it is what makes every wake, including the ones that fail, land on the rail.
 */
describe('the completion record — every settled run reports what the host measured', () => {
  const fresh = (child: Child) =>
    codexBackend({
      resolveBin: async () => '/codex',
      spawn: (() => child) as never,
      recordFreshThread: () => undefined,
    });

  it('a woke run that exits cleanly carries duration_ms', async () => {
    const child = new Child();
    const wake = fresh(child).wake(spec, ctx);
    await Promise.resolve();
    child.out('{"type":"thread.started","thread_id":"new"}');
    const result = await wake;
    expect(result.outcome.occupied).toBe(true);
    child.exit(0);
    const completion = await result.settled;
    expect(completion).toBeDefined();
    expect(completion?.duration_ms).toBeTypeOf('number');
    expect(completion?.duration_ms).toBeGreaterThanOrEqual(0);
    expect(completion?.cost_usd).toBeUndefined();
  });

  it('a run that FAILS still consumed a spawn and a clock — it prices too', async () => {
    // gptbot's shape on 2026-09-01: 11 of its wakes died `run exited with code 1`. Each one was a
    // real process on this machine for real seconds, and none of them reached the rail.
    const child = new Child();
    const wake = fresh(child).wake(spec, ctx);
    await Promise.resolve();
    child.out('{"type":"thread.started","thread_id":"new"}');
    child.exit(1);
    const result = await wake;
    expect(result.outcome.occupied).toBe(false);
    const completion = await result.settled;
    expect(completion?.duration_ms).toBeTypeOf('number');
  });

  it('a watchdog-killed run prices — it is the most expensive shape there is', async () => {
    const child = new Child();
    child.kill = () => {
      setTimeout(() => child.exit(143), 1);
      return true;
    };
    const slowVerify = () =>
      new Promise<{ occupied: boolean }>((r) => setTimeout(() => r({ occupied: false }), 150));
    const backend = codexBackend({
      resolveBin: async () => '/codex',
      spawn: (() => child) as never,
      recordFreshThread: () => undefined,
      killGraceMs: 5,
    });
    const result = await backend.wake(
      { ...spec, bounds: { timeout_ms: 30 } },
      { ...ctx, verifyOccupied: slowVerify },
    );
    expect(result.outcome.occupied).toBe(false);
    const completion = await result.settled;
    expect(completion?.duration_ms).toBeTypeOf('number');
    expect(completion?.duration_ms).toBeGreaterThanOrEqual(30);
  });
});
