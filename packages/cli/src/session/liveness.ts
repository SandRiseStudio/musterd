import { statSync } from 'node:fs';
import type { SessionCapture } from '@musterd/protocol';
import { findBinding } from '../config.js';
import { enumerateClaudeSessions } from './enumerate.js';

/**
 * Local session liveness (ADR 131 §5 inc 4; ADR 166) — the machine-local judgement over a
 * workspace's sessions that both the host's local-session guard and `musterd session show` share.
 * Everything here is read-only and best-effort.
 *
 * ADR 166 increment 2 — THE FLIP. When the harness can enumerate its own per-session transcripts,
 * the enumerated judgement decides (`source: 'enumerated'`); `binding.session` is demoted to resume
 * material and a recorded counter-verdict. When the harness cannot enumerate, the slot judgement
 * still decides, unchanged (`source: 'slot'`) — the slot is a fallback, not deleted (ADR 166 §
 * "weaker than ADR 165").
 *
 * SessionEnd is advisory (it never fires on a crash), so `ended_at` alone cannot mean "not live" in
 * the other direction — a transcript's mtime is the liveness signal that survives a crash: the
 * harness appends to it on every message/tool event, so a live session touches it constantly.
 */

/** A transcript untouched for this long means no live local session (the guard threshold): long
 *  enough to protect a human who is thinking, well under the 30-minute batched-wake cooldown. */
export const LOCAL_SESSION_LIVE_MS = 10 * 60_000;

/** Claude Code GCs sessions after 30 days (`cleanupPeriodDays` default) — a capture older than
 *  this cannot resume; skip straight to fresh (design doc §3, claude-code row). */
export const RESUME_GC_HORIZON_MS = 30 * 24 * 3_600_000;

export type LocalSessionState =
  /** No sessions found (enumerated), or no binding/capture/nothing readable (slot). */
  | 'none'
  /** A local session is (very probably) running right now: a transcript is being written. */
  | 'live'
  /** Session material exists, neither live nor past the GC horizon — resume material. */
  | 'resumable'
  /** Older than the harness GC horizon — resume would fail; go fresh. */
  | 'gc-expired';

/** What enumeration found: the harness's own per-session transcripts, judged by mtime. */
export interface EnumeratedJudgement {
  state: LocalSessionState;
  /** The newest transcript's session id — not whatever wrote the slot. */
  id?: string;
  mtime?: number;
  bytes?: number;
  /** How many sessions the harness actually has here. The slot can only ever describe one. */
  count: number;
}

export interface LocalSessionLiveness {
  /** The acted-on verdict. Enumerated when the harness can enumerate, the slot's otherwise. */
  state: LocalSessionState;
  /** Which judgement produced `state` (ADR 166 increment 2). */
  source: 'enumerated' | 'slot';
  /** The slot's captured session — resume material for the ladder, never the liveness verdict
   *  when `source` is `enumerated`. */
  session?: SessionCapture;
  transcriptBytes?: number;
  transcriptMtime?: number;
  /** Present when the harness could enumerate (then it is also what `state` came from). */
  enumerated?: EnumeratedJudgement;
  /** What the slot would have said — the demoted incumbent, recorded so disagreement stays
   *  observable after the flip. Present only when `source` is `enumerated`. */
  slotState?: LocalSessionState;
  /** True when the two judgements reach different verdicts. */
  disagreed?: boolean;
  /** The flip-blocking error direction (ADR 166 eval item 3): the slot says live but enumeration
   *  does not — enumeration may be demoting a live seat. Watched, target zero. */
  demoted?: boolean;
}

/**
 * Judge the workspace by asking the harness what sessions it has (ADR 166). Returns undefined when
 * the harness cannot enumerate — "cannot tell", which must never be laundered into "none".
 */
function enumeratedLiveness(
  workspace: string,
  now: number,
  enumerate: (workspace: string) => ReturnType<typeof enumerateClaudeSessions>,
): EnumeratedJudgement | undefined {
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
 * Judge the workspace. Reads the binding with a deliberately-empty env (the host-loop idiom): the
 * caller names an explicit workspace, and the *caller's* `MUSTERD_BINDING` must never redirect a
 * judgement about someone else's worktree.
 */
export function localSessionLiveness(
  workspace: string,
  now = Date.now(),
  enumerate: (workspace: string) => ReturnType<typeof enumerateClaudeSessions> = (w) =>
    enumerateClaudeSessions(w),
): LocalSessionLiveness {
  const slot = slotLiveness(workspace, now);
  const enumerated = enumeratedLiveness(workspace, now, enumerate);
  if (!enumerated) return { source: 'slot', ...slot };
  // ADR 199 / ADR 179: clean SessionEnd outranks a still-warm transcript on the deciding
  // (enumerated) path — but only when the "live" evidence is that same ended session. A
  // different concurrent session beside an ended capture stays live (ADR 166 guardrail).
  let state = enumerated.state;
  if (
    state === 'live' &&
    slot.session?.ended_at !== undefined &&
    enumerated.id === slot.session.id
  ) {
    state = slot.state;
  }
  const disagreed = state !== slot.state;
  return {
    state,
    source: 'enumerated',
    // Resume material rides along regardless of verdict — the ladder judges it separately.
    ...(slot.session ? { session: slot.session } : {}),
    ...(slot.transcriptBytes !== undefined ? { transcriptBytes: slot.transcriptBytes } : {}),
    ...(slot.transcriptMtime !== undefined ? { transcriptMtime: slot.transcriptMtime } : {}),
    enumerated,
    slotState: slot.state,
    disagreed,
    ...(disagreed && slot.state === 'live' ? { demoted: true } : {}),
  };
}

/** The pre-ADR-166 judgement — the fallback verdict for harnesses that cannot enumerate. */
function slotLiveness(
  workspace: string,
  now: number,
): Pick<LocalSessionLiveness, 'state' | 'session' | 'transcriptBytes' | 'transcriptMtime'> {
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
