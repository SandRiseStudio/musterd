/**
 * ADR 389's falsifier — the experiment that must pass before `daemon_wedged` is ever armed.
 *
 *   (a) an induced wedge (a long synchronous SQLite wait against a held lock) classifies as
 *       `daemon_wedged`, not `daemon_down`;
 *   (b) with the sample tool absent, the same conditions produce `daemon_down` at alert and
 *       NEVER a restart;
 *   (c) with the tier at `auto` but only two ticks elapsed, no restart;
 *   (d) with three ticks elapsed but every raise suppressed by the damper, no restart.
 *
 * Arm (a) runs LIVE where `/usr/bin/sample` exists: two child processes, one holding a write
 * lock, one blocked behind it, and the real tool run through the same `runSampleTool` the tick
 * uses. That is the one part of ADR 389 no fixture can stand in for — #1328's synthetic fixture
 * guessed the wedge's shape and guessed wrong (the leaf is a sleep, not `sqlite3_step`), which is
 * how the parser came to call the real thing wedged by luck. Elsewhere the arm is skipped, not
 * faked, and says so.
 *
 * Arms (c) and (d) are true today because no restart is BUILT; they are pinned so that whoever
 * builds it inherits the ladder's two failing tests rather than an ADR paragraph.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { actOn, type ActDeps } from './act.js';
import { classify, DEFAULT_TIERS } from './classify.js';
import { emptyStamp, raiseReason, recordRaise, type GuardianStamp } from './damp.js';
import { LIVE_WEDGED } from './sample.fixtures.js';
import { parseSample, runSampleTool, type StackSample } from './sample.js';
import { collectSignals, type SignalDeps } from './signals.js';

const NOW = 5_000_000;
const TICK_MS = 120_000;

/** The four circumstantial conditions, as the collector hands them to the classifier. */
function persisted(ticksAgo: number, stack: StackSample | undefined) {
  return {
    now: NOW,
    health: null,
    healthProbe: {
      attempts: 3,
      lastError: 'The operation was aborted due to timeout',
      confirmMs: 10_000,
      confirmError: 'The operation was aborted due to timeout',
    },
    handover: null,
    launchd: { lastExit: 0, runs: 15 },
    publisherLog: { freshFailure: false },
    errLinesSinceBoot: 0,
    httpErrorRateSinceBoot: 0,
    reaperStormSinceBoot: false,
    lastRefreshAt: null,
    firstUnreachableAt: ticksAgo === 0 ? null : NOW - ticksAgo * TICK_MS,
    ...(stack !== undefined ? { stack } : {}),
  };
}

function act(stamp: GuardianStamp, tiers: ActDeps['tiers']) {
  const got = { service: [] as string[][], asks: [] as string[], actions: [] as string[] };
  const d: ActDeps = {
    now: () => NOW,
    stamp,
    tiers,
    runService: async (args) => {
      got.service.push(args);
      return { ok: true };
    },
    osNotify: () => {},
    sendAsk: async (body) => {
      got.asks.push(body);
    },
    audit: async (action) => {
      got.actions.push(action);
    },
    log: () => {},
  };
  return { d, got };
}

const ARMED = { ...DEFAULT_TIERS, daemon_wedged: 'auto' as const };

/** The captured wedge, parsed — what arm (a) produces live, for the arms that build on it. */
const wedgedSample = parseSample(LIVE_WEDGED, 84843);

const canSample = process.platform === 'darwin' && existsSync('/usr/bin/sample');

/** better-sqlite3 from the server package when present (its own image in the sample — the
 *  attribution the raise wants); node:sqlite otherwise (bundled into `node`, so no entry frame). */
function sqliteModule(): { kind: 'better-sqlite3'; path: string } | { kind: 'node:sqlite' } {
  try {
    const req = createRequire(join(import.meta.dirname, '../../../server/package.json'));
    return { kind: 'better-sqlite3', path: req.resolve('better-sqlite3') };
  } catch {
    return { kind: 'node:sqlite' };
  }
}

function waitFor(child: ChildProcess, marker: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let buf = '';
    child.stdout?.on('data', (c: Buffer) => {
      buf += c.toString();
      if (buf.includes(marker)) resolve();
    });
    child.on('exit', (code) => reject(new Error(`child exited ${code} before "${marker}"`)));
    child.on('error', reject);
  });
}

describe.skipIf(!canSample)('arm (a) — live: an induced SQLite wedge is daemon_wedged', () => {
  let dir: string;
  let holder: ChildProcess;
  let blocked: ChildProcess;
  const mod = sqliteModule();

  const open =
    mod.kind === 'better-sqlite3'
      ? `const Database = require(${JSON.stringify(mod.path)}); const db = new Database(process.argv[1]);`
      : `const { DatabaseSync } = require('node:sqlite'); const db = new DatabaseSync(process.argv[1]);`;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'musterd-falsifier-'));
    const dbPath = join(dir, 'wedge.db');
    holder = spawn(
      process.execPath,
      [
        '-e',
        `${open} db.exec('CREATE TABLE IF NOT EXISTS t (x INTEGER)'); db.exec('BEGIN IMMEDIATE'); ` +
          `db.exec('INSERT INTO t VALUES (1)'); console.log('HOLDING'); setTimeout(() => db.exec('COMMIT'), 60000);`,
        dbPath,
      ],
      { stdio: ['ignore', 'pipe', 'ignore'] },
    );
    await waitFor(holder, 'HOLDING');
    blocked = spawn(
      process.execPath,
      [
        '-e',
        `${open} db.exec('PRAGMA busy_timeout = 60000'); console.log('BLOCKING'); db.exec('INSERT INTO t VALUES (2)');`,
        dbPath,
      ],
      { stdio: ['ignore', 'pipe', 'ignore'] },
    );
    await waitFor(blocked, 'BLOCKING');
    await new Promise((r) => setTimeout(r, 300));
  }, 20_000);

  afterAll(() => {
    holder?.kill();
    blocked?.kill();
    rmSync(dir, { recursive: true, force: true });
  });

  it('the real tool, through the tick’s own runner, reads the blocked process as wedged', () => {
    const pid = blocked.pid!;
    const s = parseSample(runSampleTool(pid, 2), pid);
    expect(s.taken).toBe(true);
    expect(s.wedged).toBe(true);
    expect(s.share).toBeGreaterThan(0.9);
    // The leaf is the busy handler's sleep — a wait primitive — and it is still a wedge.
    expect(s.frame).toMatch(/semwait|nanosleep|usleep/);
    if (mod.kind === 'better-sqlite3') expect(s.entry?.image).toBe('better_sqlite3.node');
  }, 15_000);

  it('end to end: the collector samples the pid launchd names, and the classifier promotes', async () => {
    const pid = blocked.pid!;
    const unreachable = async () => {
      throw new Error('The operation was aborted due to timeout');
    };
    const deps: SignalDeps = {
      now: () => NOW,
      fetchHealth: unreachable,
      confirmHealth: unreachable,
      sleep: async () => {},
      launchctlPrint: async () =>
        `\tstate = running\n\tpid = ${pid}\n\truns = 15\n\tlast exit code = (never exited)\n`,
      readSince: async () => [],
      statMtime: async () => null,
      sampleStack: async (p, seconds) => runSampleTool(p, Math.min(seconds, 2)),
      expected: { dbPath: '/nonexistent/musterd.db', schema: null },
      daemonErrLogPath: '/nonexistent/err.log',
      publisherBuildLogPath: '/nonexistent/build.log',
      publisherOkStampPath: '/nonexistent/build.ok',
      lastRefreshAt: async () => null,
    };
    const signals = await collectSignals(deps);
    expect(signals.health).toBeNull();
    expect(signals.stack?.taken).toBe(true);
    expect(signals.stack?.wedged).toBe(true);

    const out = classify({ ...signals, firstUnreachableAt: NOW - 2 * TICK_MS });
    expect(out.map((i) => i.class)).toEqual(['daemon_wedged']);
    expect(out[0]!.evidence).toMatch(/ALIVE and blocked/);
  }, 20_000);
});

describe('arm (b) — no sample tool: daemon_down at alert, never a restart', () => {
  it('a missing tool degrades the class and says so, even with the tier armed', async () => {
    // What the collector records when `spawnSync('sample')` fails with ENOENT (signals.ts).
    const absent: StackSample = {
      taken: false,
      reason: 'sample(1) failed: spawnSync sample ENOENT',
      wedged: false,
    };
    const out = classify(persisted(3, absent));
    expect(out.map((i) => i.class)).toEqual(['daemon_down']);
    expect(out[0]!.evidence).toContain('ENOENT');

    const { d, got } = act(emptyStamp(), ARMED);
    const r = await actOn(out, d);
    expect(got.service).toEqual([]);
    expect(r.acted).toEqual([{ class: 'daemon_down', action: 'alerted' }]);
  });

  it('no sampler wired at all (a non-macOS build) is the same posture', async () => {
    const out = classify(persisted(3, undefined));
    expect(out.map((i) => i.class)).toEqual(['daemon_down']);
    const { d, got } = act(emptyStamp(), ARMED);
    await actOn(out, d);
    expect(got.service).toEqual([]);
  });
});

describe('arm (c) — tier auto, two ticks: no restart', () => {
  it('daemon_wedged at auto with the incident two ticks old alerts and does not act', async () => {
    const out = classify(persisted(2, wedgedSample));
    expect(out.map((i) => i.class)).toEqual(['daemon_wedged']);

    const { d, got } = act(emptyStamp(), ARMED);
    const r = await actOn(out, d);
    expect(got.service).toEqual([]);
    expect(r.acted).toEqual([{ class: 'daemon_wedged', action: 'alerted' }]);
    // The raise says the truth: the tier is set and nothing is built to honour it.
    expect(got.asks[0]).toMatch(/no remediation is built/);
    expect(got.asks[0]).not.toMatch(/rollback/);
  });

  it('the first sighting defers and never reaches actOn as daemon_wedged at all', () => {
    const out = classify(persisted(0, wedgedSample));
    expect(out[0]!.class).toBe('daemon_down');
    expect(out[0]!.defer).toBe(true);
  });
});

describe('arm (d) — three ticks, every raise suppressed: no restart', () => {
  it('a damped daemon_wedged at auto is suppressed, not acted on', async () => {
    const out = classify(persisted(3, wedgedSample));
    expect(out.map((i) => i.class)).toEqual(['daemon_wedged']);

    // The damper already holds this exact sentence from a raise inside the window.
    const why = 'auto tier set but no remediation is built (ADR 389 ships dark) — alerting instead';
    const stamp = recordRaise(
      emptyStamp(),
      'daemon_wedged',
      raiseReason('daemon_wedged', why, out[0]!.evidence),
      NOW - 60_000,
    );
    const { d, got } = act(stamp, ARMED);
    const r = await actOn(out, d);
    expect(got.service).toEqual([]);
    expect(got.asks).toEqual([]);
    expect(r.acted).toEqual([{ class: 'daemon_wedged', action: 'suppressed' }]);
    expect(got.actions).toContain('guardian.suppressed');
  });

  it('nothing in the shipped defaults arms it: the tier is alert and no remedy exists', async () => {
    const out = classify(persisted(3, wedgedSample));
    const { d, got } = act(emptyStamp(), DEFAULT_TIERS);
    const r = await actOn(out, d);
    expect(got.service).toEqual([]);
    expect(r.acted).toEqual([{ class: 'daemon_wedged', action: 'alerted' }]);
  });
});
