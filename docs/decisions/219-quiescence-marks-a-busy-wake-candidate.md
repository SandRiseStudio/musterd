# 219 — Quiescence marks a busy wake candidate, and rides the roster

- Status: accepted
- Date: 2026-08-04
- Related: ADR 215 (quiescence signal — this is its increment 3), ADR 189 (wakeability facts),
  ADR 187 (wake pool carries what waking brings), ADR 169 (absent-vs-unknown), ADR 210 (exact-match
  wake resume — the surface this sits on), ADR 131 (harness residency)
- Design conversation: docs/superpowers/specs/2026-08-03-quiescence-signal-design.md (approved by
  nick, 2026-08-03)

## Context

ADR 215 shipped quiescence as a derived, never-stored read and wired its first consumer (the
auto-refresher's quiet floor). It pre-registered two more surfaces — `MemberSummary.quiescence` and
an ADR 189 wakeability fact — and deliberately deferred them behind ADR 210, because both sit on the
wake path that work was rewriting.

ADR 210 has landed. The gap those two surfaces close is specific:

The wake pool (ADR 187/189) is built from every seat **presence** calls offline. But presence lapses
for reasons other than a seat going away — a dropped socket, a harness that stopped heartbeating, a
session mid-tool-call that has not checked in. A seat whose audit trail shows it acting five seconds
ago is not idle. Waking it does not buy a remedy; it buys a duplicate, and on the ADR 179 spend path
it buys one with money. Presence answers "is this seat attached"; nothing on the wake path was
asking "is this seat _doing something_", because until ADR 215 nothing could.

Symmetrically, the authenticated roster carries `wakeable` — can dispatch reach this seat — with no
companion answering whether reaching it would interrupt anything.

## Decision

1. **`WakeabilityFacts` gains an optional `seat_quiet` fact, and `Wakeability` gains
   `enrolled_seat_busy`.** `seat_quiet: false` means the audit trail shows the seat acting inside
   the caller's line. Omitted when there is no evidence: `unknown` is not quiet, and passing `true`
   for "I did not check" would spend exactly the wake this fact exists to prevent.

2. **Busy is the softest reason — every reachability defect outranks it.** Precedence stays
   `not_enrolled` → `enrolled_dead_workspace` → `enrolled_host_stale` → `enrolled_seat_busy` →
   `wakeable`. The reachability reasons name a broken pointer an operator can fix; busy is weather.
   A seat that is both busy and unreachable must report the defect.

3. **Mark, never filter** (ADR 189's rule, unchanged). A busy seat stays in `wake_pool`, so a
   posture line still names the diversity gap it represents. Downstream spend paths already gate on
   `wakeability === 'wakeable'`, so they stop spending on it without any change of their own — which
   is the point of putting the fact in the shared predicate rather than at each call site.

4. **`MemberSummary` gains optional `quiescence`**, beside `wakeable`. Together they answer "can I
   reach this seat, and would reaching it interrupt anything?" Not folded into `activity`,
   `posture`, or any rendering: a seat may read `working` from a status_update while quiescence
   reads `quiet`, and that is correct rather than contradictory — ADR 215's whole decision is that
   these are different questions.

5. **One documented default line, `QUIESCENCE_DEFAULT_QUIET_AFTER_MS = 120_000`**, used only where
   the shape demands a label the caller did not choose: the roster's `state` and the wake pool's
   `seat_quiet`. It is the same 120s as the auto-refresher's `--quiet-floor` default, so the two
   server-side readers cannot quietly disagree about "busy". This does not retract ADR 215's
   thresholds-live-in-the-consumer rule: `quiet_for_ms` rides the wire beside the label, so any
   reader with its own line recomputes and ignores this one. What a constant cannot do is make
   `state` optional — some number has to draw it, and an undocumented one drawn ad-hoc per call
   site would be strictly worse than one named once.

6. **One audit read per roster/posture pass**, keyed by actor name, returning a `Map` in which a
   seat with no evidence is **absent** rather than present with a sentinel. A `Map` miss is
   unambiguous in a way that `0` or a floor value is not, and the absent-vs-unknown discipline only
   holds if "no evidence" cannot be mistaken for "evidence of quiet".

Explicitly untouched: ADR 210 resume logic, `activity`, posture, and `/live`.

## Consequences

- Additive and self-degrading in both directions. An older daemon omits `quiescence` and every
  consumer behaves as it did before the field existed — which is also exactly what `unknown` means,
  so there is one degradation path, not two. An older client ignores the field.
- `Wakeability` gains a member, so an exhaustive `switch` in an out-of-tree consumer would need a
  new arm. In-tree there are none: both consumers compare against `'wakeable'`, and the posture
  renderer prints the token. This is the reason this increment gets its own ADR rather than riding
  ADR 215 — a new enum value is a wire-contract addition, not an implementation detail.
- The audit tier's coverage is the honest ceiling. A plain `status_update` send is not audited (only
  a model-attestation change on that path is), so quiescence sees tool calls, lane ops and
  governance actions — not literally every keystroke of teamwork. A seat doing only unaudited work
  reads `unknown`, which degrades to today's behaviour rather than to a wrong answer. Widening audit
  coverage is a separate change with its own privacy and volume questions.
- Codex seats stay `audit`-tier (ADR 215 §4) — a labelled non-uniformity, not a hidden one.
- No `FEATURE_EPOCH` bump: nothing here involves a downgrade guard, and the ledger says err toward
  not bumping.

## Observability & Evaluation

**Traces.** `enrolled_seat_busy` is itself the instrument: it appears in `WakeCandidate.wakeability`
on every posture read and in the ADR 189 wake-report axis, both of which are already audited. So
"the wake pool declined to spend here because the seat was mid-something" is a queryable event from
day one, distinguishable from "declined because the seat is unreachable" — which was the
indistinguishable pair before this change. `MemberSummary.quiescence` carries `quiet_for_ms` beside
the label, so any client can see the raw age the verdict was drawn from and check the drawing.

**Eval.** The question is whether the fact fires on real evidence rather than on presence noise.
Replayable from the existing audit table: count wake candidates marked `enrolled_seat_busy`, and for
each, whether the seat produced another audited action within the following few minutes. A seat that
goes on working confirms the mark; a seat that never acts again was presence-correct and the mark
cost a deferred wake. Success = the confirmed share dominates, at no reduction in wakes that
actually land (the mark never removes a seat from the pool, so remedy coverage is unchanged by
construction and is the regression to watch). Baseline: zero, since no busy signal reached this path
before.

**Experiment.** The decision variable for the pre-registered harness tier (ADR 215 §4) is the
`unknown` rate on the WAKE path specifically — offline candidates with no audited action in the
lookback. That rate is higher here than on `/health` by construction, because these seats are
offline and their last action is older; if it is high enough that the fact rarely fires, the audit
tier lacks the information for this consumer and turn-boundary hook capture is the answer, not a
threshold tweak. Measured from the same audit table, no new emission.
