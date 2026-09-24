import type { SessionCapture } from '@musterd/protocol';
import { findBinding, saveBinding } from '../config.js';

/**
 * ADR 436 clause 4 — liveness: a wake that settled is over. When a wake's child exits, the host
 * stamps `ended_at` on the binding's captured session, so the enumerated-liveness override
 * (`localSessionLiveness`, ADR 199 / ADR 179) reads the finished wake as ended instead of live for
 * `LOCAL_SESSION_LIVE_MS`. Until this existed nothing marked a finished Grok wake ended — Grok has
 * no SessionEnd hook — and grokbot's handoff wake was deferred `local-session-live` twice on
 * 2026-09-21 with no grok process running.
 *
 * It stamps ONLY the capture this wake made or resumed (`ids`). A session that took the slot while
 * the wake ran — a human opening the workspace mid-wake — is someone else's and is never touched:
 * stamping it would read a live attended session as ended and let the next wake in beside it
 * (the ADR 166 guardrail, and ADR 444's). Already-ended captures are left as they are, so a
 * SessionEnd hook that got there first keeps its own timestamp.
 *
 * `id` replaces the captured id as it stamps — for a harness whose fresh capture is a placeholder
 * (Grok records `wake-<lease>` at spawn), so the ended capture names the session enumeration sees.
 *
 * Idempotent and best-effort: returns whether it stamped, never throws.
 */
export function endWakeCapture(
  workspace: string,
  opts: {
    harness: SessionCapture['harness'];
    ids: readonly (string | undefined)[];
    id?: string | undefined;
    endedAt?: number | undefined;
  },
): boolean {
  try {
    const binding = findBinding(workspace, {});
    const session = binding?.session;
    if (!binding || !session) return false;
    if (session.harness !== opts.harness || session.ended_at !== undefined) return false;
    if (!opts.ids.includes(session.id)) return false;
    saveBinding(workspace, {
      ...binding,
      session: {
        ...session,
        ...(opts.id ? { id: opts.id } : {}),
        ended_at: opts.endedAt ?? Date.now(),
      },
    });
    return true;
  } catch {
    return false;
  }
}
