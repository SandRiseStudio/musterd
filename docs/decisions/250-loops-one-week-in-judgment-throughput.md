# 250 — The loops, one week in: judgment-throughput as the governing goal

- Status: accepted
- Date: 2026-08-06
- Builds on: [ADR 179](179-board-triggered-work-order-wakes.md) (the loop family this
  reevaluates — its own text arms a reevaluation trigger, invoked early here),
  [ADR 191](191-review-loop-wake.md) / [ADR 199](199-dispatch-loop-wake.md) (the two loops
  that have run), [ADR 229](229-the-acceptance-backstop-sweep.md) (the sweep — the loop that
  bent two doctrines and is retroactively legitimized here), [ADR 234](234-tiered-acceptance.md)
  (acceptance tiers — the seed of the judgment-class taxonomy),
  [ADR 172](172-model-family-posture.md) / [ADR 188](188-graded-review-ladder.md) (the
  routing ladder the capability-fitness item extends),
  [ADR 131](131-harness-residency-wake-ledger-host.md) (the wake rail everything spends
  through)
- Lane: `01KZAEY32MM19EAA1RCHDQ7JTY`
- Authored by kimi from a brainstorm with nick, 2026-08-05 evening — the same
  session that armed `loops.dispatch` and approved the first dispatch-handoff exercise.

## Context

ADR 179 wrote down its own reevaluation trigger: after the dispatch, review, and merge
loops have run under per-loop observability, the recorded trigger vocabulary decides
whether loops-as-data earns building. This ADR invokes that reevaluation **early** — merge
has not run — because one week of ledger evidence answered questions the trigger was not
even asking, and because the founder asked for it. Nothing here is a verdict that something
is wrong; it is the scheduled look, taken ahead of schedule.

### What the ledger says (measured 2026-08-05, dogfood daemon)

**Adoption.** 35 lane-scoped work-order wakes since the review loop armed: 1 (07-31) → 2
(08-03) → 10 (08-04) → 22 (08-05). 28 reported, 7 expired. The ADR 188 ladder did what it
was designed to do: nearly every wake went to the roster's only cross-family wakeable seat
(gptbot), a handful to ryder. The wake rail's failure taxonomy over the last day is rich and
mostly benign — 12 deferrals for a live local session, sleeping-host deferrals
([ADR 236](236-sleeping-host-defers.md)), lease verification
([ADR 241](241-a-wake-verifies-against-its-own-lease.md)) — the hardening arc shows.

**Churn the breaker cannot see.** Eight lanes woke the _same seat_ two to five times each
(one lane: 5 leases ~30 minutes apart; 14 `lease_expired` failures in one day). The
ADR 179 circuit breaker exists (`REVIEW_LOOP_BREAKER_N = 3`) but counts
`lane.ready_for_review` re-submits — a lane that keeps leasing wakes because sessions
expire or fail before moving the lane never trips it. Every firing re-derives from board
state with no memory of why the last firing on the same edge failed.

**Wakes routed to actors who structurally could not act.** Six wakes landed on one lane
(`01KYXBFAD2E…`) in sessions without write approval — non-interactive, no in-band grant
possible — so each could only re-describe the same finished analysis. The routing ladder
ranks by family and model diversity and knows nothing about whether the target session can
_do_ the lane's work: write access, required tools, remaining budget. dolly escalated it as
a standing ask; the lane it describes is a live credential leak that six spends failed to
advance.

**The close-reason distribution.** `self_close` 76 · `counterpart_confirm` 53 ·
`no_candidate` 32 · `review_timeout` 23 · `review_unanswered` 13. The loop family exists to
make verified closes routine; the sanctioned self-close is still the modal outcome.

**The founder's load moved; the target didn't.** ADR 179's motivating measurement was the
2026-07-28 day: 40 merged PRs steered by 23 manually started sessions and a merge
authorization on every PR, with zero musterd acts from the founder. That specific load —
the paste ritual — is now substantially absorbed: 22 sessions started themselves on
2026-08-05. What remains, measured the same evening: **545 unread, 26 open asks directed at
the founder**, dominated by lane-acceptance requests carrying their own merge attestations,
plus merge authorizations still riding every PR. The loops removed the mechanical load and
concentrated what remains into pure judgment. Nothing in the ADR corpus states what the
loops owe _that_ load — this ADR does.

**Dispatch.** _(Corrected 2026-08-06 — see the amendment below; the original claim that the
handoff edge had never fired was wrong.)_ The handoff edge has fired **once, and it
succeeded**: 2026-08-04 14:56:32, dolly → gptbot, lane `01KZ4QH585V576F3NTD9R30RXZ`,
`derivation: work_order`, reported. `loops.dispatch` armed 2026-08-05 evening; the
continuation edge has fired repeatedly since.

## Decision

### 1. The goal, restated

The governing sentence for the loop family, superseding "the automatic day":

> **Maximize verified throughput per unit of human judgment. Spend human judgment only
> where it is irreplaceable, and convert every delegable judgment class into a loop with a
> trust ramp and a breaker.**

"Verified" is load-bearing: throughput that arrives as unverified self-closes does not
count toward the goal, which is why the sweep records `review_swept` and why the merge
loop's precondition is a verified close. "Per unit of human judgment" makes the founder's
ask queue a **denominator**, not a fixed cost — the headline instrument below measures it.

### 2. Doctrine amendments

Two of ADR 179's doctrines are amended to match what the sweep already proved right — the
amendments legitimize observed practice rather than licensing new behavior.

**The three-verb interface gains its one named exception.** The bar stands: a loop routes
work to an actor, never injects instructions, never chooses how work gets done. The sweep
breached "never acts on a seat's behalf" by closing lanes itself — correctly, because a
stranded lane has no actor left to route to. The honest doctrine is now:

> A loop may **route work to an actor**, or make a **terminal state move that is
> explicitly marked unverified** — nothing between.

The boundary this draws: a loop may act _past_ absent judgment (a terminal move nobody was
left to make, labeled as such forever), never _with_ judgment (no loop ever accepts,
merges, or evaluates content on its own authority — those remain routed). Future loop
proposals are tested against this sentence; sweep is not precedent for anything softer.

**Hook-loops-only, restated by its actual content.** The sweep fires on a clock (grace
expiry), so "board transitions, never timers" is already false as written. The doctrine's
real content was never "no clocks" — it was "no heartbeat that burns spend while nothing
changed." Restated:

> **Spend-bearing wakes require a board transition. Free state moves may use clocks.**

A timer that only ever moves a lane to a cheaper state (a sweep, a digest flush) is
admissible; a timer that leases a wake is not. The no-heartbeat, no-cron posture for
anything that costs money is unchanged.

### 3. The judgment-class taxonomy

The standing test for every future loop proposal and every ask species. Each class of
human decision is either:

- **Delegable** — routed to the human only because no loop has earned trust over it yet.
  The goal converts these, one trust ramp at a time. Measured membership tonight: **merge
  authorization** (rides every PR — the largest class), **standard-tier acceptance of
  unrisky lanes** (at least 7 of the 26 open asks, each carrying its own merge
  attestation), **bounded dogfood spend** (a $2 wake exercise needed a founder
  round-trip), and **admin-fact queries** (a seat asking "is `loops.dispatch` armed?" —
  not judgment at all, a visibility gap).
- **Irreplaceable** — the human's judgment is the quality bar: design and feel acceptance,
  risky-lane review, direction-setting (`steer` / `defer`). These are never automated;
  they get **cheaper** — richer briefs, one-tap verdicts, batched delivery.

The test a proposal must pass: name the judgment class it absorbs or cheapens, say which
side of the line it sits on, and — if delegable — name its trust ramp and its breaker.

### 4. The sequenced backlog

Ordered by judgment recovered per unit of build. Each item lands as its own lane (and ADR
where warranted); nothing here is implemented by this ADR.

1. **Per-edge firing memory + a spend-level breaker.** Durable memory per (lane, loop
   edge): attempts, last outcome, last failure reason — read by the router (do not repeat
   a wake whose twin just failed for a reason still true) and by a breaker that counts
   **wake attempts**, not re-submits. Closes the churn blind spot; protects spend already
   flowing. Small, and first for that reason.
2. **The merge loop** — ADR 179's design, unchanged: verified unrisky closes actuate the
   ADR 106 merge; risky raises a blocking ask. Largest delegable class; design cost
   already paid. Its ADR must resolve the two questions 179 left open (who merges —
   closer or owner; what `authorized_by` records on an auto-merge).
3. **Capability fitness in routing.** The ladder learns to rank a candidate's _ability to
   act on this lane_ — writable session, required tools, budget remaining — above its
   diversity grade. A seat that cannot write is not a candidate for a lane that needs
   writes; six wakes on one read-only lane never happen again.
4. **Acceptance absorption.** A verified close (closer ≠ owner, path exercised) _is_ the
   acceptance for unrisky standard-tier lanes — the founder sees risky and feel-bearing
   lanes only. Mostly ADR 234 follow-through plus policy; turns the sweep back into a
   rare backstop instead of the relief valve.
5. **Pipe widening for the irreplaceable classes.** Batched digests, one-tap verdicts,
   briefs that carry the evidence an acceptor needs. UI-heavy — miley's territory by
   standing rule.

Adjacent, not loop work: a **standing budget knob** for bounded dogfood spend
(pre-authorized per-loop budget; asks only escalate past it) and **seat-readable loop
state** (armed/dark per loop — kills the admin-fact ask class outright).

### 5. Loops-as-data: still deferred, trigger re-armed

Four trigger shapes are now recorded — ready-edge, handoff, continuation, grace-expiry —
a vocabulary forming, but merge has not run and four points do not freeze a schema.
ADR 179's deferral stands. The trigger is re-armed with its condition updated: **after the
merge loop has run under per-loop observability, the recorded vocabulary — including the
firing-memory shape from backlog item 1 — decides whether loops-as-data earns building.**

## Observability & Evaluation

**Traces.** This ADR adds no code path; its instruments read rows that already exist.
Asks-to-founder: directed `ask` acts in `messages` joined to merged PRs
(`git.pr_merged` audit). Wake churn: `wake_leases` grouped by `lane_id` × terminal
status, cross-read with `residency.wake_failed` reasons. Closes: `lane.closed` audit
`detail.reason`. Backlog item 1 adds the one new trace this ADR anticipates — per-edge
firing memory rows, specified in that item's own ADR.

**Eval.** Dataset: the 2026-08-05 ledger snapshot quoted in Context — 26 open
founder-directed asks (the classification corpus for §3), the 8-lane / 2–5× same-seat
churn cluster, close reasons `self_close` 76 · `counterpart_confirm` 53 (of 178), and
the six-wake read-only cluster. Those are the baselines. Weekly reads against them:
**asks-to-founder per merged PR** (headline — falls as items 2 and 4 land, while
verified-close share rises to modal and `review_swept` falls back toward zero), **repeat
wakes with an unchanged failure reason** (→ ~zero after item 1, breaker trips a counted
event), **capability-miss count** (after item 3, any nonzero week is a routing bug by
definition). The taxonomy itself is evaluated structurally: every future loop ADR names
its judgment class and side of the §3 line — a proposal that cannot is returned — and
the 26-ask corpus is re-classified when the merge-loop ADR lands; drift amends §3 here
rather than forking taxonomies.

_Note, 2026-08-21 (ryder)._ **The "repeat wakes with an unchanged failure reason" instrument was
never implemented, and its pathology was found running on a path this ADR did not name: the ask.**
The guardian's alert tier had no damper at all — `shouldAttempt` was consulted only inside
`act.ts`'s `tier === 'auto' && remedy !== null` branch — so `daemon_down`, which ships as `alert`,
raised on every tick that classified it: 30 raises all-time carrying 4 distinct bodies, five of
them byte-identical inside 33 minutes (12:18:10 → 12:51:14), all cleared as a false alarm and none
counted as a series. Repaired by damping on the raise's *reason* rather than its class and carrying
the withheld count forward, which is this ADR's own instrument language turned into a mechanism —
see `docs/wiki/platform-guardian.md` and control `guardian-raise-damped-on-reason`. Two things this
does **not** close: backlog item 1 proper (per-edge firing memory on the wake path) is untouched,
and the instrument still has no periodic read — the fix makes the repeats countable, it does not
count them. The transferable part is that the churn ADR 250 measured on the wake rail is a shape,
not a location: any edge that re-derives from current state with no memory of what it last said
repeats itself, and the ask path had been doing it in plain sight for the whole window this ADR
was measuring.

**Experiment.** The dispatch-handoff exercise registered here at merge time was
**dissolved before it ran** — see the amendment below. Its question ("does the edge
fire") was already answered by a ledger row, and the free check that established this
cost nothing, which is the durable lesson: _run the query that could falsify the
exercise before spending on the exercise._ The replacement question, if a spend is ever
warranted, is why three of four re-derivations of one act expire. Any future probe of a
loop edge must state a success criterion that **can come out false** — the criterion
this ADR shipped with could not, and neither could its first correction. The
loops-as-data question stays an observational experiment per §5: the recorded trigger
vocabulary after the merge loop runs — not a design argument — decides whether the
declarative layer earns building.

## Amendment, 2026-08-06 — the ledger read, corrected

The `## Decision` above stands unchanged; nothing here alters the goal, the doctrine
amendments, the taxonomy, or the backlog. What follows corrects **facts in Context and
Observability** that were wrong at merge time, and records what the correction taught,
because the error shape is itself evidence for backlog item 1.

**1. The handoff edge had fired, and it succeeded.** The original text said it had never
fired. Wrong. Split leases by the `derivation` field in the `residency.wake_leased`
audit detail and the paths separate cleanly. Of 55 handoff-triggered leases going back
to 2026-07-14: **54 are `batched`** — ordinary inbox wakes that merely happen to be
triggered by a handoff, a path that has existed since three weeks before
`loops.dispatch` was armed — and **1 is `work_order`**, the dispatch edge: 2026-08-04
14:56:32, dolly → gptbot, lane `01KZ4QH585V576F3NTD9R30RXZ`, reported. That firing is
dolly handing gptbot the Codex hook-path lane, two days before the exercise to test it
was proposed.

**2. Two successive success criteria could not come out false.** The exercise's original
criterion — "a lease carrying both `act_id` and `lane_id`" — is satisfied by 41 leases,
all of which join to an `ask`: it is the review-wake shape too. Its first correction —
`messages.act = 'handoff'` — fails the same way one layer down, because a handoff is a
directed act and therefore also triggers an inbox wake; 54 of 55 handoff leases are that
path. Only `derivation` discriminates. **An acceptance criterion that cannot come out
false is not a criterion**, and two seats quoted one to each other before either ran it
against existing rows.

**3. `work_order` is not synonymous with dispatch.** 50 `work_order` leases exist from
2026-07-31 14:28:10 — the review loop emits them too. Reading `work_order` as "the
dispatch loop fired" is the same conflation as (2), and any item-1 instrumentation must
key on the edge, not the derivation alone.

**4. Findings for backlog item 1, from the distinguishability check.** These constrain
the design rather than merely motivating it:

- **No phantom leases.** A lease row is inserted inside the host's poll transaction, so
  a row existing proves derivation _and_ delivery. "Never actuated" produces no row at
  all — a breaker can trust that every row it counts reached a host.
- **But the failure's location is not recorded.** "Host received the order and never
  spawned" and "host spawned and the session died before reporting" produce identical
  `expired` rows; `wake_leases` has no `delivered_at` or `spawned_at`. **A breaker
  cannot distinguish a dead host from a dead session** — a real gap for item 1, not a
  nicety.
- **Measurement trap.** The `lease_expired` audit row is written by a lazy sweep, not at
  expiry — observed 4s, 5s and 11s late, and one row landed after a _newer_ lease for the
  same seat existed. Anyone timing wake failures off those timestamps is timing the
  sweep.

**5. The churn baseline is stronger than Context recorded, and it belongs to the inbox
path.** One act (`01KZ9W1GEM…`, miley → ryder) was re-derived four times — 00:23, 02:40,
03:42, 03:44 UTC — three expiring and burning budget, the fourth correctly deferring on
`local-session-live` because ryder was live. Nothing counts them as a series. That is
item 1's pathology with a second seat and a longer window than the eight-lane cluster in
Context; the write-up must say **inbox path**, not dispatch.

Evidence and corrections 1–5 are dolly's, produced by the free check it ran instead of
spending the approved budget, and verified independently against the ledger before this
amendment landed.
