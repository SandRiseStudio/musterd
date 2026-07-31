# 187 — The wake pool knows what it would bring: attestation outlives presence

- Status: proposed — 2026-07-31. Authored by ryder from a brainstorm with nick the same day, on a
  lane opened by stanley (`01KYV4Q6GY`) and re-scoped after measurement. Number **187** — verified
  free against `origin/main` at branch time (highest there: 186, dolly's).
- Date: 2026-07-31
- Builds on: [ADR 158](158-model-attestation-truth.md) (attestation truth — this ADR extends its
  "an ended session is not re-observed; what it last attested is the truth about it" one step
  further, to the seat), [ADR 172](172-model-family-posture.md) (the posture and `wake_pool` this
  reshapes), [ADR 169](169-two-stage-close.md) (the review pick whose candidate set this is about),
  [ADR 179](179-board-triggered-work-order-wakes.md) (the review loop that would spend on a wake),
  [ADR 056](056-evaluation-framework.md) (why a false diversity claim is worse than none),
  [ADR 101](101-model-as-a-variable.md) (the attestation itself), [ADR 131](131-harness-residency-wake-ledger-host.md)
  (what a wake costs).

## Context

The two-stage close (ADR 169) routes a review to a counterpart from a different model family. It has
never once caught anything. The live audit log says why, and says it eleven times in a row:

```
lane.ready_for_review ×11 (2026-07-28 → 2026-07-31), every one:
  "no_candidate": true,
  "family_posture": { "state": "monoculture", "attesting": 2–4,
                      "families": {"claude": …}, "wake_pool": 7–10 }
```

Seven to ten seats idle every time, and not one of them reachable as a reviewer.

### What the lane said, and what measuring found

The lane was opened on the reading that a directed `ask` is not wake-eligible, so `lane_ready` cannot
reach an offline reviewer. **Measured, that is true.** Running `claimWakeLeases` against an offline
enrolled seat: an `ask` derives no wake; a `handoff` does; an urgent-flagged `message` does; a plain
`message` does not. The controls behave, so it is the eligibility predicate and not some unrelated
gate (offline check, caps, cooldown).

It is also not the binding constraint. Two gates fire upstream of it:

1. **`pickReviewCounterpart` filters candidates to live seats before anything else.** An offline seat
   is never picked, so the review ask is never composed, so its wake-eligibility is never consulted.
   From `lane_ready`, that path is unreachable.
2. **Even relaxing that, an idle seat has no family.** `memberFamily` reads the attested model from
   `presence`, which holds only live seats — three rows on the live daemon. An idle seat resolves to
   `unknown`, and an unknown-family seat is ineligible for cross-family review by construction. A
   second, independent gate.

So widening the ask predicate would have fixed the third link of a chain whose first two links are
broken, and the review-catch rate would have stayed zero.

### The substrate is not missing — it is discarded

Every attestation writes an `occupancy.model_attested` audit row. That table is append-only and
permanent: 661 rows, ten seats, back to 2026-07-08. It knows precisely what the idle seats are:

| seat                  | last attested | when       |
| --------------------- | ------------- | ---------- |
| `compo`               | composer-2.5  | 2026-07-14 |
| `grokbot`, `grokbot2` | grok-4.5      | 2026-07-10 |
| `gptbot`              | gpt-5.6-sol   | 2026-07-09 |
| `tinybot`             | qwen3:4b      | 2026-07-09 |

Five non-claude seats, families on record, invisible to the one query that needed them. And the
choice of source is not a judgement call: `route.ts` already states the doctrine — the occupancy
attestation is the **source**, the per-act `meta.model` stamp is the **dataset**. The audit row is
the source. The index that makes reading it cheap (`idx_audit_team_action_ts`) shipped in v25.

### `wake_pool` does not mean what ADR 179 says it means

ADR 179 describes `wake_pool` as "the offline seats that would restore diversity." What
`teamFamilyPosture` computes is every idle agent, family unknown. Waking one is therefore a lottery,
at ADR 131 prices ($0.91–1.51 a wake) — you can spend it and get another claude seat.

## Decision

**A seat's attestation outlives its presence. The wake pool says what waking each seat would bring.**

### `wake_pool` carries candidates, not names

`FamilyPosture.wake_pool` becomes `WakeCandidate[]` — `{ seat, family, attested_at }` — where
`family` comes from the durable `occupancy.model_attested` record, newest-wins, and `attested_at` is
when that claim was made. A seat that has never attested reads `unknown` with a null timestamp: the
record cannot invent one.

`describeFamilyPosture` sorts cross-family candidates **first**, so the bounded three-name line
spends its slots on the seats that would actually change the posture rather than on a fourth claude
seat. On live data the difference is the whole point:

```
before   idle & enrollable: dolly, izzo, miley +5
after    idle & enrollable: grokbot (grok, 20d ago), compo (composer, 16d ago), miley (claude, 18h ago) +5
```

### Stale attestations are trusted and labelled, never expired

No expiry window. ADR 158 §7 already settled the principle — an ended session is not re-observed, and
what it last attested is the truth about it — and this extends it from the session to the seat. The
age rides along so a reader can discount it.

The reason no expiry is safe is that the durable value is only ever used to **target a spend**, never
to certify a review: a woken seat re-attests on claim, so a stale guess costs one wake and
self-corrects. There is no path by which it produces a review whose diversity claim is false. A
`WAKE_ATTESTATION_TTL` would be a second constant needing its own tuning, in exchange for discarding
the only evidence that exists about exactly the population the wake pool is for.

### The live predicate stays presence-only — structurally, not by convention

`memberFamily` — the predicate `pickReviewCounterpart` routes on — keeps reading `presence` alone,
and the durable map is unreachable from it.

This is the load-bearing half of the design. A live seat whose current occupancy attested nothing
must read `unknown` and stay ineligible. If it fell back to what it attested last week, a stale
memory could certify a live review as cross-family — and a review whose diversity claim is false is
worse than no review at all (ADR 056), because the two-stage close would then report a catch it did
not make. The two questions are kept in separate functions so the mistake cannot be made by
forgetting an argument: "what is this seat running now" reads presence; "what would waking this idle
seat bring" reads the durable record.

## What deliberately does not change

- **Who reviews.** `pickReviewCounterpart` still requires a live counterpart. This ADR makes the
  posture honest and the pool targeted; it does not spend a cent or route a single new review.
- **Whether to wake a reviewer at all.** That is a spend decision and stays with
  [ADR 179](179-board-triggered-work-order-wakes.md) increment 5 (lane `01KYKH2SCC`), which wants to
  own it as a loop with its own toggle. This ADR is its precondition: increment 5 can now pick a
  wake target instead of drawing one.
- **The `ask` wake-eligibility predicate.** Measured, real, and still deliberately unfixed — it is
  the last link, and it only becomes worth deciding once a wake target can be chosen on evidence.
  The measurement is recorded on lane `01KYV4Q6GY` so the next owner does not have to re-derive it.
- **`presence` reaping.** The ephemeral table stays ephemeral. The fix is to read the durable record
  that already exists, not to make presence outlive the session it describes.

## Observability & Evaluation

- **Traces.** The `lane.ready_for_review` audit row already carries `family_posture`; its
  `wake_pool` count is unchanged, and the posture line that rides the no-candidate sanction now names
  the cross-family remedy and its age instead of three arbitrary seats. The eleven-row
  `no_candidate` series above is the before-baseline, and it stays queryable — this ADR adds no new
  row and removes none.
- **Eval.** No dataset, no baseline, and none is warranted: this changes what a query reads, not what
  any model does. Direct assertion stands in. Tests pin the durable read, newest-wins on a seat that
  switched models, `unknown` for a seat that never attested, cross-family-first ordering — and, most
  importantly, the negative: a live seat with a stale durable record must NOT count as attesting, and
  must not appear in the pool. Verified against a copy of the live database (never the live one):
  the posture line surfaces `grokbot (grok, 20d ago)` and `compo (composer, 16d ago)`, which were
  anonymous names before.
- **Experiment.** None. The claim ("the pool can name a cross-family candidate") is a deterministic
  property of the data, already confirmed on real rows. The interesting experiment — whether waking a
  cross-family reviewer catches defects worth the spend — belongs to ADR 179 increment 5, and this
  ADR exists to make that experiment possible to run on evidence rather than on a coin flip. Its
  pre-registration should be written there, not here.

## Consequences

- The cross-family remedy stops being invisible. Two real candidates exist on this team today and
  neither could be seen.
- The review-catch rate is still zero, and will stay zero until someone decides to spend on a wake.
  That is deliberate: this ADR makes the decision informable, not automatic.
- `FamilyPosture.wake_pool` changes shape. Every consumer is in-repo and moves with it.
- The durable read scans one team's attestation history per posture (661 rows at ~30/day when this
  shipped). Cheap for years on the v25 index; if it ever stops being cheap, the fix is a per-seat
  projection, not a different source.
- A seat renamed or re-created reuses its name's history. Attestation is keyed by seat name because
  that is what the audit row records — consistent with how the roster treats a name as the durable
  identity.

## Related

- Lane `01KYV4Q6GY`, opened by stanley 2026-07-31, re-scoped the same day after measurement.
- [#536](https://github.com/SandRiseStudio/musterd/pull/536) — the sibling lane that fixed the
  handoff wake path, and the measurement protocol this lane borrowed.
