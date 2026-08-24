# 169 — Two-stage close: ready-for-review, cross-family confirm, derived verified-ness

- Status: accepted — 2026-07-28. Authored by ryder (lane `01KYK42KRP99AY9FEABA54CQT5`). Design
  approved by nick this session, including the cross-model-family reviewer requirement and the
  risk-tiered human-first routing. Number **169** — next free above ADR 168 at branch time.
  Accepted once increments 1–4 landed (#436 the ADR, #437 the state + derived verified-ness, #440
  the `lane_ready` verbs, #442 the board surface); increment 5 is parked with its blocker recorded
  in §5 and does not hold the decision open.
- Date: 2026-07-28
- Builds on: [ADR 145](145-human-role-refounded.md) §6 (the design contract this implements),
  [ADR 025](025-resolve-act-thread-close.md) (the `resolve` act whose two claims this splits),
  [ADR 147](147-human-ask-stream.md) / [ADR 149](149-ask-surfaces.md) (the ask stream the review
  request rides — and the below-top-tier-never-wedges rule every degradation path here obeys),
  [ADR 083](083-lanes-phase1-intent-dependency.md) §4 (structured meta on existing acts, no new
  act),
  [ADR 150](150-structural-inducement-pretooluse-gates.md) (Gate A — why `ready_for_review` stays a
  contending state), [ADR 109](109-seat-git-attribution.md) (merge attestation `{pr, sha,
authorized_by}`), [ADR 158](158-model-attestation-truth.md) (observed-over-declared model — the
  fact the family check reads), [ADR 056](056-research-as-first-class-practice.md) (the diversity research that
  makes a same-family review worth less), [ADR 166](166-session-liveness-by-enumeration.md)
  (liveness — who counts as a live candidate reviewer).

## Context

`lane_resolve` conflates two different claims, made by the same seat in the same breath:

1. the **worker's** claim — "this work is technically complete"; and
2. the **owner's** claim — "this is what I wanted."

ADR 145 §6 designed the split and parked it as roadmap item `two-stage-close` (wave 8): the
worker's claim becomes a lane state **`ready_for_review`**; the owner's claim requires a
**different seat** to confirm before the lane is `done`; a missing reviewer degrades to
self-close-recorded-unverified, **never a wedge**.

Two hard constraints were settled before this ADR and are not re-litigated
(`docs/design/resolve-as-state-gate-brainstorm.md`):

- musterd runs **no verifiers** — no tests, no compilers, no LLM judges. That is batond's job.
  Review here is a human-or-agent counterpart's judgement, delivered as an act.
- The **act log is the source of truth**. Any "verified" status must be _derived_ from acts —
  a counterpart's terminal act — never stored as a second flag that can disagree with the log.

One founder decision, made at design time for this ADR, extends §6: **the reviewer must come from
a different model _family_ than the worker.** An Opus 5 worker's lane cannot be confirmed by any
`claude-*` seat. The reasoning is [ADR 314](314-correlated-models-correlated-mistakes.md)'s: correlated models make correlated mistakes, so a
same-family review re-runs the worker's own blind spots and attests little. The observed model
attestation ADR 158 built is exactly the fact this check needs — and this ADR is its first
consumer beyond the doctor.

## Problem

A self-close is structurally indistinguishable from a reviewed close. Every lane in the audit log
today was closed by its own worker, and nothing marks that as the weaker claim it is. There is no
moment where a counterpart can say "this is not what I wanted" before the lane leaves the board,
and no metric that could ever measure how often that would have happened.

## Decision

### 1. One new stored state; verified-ness is derived, never stored

`LaneStateSchema` gains **`ready_for_review`**, between the live states and the terminal ones.
`done` remains the **only** success-terminal state. There is **no stored `unverified` state** —
ADR 145's mid-paragraph phrasing ("marking it `unverified`") loses to its own closing constraint
("derived from a counterpart act, never a stored second flag"):

> A lane is **verified** iff the act that moved it to `done` was authored by a seat **different
> from the lane's owner at close time**.

The close audit row pins `closed_by` and `owner_at_close` in its detail, so the derivation is one
row and survives post-close handoffs. Every historical close honestly derives `unverified` — which
is true, and is the baseline the eval below starts from.

A **failed review is not a state** either: the reviewer moves the lane back to `active` with a
note. The lane simply is not done yet. (Audit: `lane.review_sent_back` — the review-catch event.)

Why not a stored terminal `unverified`: it forks `TERMINAL` and `deriveGoalStatus` into a
three-way success semantics ("is a goal shipped if all its lanes are unverified-done?" — a policy
question with no right answer), it is a second source of truth that can drift from the act log,
and it breaks every consumer that matches `state === 'done'`.

### 2. Where the new state sits in the semantic sets

- **Contending** (`claimed`/`active`/`blocked` + now `ready_for_review`): the surface is still
  owned until confirmed. Releasing the ADR 150 Gate A edit-guard at ready-for-review would let
  another seat edit files under a lane still pending review.
- **Not terminal**: `deriveGoalStatus` is unchanged — a goal with a `ready_for_review` lane is
  in-flight, which is correct: a goal is not shipped until its closes land.
- `unmet_dependency` keeps clearing only on `done`. A dependent building on unreviewed work is
  exactly when the warning earns its keep, and warnings are advisory-never-blocking, so keeping
  it costs nothing and wedges nothing.
- The three hand-duplicated copies of these sets (store `CONTENDING`/`TERMINAL`, transport
  `LANE_TERMINAL_STATES`, the MCP z.enum) consolidate onto exported constants in
  `@musterd/protocol` — this change would otherwise triple the drift hazard.

### 3. Transitions, acts, audit

No hard state machine is introduced: `updateLane` keeps its any→any posture. A legality table
bolted on now would wedge mid-flight agents holding older CLIs — exactly the wedge the ask
tiers were designed to rule out. The
transitions below are the _supported_ paths; others remain legal and merely derive `unverified`.

- **`lane_ready`** (new verb, MCP + CLI): `claimed|active|blocked → ready_for_review`. The
  worker's merge attestation `{pr, sha, authorized_by}` (ADR 109) is captured **here**, at the
  moment the worker makes their claim, and persisted on the lane (`merged_json`, the feature's
  only migration). Emits the existing non-terminal `lane_state` broadcast plus audit
  `lane.ready_for_review`. The daemon composes the review ask (§4).
- **Confirm**: a _different_ seat moves `ready_for_review → done`. The existing `lane_resolve`
  act fires; audit `lane.closed { verified: true, closed_by, owner_at_close, ... }`. The
  `git.pr_merged` audit keeps its shape, with its actor honestly the confirmer and the worker's
  stage-one attestation carried verbatim plus `attested_by: <worker>` — the confirmer performs
  the act, the worker made the attestation, and the log says both.
- **Send-back**: the reviewer moves `ready_for_review → active` with a note. Ordinary
  `lane_state` broadcast; audit `lane.review_sent_back { lane, reviewer }`.
- **Self-close** (the degradation, and the backward-compat path): the owner moves
  `ready_for_review → done` after the ask times out, or any seat calls today's `lane_resolve`
  straight from a live state. Both succeed — never a wedge, never an error. Audit
  `lane.closed { verified: false, reason: 'review_timeout' | 'no_candidate' | 'self_close',
ask_ref? }` — `no_candidate` when the picker found nobody, so no ask was ever sent, kept
  distinct from a real timeout for the reasons in the eval below. The
  verb response gains one advisory line: _"unverified close recorded — prefer `lane_ready`
  when a counterpart is live."_ Existing callers keep working byte-for-byte; only the response
  text grows.

### 4. The review ask: risk-tiered, cross-family, standard-tier

On entry to `ready_for_review` the daemon composes an ordinary **`ask` act** — species
`approve`, tier **`standard`** (5 m, `proceed_with_risk`) — directed at the counterpart, with
structured `meta.lane_review = { lane, branch, merged }`. No new act, no SPEC break (the ADR 083
§4 pattern); SPEC.md gets a minor note for the new state value. `standard` and not `blocking` is
deliberate: ADR 145 requires a missing reviewer to degrade to self-close, and only the top tier
holds. `advisory`'s 3 m is too short for a real review; `standard`'s proceed-on-silence is
exactly the designed degradation.

**`pickReviewCounterpart(lane, roster)`** — one server function, so the policy can evolve
without touching the transition machinery:

1. **Risk-tiered human-first.** If the lane is high-risk — declared via a new optional `risk`
   field on lanes (e.g. `['user-facing', 'production', 'cost']`, set at `lane_open` /
   `lane_update`) — route to a live **human/admin** seat first. Declared, not inferred: v1 does
   no guessing from surface globs.
2. **Cross-family otherwise.** Route to a live seat whose **model family differs from the
   worker's**. Family is derived from the resolved model attestation (ADR 158,
   observed-over-declared) via a new `modelFamily(model)` helper in `@musterd/protocol`
   (`claude-*` → anthropic; `gpt-*`/codex → openai; gemini → google; grok → xai; deepseek;
   composer → cursor; kimi → moonshot; else → unknown). A seat whose family is `unknown` is
   **not eligible** — it cannot prove diversity, and musterd would rather say nothing than
   something false (the ADR 158 posture).
3. **No different-family seat live** → _spin up an ephemeral reviewer on a different family_
   (§5). Until that increment lands: no ask is emitted, and the verb response tells the worker
   plainly that self-close is sanctioned.
4. **Nobody at all** → the same sanctioned self-close.

The verb response carries the contract either way: _wait ≤5 m; a confirm closes the lane; a
send-back resumes it; silence → self-close, recorded unverified._

### 5. The ephemeral reviewer (last increment, ask-gated)

When no different-family seat is live, the daemon may provision one: an ephemeral seat on a
different model family (the `musterd agent` + host plumbing — ADR 158 §3 already treats a
`musterd host`-spawned seat's model as authoritative from its spawn arguments), which reviews the
lane and is spun down when the review resolves. Spinning up an agent costs real money and starts
real processes, so the daemon raises a **to-human ask before the first spin-up of a session**;
approval covers that session, not forever. This ships as its own increment at the end of the arc.
If the plumbing proves too thin, increments 1–4 stand alone and this section remains the
documented follow-up lane — the degradation path covers the gap honestly in the meantime.

**Increment 5 as of 2026-07-28 — earned, unbuilt, and blocked on arm availability, not on worth.**
(Phrased so it cannot be mistaken for this ADR's own Status line above, which is `accepted`.) The
amendment below settles the worth question in the affirmative (the no-candidate rate earns this
increment without waiting on a catch rate). What stops it is narrower and more mundane: on this
machine there is currently **no cross-family reviewer to spin up**. Surveyed the day the amendment
landed, and it drifts — re-verify rather than trusting this list:

- **ollama** (local `qwen3:4b`, the only model pulled) — on PATH and free, so it would need no ask
  gate at all. Ruled out by the host owner: a prior unbounded run left `ollama serve` resident at
  `num_ctx 32768` and brought the host to a standstill twice, competing with the dev fleet for RAM.
  A local arm is off the table on this host regardless of how it is bounded.
- **cursor-agent** — on PATH but unauthenticated (`--list-models` → "No models available for this
  account"). Installed is not available.
- **codex, grok, kimi, deepseek** — not on PATH.
- **gemini** — on PATH, a genuinely different family, and hosted, so it carries no local-RAM risk.
  It costs money, so it remains behind the §5 ask gate. This is the one live arm.

**One rule this survey produced, and it is simpler than the carve-out it replaces: family is a
property of the model, never of the harness.** `cursor-agent` looked at first like a distinct
"composer family" deserving its own clause in ADR 158 §3. It is not a family at all — it is a
harness taking `--model`, whose own `--help` advertises `gpt-5, sonnet-4, sonnet-4-thinking`. The
same binary is an OpenAI reviewer or an Anthropic one depending on one flag. So a daemon-spawned
reviewer is authoritative from its spawn arguments **whenever the daemon passes the model
explicitly** — already true for codex, equally true for `cursor-agent --model X`, `ollama run
qwen3:4b`, `gemini -m X`. No per-harness carve-out is needed, and ADR 158's `cursor → undefined`
is correct as written: an unspawned cursor seat genuinely cannot know what it is running. The
observation tier (reading a transcript to learn what a seat you did _not_ spawn is running) is
untouched.

**A caution for whoever measures the catch rate.** An offline spike was drafted to get a cheap
catch-rate signal by replaying merged lane/diff pairs past a reviewer, and it was never run. On
inspection its fixture would have inflated the number: four of its five cases were trivial — two
paired a lane with a wholly unrelated commit (a title check, not a review) and two paired a lane
with its own commit. Only one case tested the failure mode that actually occurs, **partial
delivery**: a lane's own diff clipped to one package, so the UI requirement shipped and a
server-side requirement silently did not. A rubber-stamping reviewer confirms exactly that case and
catches the other two for free, so "3 of 3 catches" would have been two gimmes carrying one real
test. Any future catch-rate measurement should be built from partial-delivery cases drawn from real
merged lanes; unrelated-commit pairs measure nothing.

**Budget note.** The daemon cannot spawn. Process actuation lives host-side (`musterd host`, ADR
131): the daemon issues orders and the host actuates them through the `ActuatorBackend` seam in
`packages/cli/src/host/backend.ts`, where `claudeCode` is backend #1 and the only one. A spin-up is
therefore daemon mints an ephemeral seat and emits an order → host backend spawns it with an
explicit `--model` → the seat comes online and attests → it reviews → it is spun down on
resolution. `memberFamily` reads the model of the **latest live presence**, so a spawned reviewer
must genuinely come online and attest; merely existing in the roster does not make it eligible.
This is not a one-file change.

### What this does not do

It does not gate `done` (a goal whose lanes are all unverified-done still derives `shipped` —
verified-ness is telemetry, not a gate; founder-confirmed), does not run verifiers, does not add
a lane-state legality table, and does not touch the unbuilt writable board
(`docs/superpowers/specs/2026-07-22-human-work-identity-writable-board-design.md`) beyond adding
one read-only column.

## Observability & Evaluation

**Traces.** The audit rows are the instrument, all new, all shapes-not-bodies:

- `lane.ready_for_review { lane, owner, merged? }` — the worker's claim, timestamped.
- `lane.closed { verified, reason, closed_by, owner_at_close, worker_family?, reviewer_family?,
time_in_review_ms }` — every terminal edge, including all legacy self-closes.
- `lane.review_sent_back { lane, reviewer }` — the review catch.
- The review ask itself rides the existing ask-span telemetry (species/tier/timeout/outcome)
  with no new wiring.

**Eval.** _Dataset:_ the audit log's `lane.closed` rows on the dogfood daemon, joined with
`lane.ready_for_review` and `lane.review_sent_back`. _Baseline, exact by construction:_ at merge
time the unverified-close rate is **100%** — every close in the log's history is a self-close,
which is precisely the condition this ADR exists to make visible. _Metrics:_ the
**unverified-close rate** (closed rows with `verified: false` / all closed — target: falls as
the fleet adopts `lane_ready`; a floor well above zero is expected and honest, since solo
sessions self-close by design); the **review-catch rate** (`review_sent_back` / reviews
**actually routed** — the number that measures whether review does anything; if it sits at zero
for weeks while reviews are being routed, review is rubber-stamping and the feature is
decorative); the **no-candidate degradation rate** (`lane.closed` rows with
`reason: no_candidate` / all rows entering review — what share of "reviews" never happened
because the picker found nobody eligible); the **family-diversity coverage** (share of verified
closes where `reviewer_family ≠ worker_family` — target 100% by construction once routing works;
below that means the picker leaked a same-family review). _Counter-metric:_ the review-ask
timeout rate — if nearly all _routed_ asks expire unanswered, the tier or the routing is wrong
and the feature is adding a 5 m tax with no review.

**Correction — the original inference was unsound, not merely incomplete** (2026-07-28, from the
first live data; recorded at the ADR author's request rather than quietly patched). As first
written, this section said a persistent zero catch rate means review is rubber-stamping and the
feature is decorative. That inference is **invalid on any fleet where the candidate pool can be
empty**, and this fleet is one: a zero has two opposite causes — reviewers looked and found
nothing (rubber-stamping: the feature IS decorative), or no reviewer was ever eligible so nothing
was reviewed (the feature was never exercised) — and retiring the feature is the right response
to only the first. As written it would have retired a feature that had never once run. The
counter-metric failed the same way: it would have read a 100% ask-timeout rate against **zero
asks sent**, indicting the tier choice and the picker for what is a _staffing_ fact — a
counter-metric pointing at the wrong subsystem.

The evidence is the first three uses of `lane_ready`, all of which degraded with no candidate:
miley's lane at 8.5 s, ryder's at 13.0 s, and the lane that produced this amendment, which
returned `no eligible cross-family counterpart is live`. **3 of 3, zero asks routed**, on a fleet
whose live seats are all Claude-family by construction.

**The no-candidate rate is a first-class metric, and it is what earns increment 5.** Increment 5
(spin up an ephemeral cross-family reviewer) was parked pending the catch rate — but the
dependency runs the other way, and having it backwards is what deadlocked the plan: the catch
rate _cannot_ move until an eligible reviewer exists, which is precisely what increment 5 builds.
Increment 5 never needed the catch rate. It needed proof the candidate pool is empty **in
practice**, which the no-candidate rate supplies immediately, without a single review happening.
So it is not a caveat beside the headline number: it is the number that earns the increment, and
only once the increment lands can the catch rate become a statement about reviewing rather than
about staffing.

That split needed instrumentation, not just arithmetic. The ready edge is the only place that
knows whether a counterpart was found, so it now records the outcome (`reviewer` + `route`, or
`no_candidate: true`) in the `lane.ready_for_review` detail, and the close edge derives
`reason: no_candidate` from it instead of labelling every owner-close a `review_timeout` — a
label that asserts somebody was asked and did not answer. Legacy rows that recorded neither keep
the old label rather than having a verdict invented about the past; a backfill there would have
been fabricating data to make a metric look coherent.

**A practice this produced, worth keeping.** The lane carrying that fix was not closed while the
daemon still ran the pre-fix build — closing then would have written the exact wrong audit row
onto the lane that exists to prevent it, and the log's first `no_candidate` row would have been a
`review_timeout`. The close waited for the ADR 152 auto-refresher to bounce the daemon onto the
merged build, so the row is correct by construction. This is the same non-action ADR 168 records
("the repair waits for the merged build"), arrived at independently on a different surface, which
is what makes it a rule rather than a coincidence: **when a change alters what gets written to a
durable log, do not write to that log from a build that predates the change.**

_Reading the numbers requires an admin credential:_ `GET /audit` is admin-only, so an agent seat
cannot compute any of this for itself. That is deliberate (the log carries governance rows) but
it means the eval is a human-run or admin-run analysis, not something a seat can self-serve — if
that becomes a barrier to it ever being computed, the fix is a non-admin projection of these
counts in `musterd report`, not widening audit access.

**Experiment.** No A/B: the baseline arm (single-stage close) is the entire recorded history,
measured not assumed. Verification is adversarial-by-construction: the through-DB integration
tests assert the verified derivation from the audit rows alone (never from lane state), and the
backward-compat contract test proves a legacy direct `active → done` still succeeds and derives
`verified: false` — confirmed to fail if the derivation reads current owner instead of
`owner_at_close`. The natural experiment worth watching is the first month's review-catch rate:
it is the first number musterd has ever produced about whether a second pair of eyes changes
outcomes, and it feeds the ADR 056 diversity research a labeled cross-family sample.

## Consequences

- Closing a lane finally distinguishes "I say I'm done" from "someone else agrees" — and the
  audit log measures the difference instead of erasing it.
- Every review is a cross-family review by construction, so the ADR 056 research gains a stream
  of labeled diversity data as a side effect of ordinary work.
- A lone agent's workflow is unchanged except for one advisory line — no wedge, no new required
  step, no broken caller.
- `ready_for_review` keeps the surface owned, so review time extends lane tenure; on a busy
  board that is more surface-overlap warnings, accepted as the honest cost of "owned until
  confirmed."
- The family check inherits ADR 158's honesty: seats attesting `unknown` cannot review. On a
  fleet that is mostly one family plus unknowns, most asks will route nowhere until the
  ephemeral-reviewer increment lands — the degradation path absorbs this visibly rather than
  silently.
- One new migration (`lanes.merged_json`), one new lane field (`risk`), one SPEC minor note.

## Related

- [ADR 145](145-human-role-refounded.md) §6 — the design contract; this ADR is its
  implementation and one deliberate correction (`unverified` derived, not stored).
- [ADR 158](158-model-attestation-truth.md) — the attestation the family check consumes; its
  "prefer unknown to false" posture propagates here as reviewer ineligibility.
- [ADR 153](153-ask-reachability-gated-hold.md) — the ask-stream degradation machinery the
  review request inherits.
