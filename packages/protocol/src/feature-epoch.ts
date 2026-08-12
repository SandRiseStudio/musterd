/**
 * The **feature epoch** — a monotonic capability counter, and nothing else.
 *
 * Distinct from {@link PROTOCOL_VERSION}, which is the *breaking wire contract* the handshake enforces
 * (a version mismatch is refused at connect, ADR 135 · `ws.ts`). The feature epoch is the *soft* axis: a
 * seat one epoch behind still connects and works — it simply lacks a capability that landed later (a new
 * act, a new MCP tool, a roster-affecting field). That gap is exactly what the roster surfaces (ADR 148),
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
// Epoch 2 — ADR 153: the `stranded` ask outcome + the daemon-derived `unblocker_reachable` contract
// field. A seat behind this epoch still holds correctly (fails safe toward the old contract) but cannot
// strand or render the reachability-gated orders.
// Epoch 3 — ADR 167: the `delivery_hint` on directed-act acks + the nudge-relay skill. A seat behind
// this epoch simply never relays (the hint is additive and ignored) — its directed acts still deliver
// through the ADR 088/131 ladder, just without the seconds-latency rail.
// Epoch 4 — the label-sweep nudge rail: `musterd session label-nudge` + the managed machine-wide
// UserPromptSubmit hook, and the SessionStart orientation's label clause going due-gated. The bump is
// what stops an older checkout's `init` from rewriting the machine-wide hooks back to the one-shot
// text (ADR 168 downgrade guard — equal epochs overwrite). An older seat simply never nudges.
// Epoch 5 — the standing-context trim (ADR 212 increment 2): the SessionStart orientation and the
// per-turn PromptSubmit ritual shrink to triggers, with the autojoin rule moved into the committed
// primer. Same rationale as epoch 4 — the ADR 168 downgrade guard only refuses a *newer* epoch, so
// without the bump an older checkout's `init` would rewrite the trimmed hooks back to the fat text.
// An older seat is unaffected: it just carries the longer nudges.
// Epoch 6 — ADR 228: broadcast audio (`musterd broadcast --audio` + the page's enableForBroadcast
// path) and the AsksReel stream chrome. A daemon behind this epoch serves a /broadcast that neither
// sounds nor shows asks — the roster's calm `behind` chip (ADR 148) is the operator's cue that the
// stream is running older capability than the capturer expects.
// Epoch 7 — ADR 227 increment 1: discoverable roles. Seats carry `roles[]` (multi-role, validated
// against the library), role files carry a `summary`, and `team_members` grows a role filter composed
// with the liveness trio. An older seat still renders the single `role` display label and simply
// cannot filter by role; the roster's `behind` hint is the cue.
// Epoch 8 — ADR 232 increment 1: `kind: 'service'` ledger seats. The roster can now carry an
// unattended actor (the auto-refresher first) as a named, attributed row; an older seat's renderer
// doesn't know the kind and may facet it oddly, and its tools cannot reason about the peer/ledger
// split — the roster's `behind` hint is the cue.
// Epoch 9 — ADR 240: a lane's title is correctable. `lane_update` (and `musterd lane update`) take
// `title`, so a lane opened with a title that misstates the work can be put right instead of
// carrying a correction buried in its detail. An older seat is unaffected in what it reads — titles
// render as they always did — it simply cannot issue the correction, and the roster's `behind` hint
// is the cue for why its lane_update refuses the field.
// Epoch 10 — no_goal lane warning + Goal.story (goals front door). An epoch-9 seat neither emits nor
// renders either.
// Epoch 11 — value layer (ADR 257): team_goal_outcome + Goal.outcome, lane_claim {goal_id},
// stale_acceptance warning, review_debt in the brief, notices on lane mutations. An epoch-10 seat
// reads goals/briefs as before (all fields additive) but cannot record an outcome or claim-link.
export const FEATURE_EPOCH = 11 as const;
export type FeatureEpoch = typeof FEATURE_EPOCH;
