import { describe, expect, it } from 'vitest';
import { describeSample, normalizeFrame, parseSample, WEDGED_FRAME_SHARE } from './sample.js';

/**
 * Shaped after big-body's 2026-09-04 incident (2,406 of 2,407 samples in `sqlite3_step`), in the
 * `sample(1)` report layout: a header, a `Call graph:` section whose frames carry tree glyphs and
 * increasing indentation, then the trailing sections the parser must stop at.
 *
 * Synthetic, and named as such: `sample(1)` could not be executed in the session that wrote this
 * (the binary is behind a permission gate on this machine), so this fixture asserts the parser
 * against the documented layout rather than against a captured report. ADR 389's induced-wedge
 * falsifier is what proves the parser against a live one, and it must run before arming.
 */
const WEDGED = `Sampling process 11116 for 3 seconds with 1 millisecond of run time between samples
Sampling completed, processing symbols...
Analysis of sampling node (pid 11116) every 1 millisecond
Process:         node [11116]
Path:            /opt/homebrew/opt/node@22/bin/node

Call graph:
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

/** The same four circumstantial conditions, but the process is parked in the event loop. */
const IDLE = `Analysis of sampling node (pid 11116) every 1 millisecond

Call graph:
    2400 Thread_9410215   DispatchQueue_1: com.apple.main-thread  (serial)
      2400 node::Start(int, char**)  (in node) + 728  [0x1013a55f8]
        2400 uv_run  (in node) + 412  [0x1017c2210]
          2399 uv__io_poll  (in node) + 1204  [0x1017d4a10]
            2399 kevent  (in libsystem_kernel.dylib) + 8  [0x18f2e1b30]

Binary Images:
`;

/** Work spread across many frames — busy, not held by any one of them. */
const BUSY = `Call graph:
    1000 Thread_1   DispatchQueue_1: com.apple.main-thread  (serial)
      600 v8::internal::Runtime_CompileLazy  (in node) + 12  [0x1013a0000]
      400 sqlite3_step  (in better_sqlite3.node) + 44  [0x10b3901c4]

Binary Images:
`;

describe('parseSample (ADR 389 §1 — the classification boundary)', () => {
  it('names the dominant synchronous frame and calls it wedged', () => {
    const s = parseSample(WEDGED, 11116);
    expect(s.taken).toBe(true);
    expect(s.wedged).toBe(true);
    expect(s.frame).toBe('sqlite3_step');
    expect(s.pid).toBe(11116);
    expect(s.total).toBe(2407);
    expect(s.inFrame).toBe(2406);
    expect(s.share).toBeGreaterThan(0.99);
  });

  it('takes the DEEPEST frame over the threshold, not the first ancestor over it', () => {
    // Every ancestor of a held leaf trivially holds at least as much; reporting `node::Start`
    // would be true and useless — the leaf is the sentence a human can act on.
    expect(parseSample(WEDGED).frame).toBe('sqlite3_step');
  });

  it('an idle event loop concentrates just as hard and is NOT wedged', () => {
    const s = parseSample(IDLE);
    expect(s.taken).toBe(true);
    expect(s.share).toBeGreaterThan(WEDGED_FRAME_SHARE);
    expect(s.wedged).toBe(false);
    expect(s.reason).toMatch(/wait primitive/);
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
    expect(parseSample(WEDGED).total).toBe(2407);
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
  it('says what it saw, in one line, for the raise body', () => {
    expect(describeSample(parseSample(WEDGED))).toMatch(
      /2406\/2407 samples \(99\.9%\) in sqlite3_step — alive and blocked/,
    );
  });

  it('floors the share so a not-quite-total hold never prints as 100%', () => {
    // 2406/2407 is 99.958%, which ROUNDS to 100.0% — a reader would take that as "nothing else
    // ran", which is a stronger claim than the sample made.
    expect(describeSample(parseSample(WEDGED))).not.toMatch(/100\.0%/);
  });

  it('never returns an empty line when no sample could be taken', () => {
    expect(describeSample({ taken: false, reason: 'sample(1) not on PATH', wedged: false })).toBe(
      'stack sample not taken (sample(1) not on PATH)',
    );
  });
});
