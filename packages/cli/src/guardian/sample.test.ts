import { describe, expect, it } from 'vitest';
import { LIVE_IDLE, LIVE_SPIN, LIVE_WEDGED } from './sample.fixtures.js';
import {
  describeSample,
  LOOP_POLL_FRAMES,
  normalizeFrame,
  parseSample,
  WEDGED_FRAME_SHARE,
} from './sample.js';

/**
 * The fixtures are CAPTURED reports (sample.fixtures.ts), not shaped ones. #1328's synthetic
 * fixture guessed that a SQLite wedge bottoms out in `sqlite3_step`; the live one bottoms out in
 * `__semwait_signal` six frames below it, inside the busy handler's sleep — and that difference is
 * what this file exists to pin (ADR 389 falsifier, arm a, 2026-09-05).
 */

/** Big-body's shape as #1328 imagined it — kept because a wedge CAN look like this too. */
const LEAF_IN_STEP = `Call graph:
    2407 Thread_9410215   DispatchQueue_1: com.apple.main-thread  (serial)
      2407 start  (in dyld) + 6000  [0x18f0b4274]
        2407 node::Start(int, char**)  (in node) + 728  [0x1013a55f8]
          2406 Napi::ObjectWrap<Statement>::step()  (in better_sqlite3.node) + 120  [0x10b2c1a48]
            2406 sqlite3_step  (in better_sqlite3.node) + 44  [0x10b3901c4]
          1 kevent  (in libsystem_kernel.dylib) + 8  [0x18f2e1b30]
    12 Thread_9410216
      12 _pthread_start  (in libsystem_pthread.dylib) + 136  [0x18f31e0f4]

Total number in stack (recursive counted multiple, when >=5):
        2407  start

Binary Images:
       0x1013a0000 -   0x101ff7fff  node (0) <...>
`;

/** Work spread across many frames — busy, not held by any one of them. */
const BUSY = `Call graph:
    1000 Thread_1   DispatchQueue_1: com.apple.main-thread  (serial)
      600 v8::internal::Runtime_CompileLazy  (in node) + 12  [0x1013a0000]
      400 sqlite3_step  (in better_sqlite3.node) + 44  [0x10b3901c4]

Binary Images:
`;

describe('parseSample (ADR 389 §1 — the classification boundary)', () => {
  it('the live SQLite wedge is wedged, and its leaf is a SLEEP, not sqlite3_step', () => {
    const s = parseSample(LIVE_WEDGED, 84843);
    expect(s.taken).toBe(true);
    expect(s.wedged).toBe(true);
    expect(s.pid).toBe(84843);
    expect(s.total).toBe(2636);
    expect(s.inFrame).toBe(2635);
    expect(s.frame).toBe('__semwait_signal');
    expect(s.share).toBeGreaterThan(0.99);
  });

  it('the wedge is attributed to where control left the runtime — the sqlite image', () => {
    // `__semwait_signal` alone is a bare kernel symbol; the sentence a human can act on is which
    // native call the loop is asleep inside.
    const s = parseSample(LIVE_WEDGED);
    expect(s.entry).toEqual({ frame: 'Database::JS_exec', image: 'better_sqlite3.node' });
  });

  it('a wait primitive as the leaf does NOT read as parked — only the loop’s own poll does', () => {
    // The 2026-09-05 finding: `nanosleep` was on #1328's idle list and `__semwait_signal` was not,
    // so the verdict was right by one missing entry. Wedged-in-a-sleep is a wedge.
    expect(LOOP_POLL_FRAMES.has('nanosleep')).toBe(false);
    expect(LOOP_POLL_FRAMES.has('semwait_signal')).toBe(false);
    expect(LOOP_POLL_FRAMES.has('psynch_cvwait')).toBe(false);
    expect(LOOP_POLL_FRAMES.has('read')).toBe(false);
    for (const f of LOOP_POLL_FRAMES) expect(f).not.toMatch(/sleep|cvwait|semwait|^read$|mach_msg/);
  });

  it('the live idle loop concentrates just as hard and is NOT wedged', () => {
    const s = parseSample(LIVE_IDLE);
    expect(s.taken).toBe(true);
    expect(s.share).toBeGreaterThan(WEDGED_FRAME_SHARE);
    expect(s.frame).toBe('kevent');
    expect(s.wedged).toBe(false);
    expect(s.reason).toMatch(/event loop's own poll/);
  });

  it('a synchronous JS loop is wedged with no entry — nothing left the runtime', () => {
    const s = parseSample(LIVE_SPIN);
    expect(s.wedged).toBe(true);
    expect(s.entry).toBeUndefined();
    expect(s.frame).toMatch(/^Builtins_/);
  });

  it('measures the MAIN thread, not whichever thread sorts first', () => {
    // Every thread is sampled on the same clock, so root counts tie across threads. A worker
    // parked in kevent listed first must not turn a wedged main thread into "parked".
    const workerFirst = LIVE_WEDGED.replace(
      /(Call graph:\n)([\s\S]*?)(\n {4}\d+ Thread_\d+: DelayedTaskSchedulerWorker[\s\S]*?)(\n\nTotal number)/,
      (_m, head: string, main: string, worker: string, tail: string) =>
        `${head}${worker.trimStart()}\n${main}${tail}`,
    );
    expect(workerFirst.indexOf('DelayedTaskSchedulerWorker')).toBeLessThan(
      workerFirst.indexOf('main-thread'),
    );
    const s = parseSample(workerFirst);
    expect(s.wedged).toBe(true);
    expect(s.frame).toBe('__semwait_signal');
  });

  it('a wedge whose leaf is sqlite3_step itself still reads wedged and still names it', () => {
    const s = parseSample(LEAF_IN_STEP, 11116);
    expect(s.wedged).toBe(true);
    expect(s.frame).toBe('sqlite3_step');
    expect(s.total).toBe(2407);
    expect(s.entry).toEqual({
      frame: 'Napi::ObjectWrap<Statement>::step',
      image: 'better_sqlite3.node',
    });
  });

  it('work spread below the threshold is not wedged', () => {
    const s = parseSample(BUSY);
    expect(s.taken).toBe(true);
    expect(s.wedged).toBe(false);
    expect(s.frame).toBeUndefined();
    expect(s.reason).toMatch(/no single frame held/);
  });

  it('stops at the trailing sections rather than reading Binary Images as frames', () => {
    // `Binary Images:` lines begin with hex addresses, not counts, but `Total number in stack`
    // repeats real counts — reading it would double-count the root.
    expect(parseSample(LIVE_WEDGED).total).toBe(2636);
  });

  it('an unrecognised report is not taken — never a confident wrong answer', () => {
    expect(parseSample('sample: cannot examine process 11116').taken).toBe(false);
    expect(parseSample('Call graph:\n\nBinary Images:\n').taken).toBe(false);
  });

  it('normalizeFrame strips underscore prefixes and argument lists', () => {
    expect(normalizeFrame('__kevent')).toBe('kevent');
    expect(normalizeFrame('_pthread_cond_wait')).toBe('pthread_cond_wait');
    expect(normalizeFrame('node::Start(int, char**)')).toBe('node::Start');
  });
});

describe('describeSample', () => {
  it('says what it saw, in one line, for the raise body — leaf and entry both', () => {
    expect(describeSample(parseSample(LIVE_WEDGED))).toBe(
      'stack sample: 2635/2636 samples (99.9%) in __semwait_signal, entered via Database::JS_exec (better_sqlite3.node) — alive and blocked in synchronous work',
    );
  });

  it('floors the share so a not-quite-total hold never prints as 100%', () => {
    // 2635/2636 is 99.96%, which ROUNDS to 100.0% — a reader would take that as "nothing else
    // ran", which is a stronger claim than the sample made.
    expect(describeSample(parseSample(LIVE_WEDGED))).not.toMatch(/100\.0%/);
  });

  it('a parked loop says so, with the reason', () => {
    expect(describeSample(parseSample(LIVE_IDLE))).toMatch(
      /in kevent — not wedged \(dominant frame kevent is the event loop's own poll/,
    );
  });

  it('never returns an empty line when no sample could be taken', () => {
    expect(describeSample({ taken: false, reason: 'sample(1) not on PATH', wedged: false })).toBe(
      'stack sample not taken (sample(1) not on PATH)',
    );
  });
});
