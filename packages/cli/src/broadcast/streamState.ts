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
  /** Supervisor restart stamps (epoch ms), pruned to the flap window. */
  restarts: number[];
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

/** The reconcile rule, pure: actual (liveCount) vs desired, under the flap budget. */
export function decideEnsure(args: {
  state: StreamState | null;
  liveCount: number;
  now: number;
}): EnsureDecision {
  const { state, liveCount, now } = args;
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
  if (liveCount > 0) return { action: 'noop', state: { ...state, restarts }, note: 'live' };
  if (restarts.length >= FLAP_MAX) {
    return {
      action: 'stand_down',
      state: { ...state, restarts, standDownAt: now },
      note: `${restarts.length} restarts in ${FLAP_WINDOW_MS / 60_000}min — standing down and asking`,
    };
  }
  return {
    action: 'restart',
    state: { ...state, restarts: [...restarts, now] },
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
