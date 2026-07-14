import { EventEmitter } from 'node:events';
import type { WakeOrder } from '@musterd/protocol';
import { describe, expect, it } from 'vitest';
import type { LocalSessionLiveness } from '../../session/liveness.js';
import type { BackendContext, WakeSpec } from '../backend.js';
import {
  buildResumeArgs,
  buildWakeArgs,
  claudeCodeBackend,
  parseRunSummary,
  RESUME_TRANSCRIPT_MAX_BYTES,
  type ClaudeCodeDeps,
} from './claudeCode.js';

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

function harness(children: FakeChild | FakeChild[], deps: Partial<ClaudeCodeDeps> = {}) {
  const queue = Array.isArray(children) ? [...children] : [children];
  const calls: SpawnCall[] = [];
  const backend = claudeCodeBackend({
    resolveBin: async () => '/fake/claude',
    // reason: the fake child mirrors only the ChildProcess surface the backend touches.

    spawn: ((bin: string, args: string[], opts: SpawnCall['opts']) => {
      calls.push({ bin, args, opts });
      return (queue.length > 1 ? queue.shift()! : queue[0]!) as any;
    }) as any,
    mintSessionId: () => '00000000-0000-4000-8000-000000000000',
    killGraceMs: 5,
    confirmBeatMs: 5,
    // Deterministic capture state: default = the pre-capture world (fresh path, quiet).
    readSession: () => ({ state: 'none' }),
    ...deps,
  });
  return { backend, calls };
}

/** A resumable capture as the shared liveness module would report it. */
const resumable = (over: Partial<LocalSessionLiveness> = {}): LocalSessionLiveness => ({
  state: 'resumable',
  session: {
    harness: 'claude-code',
    id: 'cap-1234',
    transcript_path: '/ws/scout/.claude/t.jsonl',
    started_at: Date.now() - 60_000,
  },
  transcriptBytes: 4096,
  transcriptMtime: Date.now() - 20 * 60_000,
  ...over,
});

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

describe('buildResumeArgs (the resume argv invariants, inc 4)', () => {
  const args = buildResumeArgs('musterd wake — line', 'cap-1234');

  it('resumes the captured session id, with the composed line verbatim via -p', () => {
    expect(args[args.indexOf('--resume') + 1]).toBe('cap-1234');
    expect(args[args.indexOf('-p') + 1]).toBe('musterd wake — line');
    expect(args).not.toContain('--session-id'); // the source of the id is the capture, not a mint
  });
  it('identical permission posture to fresh: reply-only tools, default permission mode', () => {
    expect(args[args.indexOf('--allowedTools') + 1]).toBe('mcp__musterd');
    expect(args).not.toContain('--permission-mode');
  });
  it('NEVER a skip-permissions flag — on EITHER arg builder (ADR 131 §6)', () => {
    expect(args.join(' ')).not.toMatch(/skip-permissions|dangerously/i);
    expect(buildWakeArgs('l', 'i').join(' ')).not.toMatch(/skip-permissions|dangerously/i);
  });
});

describe('WakeArgOpts (inc 5): tool policy + turn cap ride the argv', () => {
  it('seat-policy omits --allowedTools (workspace settings govern) — and STILL never a skip flag', () => {
    for (const args of [
      buildWakeArgs('l', 'i', { toolPolicy: 'seat-policy' }),
      buildResumeArgs('l', 'i', { toolPolicy: 'seat-policy' }),
    ]) {
      expect(args).not.toContain('--allowedTools');
      expect(args.join(' ')).not.toMatch(/skip-permissions|dangerously/i);
      expect(args).not.toContain('--permission-mode');
    }
  });
  it('--max-turns lands when bounded; reply-only stays the default posture', () => {
    const args = buildWakeArgs('l', 'i', { maxTurns: 12 });
    expect(args[args.indexOf('--max-turns') + 1]).toBe('12');
    expect(args[args.indexOf('--allowedTools') + 1]).toBe('mcp__musterd');
    expect(buildWakeArgs('l', 'i')).not.toContain('--max-turns');
  });
});

describe('claudeCodeBackend.wake', () => {
  it('order knobs flow into the spawn argv; a per-seat transcript bound tightens the ladder', async () => {
    const child = new FakeChild();
    const { backend, calls } = harness(child, { readSession: () => resumable() });
    // The capture is 4096 bytes; the seat's policy bound is 1 KiB — resume rolls over to fresh.
    const actuation = await backend.wake(
      spec({
        order: order({ tool_policy: 'seat-policy', transcript_max_bytes: 1_024 }),
        bounds: { timeout_ms: 60_000, max_turns: 7 },
      }),
      ctx(async () => ({ occupied: true, provenance: 'wake' })),
    );
    expect(calls).toHaveLength(1); // no resume attempt — the ladder skipped it
    expect(calls[0]!.args).toContain('--session-id');
    expect(calls[0]!.args).not.toContain('--resume');
    expect(calls[0]!.args).not.toContain('--allowedTools'); // seat-policy
    expect(calls[0]!.args[calls[0]!.args.indexOf('--max-turns') + 1]).toBe('7');
    expect(actuation.outcome).toEqual({ occupied: true, session: 'fresh' });
    child.exit(0);
    await actuation.settled;
  });

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

describe('claudeCodeBackend.wake — the resume ladder (inc 4)', () => {
  it('resumable capture: spawns --resume and reports session=resumed on roster occupancy', async () => {
    const child = new FakeChild();
    const { backend, calls } = harness(child, { readSession: () => resumable() });
    const actuation = await backend.wake(
      spec(),
      ctx(async () => ({ occupied: true, provenance: 'wake' })),
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args[calls[0]!.args.indexOf('--resume') + 1]).toBe('cap-1234');
    expect(calls[0]!.opts.env?.['MUSTERD_PROVENANCE']).toBe('wake'); // same provenance either path
    expect(actuation.outcome).toEqual({ occupied: true, session: 'resumed' });
    child.exit(0);
    await actuation.settled;
  });

  it('resume that never occupies: killed, then a fresh fallback in the same wake call', async () => {
    const resumeChild = new FakeChild();
    const freshChild = new FakeChild();
    const { backend, calls } = harness([resumeChild, freshChild], {
      readSession: () => resumable(),
      resumeVerifyWindowMs: 5,
    });
    // The fake roster: the resume attempt (sub-window 5ms) never sees the seat; the fresh attempt
    // (no explicit window) does — occupancy only ever comes from the roster, either path.
    const context = ctx(((_seat: string, windowMs?: number) =>
      Promise.resolve(
        windowMs === 5 ? { occupied: false } : { occupied: true, provenance: 'wake' },
      )) as never);
    const actuation = await backend.wake(spec(), context);

    expect(calls).toHaveLength(2);
    expect(calls[0]!.args).toContain('--resume');
    expect(calls[1]!.args).toContain('--session-id'); // the complete inc-3 fresh path
    // The same daemon-composed line, verbatim, on both attempts — one lease, one prompt.
    expect(calls[1]!.args[calls[1]!.args.indexOf('-p') + 1]).toBe(spec().order.composed_line);
    expect(resumeChild.signals).toContain('SIGTERM'); // the dead resume never lingers
    expect(actuation.outcome.occupied).toBe(true);
    expect(actuation.outcome.session).toBe('fresh');
    expect(context.lines.join('\n')).toMatch(/resume failed .* fresh fallback/);
    resumeChild.exit(143);
    freshChild.exit(0);
    await actuation.settled;
  });

  it.each([
    [
      'harness mismatch',
      resumable({ session: { ...resumable().session!, harness: 'codex' } }),
      /captured harness/,
    ],
    ['gc horizon', resumable({ state: 'gc-expired' }), /GC horizon/],
    [
      'missing transcript',
      resumable({ transcriptBytes: undefined, session: { ...resumable().session! } }),
      /transcript is missing/,
    ],
    [
      'bloated transcript',
      resumable({ transcriptBytes: RESUME_TRANSCRIPT_MAX_BYTES + 1 }),
      /hygiene bound/,
    ],
  ] as const)(
    'ladder rung "%s" degrades to fresh with a named skip',
    async (_name, liveness, re) => {
      const child = new FakeChild();
      const { backend, calls } = harness(child, { readSession: () => liveness });
      const context = ctx(async () => ({ occupied: true, provenance: 'wake' }));
      const actuation = await backend.wake(spec(), context);
      expect(calls).toHaveLength(1);
      expect(calls[0]!.args).toContain('--session-id');
      expect(calls[0]!.args).not.toContain('--resume');
      expect(actuation.outcome.session).toBe('fresh');
      expect(context.lines.join('\n')).toMatch(re);
      child.exit(0);
      await actuation.settled;
    },
  );

  it('the pre-capture world (state none) goes fresh QUIETLY — no skip noise', async () => {
    const child = new FakeChild();
    const { backend, calls } = harness(child); // default readSession: none
    const context = ctx(async () => ({ occupied: true, provenance: 'wake' }));
    const actuation = await backend.wake(spec(), context);
    expect(calls[0]!.args).toContain('--session-id');
    expect(context.lines.join('\n')).not.toContain('resume skipped');
    expect(actuation.outcome.session).toBe('fresh');
    child.exit(0);
    await actuation.settled;
  });

  it('debris presence: a resume child that dies right after the roster hit is NOT woke — fresh fallback', async () => {
    // The first live fallback rehearsal (2026-07-13): a stale-id --resume died with exit 1 at
    // 2.3s but its adapter had blipped a presence row at 2.1s; the roster read credited a dead
    // child as woke {session:resumed} and the act went unanswered. The confirmation beat catches
    // it: a roster hit only counts if the child is still alive (or exited 0) a beat later.
    const resumeChild = new FakeChild();
    const freshChild = new FakeChild();
    const { backend, calls } = harness([resumeChild, freshChild], {
      readSession: () => resumable(),
      resumeVerifyWindowMs: 5,
      confirmBeatMs: 30,
    });
    // The roster says occupied instantly on BOTH attempts (the debris row lingers)…
    const context = ctx(async () => ({ occupied: true, provenance: 'session' }));
    // …but the resume child dies nonzero during the confirmation beat.
    setTimeout(() => resumeChild.exit(1), 10);
    const actuation = await backend.wake(spec(), context);

    expect(calls).toHaveLength(2);
    expect(calls[0]!.args).toContain('--resume');
    expect(calls[1]!.args).toContain('--session-id');
    expect(actuation.outcome.occupied).toBe(true);
    expect(actuation.outcome.session).toBe('fresh'); // the debris resume never counted
    expect(context.lines.join('\n')).toMatch(/resume failed .*debris presence/);
    freshChild.exit(0);
    await actuation.settled;
  });

  it('a LIVE local session: defensive defer — nothing spawns, even if the loop guard is bypassed', async () => {
    const child = new FakeChild();
    const { backend, calls } = harness(child, {
      readSession: () => resumable({ state: 'live', transcriptMtime: Date.now() - 1_000 }),
    });
    const actuation = await backend.wake(
      spec(),
      ctx(async () => ({ occupied: true })),
    );
    expect(calls).toHaveLength(0);
    expect(actuation.outcome.occupied).toBe(false);
    expect(actuation.outcome.deferred).toBe(true);
    expect(actuation.outcome.reason).toBe('local-session-live');
    await actuation.settled;
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

describe('WakeCompletion (inc 5): settled resolves the run summary; fast-fail merges', () => {
  it('settled resolves cost/duration parsed from the run summary after exit', async () => {
    const child = new FakeChild();
    const { backend } = harness(child);
    const actuation = await backend.wake(
      spec(),
      ctx(async () => ({ occupied: true, provenance: 'wake' })),
    );
    expect(actuation.outcome).toEqual({ occupied: true, session: 'fresh' });
    child.stdout.emit(
      'data',
      Buffer.from(JSON.stringify({ total_cost_usd: 0.42, duration_ms: 34_000 })),
    );
    child.exit(0);
    const completion = await actuation.settled;
    expect(completion).toEqual({ cost_usd: 0.42, duration_ms: 34_000 });
  });

  it('an instant crash carries its summary on the PRIMARY outcome (fast-fail merge)', async () => {
    const child = new FakeChild();
    const { backend } = harness(child);
    const p = backend.wake(
      spec(),
      ctx(async () => {
        // The child dies with a summary before verification concludes.
        child.stdout.emit(
          'data',
          Buffer.from(JSON.stringify({ total_cost_usd: 0.05, duration_ms: 900, is_error: true })),
        );
        child.exit(1);
        return { occupied: false };
      }),
    );
    const actuation = await p;
    expect(actuation.outcome.occupied).toBe(false);
    expect(actuation.outcome.cost_usd).toBe(0.05);
    expect(actuation.outcome.duration_ms).toBe(900);
    await actuation.settled;
  });

  it('a failed resume and the fresh fallback SUM their attested spend (same lease)', async () => {
    const resumeChild = new FakeChild();
    const freshChild = new FakeChild();
    let call = 0;
    const { backend } = harness([resumeChild, freshChild], {
      readSession: () => resumable(),
      resumeVerifyWindowMs: 20,
    });
    const actuation = await backend.wake(
      spec(),
      ctx(async () => {
        call += 1;
        if (call === 1) {
          // The resume attempt dies (with a cost) — fresh fallback follows.
          resumeChild.stdout.emit(
            'data',
            Buffer.from(JSON.stringify({ total_cost_usd: 0.1, duration_ms: 800 })),
          );
          resumeChild.exit(1);
          return { occupied: false };
        }
        return { occupied: true, provenance: 'wake' };
      }),
    );
    expect(actuation.outcome.occupied).toBe(true);
    expect(actuation.outcome.session).toBe('fresh');
    freshChild.stdout.emit(
      'data',
      Buffer.from(JSON.stringify({ total_cost_usd: 0.9, duration_ms: 30_000 })),
    );
    freshChild.exit(0);
    const completion = await actuation.settled;
    expect(completion?.cost_usd).toBeCloseTo(1.0);
    expect(completion?.duration_ms).toBe(30_800);
  });
});
