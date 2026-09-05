/**
 * The stack sample — ADR 389's classification boundary.
 *
 * Four circumstantial conditions (three failed /health probes, a failed confirming probe on a
 * longer bound, persistence across ticks, and launchd reporting a clean exit) are jointly
 * satisfied by BOTH "wedged with the socket still held" and "went away without launchd noticing".
 * Those are different incidents with different owners, and only one observation separates them: a
 * bounded, read-only stack sample of the live pid.
 *
 * Nothing here sends a signal, writes to the target, or blocks longer than the caller's bound. The
 * failure mode is designed to be boring: any sample that cannot be taken, or cannot be read, yields
 * `wedged: false` with a stated reason, and the classifier degrades to exactly today's posture.
 */

/**
 * Share of samples in ONE frame before the process counts as held by it.
 *
 * Not tuned to the margin: big-body's 2026-09-04 incident read 2,406 of 2,407 samples (99.96%) in
 * `sqlite3_step`. 90% leaves room for a wedge that also services a little work without letting a
 * merely-busy process across the line.
 */
export const WEDGED_FRAME_SHARE = 0.9;

/**
 * Frames that mean "parked", not "held".
 *
 * A sample is not self-interpreting. An IDLE process concentrates just as hard as a wedged one —
 * an idle Node event loop sits ~100% in `kevent`/`uv__io_poll` — so a bare share threshold would
 * call a daemon whose HTTP server died, on an otherwise quiet loop, `daemon_wedged` and hand it
 * the destructive tier. That is the one direction this class must never be wrong in, so the
 * dominant frame is checked against the wait primitives by name: a process blocked in a kernel
 * wait is not doing synchronous work, whatever its share.
 *
 * Matched on the leading symbol, `_`/`__` prefixes stripped, so `__kevent` and `kevent` are one
 * entry. Unknown frames are NOT treated as idle — a name nobody has met yet fails toward the
 * evidence being examined by a human, not toward silence.
 */
export const IDLE_FRAMES: ReadonlySet<string> = new Set([
  'kevent',
  'kevent_id',
  'epoll_wait',
  'poll',
  'select',
  'psynch_cvwait',
  'psynch_mutexwait',
  'mach_msg',
  'mach_msg_trap',
  'mach_msg2_trap',
  'semaphore_wait_trap',
  'workq_kernreturn',
  'ulock_wait',
  'ulock_wait2',
  'thread_switch',
  'start_wqthread',
  'pthread_wqthread',
  'pthread_cond_wait',
  'nanosleep',
  'uv__io_poll',
  'read',
  'read_nocancel',
  'accept',
]);

export interface StackSample {
  /** False when no sample could be taken at all — `reason` then says why. */
  taken: boolean;
  /** Why the sample is absent or unusable. Rides the raise so a human is never told nothing. */
  reason?: string;
  pid?: number;
  /** Samples in the busiest thread's root frame — the denominator. */
  total?: number;
  /** Samples in the dominant frame. */
  inFrame?: number;
  /** `inFrame / total`, 0–1. */
  share?: number;
  /** The dominant frame's symbol, as sampled. */
  frame?: string;
  /** True only when a non-idle frame holds ≥ WEDGED_FRAME_SHARE of the busiest thread. */
  wedged: boolean;
}

interface ParsedFrame {
  /** Width of everything before the count — grows monotonically with call-graph depth. */
  indent: number;
  count: number;
  symbol: string;
}

/**
 * `sample` prints tree glyphs (`+`, `!`, `:`, `|`) as well as indentation, and a frame line is
 * `<indent><glyphs><count> <symbol>  (in <image>) + <offset>  [<addr>]`. The count's OFFSET in the
 * line is the depth signal — it grows with nesting whether the glyphs are present or not.
 */
const FRAME_LINE = /^([\s+!:|]*)(\d+)\s+(\S.*)$/;

/** Everything after the symbol: the image, the offset, the address. */
const SYMBOL_TAIL = /\s{2,}\(in\s|\s+\[0x|\s+\+\s+\d+\s*$/;

function symbolOf(rest: string): string {
  const cut = SYMBOL_TAIL.exec(rest);
  return (cut ? rest.slice(0, cut.index) : rest).trim();
}

/** Leading symbol, comparable against IDLE_FRAMES: no leading underscores, no C++ argument list. */
export function normalizeFrame(symbol: string): string {
  return symbol.replace(/^_+/, '').replace(/\(.*$/, '').trim();
}

/**
 * Parse `sample <pid> <seconds>` output into a verdict.
 *
 * Deliberately tolerant: an unrecognised report yields `taken: false` with a reason rather than a
 * throw or a confident wrong answer, because this predicate gates a destructive remediation and
 * "the format changed" must never read as "wedged".
 */
export function parseSample(out: string, pid?: number): StackSample {
  const start = out.indexOf('Call graph:');
  if (start < 0)
    return { taken: false, reason: 'no call graph in the sample output', wedged: false };

  const body = out.slice(start + 'Call graph:'.length);
  const end = body.search(/\n\s*(Total number in stack|Binary Images:)/);
  const lines = (end < 0 ? body : body.slice(0, end)).split('\n');

  const frames: ParsedFrame[] = [];
  for (const line of lines) {
    const m = FRAME_LINE.exec(line);
    if (m === null) continue;
    const symbol = symbolOf(m[3] ?? '');
    if (symbol === '') continue;
    frames.push({ indent: (m[1] ?? '').length, count: Number(m[2]), symbol });
  }
  if (frames.length === 0)
    return { taken: false, reason: 'call graph had no readable frames', wedged: false };

  // The busiest thread's root is the denominator. Sampling is per-thread and the guardian's
  // question is "is ONE thread holding this process", not "what is the whole process doing".
  const root = frames.reduce((a, b) => (b.count > a.count ? b : a));
  if (root.count === 0)
    return { taken: false, reason: 'call graph reported zero samples', wedged: false };

  // Deepest frame that still holds the threshold: the leaf is what the process is actually IN,
  // and every ancestor trivially holds at least as much.
  const held = frames
    .filter((f) => f.indent > root.indent && f.count / root.count >= WEDGED_FRAME_SHARE)
    .sort((a, b) => b.indent - a.indent || b.count - a.count);
  const dominant = held[0];

  if (dominant === undefined) {
    return {
      taken: true,
      ...(pid !== undefined ? { pid } : {}),
      total: root.count,
      wedged: false,
      reason: `no single frame held ${Math.round(WEDGED_FRAME_SHARE * 100)}% of ${root.count} samples`,
    };
  }

  const idle = IDLE_FRAMES.has(normalizeFrame(dominant.symbol));
  return {
    taken: true,
    ...(pid !== undefined ? { pid } : {}),
    total: root.count,
    inFrame: dominant.count,
    share: dominant.count / root.count,
    frame: dominant.symbol,
    wedged: !idle,
    ...(idle
      ? { reason: `dominant frame ${dominant.symbol} is a wait primitive — parked, not held` }
      : {}),
  };
}

/** One line for the raise body and the `guardian.sampled` ledger entry. Never empty. */
export function describeSample(s: StackSample): string {
  if (!s.taken) return `stack sample not taken (${s.reason ?? 'no reason recorded'})`;
  if (s.frame === undefined)
    return `stack sample inconclusive (${s.reason ?? 'no dominant frame'})`;
  // Floored, not rounded: 2,406 of 2,407 rounds to "100.0%", and a share printed as 100% when one
  // sample was elsewhere invites a reader to believe the process was wholly stopped. Floor keeps
  // the printed number a lower bound on what was seen.
  const pct = `${(Math.floor((s.share ?? 0) * 1000) / 10).toFixed(1)}%`;
  const verdict = s.wedged
    ? 'alive and blocked in synchronous work'
    : `not wedged (${s.reason ?? 'dominant frame is a wait'})`;
  return `stack sample: ${s.inFrame}/${s.total} samples (${pct}) in ${s.frame} — ${verdict}`;
}
