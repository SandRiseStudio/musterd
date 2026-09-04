import { EventEmitter } from 'node:events';
import type { ContinuityBinding, ContinuityRegistry, WakeOrder } from '@musterd/protocol';
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
  verify: () => Promise<{
    occupied: boolean;
    provenance?: string | null;
    lease_matched?: boolean;
    own_unattested?: boolean;
  }>,
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
      ctx(async () => ({ occupied: true, provenance: 'wake', lease_matched: true })),
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
      ctx(async () => ({ occupied: true, provenance: 'wake', lease_matched: true })),
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

  it('pins the actuator’s own musterd FIRST on the woken PATH (lane 01KYQMM141)', async () => {
    const child = new FakeChild();
    const { backend, calls } = harness(child, { ensurePinned: () => '/pinned/bin' });
    const actuation = await backend.wake(
      spec(),
      ctx(async () => ({ occupied: true, provenance: 'wake', lease_matched: true })),
    );
    // A woken session's hooks call a bare `musterd`; the pin must beat whatever else is on PATH.
    expect(calls[0]!.opts.env?.['PATH']).toMatch(/^\/pinned\/bin:/);
    child.exit(0);
    await actuation.settled;
  });

  it('an unwritable pin degrades to the inherited PATH — never a failed wake', async () => {
    const child = new FakeChild();
    const { backend, calls } = harness(child, { ensurePinned: () => undefined });
    const actuation = await backend.wake(
      spec(),
      ctx(async () => ({ occupied: true, provenance: 'wake', lease_matched: true })),
    );
    expect(calls[0]!.opts.env?.['PATH']).toBe(process.env['PATH']);
    expect(actuation.outcome).toEqual({ occupied: true, session: 'fresh' });
    child.exit(0);
    await actuation.settled;
  });

  it('a stale cached claude path self-heals: re-resolve and retry inside the same attempt', async () => {
    // The measured failure (lane 01KYQ913P5): a resident host cached a path, a CLI upgrade moved the
    // install, and 8 of 14 wake failures were ENOENT on the dead path — three of which exhaust an act.
    const child = new FakeChild();
    let invalidated = 0;
    const bins = ['/gone/claude', '/moved/claude'];
    const calls: SpawnCall[] = [];
    const backend = claudeCodeBackend({
      resolveBin: async () => bins[Math.min(invalidated, 1)]!,
      invalidateBin: () => {
        invalidated++;
      },
      spawn: ((bin: string, args: string[], opts: SpawnCall['opts']) => {
        calls.push({ bin, args, opts });
        if (bin === '/gone/claude') throw new Error('spawn /gone/claude ENOENT');
        return child as never;
      }) as never,
      mintSessionId: () => '00000000-0000-4000-8000-000000000000',
      killGraceMs: 5,
      confirmBeatMs: 5,
      readSession: () => ({ state: 'none' }),
    });
    const c = ctx(async () => ({ occupied: true, provenance: 'wake', lease_matched: true }));
    const actuation = await backend.wake(spec(), c);

    expect(invalidated).toBe(1);
    expect(calls.map((k) => k.bin)).toEqual(['/gone/claude', '/moved/claude']);
    expect(actuation.outcome).toEqual({ occupied: true, session: 'fresh' });
    expect(c.lines.join(' ')).toContain('re-resolved and retrying');
    child.exit(0);
    await actuation.settled;
  });

  it('a NON-ENOENT spawn failure does not re-resolve — the path is right, something else is wrong', async () => {
    let invalidated = 0;
    const calls: string[] = [];
    const backend = claudeCodeBackend({
      resolveBin: async () => '/fake/claude',
      invalidateBin: () => {
        invalidated++;
      },
      spawn: ((bin: string) => {
        calls.push(bin);
        throw new Error('spawn /fake/claude EACCES');
      }) as never,
      mintSessionId: () => '00000000-0000-4000-8000-000000000000',
      readSession: () => ({ state: 'none' }),
    });
    const actuation = await backend.wake(
      spec(),
      ctx(async () => ({ occupied: false })),
    );
    expect(invalidated).toBe(0);
    expect(calls).toEqual(['/fake/claude']); // one attempt only — never double-spend on EACCES
    expect(actuation.outcome.reason).toContain('EACCES');
  });

  it('re-resolving to the SAME path does not retry — a retry that cannot differ is wasted spend', async () => {
    const calls: string[] = [];
    const backend = claudeCodeBackend({
      resolveBin: async () => '/same/claude',
      invalidateBin: () => {},
      spawn: ((bin: string) => {
        calls.push(bin);
        throw new Error('spawn /same/claude ENOENT');
      }) as never,
      mintSessionId: () => '00000000-0000-4000-8000-000000000000',
      readSession: () => ({ state: 'none' }),
    });
    const actuation = await backend.wake(
      spec(),
      ctx(async () => ({ occupied: false })),
    );
    expect(calls).toEqual(['/same/claude']);
    expect(actuation.outcome.reason).toContain('ENOENT');
  });

  it('verified occupancy with non-wake provenance still occupies but names the stale adapter', async () => {
    const child = new FakeChild();
    const { backend } = harness(child);
    const context = ctx(async () => ({
      occupied: true,
      provenance: 'session',
      lease_matched: true,
    }));
    const actuation = await backend.wake(spec(), context);
    expect(actuation.outcome.occupied).toBe(true);
    expect(context.lines.join('\n')).toMatch(/predate|rebuild/);
    child.exit(0);
    await actuation.settled;
  });

  /**
   * ADR 241 increment 3 (lane 01M1HQC9JJ). Until 2026-09-02 this backend gated on `occupied`
   * alone — the only one of five that never read `lease_matched` — so a presence row belonging to
   * ANOTHER session (a human in the worktree, a prior wake inside its 30m timeout) was credited as
   * this wake's own: reported delivered, and the spawned child left running beside the occupant.
   * The stub at the top of this file returned `{occupied: true}` with no `lease_matched` field at
   * all, which is why the gap survived every green run. The contract (backend.ts): `occupied &&
   * !lease_matched` is a deferral, never a failure and never a success.
   */
  it('a seat held by ANOTHER session defers, never charges, and kills the child (ADR 241 inc 3)', async () => {
    const child = new FakeChild();
    const { backend } = harness(child);
    const context = ctx(async () => ({
      occupied: true,
      provenance: 'session',
      lease_matched: false,
    }));
    const actuation = await backend.wake(spec(), context);
    expect(actuation.outcome.occupied).toBe(false);
    expect(actuation.outcome.deferred).toBe(true);
    expect(actuation.outcome.reason).toMatch(/held by another session/);
    expect(actuation.outcome.reason).toContain('L1');
    // The child was never ours to keep: killed, not left burning beside the occupant.
    expect(child.signals.length).toBeGreaterThan(0);
    // A foreign row is not a stale adapter dist — the rebuild note must not fire here.
    expect(context.lines.join('\n')).not.toMatch(/predate|rebuild/);
    child.exit(0);
    await actuation.settled;
  });

  it('a seat held by ANOTHER WAKE defers too — provenance "wake" without a lease match is not ours', async () => {
    const child = new FakeChild();
    const { backend } = harness(child);
    const actuation = await backend.wake(
      spec(),
      ctx(async () => ({ occupied: true, provenance: 'wake', lease_matched: false })),
    );
    expect(actuation.outcome.occupied).toBe(false);
    expect(actuation.outcome.deferred).toBe(true);
    child.exit(0);
    await actuation.settled;
  });

  it("an unattested occupant the loop identifies as this wake's own child is NOT killed (ADR 379)", async () => {
    const child = new FakeChild();
    const { backend } = harness(child);
    const context = ctx(async () => ({
      occupied: true,
      provenance: 'session',
      lease_matched: false,
      own_unattested: true,
    }));
    const actuation = await backend.wake(spec(), context);
    expect(actuation.outcome.occupied).toBe(true);
    expect(actuation.outcome.deferred).toBeUndefined();
    // The whole point: the actuator held the evidence that this was its own child and did not
    // kill it on the strength of one missing env var (ADR 354 §Consequences, the named residual).
    expect(child.signals).toHaveLength(0);
    expect(context.lines.join('\n')).toMatch(/credited as this wake's own/);
    expect(context.lines.join('\n')).toMatch(/ADR 379/);
    child.exit(0);
    await actuation.settled;
  });

  it('a resume attempt that finds the seat held by another session does NOT fall through to a fresh spawn', async () => {
    const child = new FakeChild();
    const { backend, calls } = harness(child, { readSession: () => resumable() });
    const actuation = await backend.wake(
      spec(),
      ctx(async () => ({ occupied: true, provenance: 'session', lease_matched: false })),
    );
    // One spawn (the --resume), then a deferral — a fresh fallback would be a second process
    // aimed into a worktree someone else is sitting in.
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args).toContain('--resume');
    expect(actuation.outcome.occupied).toBe(false);
    expect(actuation.outcome.deferred).toBe(true);
    expect(actuation.outcome.session).toBe('resumed');
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
    // Lane 01M1G310Y7: a killed run prints no JSON summary, and until 2026-09-02 that meant NO
    // completion at all — the most expensive wake shape there is (a full timeout_ms of a live
    // agent) priced at nothing. 26 of the 55 unpriced claude-code settles on the live host log
    // were exactly this. Wall-clock is the host's own measurement and does not need the child's
    // cooperation to exist.
    const completion = await actuation.settled;
    expect(completion?.duration_ms).toBeTypeOf('number');
    expect(completion?.duration_ms).toBeGreaterThanOrEqual(50);
    expect(completion?.cost_usd).toBeUndefined();
  });

  it('a run that exits with no parseable summary still carries the host-measured wall clock', async () => {
    // The `exit=error` / `exit=0 with no JSON` shapes — 25 more of the 55 unpriced settles.
    const child = new FakeChild();
    const { backend } = harness(child);
    const c = ctx(async () => ({ occupied: false }));
    const wake = backend.wake(spec({ bounds: { timeout_ms: 1_000 } }), c);
    await Promise.resolve();
    child.stdout.emit('data', Buffer.from('not json at all\n'));
    child.exit(1);
    const actuation = await wake;
    expect(actuation.outcome.occupied).toBe(false);
    const completion = await actuation.settled;
    expect(completion?.duration_ms).toBeTypeOf('number');
    expect(completion?.cost_usd).toBeUndefined();
  });

  // A host that cannot spawn is DEFERRED, never FAILED (ADR 221). A failure consumes an attempt
  // against attempt_cap and an hourly-cap slot; three of them retire the act as
  // residency.wake_exhausted — terminally undeliverable, with the seat reading as if it refused.
  // The act is fine and the seat is fine; this machine simply cannot actuate, which is the same
  // shape as the local-session guard and must be budget-neutral for the same reason.
  it('claude not found: DEFERS with a named reason, nothing spawned, no attempt spent', async () => {
    const backend = claudeCodeBackend({ resolveBin: async () => null });
    const actuation = await backend.wake(
      spec(),
      ctx(async () => ({ occupied: true, lease_matched: true })),
    );
    expect(actuation.outcome.occupied).toBe(false);
    expect(actuation.outcome.deferred).toBe(true);
    expect(actuation.outcome.reason).toMatch(/claude CLI not found/);
  });
});

describe('claudeCodeBackend.wake — the resume ladder (inc 4)', () => {
  it('resumable capture: spawns --resume and reports session=resumed on roster occupancy', async () => {
    const child = new FakeChild();
    const { backend, calls } = harness(child, { readSession: () => resumable() });
    const actuation = await backend.wake(
      spec(),
      ctx(async () => ({ occupied: true, provenance: 'wake', lease_matched: true })),
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args[calls[0]!.args.indexOf('--resume') + 1]).toBe('cap-1234');
    expect(calls[0]!.opts.env?.['MUSTERD_PROVENANCE']).toBe('wake'); // same provenance either path
    expect(actuation.outcome).toEqual({ occupied: true, session: 'resumed' });
    child.exit(0);
    await actuation.settled;
  });

  it('portable fresh orders bypass --resume even with a valid local capture', async () => {
    const child = new FakeChild();
    const { backend, calls } = harness(child, { readSession: () => resumable() });
    const actuation = await backend.wake(
      spec({ order: order({ intended_delivery: 'fresh', continuity_requirement: 'portable' }) }),
      ctx(async () => ({ occupied: true, provenance: 'wake', lease_matched: true })),
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args).not.toContain('--resume');
    expect(actuation.outcome).toMatchObject({
      occupied: true,
      session: 'fresh',
      delivery_outcome: 'fresh',
      transcript_bytes: 4096,
    });
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
        windowMs === 5
          ? { occupied: false }
          : { occupied: true, provenance: 'wake', lease_matched: true },
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
      const context = ctx(async () => ({
        occupied: true,
        provenance: 'wake',
        lease_matched: true,
      }));
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

  // ── The recalibrated hygiene bound (2026-07-29) ────────────────────────────────────────────
  // The bound is a *cost* crossover, not a hygiene aesthetic: its own doc comment says "past it,
  // resume spends more re-ingesting history than a fresh seat-primer boot costs". These two pin
  // the bound against the measurement rather than against the constant, so a future retune that
  // walks back past the crossover fails here instead of silently costing money.
  it('a transcript past the measured crossover (450 KiB) rolls to fresh', async () => {
    const child = new FakeChild();
    const { backend, calls } = harness(child, {
      readSession: () => resumable({ transcriptBytes: 460_597 }), // dolly, the $2.53 resume
    });
    const context = ctx(async () => ({ occupied: true, provenance: 'wake', lease_matched: true }));
    const actuation = await backend.wake(spec(), context);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args).not.toContain('--resume');
    expect(actuation.outcome.session).toBe('fresh');
    // Legible at sub-MiB bounds: "0.4 MiB (hygiene bound 0.2 MiB)" says nothing useful.
    expect(context.lines.join('\n')).toMatch(/transcript is 449\.8 KiB \(hygiene bound 256 KiB\)/);
    child.exit(0);
    await actuation.settled;
  });

  it('a transcript inside the cheap region (231 KiB) still resumes — continuity is not thrown away', async () => {
    const child = new FakeChild();
    const { backend, calls } = harness(child, {
      readSession: () => resumable({ transcriptBytes: 236_590 }), // dolly, the $1.21 resume
    });
    const context = ctx(async () => ({ occupied: true, provenance: 'wake', lease_matched: true }));
    const actuation = await backend.wake(spec(), context);
    expect(calls[0]!.args).toContain('--resume');
    expect(context.lines.join('\n')).not.toContain('resume skipped');
    child.exit(0);
    await actuation.settled;
  });

  it('the pre-capture world (state none) goes fresh QUIETLY — no skip noise', async () => {
    const child = new FakeChild();
    const { backend, calls } = harness(child); // default readSession: none
    const context = ctx(async () => ({ occupied: true, provenance: 'wake', lease_matched: true }));
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
    const context = ctx(async () => ({
      occupied: true,
      provenance: 'session',
      lease_matched: true,
    }));
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
      ctx(async () => ({ occupied: true, lease_matched: true })),
    );
    expect(calls).toHaveLength(0);
    expect(actuation.outcome.occupied).toBe(false);
    expect(actuation.outcome.deferred).toBe(true);
    expect(actuation.outcome.reason).toBe('local-session-live');
    await actuation.settled;
  });
});

/**
 * ADR 166 increment 3 — the guard and resume questions split, each failing in its cheap direction:
 * guard unsure ⇒ assume live (refuse, costs a delay); resume unsure ⇒ assume nothing (fresh).
 */
describe('claudeCodeBackend.wake — split guard/resume (ADR 166 inc 3)', () => {
  it('GUARD: a demoted conflict (slot live, enumeration disagrees) still defers — either side saying live refuses', async () => {
    const child = new FakeChild();
    const { backend, calls } = harness(child, {
      readSession: () =>
        resumable({
          state: 'resumable',
          source: 'enumerated',
          slotState: 'live',
          disagreed: true,
          demoted: true,
        }),
    });
    const actuation = await backend.wake(
      spec(),
      ctx(async () => ({ occupied: true, lease_matched: true })),
    );
    expect(calls).toHaveLength(0);
    expect(actuation.outcome).toMatchObject({
      occupied: false,
      deferred: true,
      reason: 'local-session-live',
    });
    await actuation.settled;
  });

  it('RESUME: an empty slot with an enumerated resumable newest resumes THAT id (no full-price fresh)', async () => {
    const child = new FakeChild();
    const { backend, calls } = harness(child, {
      readSession: () => ({
        state: 'resumable',
        source: 'enumerated',
        slotState: 'none',
        disagreed: true,
        enumerated: {
          state: 'resumable',
          id: 'enum-5678',
          mtime: Date.now() - 20 * 60_000,
          bytes: 2048,
          count: 3,
        },
      }),
    });
    const context = ctx(async () => ({ occupied: true, provenance: 'wake', lease_matched: true }));
    const actuation = await backend.wake(spec(), context);
    expect(calls[0]!.args[calls[0]!.args.indexOf('--resume') + 1]).toBe('enum-5678');
    expect(actuation.outcome).toEqual({ occupied: true, session: 'resumed' });
    expect(context.lines.join('\n')).toMatch(/from enumeration/);
    child.exit(0);
    await actuation.settled;
  });

  it('RESUME: a foreign-harness slot no longer forces fresh when enumeration names a resumable newest', async () => {
    const child = new FakeChild();
    const { backend, calls } = harness(child, {
      readSession: () =>
        resumable({
          source: 'enumerated',
          slotState: 'resumable',
          session: { ...resumable().session!, harness: 'codex' },
          enumerated: {
            state: 'resumable',
            id: 'enum-9012',
            mtime: Date.now() - 20 * 60_000,
            bytes: 2048,
            count: 1,
          },
        }),
    });
    const context = ctx(async () => ({ occupied: true, provenance: 'wake', lease_matched: true }));
    const actuation = await backend.wake(spec(), context);
    expect(calls[0]!.args[calls[0]!.args.indexOf('--resume') + 1]).toBe('enum-9012');
    expect(actuation.outcome.session).toBe('resumed');
    child.exit(0);
    await actuation.settled;
  });

  it('RESUME: an enumerated newest over the hygiene bound degrades to fresh with a named skip', async () => {
    const child = new FakeChild();
    const { backend, calls } = harness(child, {
      readSession: () => ({
        state: 'resumable' as const,
        source: 'enumerated' as const,
        enumerated: {
          state: 'resumable' as const,
          id: 'enum-big',
          mtime: Date.now() - 20 * 60_000,
          bytes: RESUME_TRANSCRIPT_MAX_BYTES + 1,
          count: 1,
        },
      }),
    });
    const context = ctx(async () => ({ occupied: true, provenance: 'wake', lease_matched: true }));
    const actuation = await backend.wake(spec(), context);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args).not.toContain('--resume');
    expect(actuation.outcome.session).toBe('fresh');
    expect(context.lines.join('\n')).toMatch(/newest transcript .*hygiene bound/);
    child.exit(0);
    await actuation.settled;
  });

  it('RESUME: a usable slot capture still wins over enumeration (inc 3 changes the fallback, not the preference)', async () => {
    const child = new FakeChild();
    const { backend, calls } = harness(child, {
      readSession: () =>
        resumable({
          source: 'enumerated',
          enumerated: {
            state: 'resumable',
            id: 'enum-other',
            mtime: Date.now() - 20 * 60_000,
            bytes: 2048,
            count: 2,
          },
        }),
    });
    const actuation = await backend.wake(
      spec(),
      ctx(async () => ({ occupied: true, provenance: 'wake', lease_matched: true })),
    );
    expect(calls[0]!.args[calls[0]!.args.indexOf('--resume') + 1]).toBe('cap-1234');
    child.exit(0);
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
      ctx(async () => ({ occupied: true, provenance: 'wake', lease_matched: true })),
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
        return { occupied: true, provenance: 'wake', lease_matched: true };
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

describe('claudeCodeBackend.wake — exact-match local continuity (ADR 210)', () => {
  const THREAD = 'T1';
  const binding = (over: Partial<ContinuityBinding> = {}): ContinuityBinding => ({
    thread_id: THREAD,
    harness: 'claude-code',
    session_id: 'thread-session-9',
    transcript_path: '/ws/scout/.claude/thread.jsonl',
    bound_at: Date.now() - 60_000,
    captured_at: Date.now() - 120_000,
    ...over,
  });
  const registry = (bindings: ContinuityBinding[]): ContinuityRegistry => ({
    v: 1,
    team: 'dawn',
    seat: 'scout',
    bindings,
  });
  const eligible = (over: Partial<WakeOrder> = {}) =>
    order({
      resume_eligible: true,
      thread_id: THREAD,
      intended_delivery: 'fresh',
      continuity_requirement: 'portable',
      ...over,
    });
  /** A transcript small and recent enough to clear the byte/age ladder. */
  const healthyStat = () => ({ bytes: 4096, mtimeMs: Date.now() - 60_000 });

  it('an exact match resumes THAT thread’s session — not the slot capture', async () => {
    const child = new FakeChild();
    const { backend, calls } = harness(child, {
      readSession: () => resumable(), // slot holds a DIFFERENT session (cap-1234)
      readContinuity: () => registry([binding()]),
      statTranscript: healthyStat,
    });
    const actuation = await backend.wake(
      spec({ order: eligible() }),
      ctx(async () => ({ occupied: true, provenance: 'wake', lease_matched: true })),
    );
    expect(calls[0]!.args[calls[0]!.args.indexOf('--resume') + 1]).toBe('thread-session-9');
    expect(actuation.outcome).toMatchObject({ occupied: true, session: 'resumed' });
    child.exit(0);
    await actuation.settled;
  });

  it('a non-eligible order never reads the registry at all — the daemon’s bit gates the lookup', async () => {
    const child = new FakeChild();
    let reads = 0;
    const { backend, calls } = harness(child, {
      readSession: () => ({ state: 'none' }),
      readContinuity: () => {
        reads += 1;
        return registry([binding()]);
      },
      statTranscript: healthyStat,
    });
    const actuation = await backend.wake(
      spec({ order: order({ intended_delivery: 'fresh', continuity_requirement: 'portable' }) }),
      ctx(async () => ({ occupied: true, provenance: 'wake', lease_matched: true })),
    );
    expect(reads).toBe(0);
    expect(calls[0]!.args).not.toContain('--resume');
    child.exit(0);
    await actuation.settled;
  });

  it('eligible but no binding for that thread: fresh, and it says the match was missing', async () => {
    const child = new FakeChild();
    const { backend, calls } = harness(child, {
      readSession: () => resumable(),
      readContinuity: () => registry([binding({ thread_id: 'a-different-thread' })]),
      statTranscript: healthyStat,
    });
    const c = ctx(async () => ({ occupied: true, provenance: 'wake', lease_matched: true }));
    const actuation = await backend.wake(spec({ order: eligible() }), c);
    expect(calls[0]!.args).not.toContain('--resume');
    expect(actuation.outcome).toMatchObject({
      occupied: true,
      session: 'fresh',
      exact_match: 'missing',
    });
    expect(c.lines.join('\n')).toMatch(/no local binding/i);
    child.exit(0);
    await actuation.settled;
  });

  it('an exact match failing the byte bound degrades to fresh, naming the bound', async () => {
    const child = new FakeChild();
    const { backend, calls } = harness(child, {
      readSession: () => resumable(),
      readContinuity: () => registry([binding()]),
      statTranscript: () => ({ bytes: 5_000_000, mtimeMs: Date.now() }),
    });
    const c = ctx(async () => ({ occupied: true, provenance: 'wake', lease_matched: true }));
    const actuation = await backend.wake(spec({ order: eligible() }), c);
    expect(calls[0]!.args).not.toContain('--resume');
    expect(c.lines.join('\n')).toMatch(/hygiene bound/i);
    child.exit(0);
    await actuation.settled;
  });

  it('an exact match whose transcript is gone degrades to fresh', async () => {
    const child = new FakeChild();
    const { backend, calls } = harness(child, {
      readSession: () => resumable(),
      readContinuity: () => registry([binding()]),
      statTranscript: () => undefined, // the file is not there any more
    });
    const actuation = await backend.wake(
      spec({ order: eligible() }),
      ctx(async () => ({ occupied: true, provenance: 'wake', lease_matched: true })),
    );
    expect(calls[0]!.args).not.toContain('--resume');
    child.exit(0);
    await actuation.settled;
  });

  it('an exact match whose resume never occupies still falls back fresh in the same lease', async () => {
    const resumeChild = new FakeChild();
    const freshChild = new FakeChild();
    let call = 0;
    const { backend, calls } = harness([resumeChild, freshChild], {
      readSession: () => resumable(),
      readContinuity: () => registry([binding()]),
      statTranscript: healthyStat,
      resumeVerifyWindowMs: 10,
    });
    const actuation = await backend.wake(
      spec({ order: eligible() }),
      ctx(async () => ({ occupied: ++call > 1, provenance: 'wake', lease_matched: true })),
    );
    expect(calls).toHaveLength(2);
    expect(calls[0]!.args).toContain('--resume');
    expect(calls[1]!.args).not.toContain('--resume');
    expect(actuation.outcome).toMatchObject({ occupied: true, session: 'fresh' });
    resumeChild.exit(1);
    freshChild.exit(0);
    await actuation.settled;
  });

  it('reports exact_match on every branch — the axis ADR 210 evaluates on', async () => {
    const cases: { name: string; deps: Partial<ClaudeCodeDeps>; expected: string }[] = [
      {
        name: 'bound',
        deps: { readContinuity: () => registry([binding()]), statTranscript: healthyStat },
        expected: 'bound',
      },
      {
        name: 'missing',
        deps: { readContinuity: () => registry([]), statTranscript: healthyStat },
        expected: 'missing',
      },
      {
        name: 'mismatched',
        deps: {
          readContinuity: () => registry([binding({ harness: 'codex' })]),
          statTranscript: healthyStat,
        },
        expected: 'mismatched',
      },
      {
        name: 'stale',
        deps: { readContinuity: () => registry([binding()]), statTranscript: () => undefined },
        expected: 'stale',
      },
    ];
    for (const c of cases) {
      const child = new FakeChild();
      const { backend } = harness(child, { readSession: () => resumable(), ...c.deps });
      const actuation = await backend.wake(
        spec({ order: eligible() }),
        ctx(async () => ({ occupied: true, provenance: 'wake', lease_matched: true })),
      );
      expect(actuation.outcome, c.name).toMatchObject({ exact_match: c.expected });
      child.exit(0);
      await actuation.settled;
    }
  });

  it('a non-eligible wake reports NO exact_match — absent means never considered', async () => {
    const child = new FakeChild();
    const { backend } = harness(child, { readSession: () => resumable() });
    const actuation = await backend.wake(
      spec({ order: order({ intended_delivery: 'fresh' }) }),
      ctx(async () => ({ occupied: true, provenance: 'wake', lease_matched: true })),
    );
    expect(actuation.outcome).not.toHaveProperty('exact_match');
    child.exit(0);
    await actuation.settled;
  });
});
