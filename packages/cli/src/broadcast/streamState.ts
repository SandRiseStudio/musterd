/**
 * The stream's desired state — the one fact a crash and a deliberate stop used to share.
 *
 * `--rm --restart no` means machine lifetime = stream lifetime, so after the fact a Chrome death
 * (2026-08-18, "Chrome DevTools socket closed") and `musterd stream stop` both look like "no
 * machine". This file records INTENT, written only by the stream verbs: `start` says live, `stop`
 * says stopped and by whom. A machine gone while this says live is therefore a crash by
 * definition — and anything that kills the machine around the verbs (raw `fly machine stop`, a
 * watchdog, an OOM) gets healed by the supervisor, which makes `stream stop` the one off-switch
 * that sticks and leaves a name on it.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export interface StreamState {
  desired: 'live' | 'stopped';
  /** Who last set `desired` — the CLI's resolved seat, so "nick asked miley to stop it" is never
   * confusable with a crash. */
  by?: string;
  /** When `desired` was last set (epoch ms). */
  at: number;
  /** Free-text provenance on a stop (`--reason`), surfaced by `stream status`. */
  reason?: string;
  team?: string;
  /** The image digest the last launch ran — what lets `ensure` tell a deploy from a crash. */
  image?: string;
  /** Supervisor restart stamps (epoch ms), pruned to the flap window. */
  restarts: number[];
  /**
   * The relaunches that never produced a machine, pruned alongside `restarts` — what `fly` exited
   * with and what it said. Parallel to the ledger rather than folded into it, because the ledger's
   * job (spend a budget, converge on asking a human) is correct and must not change shape.
   *
   * It exists because the supervisor used to throw this away: `LaunchResult` already carried
   * `output`, `ensure` destructured `{ code }`, and the stand-down ask then told a human "the
   * broadcast crashed" — the one thing it had not observed. Absent on state written before this
   * field existed, which `standDownReport` degrades for honestly rather than guessing.
   */
  failures?: { at: number; code: number; error: string }[];
  /** Set when the flap guard tripped; only a human start/stop clears it — one ask, not one per tick. */
  standDownAt?: number;
}

/** The flap budget: this many supervisor restarts inside the window, then stand down and ask.
 * Each restart is a performance-4x Fly machine — an unguarded loop burns real money (nick,
 * 2026-08-19: 3/30min, then a human decides about the 4th try). */
export const FLAP_MAX = 3;
export const FLAP_WINDOW_MS = 30 * 60_000;

export interface EnsureDecision {
  action: 'noop' | 'restart' | 'stand_down';
  /** The state as it should be persisted after this decision (ledger stamped / stand-down set). */
  state: StreamState;
  /** One human-readable line for the supervisor log. */
  note: string;
}

/** The reconcile rule, pure: actual (liveCount) vs desired, under the flap budget.
 * `recordedDigest` is what a relaunch would run right now (the machine's capture-image record, or
 * a legacy checkout's `.image-digest` when there is none); a machine gone while
 * it differs from the digest the dead machine ran is a deploy, not a crash (2026-08-21: two
 * image-push replacements burned 2/3 flap slots and were one event from standing down a healthy
 * stream). A deploy relaunches without spending the budget — once, since the relaunch records the
 * new digest and the next disagreement is real again.
 *
 * `recordedDigestAt` is when that file was last written, and it is what tells a deploy from a
 * DIFFERENT CHECKOUT (2026-09-17). `.image-digest` is gitignored and per-checkout: streamwatch's
 * LaunchAgent runs from the main checkout while a stream is routinely started from a worktree, so
 * "the digest differs" stopped being evidence of a rebuild the day the second checkout appeared.
 * Measured that day — main held a 14-day-old digest, the live machine ran a 1-day-old one — every
 * crash would have relaunched 14-day-old capture code, uncharged to the flap budget, logging
 * "deploy" about a deploy that never happened. A digest written BEFORE the run started cannot be
 * this run's replacement, so it is not a deploy. Absent (legacy callers, unit tests) the old
 * reading stands: only positive evidence of age demotes a deploy, never the lack of it. */
export function decideEnsure(args: {
  state: StreamState | null;
  liveCount: number;
  now: number;
  recordedDigest?: string | null;
  recordedDigestAt?: number | null;
  recordedDigestAuthoritative?: boolean;
}): EnsureDecision {
  const { state, liveCount, now, recordedDigest, recordedDigestAt, recordedDigestAuthoritative } =
    args;
  if (!state)
    return {
      action: 'noop',
      state: { desired: 'stopped', at: now, restarts: [] },
      note: 'no stream state — nothing to enforce',
    };
  if (state.desired === 'stopped') {
    return { action: 'noop', state, note: `desired stopped (by ${state.by ?? 'unknown'})` };
  }
  if (state.standDownAt !== undefined) {
    return { action: 'noop', state, note: 'stood down — awaiting a human `stream start`/`stop`' };
  }
  const restarts = state.restarts.filter((t) => now - t < FLAP_WINDOW_MS);
  // Pruned with the ledger, not separately: a cause outliving the attempt it explains is how a
  // stale error ends up quoted in a report about a newer failure.
  const failures = (state.failures ?? []).filter((f) => now - f.at < FLAP_WINDOW_MS);
  if (liveCount > 0)
    return { action: 'noop', state: { ...state, restarts, failures }, note: 'live' };
  // A missing `image` (legacy state) is never a free pass — only an observed change is a deploy.
  //
  // When the record is AUTHORITATIVE (one per machine, beside this file) a difference is the whole
  // answer: `start` launched whatever the record said and stamped it, so a record that now differs
  // means somebody rebuilt since — in whichever checkout, in whichever direction the timestamps
  // fall. The age proxy is not consulted, and that is the point: it was standing in for a question
  // the old layout could not ask, and it answered it right in one direction only (sloane's
  // residual on #1538 — a main-checkout rebuild adopted for a worktree-started stream).
  //
  // The legacy per-checkout file keeps #1538's gate, because it really can be another checkout's
  // and really does carry no other evidence of whose.
  const digestPredatesRun =
    !recordedDigestAuthoritative &&
    recordedDigestAt !== undefined &&
    recordedDigestAt !== null &&
    recordedDigestAt <= state.at;
  if (recordedDigest && state.image && state.image !== recordedDigest && !digestPredatesRun) {
    return {
      action: 'restart',
      state: { ...state, restarts, failures, image: recordedDigest },
      note: `deploy detected: machine gone and the recorded image changed (${state.image.slice(7, 15)} → ${recordedDigest.slice(7, 15)}) — replacing, not charged to the flap window`,
    };
  }
  if (restarts.length >= FLAP_MAX) {
    return {
      action: 'stand_down',
      state: { ...state, restarts, failures, standDownAt: now },
      note: `standing down and asking — ${standDownReport({ ...state, restarts, failures }, now)}`,
    };
  }
  // What a crash relaunches is what the stream RECORDED, not whatever the supervisor's checkout
  // holds — the deploy branch above is the only path that adopts a new digest, and it has now
  // proven the digest postdates the run. `recordedDigest` remains the fallback for a state written
  // before `image` existed, which is the case the 2026-08-21 stamp was added for.
  const relaunchImage = state.image ?? recordedDigest;
  return {
    action: 'restart',
    state: {
      ...state,
      restarts: [...restarts, now],
      failures,
      ...(relaunchImage ? { image: relaunchImage } : {}),
    },
    note: `crash detected: machine gone, no stop record — restarting (${restarts.length + 1}/${FLAP_MAX} in window)`,
  };
}

export function readStreamState(path: string): StreamState | null {
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as StreamState;
    if (raw.desired !== 'live' && raw.desired !== 'stopped') return null;
    return { ...raw, restarts: Array.isArray(raw.restarts) ? raw.restarts : [] };
  } catch {
    return null; // missing or unparseable — fail safe: no state, no enforcement
  }
}

/** Atomic write (tmp + rename): the supervisor and the verbs race by design. */
export function writeStreamState(path: string, state: StreamState): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n', 'utf8');
  renameSync(tmp, path);
}

/**
 * The one sentence a human gets when the supervisor gives up — and the supervisor's own log line,
 * so the two can never say different things. It used to be two strings: the log said "3 restarts in
 * 30min", the ask said "the broadcast crashed 3× in 30min", and only one of them was ever true.
 *
 * It reports what was OBSERVED and nothing else. The supervisor cannot see why a machine is gone —
 * `decideEnsure` branches on a machine count — but it can see perfectly well whether its own
 * relaunch got one off the ground, and that distinction is the whole difference between "the stream
 * is unstable" and "this laptop cannot reach fly.io". Measured 2026-09-15: every one of the 15
 * relaunch failures on nick's laptop was the second kind, and both stand-downs reported the first.
 */
export function standDownReport(state: StreamState, now: number): string {
  const restarts = state.restarts.filter((t) => now - t < FLAP_WINDOW_MS);
  const failures = (state.failures ?? []).filter((f) => now - f.at < FLAP_WINDOW_MS);
  const mins = FLAP_WINDOW_MS / 60_000;
  const n = restarts.length;
  // `fly` errors run to several lines and an ask is read in a notification: take the line that
  // names the fault, not the GraphQL query body it is wrapped in.
  const last = failures.at(-1);
  const cause = last ? ` — last error (fly exit ${last.code}): ${oneLine(last.error)}` : '';

  if (failures.length === 0) {
    // No launch ever failed, so machines really were coming up and going away. This is the only
    // case the old wording fitted, and even here "stopped" is what was seen — "crashed" is a guess
    // about a machine whose exit this process never looked at.
    return state.failures === undefined
      ? `the broadcast stopped ${n}× in ${mins}min and the supervisor stood down (this state predates launch-failure recording, so there is no cause to report)`
      : `the broadcast stopped ${n}× in ${mins}min and the supervisor stood down`;
  }
  if (failures.length >= n) {
    // Every attempt failed to launch: the stream is not the subject at all. Naming `doctor` here
    // because it is the verb that checks exactly this family of precondition.
    return `${failures.length} launch attempts failed in ${mins}min and the supervisor stood down — no machine ever came up, so this is the environment, not the stream${cause}. \`musterd stream doctor\` checks each precondition`;
  }
  return `the broadcast stopped ${n}× in ${mins}min and the supervisor stood down — ${failures.length} of them never got a machine up${cause}`;
}

/**
 * Collapse to a single line and cap it: an ask is read in a notification, not a terminal.
 *
 * Prefers the line that declares the fault over the last line printed. flyctl emits a metrics
 * warning next to the real error and — on a DNS outage — that warning is itself about DNS, so
 * "whatever came last" reads plausibly while naming the wrong subsystem. That is the same mistake
 * one layer up that this whole function exists to stop making.
 */
function oneLine(text: string, cap = 180): string {
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const raw = lines.filter((l) => /^error\b/i.test(l)).at(-1) ?? lines.at(-1) ?? text.trim();
  // Collapse embedded payloads. flyctl quotes the entire GraphQL query it was running — ~300
  // characters of braces — in front of the six words that say what went wrong. Squeezing braced
  // blocks keeps the sentence and drops the document, without knowing anything about GraphQL.
  let line = raw;
  for (let i = 0; i < 8; i++) {
    // The placeholder must contain NO braces of its own, or it blocks the next round: a `{…}`
    // standing in for an inner block makes its parent unmatchable by this same pattern, and the
    // squeeze stalls one level in. (It did exactly that on the first attempt.)
    const squeezed = line.replace(/\{[^{}]*\}/g, '…');
    if (squeezed === line) break;
    line = squeezed;
  }
  line = line.replace(/…[\s,…]*…/g, '…').replace(/\s+…/g, ' …');
  // Keep the TAIL, not the head. Error causes nest rightward — "failed to run query <300 chars of
  // GraphQL>: Post https://…: dial tcp: lookup api.fly.io: no such host" — so trimming from the end
  // throws away the only part an operator can act on and keeps the boilerplate. Measured on the real
  // fly output from 2026-09-04: a head-trim at 180 chars cut off `no such host` and kept the query body.
  return line.length > cap ? `…${line.slice(line.length - (cap - 1))}` : line;
}
