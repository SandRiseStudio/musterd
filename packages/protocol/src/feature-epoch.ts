/**
 * The **feature epoch** — a monotonic capability counter, and nothing else.
 *
 * Distinct from {@link PROTOCOL_VERSION}, which is the *breaking wire contract* the handshake enforces
 * (a version mismatch is refused at connect, ADR 135 · `ws.ts`). The feature epoch is the *soft* axis: a
 * seat one epoch behind still connects and works — it simply lacks a capability that landed later (a new
 * act, a new MCP tool, a roster-affecting field). That gap is exactly what the roster surfaces (ADR 147),
 * in place of the old raw build-SHA "stale" chip that fired on every benign drift.
 *
 * Kept in its own pure module (no Node built-ins) for the same reason `version.ts` is: the barrel
 * re-exports it to every consumer, the browser included.
 *
 * ## When to bump
 *
 * Increment by exactly 1 when a change lands that gives the daemon (and freshly-built seats) a capability
 * an older seat cannot participate in or render — a new act, a new MCP tool, a new roster affordance that
 * needs client support. **Do not** bump for bugfixes, internal refactors, or web-only visual tweaks.
 *
 * A *missed* bump only makes the roster's "behind" hint slightly less sensitive — it fails safe, unlike a
 * missed {@link PROTOCOL_VERSION} bump, which would ship a real wire break. Err toward not bumping when
 * unsure; the epoch is a courtesy signal, not a gate.
 */

/** The current feature epoch. Attested by each runtime (like the build stamp) and compared against the
 *  daemon's on the roster: a member behind the daemon's epoch is missing recently-landed features. */
export const FEATURE_EPOCH = 1 as const;
export type FeatureEpoch = typeof FEATURE_EPOCH;
