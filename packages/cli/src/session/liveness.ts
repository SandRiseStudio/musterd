import { statSync } from 'node:fs';
import type { SessionCapture } from '@musterd/protocol';
import { findBinding } from '../config.js';

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
}

/**
 * Judge the workspace's captured session. Reads the binding with a deliberately-empty env (the
 * host-loop idiom): the caller names an explicit workspace, and the *caller's* `MUSTERD_BINDING`
 * must never redirect a judgement about someone else's worktree.
 */
export function localSessionLiveness(workspace: string, now = Date.now()): LocalSessionLiveness {
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
