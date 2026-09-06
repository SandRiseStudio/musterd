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

import { spawnSync } from 'node:child_process';

/**
 * Share of samples in ONE frame before the process counts as held by it.
 *
 * Not tuned to the margin: big-body's 2026-09-04 incident read 2,406 of 2,407 samples (99.96%) in
 * `sqlite3_step`. 90% leaves room for a wedge that also services a little work without letting a
 * merely-busy process across the line.
 */
export const WEDGED_FRAME_SHARE = 0.9;

/**
 * The event loop's OWN wait — the only leaf that means "parked", not "held".
 *
 * A sample is not self-interpreting. An IDLE process concentrates just as hard as a wedged one —
 * an idle Node event loop sits ~100% in `uv__io_poll`/`kevent` — so a bare share threshold would
 * call a daemon whose HTTP server died, on an otherwise quiet loop, `daemon_wedged` and hand it the
 * destructive tier. That is the one direction this class must never be wrong in.
 *
 * But the list is the LOOP's poll, not "every wait primitive". #1328 shipped the wider list
 * (`nanosleep`, `psynch_cvwait`, `read`, `mach_msg`…), and ADR 389's falsifier, run live on
 * 2026-09-05, showed why that is wrong: a process blocked on a held SQLite lock samples 2,635 of
 * 2,636 in `sqlite3_step → … → sqliteDefaultBusyCallback → unixSleep → nanosleep → __semwait_signal`.
 * Its leaf IS a wait primitive. The main thread is asleep inside a synchronous native call, and
 * from `/health`'s point of view that is exactly a wedge — the loop is not polling. The verdict
 * came out right only because `__semwait_signal` happened to be unlisted while its parent
 * `nanosleep` was listed: one more entry in that list, and the incident the ADR was written for
 * would have read "parked". So the question is not "is the leaf a wait" but "is the leaf the
 * loop's wait". Anything else on the main thread — a sleep, a lock, a blocking read, a JS loop —
 * is holding it.
 *
 * Matched on the leading symbol, `_`/`__` prefixes stripped. Unknown frames are NOT parked — a name
 * nobody has met yet fails toward the evidence being examined by a human, not toward silence.
 */
export const LOOP_POLL_FRAMES: ReadonlySet<string> = new Set([
  'uv__io_poll',
  'kevent',
  'kevent_id',
  'epoll_wait',
  'epoll_pwait',
  'poll',
  'select',
]);

/**
 * Images that are the runtime or the OS, not the daemon's own work. The first frame on the
 * dominant chain OUTSIDE these is where control left the runtime — `Database::JS_exec (in
 * better_sqlite3.node)` in the live wedge — and is the sentence a human can act on when the leaf is
 * a bare kernel symbol.
 */
// `<unknown binary>` is V8's JIT code — frames named `???` — the runtime too, not the daemon's work.
const RUNTIME_IMAGE =
  /^(node|libnode|libuv|dyld|libsystem|libc\+\+|libc\b|libobjc|libdispatch|libpthread|CoreFoundation|<unknown binary>)/i;

export interface StackSample {
  /** False when no sample could be taken at all — `reason` then says why. */
  taken: boolean;
  /** Why the sample is absent or unusable. Rides the raise so a human is never told nothing. */
  reason?: string;
  pid?: number;
  /** Samples in the main thread's root frame — the denominator. */
  total?: number;
  /** Samples in the dominant (deepest ≥ threshold) frame. */
  inFrame?: number;
  /** `inFrame / total`, 0–1. */
  share?: number;
  /** The dominant frame's symbol, as sampled — the leaf of the held chain. */
  frame?: string;
  /**
   * Where the dominant chain left the runtime: the shallowest held frame in an image that is
   * neither node/libuv nor the OS, with its image. Absent when the whole chain is runtime — a JS
   * busy loop, say — which `sample(1)` cannot attribute further anyway.
   */
  entry?: { frame: string; image: string };
  /** True only when a non-loop frame holds ≥ WEDGED_FRAME_SHARE of the main thread. */
  wedged: boolean;
}

interface ParsedFrame {
  /** Width of everything before the count — grows monotonically with call-graph depth. */
  indent: number;
  count: number;
  symbol: string;
  image?: string;
}

/**
 * `sample` prints tree glyphs (`+`, `!`, `:`, `|`) as well as indentation, and a frame line is
 * `<indent><glyphs><count> <symbol>  (in <image>) + <offset>  [<addr>]`. The count's OFFSET in the
 * line is the depth signal — it grows with nesting whether the glyphs are present or not.
 */
const FRAME_LINE = /^([\s+!:|]*)(\d+)\s+(\S.*)$/;

/** Everything after the symbol: the image, the offset, the address. */
const SYMBOL_TAIL = /\s{2,}\(in\s|\s+\[0x|\s+\+\s+\d+\s*$/;
const IMAGE = /\(in\s+([^)]+)\)/;

function symbolOf(rest: string): string {
  const cut = SYMBOL_TAIL.exec(rest);
  return (cut ? rest.slice(0, cut.index) : rest).trim();
}

/** Leading symbol, comparable against LOOP_POLL_FRAMES: no leading underscores, no C++ argument list. */
export function normalizeFrame(symbol: string): string {
  return symbol.replace(/^_+/, '').replace(/\(.*$/, '').trim();
}

/**
 * How long past its own sampling window `sample` may take to symbolicate and print before the
 * guardian gives up on it. #1328 allowed 5 s. Measured 2026-09-05: a 2 s sample of a blocked node
 * process returns in 2.1–2.35 s on a quiet machine, and took over 7 s — past that bound — as the
 * first sample inside a parallel vitest run. The tick reaches this call only after ~16 s of failed
 * probes on a machine that is, by hypothesis, in trouble, so the bound is sized for a loaded host:
 * a sample that times out degrades to `daemon_down`, which is safe, but it also throws away the one
 * observation the tick was taken for.
 */
export const SAMPLE_GRACE_MS = 15_000;

/**
 * Run the tool itself: `sample <pid> <seconds> -file /dev/stdout` — read-only, bounded, no signal
 * sent (ADR 389 §1), with a hard timeout beyond the sampler's own bound because evidence that can
 * hang is a second way for the probe to go quiet. `-file /dev/stdout` because without it `sample`
 * ALSO writes a report to `/tmp/<name>_<date>.sample.txt` on every run, and a guardian that
 * samples every tick of a long outage would litter the disk with them.
 *
 * macOS only, and its absence is a first-class answer: elsewhere the spawn fails with ENOENT, the
 * collector records "not taken" with that reason, and the class is simply unreachable.
 */
export function runSampleTool(pid: number, seconds: number): string {
  const r = spawnSync('sample', [String(pid), String(seconds), '-file', '/dev/stdout'], {
    encoding: 'utf8',
    timeout: seconds * 1000 + SAMPLE_GRACE_MS,
  });
  if (r.error) throw r.error;
  if (r.status !== 0)
    throw new Error(`exit ${r.status}: ${(r.stderr || r.stdout || '').slice(0, 200)}`);
  return r.stdout;
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
    const rest = m[3] ?? '';
    const symbol = symbolOf(rest);
    if (symbol === '') continue;
    const image = IMAGE.exec(rest)?.[1]?.trim();
    frames.push({
      indent: (m[1] ?? '').length,
      count: Number(m[2]),
      symbol,
      ...(image !== undefined ? { image } : {}),
    });
  }
  if (frames.length === 0)
    return { taken: false, reason: 'call graph had no readable frames', wedged: false };

  // The MAIN thread is the denominator: the guardian's question is whether the event loop is
  // answering, and only one thread runs it. Every thread is sampled on the same clock, so their
  // root counts tie — "busiest thread" (#1328) picked the first by accident of ordering. `sample`
  // labels the main thread; when it does not, fall back to the first root.
  const rootIndent = Math.min(...frames.map((f) => f.indent));
  const rootIdx = frames.map((f, i) => (f.indent === rootIndent ? i : -1)).filter((i) => i >= 0);
  const mainIdx = rootIdx.find((i) => /main-thread/i.test(frames[i]!.symbol)) ?? rootIdx[0] ?? 0;
  const nextRoot = rootIdx.find((i) => i > mainIdx) ?? frames.length;
  const root = frames[mainIdx]!;
  const thread = frames.slice(mainIdx + 1, nextRoot);
  if (root.count === 0)
    return { taken: false, reason: 'call graph reported zero samples', wedged: false };

  // The held chain: every frame under the root that still holds the threshold. Two siblings cannot
  // both hold ≥ 90%, so these ARE the dominant path, root to leaf, in depth order.
  const held = thread
    .filter((f) => f.count / root.count >= WEDGED_FRAME_SHARE)
    .sort((a, b) => a.indent - b.indent || b.count - a.count);
  const leaf = held[held.length - 1];

  if (leaf === undefined) {
    return {
      taken: true,
      ...(pid !== undefined ? { pid } : {}),
      total: root.count,
      wedged: false,
      reason: `no single frame held ${Math.round(WEDGED_FRAME_SHARE * 100)}% of ${root.count} samples`,
    };
  }

  const entryFrame = held.find((f) => f.image !== undefined && !RUNTIME_IMAGE.test(f.image));
  const parked = LOOP_POLL_FRAMES.has(normalizeFrame(leaf.symbol));
  return {
    taken: true,
    ...(pid !== undefined ? { pid } : {}),
    total: root.count,
    inFrame: leaf.count,
    share: leaf.count / root.count,
    frame: leaf.symbol,
    ...(entryFrame !== undefined
      ? { entry: { frame: normalizeFrame(entryFrame.symbol), image: entryFrame.image! } }
      : {}),
    wedged: !parked,
    ...(parked
      ? { reason: `dominant frame ${leaf.symbol} is the event loop's own poll — parked, not held` }
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
  const via = s.entry !== undefined ? `, entered via ${s.entry.frame} (${s.entry.image})` : '';
  const verdict = s.wedged
    ? 'alive and blocked in synchronous work'
    : `not wedged (${s.reason ?? "dominant frame is the loop's poll"})`;
  return `stack sample: ${s.inFrame}/${s.total} samples (${pct}) in ${s.frame}${via} — ${verdict}`;
}
