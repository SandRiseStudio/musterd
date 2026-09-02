import { EventEmitter } from 'node:events';
import type { WakeOrder } from '@musterd/protocol';
import { describe, expect, it } from 'vitest';
import type { BackendContext, WakeSpec } from '../backend.js';
import {
  buildOpencodeFreshArgs,
  buildOpencodeResumeArgs,
  opencodeBackend,
  opencodeWakeEnv,
  parseOpencodeSessionLine,
} from './opencode.js';

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
  // ADR 241: the happy path is a row attesting THIS lease — `lease_matched`.
  verifyOccupied: async () => ({ occupied: true, provenance: 'wake', lease_matched: true }),
  log: () => {},
};

describe('OpenCode residency argv', () => {
  it('fresh and resume forms carry no workspace flag and never pass a bypass', () => {
    expect(buildOpencodeFreshArgs('line')).toEqual(['run', '--format', 'json', 'line']);
    expect(buildOpencodeResumeArgs('line', 'ses_x')).toEqual([
      'run',
      '--format',
      'json',
      '--session',
      'ses_x',
      'line',
    ]);
    for (const args of [buildOpencodeFreshArgs('line'), buildOpencodeResumeArgs('line', 's')])
      expect(args.join(' ')).not.toMatch(/dangerously|bypass|yolo|auto-approve|approval/i);
  });
  it('accepts only a typed event record with a session id (the run.ts emit shape)', () => {
    expect(
      parseOpencodeSessionLine('{"type":"step_start","timestamp":1,"sessionID":"ses_x"}'),
    ).toBe('ses_x');
    expect(parseOpencodeSessionLine('{"type":"text","timestamp":1}')).toBeUndefined();
    expect(parseOpencodeSessionLine('not json at all')).toBeUndefined();
  });
  it('does not pass ambient musterd credentials into the child', () => {
    const env = opencodeWakeEnv({
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
    expect(opencodeWakeEnv({ HOME: '/h' }, 'L42').MUSTERD_WAKE_LEASE).toBe('L42');
    expect(opencodeWakeEnv({ HOME: '/h' }).MUSTERD_WAKE_LEASE).toBeUndefined();
  });

  it('puts the pinned actuator build before a Homebrew musterd on PATH', () => {
    expect(
      opencodeWakeEnv(
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

describe('opencodeBackend', () => {
  it('opencode not found: DEFERS with a named reason, nothing spawned, no attempt spent (ADR 221)', async () => {
    const backend = opencodeBackend({ resolveBin: async () => null });
    const result = await backend.wake(spec, ctx);
    expect(result.outcome.occupied).toBe(false);
    expect(result.outcome.deferred).toBe(true);
    expect(result.outcome.reason).toMatch(/opencode CLI not found/);
    await result.settled;
  });

  it('requires exact streamed identity and fresh wake Presence before crediting a fresh session', async () => {
    const child = new Child();
    let recorded: string | undefined;
    const backend = opencodeBackend({
      resolveBin: async () => '/opencode',
      recordFreshSession: (_w, id) => {
        recorded = id;
      },
      spawn: (() => child) as never,
    });
    const wake = backend.wake(spec, ctx);
    await Promise.resolve();
    child.out('{"type":"step_start","timestamp":1,"sessionID":"ses_new"}');
    const result = await wake;
    expect(result.outcome).toEqual({ occupied: true, session: 'fresh' });
    expect(recorded).toBe('ses_new');
    child.exit();
    await result.settled;
  });

  it('a seat held by a non-wake session DEFERS — it does not burn the act (ADR 238)', async () => {
    const child = new Child();
    const backend = opencodeBackend({
      resolveBin: async () => '/opencode',
      recordFreshSession: () => undefined,
      spawn: (() => child) as never,
    });
    const heldByOther: BackendContext = {
      verifyOccupied: async () => ({ occupied: true, provenance: 'session', lease_matched: false }),
      log: () => {},
    };
    const wake = backend.wake(spec, heldByOther);
    await Promise.resolve();
    child.out('{"type":"step_start","timestamp":1,"sessionID":"ses_new"}');
    const result = await wake;
    expect(result.outcome.occupied).toBe(false);
    expect(result.outcome.deferred).toBe(true);
    expect(result.outcome.reason).toMatch(/session/);
    child.exit();
    await result.settled;
  });

  it('a seat held by ANOTHER WAKE defers too — the lease token decides (ADR 241)', async () => {
    const child = new Child();
    const backend = opencodeBackend({
      resolveBin: async () => '/opencode',
      recordFreshSession: () => undefined,
      spawn: (() => child) as never,
    });
    const heldByPriorWake: BackendContext = {
      verifyOccupied: async () => ({ occupied: true, provenance: 'wake', lease_matched: false }),
      log: () => {},
    };
    const wake = backend.wake(spec, heldByPriorWake);
    await Promise.resolve();
    child.out('{"type":"step_start","timestamp":1,"sessionID":"ses_new"}');
    const result = await wake;
    expect(result.outcome.occupied).toBe(false);
    expect(result.outcome.deferred).toBe(true);
    expect(result.outcome.reason).toMatch(/held by another session/);
    child.exit();
    await result.settled;
  });

  it('a wake that genuinely produced nothing still FAILS — deferral is not the catch-all', async () => {
    const child = new Child();
    const backend = opencodeBackend({
      resolveBin: async () => '/opencode',
      recordFreshSession: () => undefined,
      spawn: (() => child) as never,
    });
    const nobody: BackendContext = {
      verifyOccupied: async () => ({ occupied: false, lease_matched: false }),
      log: () => {},
    };
    const wake = backend.wake(spec, nobody);
    await Promise.resolve();
    child.out('{"type":"step_start","timestamp":1,"sessionID":"ses_new"}');
    const result = await wake;
    expect(result.outcome.occupied).toBe(false);
    expect(result.outcome.deferred).toBeUndefined();
    child.exit();
    await result.settled;
  });

  it('GUARD: a demoted conflict (slot live) defers without spawning — either side saying live refuses', async () => {
    const spawned: string[][] = [];
    const backend = opencodeBackend({
      resolveBin: async () => '/opencode',
      readSession: () => ({
        state: 'resumable',
        source: 'enumerated',
        slotState: 'live',
        disagreed: true,
        demoted: true,
        session: { harness: 'opencode', id: 'old', started_at: 1 },
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

  it('resumes the captured session only when the streamed identity agrees', async () => {
    const child = new Child();
    const calls: string[][] = [];
    const backend = opencodeBackend({
      resolveBin: async () => '/opencode',
      readSession: () => ({
        state: 'resumable',
        session: { harness: 'opencode', id: 'ses_old', started_at: 1 },
      }),
      ensurePinned: () => '/Users/nick/.musterd/bin',
      spawn: ((_bin: string, args: string[]) => {
        calls.push(args);
        return child;
      }) as never,
    });
    const priorPath = process.env.PATH;
    process.env.PATH = '/opt/homebrew/bin:/usr/bin';
    try {
      const wake = backend.wake(spec, ctx);
      await Promise.resolve();
      child.out('{"type":"step_start","timestamp":1,"sessionID":"ses_old"}');
      const result = await wake;
      expect(calls[0]).toEqual(buildOpencodeResumeArgs('wake line', 'ses_old'));
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
    const backend = opencodeBackend({
      resolveBin: async () => '/opencode',
      readSession: () => ({
        state: 'resumable',
        source: 'slot',
        session: { harness: 'opencode', id: 'ses_old', started_at: 1 },
        transcriptBytes: 4096,
        transcriptMtime: Date.now() - 1_000,
      }),
      recordFreshSession: () => undefined,
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
    child.out('{"type":"step_start","timestamp":1,"sessionID":"ses_new"}');
    const result = await wake;
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual(buildOpencodeFreshArgs('wake line'));
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
    const backend = opencodeBackend({
      resolveBin: async () => '/opencode',
      spawn: (() => child) as never,
      recordFreshSession: () => undefined,
    });
    const wake = backend.wake(spec, ctx);
    await Promise.resolve();
    child.out('{"type":"step_start","timestamp":1,"sessionID":"ses_new"}');
    child.exit(2);
    const result = await wake;
    expect(result.outcome).toMatchObject({ occupied: false, session: 'fresh' });
    expect(result.outcome.reason).toContain('code 2');
    await result.settled;
  });
});

/**
 * The completion record (lane 01M1G310Y7) — same defect and same fix as the codex backend, whose
 * `attempt` this one was written from: `settled` resolved with nothing, so no wake on this
 * harness ever reached the `residency.wake_cost` rail. Wall-clock is host-measured, so every
 * settled run carries it; opencode prints no attested cost, so `cost_usd` stays absent.
 */
describe('the completion record — every settled run reports what the host measured', () => {
  const fresh = (child: Child) =>
    opencodeBackend({
      resolveBin: async () => '/opencode',
      spawn: (() => child) as never,
      recordFreshSession: () => undefined,
    });

  it('a woke run that exits cleanly carries duration_ms', async () => {
    const child = new Child();
    const wake = fresh(child).wake(spec, ctx);
    await Promise.resolve();
    child.out('{"type":"step_start","timestamp":1,"sessionID":"ses_new"}');
    const result = await wake;
    expect(result.outcome.occupied).toBe(true);
    child.exit(0);
    const completion = await result.settled;
    expect(completion?.duration_ms).toBeTypeOf('number');
    expect(completion?.cost_usd).toBeUndefined();
  });

  it('a run that FAILS still prices', async () => {
    const child = new Child();
    const wake = fresh(child).wake(spec, ctx);
    await Promise.resolve();
    child.out('{"type":"step_start","timestamp":1,"sessionID":"ses_new"}');
    child.exit(1);
    const result = await wake;
    expect(result.outcome.occupied).toBe(false);
    const completion = await result.settled;
    expect(completion?.duration_ms).toBeTypeOf('number');
  });
});
