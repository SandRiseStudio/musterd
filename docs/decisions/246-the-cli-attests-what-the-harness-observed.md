# 246 — The CLI attests what the harness observed, and a lost attestation is recorded

- Status: accepted
- Date: 2026-08-06
- Deciders: ryder, miley (found it from the surface side and handed over the lane)
- Relates to: ADR 158 (observed over declared — the ladder this adopts), ADR 101 (model as a
  variable), ADR 119 (ambient HTTP re-attest), ADR 121 (a human shell must not stamp a model),
  ADR 187 (grading speaks only about a session running now), ADR 188 (the graded review ladder that
  consumes this), ADR 010 (the reclaim grace whose interaction causes it), ADR 314 (the diversity
  conclusions downstream)

## Context

A seat can silently stop being eligible to review. miley found the symptom while building the
acceptance-capacity surface and handed over a precise brief; the mechanism turned out to be
somewhere else entirely, which is worth recording because the wrong mechanism was the plausible one.

**The brief's hypothesis was that a claim frame carrying no model inserts a null presence row and
audits nothing.** There was no claim frame. Every born-null row carries `conn_id IS NULL`, and the
claim path always attaches with a live connection id. The decisive tell is the **epoch**: those rows
have `build` set and `epoch` null, and an MCP claim can never produce a null epoch because the
adapter hardcodes `epoch: FEATURE_EPOCH`. There is no `x-musterd-epoch` header anywhere in the tree.
Exactly one path produces that combination — the HTTP ambient touch.

The real chain, reproduced against the live daemon on 2026-08-05:

1. A session disconnects cleanly. `release()` sets `held_until` — ADR 010's reclaim hold. **The row
   keeps its attestation.** (Seat miley: row `01KZA53JS0`, `model = claude-fable-5`, held.)
2. Inside that grace window a CLI one-shot authenticates. A SessionStart hook is enough.
3. `touchAmbientPresence`'s reuse query is `conn_id IS NULL AND held_until IS NULL`. The held row
   fails the **second** clause, so nothing matches.
4. It therefore attaches a **brand-new row** — fifteen seconds after the release, in miley's case.
   The `model = COALESCE(?, model)` stickiness never applies: stickiness is per-row, and this is a
   different row.
5. `latestAttestedModel` reads the newest **non-held** row and returns its model **even when null**
   — unlike `currentAttestedModel`, which filters `model IS NOT NULL`. So the born-null row
   _shadows_ the held attested one, `modelFamily(null)` is `unknown`, and the seat is ungradeable.

At the moment that query ran, two live seats were silently outside the ADR 188 pool, and neither
had any way to know.

**And the attestation was available the whole time.** miley's binding carried
`model_observed: {model: 'claude-fable-5', observed_at: 17:47:02}` — twelve seconds before the
unattested row was created at 17:47:14. The truth was on disk, freshly observed by her own harness.
The CLI could not see it: `client.ts` resolved from `MUSTERD_MODEL`/`ANTHROPIC_MODEL` alone, while
the MCP adapter uses the full ADR 158 ladder (`observed > env > binding`). The shared resolver in
`protocol/model.ts` exists precisely so the two attest identically, and the CLI never adopted it for
model. So the CLI's attestation was blind to the one tier ADR 158 says **wins** — and it is the tier
a hook process is least likely to have in its environment.

Two facts about the ledger complete the picture. There was no audit row for either born-null
occupancy, because an occupancy born null has no old→new transition to audit. And `review.ts` has
always read a shape nothing has ever written: `if (!r.target || !r.model) continue; // a
de-attestation (new: null) proves nothing`. Across the whole audit table at the time: **1214
`occupancy.model_attested` rows, zero with `new: null`.** The row was designed for and never emitted.

Three consumers were silently wrong for as long as this ran: ADR 188 routing (the eligible pool
changed with no recorded cause), ADR 314 diversity conclusions (a review episode's candidate set was
smaller than the roster suggests, with no artefact saying why), and ADR 234's acceptance measurements
(a lane finding no candidate looks like a routing outcome when it was an attestation gap). This is
the instrument-vs-system confusion in its purest form: `unknown` reads as a fact about the seat while
being a fact about which presence row happened to be newest.

## Decision

**Attest what is knowable, and record what is lost.** Two halves, and the order between them matters.

### 1. The CLI adopts the shared ADR 158 ladder

A CLI one-shot resolves its model through `resolveAttestation({observed, env, binding})` — the same
resolver the MCP adapter uses — instead of reading the environment alone. Resolution happens where
the binding is already in hand (`gather()` in the commands layer) and the answer is passed down to
the transport.

**The client does not resolve this itself.** `HttpClient` is constructed in a dozen places — tests,
the host loop, `init` before a binding exists — and having it call `findBinding(process.cwd())` would
make every one of them attest from an ambient cwd, which is the ADR 143 hazard. The client takes an
optional pre-resolved `model` and falls back to the env declaration when it is absent, which is
exactly the pre-246 behaviour for callers that have no binding to consult.

**No freshness bound on the observation**, deliberately, and consistently with the adapter, which
reads `model_observed` unconditionally. ADR 158's never-erase rule already governs how an observation
ages. Inventing a second, CLI-only staleness rule here would let two surfaces disagree about the same
seat at the same instant — the precise thing the shared resolver exists to prevent.

**ADR 121 is untouched and outranks all of it.** The gate is on the _credential_, not on where the
value came from: a human credential forwards no model however thoroughly one was resolved. Resolving
better must not become a new way for a human shell to stamp an occupancy.

### 2. An occupancy born unattested after an attested one writes the de-attestation row

`recordUnattestedOccupancy` emits `occupancy.model_attested` with `{old: <previous>, new: null}` —
the shape `review.ts` already reads — when a new occupancy attests nothing and the member's previous
occupancy attested something. Both the claim paths and the ambient path call it.

**`new: null` is load-bearing, not incidental.** The durable-attestation reader skips these rows, so
recording the loss can never become a route for a dead session's model to certify a live review —
the thing ADR 187 exists to forbid. The row is a record _of_ a loss, never a claim about what is
running.

**A seat that never attested drops nothing.** `unknown` from the start is a different fact from "was
X, now nothing", and only the second is an event. Without that guard the ledger fills with rows about
harnesses that cannot attest yet (ADR 158: Codex, until its hook path lands) and the real drops are
buried.

**One function, because the predicate had five copies.** The `if (model)` branch was duplicated
across the WS occupy, three HTTP claim outcomes, and the grant-approval attach — each recording the
attested case and silently dropping the unattested one. `recordClaimAttestation` replaces all five.
Fixing four of five would have produced a ledger that is right except where it isn't, which is worse
than one uniformly incomplete: a reader can reason about the second and not the first.

### What was rejected

- **Making `latestAttestedModel` skip null models** to find an older attested row. This is ADR 187's
  forbidden move exactly: a stale memory certifying a live review.
- **Letting the ambient touch reuse the held row.** It resurrects a previous session's attestation
  onto whatever is touching now, and the ambient path has no session identity to justify it. (Wake
  sessions now carry one — `wake_lease`, ADR 241 — but ordinary sessions do not.)
- **Widening the reuse query to include held rows.** The hold is ADR 010's reclaim grace; silently
  un-holding it changes displacement semantics for a reason unrelated to displacement.

## Consequences

- A hook one-shot now attests the model its harness observed seconds earlier, so the common case
  stops producing born-null occupancies at all. Half 1 is prevention where the truth is knowable.
- Where it genuinely is not knowable, the drop is now in the ledger with the model that was lost, so
  all three consumers can say _when_ a seat left the pool and _what it had been_. Half 2 is the
  record for everything half 1 cannot prevent.
- **The ordering is deliberate**: half 1 before half 2, or the ledger immediately fills with drops
  that half 1 would have prevented, and the new row is noise from its first day.
- `occupancy.model_attested` now carries two shapes. Any future reader must handle `new: null` —
  `review.ts` already did, which is what made this shape the obvious one rather than a new action.
- The CLI and the MCP adapter now attest identically. They should be kept that way: a third surface
  that resolves its own ladder re-opens this defect in a new place.
- **2026-09-02 — a third resolver, found and closed.** The consequence above ("a third surface that
  resolves its own ladder re-opens this defect in a new place") happened inside the CLI itself:
  `session.ts` built its hook client from `binding.model` alone (orientation, statusline) or from
  nothing (`pushAttestation`), and the ADR 339 reclaim that client performs on a refused lease is a
  real seat claim — so a late hook minted a `cli` Presence attesting nothing. Measured after the
  2026-09-01 claim storm ended: the two surviving `worker_unattested` picker rows each sat 4 s
  after a bare `cli` claim; 244 `cli` claims to 50 `claude-code` in the same window. Fixed on lane
  `01M1G4P6GD8SHFAZJYQ2KJ2A10`: all three clients resolve through `attestedModel` (observed >
  env > declared), and a test pins the reclaim's carried model. The rung [ADR 351](351-unattested-worker-routes-ungraded.md)
  added the same day is what catches whatever this still misses.
- Not fixed here, and deliberately: the presence table still has no session identity, so nothing
  distinguishes "the same session touching again" from "a new session in the same folder". Half 2
  records the consequence rather than removing the ambiguity. ADR 241's `wake_lease` is the only
  correlation on that table today, and it exists only for wakes.

## Observability & Evaluation

**Traces.** No new action and no new span — deliberately, since `occupancy.model_attested` already
_is_ the model history and `review.ts` already reads the de-attestation shape. The new rows are
distinguishable by `detail.new IS NULL`, and `detail.source` (`claim` | `ambient`) says which path
produced them, which is the split that would tell us whether half 1 is working.

**Eval.** The claim is that a seat no longer leaves the ADR 188 pool silently. Baseline, measured on
the live daemon 2026-08-05: **two of the roster's live seats (miley, wanderer) held presence rows
attesting no model, with `model_observed` fresh on disk twelve seconds earlier, and zero audit rows
recording it — out of 1214 attestation rows, none with `new: null`.** Success is two-sided and both
sides are needed: the count of born-null ambient occupancies falls toward zero (half 1 working), and
those that remain each carry a de-attestation row naming the lost model (half 2 working). The failure
to watch is a de-attestation rate that stays flat while attestations rise — that would mean the CLI
resolved a model but the row was still born null, which points at the ambient path's row identity
rather than at the ladder.

**First live reading (2026-08-05 18:31, added after the daemon picked up this ADR).** The PR said
"not verified live", because the daemon was pinned on a pre-246 build and no ambient touch could
exercise the change. It has since bounced, and the measurement is now taken rather than promised:

| when                       | seat     | kind    | model           | epoch  |
| -------------------------- | -------- | ------- | --------------- | ------ |
| 17:47 — **before** the fix | miley    | ambient | `(null)`        | `null` |
| 17:47 — **before** the fix | wanderer | ambient | `(null)`        | `null` |
| 18:31 — **after** the fix  | dolly    | ambient | `claude-opus-5` | `null` |

The `epoch: null` in all three rows is what makes this a like-for-like comparison rather than a
hopeful one: it is the fingerprint of the HTTP ambient path (no `x-musterd-epoch` header exists), so
the third row is the _same_ code path as the first two, now attesting. Half 1 is confirmed in
production.

Half 2 is **not** confirmed by this reading and the distinction matters: zero de-attestation rows
exist, which is what half 1 working looks like, and is indistinguishable at this sample size from
half 2 never firing. It is proven by unit test and by mutation, not yet by production. What would
confirm it is a seat whose harness genuinely cannot attest (ADR 158: Codex) taking an occupancy
after an attested one — and the first such row should be checked by hand rather than assumed.

One methodological note for whoever re-runs this: **the before-rows cannot be re-read.** Presence
rows are deleted on detach, so the 17:47 control exists only because it was captured live during the
investigation. A comparison of this kind has to be taken before the fix ships or not at all.

**Experiment.** None. An arm without the fix is an arm where the review pool silently shrinks and no
artefact records it, which corrupts the ADR 314 diversity conclusions at the source — the same reason
ADR 241 declined an arm. The discriminating evidence was gathered before the change instead: the live
DB read that separated the ambient path from the claim path by the null-epoch fingerprint, and the
binding timestamp that proved the attestation was available twelve seconds before it was dropped.
