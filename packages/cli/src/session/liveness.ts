import { statSync } from 'node:fs';
import type { SessionCapture } from '@musterd/protocol';
import { findBinding } from '../config.js';
import { enumerateClaudeSessions } from './enumerate.js';

/**
 * Local session liveness (ADR 131 §5, increment 4) — the machine-local judgement over a workspace's
 * `binding.session` that both the host's local-session guard and `musterd session show` share.
 * Everything here is read-only and best-effort: an unreadable binding, a missing capture, or an
 * unstattable transcript all degrade to `none` — fresh-first is inviolable, so a broken capture can
 * never block a wake, only fail to upgrade it.
 *
 * SessionEnd is advisory (it never fires on a crash), so `ended_at` alone cannot mean "not live" in
 * the other direction — the transcript's mtime is the liveness signal that survives a crash: the
 * harness appends to it on every message/tool event, so a live session touches it constantly.
 */

/** A transcript untouched for this long means no live local session (the guard threshold): long
 *  enough to protect a human who is thinking, well under the 30-minute batched-wake cooldown. */
export const LOCAL_SESSION_LIVE_MS = 10 * 60_000;

/** Claude Code GCs sessions after 30 days (`cleanupPeriodDays` default) — a capture older than
 *  this cannot resume; skip straight to fresh (design doc §3, claude-code row). */
export const RESUME_GC_HORIZON_MS = 30 * 24 * 3_600_000;

export type LocalSessionState =
  /** No binding, no capture, or nothing readable — the pre-increment-4 world. */
  | 'none'
  /** A local session is (very probably) running right now: no `ended_at`, transcript freshly touched. */
  | 'live'
  /** A captured session exists and is neither live nor past the GC horizon — resume material. */
  | 'resumable'
  /** Captured, but older than the harness GC horizon — resume would fail; go fresh. */
  | 'gc-expired';

export interface LocalSessionLiveness {
  state: LocalSessionState;
  session?: SessionCapture;
  transcriptBytes?: number;
  transcriptMtime?: number;
  /** ADR 166 increment 1 — the challenger judgement, computed but NEVER acted on. Absent when the
   *  harness cannot enumerate (then there is nothing to compare and nothing to learn). */
  shadow?: ShadowJudgement;
}

/**
 * What enumeration would have said (ADR 166 increment 1). This is deliberately inert: the slot's
 * verdict is still what every caller acts on. Increment 1 exists to measure how often the two
 * disagree, and in which direction, on real wake decisions — because ADR 164 twice shipped a
 * judgement that looked correct, passed its tests, and was wrong about a live session.
 */
export interface ShadowJudgement {
  state: LocalSessionState;
  /** The session enumeration would have named — the newest transcript, not whatever wrote the slot. */
  id?: string;
  mtime?: number;
  bytes?: number;
  /** How many sessions the harness actually has here. The slot can only ever describe one. */
  count: number;
  /** True when the challenger and the incumbent reach different verdicts. */
  disagreed: boolean;
  /** Set when the disagreement is the money-losing one: the slot says no live session, enumeration
   *  says there is. This is the exact shape measured on agents-miley and agents-stanley. */
  dangerous?: boolean;
}

/**
 * Judge the same workspace by asking the harness what sessions it has (ADR 166). Returns undefined
 * when the harness cannot enumerate — "cannot tell", which must never be laundered into "none".
 */
function enumeratedLiveness(
  workspace: string,
  now: number,
  enumerate: typeof enumerateClaudeSessions,
): Omit<ShadowJudgement, 'disagreed'> | undefined {
  const files = enumerate(workspace);
  if (files === undefined) return undefined;
  const newest = files[0];
  if (!newest) return { state: 'none', count: 0 };
  const base = { id: newest.id, mtime: newest.mtime, bytes: newest.bytes, count: files.length };
  // Liveness is ANY session still being written, not merely the newest — a workspace with a live
  // session and a newer dead one is exactly the case the slot gets wrong.
  if (files.some((f) => now - f.mtime < LOCAL_SESSION_LIVE_MS)) return { state: 'live', ...base };
  if (now - newest.mtime > RESUME_GC_HORIZON_MS) return { state: 'gc-expired', ...base };
  return { state: 'resumable', ...base };
}

/**
 * Judge the workspace's captured session. Reads the binding with a deliberately-empty env (the
 * host-loop idiom): the caller names an explicit workspace, and the *caller's* `MUSTERD_BINDING`
 * must never redirect a judgement about someone else's worktree.
 */
export function localSessionLiveness(
  workspace: string,
  now = Date.now(),
  enumerate: typeof enumerateClaudeSessions = enumerateClaudeSessions,
): LocalSessionLiveness {
  const incumbent = slotLiveness(workspace, now);
  const challenger = enumeratedLiveness(workspace, now, enumerate);
  if (!challenger) return incumbent;
  const disagreed = challenger.state !== incumbent.state;
  return {
    ...incumbent,
    shadow: {
      ...challenger,
      disagreed,
      // The dangerous direction: the incumbent would permit a spawn beside a session that is alive.
      ...(disagreed && challenger.state === 'live' ? { dangerous: true } : {}),
    },
  };
}

/** The pre-ADR-166 judgement, unchanged — still the verdict every caller acts on. */
function slotLiveness(workspace: string, now: number): LocalSessionLiveness {
  const binding = findBinding(workspace, {});
  const session = binding?.session;
  if (!session) return { state: 'none' };

  let transcriptBytes: number | undefined;
  let transcriptMtime: number | undefined;
  if (session.transcript_path) {
    try {
      const st = statSync(session.transcript_path);
      transcriptBytes = st.size;
      transcriptMtime = st.mtimeMs;
    } catch {
      // transcript gone (GC, manual cleanup) — not live, and the backend will skip resume
    }
  }

  const base = {
    session,
    ...(transcriptBytes !== undefined ? { transcriptBytes } : {}),
    ...(transcriptMtime !== undefined ? { transcriptMtime } : {}),
  };

  if (
    session.ended_at === undefined &&
    transcriptMtime !== undefined &&
    now - transcriptMtime < LOCAL_SESSION_LIVE_MS
  ) {
    return { state: 'live', ...base };
  }
  if (now - session.started_at > RESUME_GC_HORIZON_MS) {
    return { state: 'gc-expired', ...base };
  }
  return { state: 'resumable', ...base };
}
