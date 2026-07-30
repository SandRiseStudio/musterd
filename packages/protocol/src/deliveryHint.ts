/**
 * The delivery hint (ADR 167 increment 2) — a **daemon-computed, additive** field on the `POST
 * /messages` ack, exactly the ADR 153 `unblocker_reachable` shape: older clients ignore it, older
 * daemons omit it, and its absence is today's behavior in full (warn-never-block; the rail is an
 * opportunity, never an obligation).
 *
 * It rides the ack because the **sender is the actuator**: the harness's session-to-session send
 * exists only inside live attended desktop sessions, so the daemon cannot push and the one party
 * reliably holding the tool at the right moment is the seat that just sent the act. The hint says
 * "your recipient is live on this machine — if you hold the session tools, relay `nudge_text` to
 * their session verbatim."
 *
 * Deliberately NOT here: any session id. Those are contractually machine-local (the
 * `SessionCaptureSchema` never-cross-the-wire rule) — routing is resolved by the *sender* via the
 * harness's own `list_sessions`, where ADR 160's seat labels make the recipient legible by name.
 * `nudge_text` is daemon-composed from structured fields only (ADR 128): sender, act, message id —
 * never the act body. `nudge_fingerprint` is sha256-16 of `nudge_text`, letting any surface verify
 * a relay without recomputing.
 */

/** The directed acts whose seconds-latency matters enough to hint on. Loop-closers (`accept`,
 *  `decline`) and `status_update` are excluded for v1 — their recipient is typically already waiting
 *  on the inbox — revisit with relay-rate data. */
export const DELIVERY_HINT_ACTS = ['handoff', 'ask', 'steer', 'request_help'] as const;
export type DeliveryHintAct = (typeof DELIVERY_HINT_ACTS)[number];

export interface DeliveryHint {
  recipient_live: true;
  rail: 'ccd_session';
  nudge_text: string;
  nudge_fingerprint: string;
}

/**
 * Why no hint was issued (ADR 173 clause 1 — name the abstention after its cause, not its shape).
 *
 * The predicate used to return a bare `null` for all six of these, which made the rail's own decision
 * unreadable from outside: "no hint was warranted" and "the hint code never fires" were the same
 * observation. That indistinguishability let a correct zero sit as a suspected bug for two days
 * (lane `01KYQ9175S`), and the pre-existing test asserted four different causes as one
 * `toBeUndefined()` — the collapse encoded as coverage.
 */
export const NO_HINT_REASONS = [
  /** Team- or broadcast-addressed: the rail nudges one live recipient, so there is nobody to nudge. */
  'not_directed',
  /** Directed, but the act is not in {@link DELIVERY_HINT_ACTS} — a `message`/`status_update` etc. */
  'act_not_eligible',
  /** Sender addressed themselves; a doorbell for your own session is noise. */
  'self_addressed',
  /** `to_member` did not resolve to a member row — a data-integrity oddity, rare and worth seeing. */
  'recipient_unknown',
  /** Resolved, eligible, directed — but the recipient has no fresh presence on the rail. */
  'recipient_not_live',
  /** Damped: another eligible act already reached them inside the suppression window. */
  'suppressed_window',
] as const;
export type NoHintReason = (typeof NO_HINT_REASONS)[number];

/** The predicate's full answer: the hint when one was issued, and always the reason either way. */
export type DeliveryHintDecision =
  | { hint: DeliveryHint; reason: 'issued' }
  | { hint: null; reason: NoHintReason };

/**
 * Reasons where the rail was genuinely **in play** — the act was directed at a real other member and
 * was hint-eligible, so whether a nudge went out is a fact about the rail rather than about ordinary
 * traffic. Only these are worth a durable audit row: all-time they number in the tens (40 eligible
 * acts across the project's entire history), while the excluded reasons cover essentially every
 * message ever sent and would turn the audit log into a message mirror.
 */
export const RAIL_CANDIDATE_REASONS: readonly (NoHintReason | 'issued')[] = [
  'issued',
  'recipient_unknown',
  'recipient_not_live',
  'suppressed_window',
];

/** Was the rail a real candidate for this act? See {@link RAIL_CANDIDATE_REASONS}. */
export function isRailCandidate(reason: NoHintReason | 'issued'): boolean {
  return RAIL_CANDIDATE_REASONS.includes(reason);
}
