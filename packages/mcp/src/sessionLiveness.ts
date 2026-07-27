import { statSync } from 'node:fs';
import type { SessionCapture } from '@musterd/protocol';
import { findBinding } from './binding.js';

/**
 * Session-attested presence (ADR 164). A heartbeat must be attested by the **session** it claims to
 * represent, not merely by the process sending it. An MCP adapter that outlives its harness session
 * keeps heartbeating, and the roster reports a dead seat as `working` — measured live on seat `izzo`
 * for 12h36m, long enough to misroute a `lane_handoff` to someone who could not answer.
 *
 * The judgement runs adapter-side because session truth is machine-local (a binding file and a
 * transcript on the same filesystem) while the daemon is not guaranteed to be on that machine
 * (ADR 039/040). It rides the existing 15s heartbeat tick, which already re-reads the binding off
 * disk for model re-attestation (ADR 158 §7), so it costs one extra `stat`.
 *
 * **Fail open, always.** An unreadable binding, an absent capture, a missing or unstattable
 * transcript all mean *no judgement* — keep heartbeating. A harness that writes no transcript
 * (measured: one live worktree's `transcript_path` did not exist) must never be demoted by
 * staleness. Only definitive evidence removes a seat.
 */

/** A transcript untouched for this long, with no `ended_at`, is the crash/orphan backstop. Far more
 *  generous than the wake path's 10-minute guard: a false positive here costs a live seat its
 *  presence, so the horizon is sized to a long human deliberation. Every observed lie exceeded it by
 *  an order of magnitude (804 min, 1341 min). */
export const SESSION_STALE_MS = 60 * 60_000;

/**
 * How long after process start to wait before adopting a session — see `adopt` below. Long enough
 * for the `SessionStart` hook to have written, in either hook-vs-adapter order.
 */
export const ADOPT_SETTLE_MS = 60_000;

/**
 * What the ladder concluded.
 *  - `live` — no evidence against us (including "cannot tell"). Keep heartbeating.
 *  - `dormant` — this seat has no running session to vouch for it: release presence, keep the tools
 *    registered, and let ADR 108 autojoin re-occupy on the next tool call. **Every rung but one ends
 *    here**, because dormancy is recoverable and an exit is not.
 *  - `exit` — the process that spawned us is provably gone, so there is nothing left to recover for.
 *    Only `ppid` reaches this.
 */
export type SessionVerdict = 'live' | 'dormant' | 'exit';

/** Which signal fired, for the audit detail — the point of the ladder is knowing which rung carries
 *  the weight in the field. (`stdin` is the pre-existing teardown and never surfaces here.) */
export type SessionRung = 'ppid' | 'ended' | 'stale';

export interface SessionJudgement {
  verdict: SessionVerdict;
  rung?: SessionRung;
  /** Age of the transcript at judgement time, when it could be stat'd. */
  age_ms?: number;
  /** The adopted session id, when one has been adopted. */
  session_id?: string;
}

export interface SessionAttestationDeps {
  /** The workspace whose binding carries our session capture. */
  bindingDir: string;
  /** Injected for tests; defaults read the real world. */
  readSession?: (dir: string) => SessionCapture | undefined;
  statMtime?: (path: string) => number | undefined;
  ppid?: () => number;
  /** When this process started — the fence that stops us adopting a predecessor's session. */
  processStart?: number;
  staleMs?: number;
  settleMs?: number;
}

function defaultReadSession(dir: string): SessionCapture | undefined {
  try {
    // A deliberately-empty env: this is a judgement about *this* workspace, and the ambient
    // MUSTERD_BINDING must never redirect it elsewhere (the host-loop idiom).
    return findBinding(dir, {})?.session;
  } catch {
    return undefined;
  }
}

function defaultStatMtime(path: string): number | undefined {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return undefined;
  }
}

/**
 * The ladder, with the one piece of state it needs: which session is ours.
 *
 * ADR 131 kept the adapter out of `binding.session` precisely to avoid a hook-vs-adapter boot race,
 * so bringing it in means handling that race rather than inheriting it. At boot the adapter
 * routinely sees the *previous* session's capture, because `SessionStart` has not written yet. An
 * adapter that pinned that id would watch it be replaced and conclude, exactly backwards, that it
 * was itself the orphan.
 *
 * Adoption is therefore two rules, both learned from a live probe that the first design failed:
 *
 *  - **Settle first.** Adopt nothing for `ADOPT_SETTLE_MS` after *process* start, by which point the
 *    hook has written in either order. Comparing `started_at` against process start instead —
 *    the first attempt — is not a fence but a coin flip: the harness may run the hook before or
 *    after it spawns us, and when it loses, the adapter adopts nothing, forever, in total silence.
 *    An inert safety mechanism that reports nothing is worse than none.
 *  - **Never adopt a corpse.** After settling, adopt the capture on disk only if it still looks
 *    alive — no `ended_at`, transcript not already stale. A dead capture is somebody else's, or a
 *    workspace whose hooks are not installed; either way it is not evidence about us, so we keep
 *    failing open and look again next tick.
 *
 * Before adoption only the `ppid` rung applies: an un-adopted adapter never demotes itself on
 * evidence about somebody else's session.
 */
export class SessionAttestation {
  private adopted: string | null = null;
  private readonly bindingDir: string;
  private readonly readSession: (dir: string) => SessionCapture | undefined;
  private readonly statMtime: (path: string) => number | undefined;
  private readonly ppid: () => number;
  private readonly processStart: number;
  private readonly staleMs: number;
  private readonly settleMs: number;

  constructor(deps: SessionAttestationDeps) {
    this.bindingDir = deps.bindingDir;
    this.readSession = deps.readSession ?? defaultReadSession;
    this.statMtime = deps.statMtime ?? defaultStatMtime;
    this.ppid = deps.ppid ?? (() => process.ppid);
    // The PROCESS's start, not this object's: the ladder is constructed lazily on the first
    // heartbeat tick, minutes into a session, and dating the settle window from there would keep
    // re-arming it on every reconnect.
    this.processStart = deps.processStart ?? Date.now() - Math.round(process.uptime() * 1000);
    this.staleMs = deps.staleMs ?? SESSION_STALE_MS;
    this.settleMs = deps.settleMs ?? ADOPT_SETTLE_MS;
  }

  /** The session id this adapter has claimed as its own, or null before adoption. */
  get adoptedSession(): string | null {
    return this.adopted;
  }

  /** Adoption-time sanity: a capture already ended, or already quiet past the horizon, is a corpse
   *  — somebody else's session, or a workspace whose hooks never ran. Not evidence about us. */
  private looksAlive(session: SessionCapture, now: number): boolean {
    if (session.ended_at !== undefined) return false;
    if (!session.transcript_path) return true; // unknowable, and unknowable is not dead
    const mtime = this.statMtime(session.transcript_path);
    if (mtime === undefined) return true;
    return now - mtime <= this.staleMs;
  }

  check(now = Date.now()): SessionJudgement {
    // Rung 2 — re-parented to init/launchd: whatever spawned us is gone. Independent of the binding,
    // so it applies even before adoption.
    if (this.ppid() === 1) return { verdict: 'exit', rung: 'ppid' };

    const session = this.readSession(this.bindingDir);
    if (!session) return { verdict: 'live' };

    if (this.adopted === null) {
      if (now - this.processStart < this.settleMs) return { verdict: 'live' }; // still settling
      if (!this.looksAlive(session, now)) return { verdict: 'live' }; // never adopt a corpse
      this.adopted = session.id;
    }

    // A different session id now sits in the binding. This is NOT evidence that we are an orphan —
    // measured on `agents-miley`, a foreign 2-second capture (transcript never even written) landed
    // in the binding while that workspace's real session, alive since the previous evening, kept
    // working. Treating that as a takeover would have killed a live session's adapter. The genuine
    // reload-orphan case is already caught server-side by the ADR 092 `same_workspace` frame, which
    // knows what this file cannot. So: re-adopt and carry on serving the workspace.
    if (session.id !== this.adopted) {
      if (!this.looksAlive(session, now)) return { verdict: 'live', session_id: this.adopted };
      this.adopted = session.id;
    }

    // Rung 3 — the advisory SessionEnd hook fired for our own session. Dormant, not exit: the app
    // may be alive and about to open another session, and a dormant adapter comes back on its next
    // tool call while an exited one is gone until the harness restarts.
    if (session.ended_at !== undefined)
      return { verdict: 'dormant', rung: 'ended', session_id: this.adopted };

    // Rung 4 — the crash backstop, the only rung that catches a session that died without a hook.
    if (!session.transcript_path) return { verdict: 'live', session_id: this.adopted };
    const mtime = this.statMtime(session.transcript_path);
    if (mtime === undefined) return { verdict: 'live', session_id: this.adopted };
    const age = now - mtime;
    if (age > this.staleMs)
      return { verdict: 'dormant', rung: 'stale', age_ms: age, session_id: this.adopted };
    return { verdict: 'live', age_ms: age, session_id: this.adopted };
  }
}
