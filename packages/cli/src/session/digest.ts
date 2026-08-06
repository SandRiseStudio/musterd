import { createHmac } from 'node:crypto';

/**
 * The session correlation digest (ADR 131 §5, amended 2026-08-05).
 *
 * §5's rule is that the daemon learns harness CLASS and nothing else about a session — never the
 * id, never the transcript path. That rule cost us a real investigation: `residency.session_captured`
 * / `.session_ended` name a seat but not a session, so a captured row followed by an ended row nine
 * seconds later cannot be told apart from two short-lived sessions of the same seat — and which one
 * it is decides the fix entirely.
 *
 * The digest closes that without reopening the rule. It is a KEYED HMAC of the session id under the
 * workspace's own agent key, truncated: identical for one session's start and end, different for two
 * sessions, and one-way. Keyed rather than a bare `sha256(id)` on purpose — today's ids are
 * high-entropy UUIDs and a plain hash would be safe, but the guarantee then rests on every future
 * harness choosing a large id space rather than on the construction. The daemon holds only the key's
 * hash, so it cannot recompute a digest and cannot confirm a guessed id.
 *
 * Correlation is scoped to the team (one agent key) and resets on key rotation — acceptable, because
 * this answers questions about session lifecycles over seconds and minutes, not months.
 */
export const SESSION_DIGEST_LEN = 12;

/** Digest `sessionId` for the wire. `key` is the workspace binding's agent key. */
export function sessionDigest(key: string, sessionId: string): string {
  return createHmac('sha256', key).update(sessionId).digest('hex').slice(0, SESSION_DIGEST_LEN);
}
