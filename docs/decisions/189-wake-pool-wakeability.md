# 189 — `wake_pool` marks wakeability; it does not pretend every idle seat can be woken

- Status: accepted
- Date: 2026-07-31
- Builds on: [ADR 187](187-durable-model-attestation.md) (what waking a seat would
  bring — family + age), [ADR 179](179-board-triggered-work-order-wakes.md) (the
  board-triggered wake that will spend from this pool), [ADR 172](172-model-family-posture.md)
  ("enrolled-but-silent agents are the wake_pool" — aspirational until this ADR),
  [ADR 131](131-harness-residency-wake-ledger-host.md) (enrollment is the opt-in that
  makes a seat wakeable).
- Lane: `01KYWG6ZE511P8GBJGM6M72EZM`.

## Context

ADR 187 made `wake_pool` honest about **family**: idle seats carry `{seat, family,
attested_at}` from the durable attestation record, so a monoculture posture can name
`grokbot (grok, 20d ago)` instead of three anonymous claude seats. That is the
precondition for ADR 179 increment 5 — pick a wake target on evidence rather than draw
one.

It did not make the pool honest about **whether the seat can actually be woken**.
Enrollment lives in the `residency` table (ADR 131); the host registry and workspace
binding live on the machine. `teamFamilyPosture` joins neither. On revive, the two
cross-family remedies the posture line now names — `grokbot`, `compo` — are not
host-enrolled. Waking them is impossible; the pool still advertises them as the
remedy.

Actual wakes already refuse the unenrolled: `claimWakeLeases` only leases seats
enrolled to the polling host. The gap is informational — the posture says "wake X"
and dispatch cannot — not a safety hole. ADR 179 increment 5 will close the loop by
spending from the pool; spending a name you cannot wake is the failure mode this ADR
removes.

## Problem

Two truths, no shared vocabulary:

1. **Posture** lists every idle agent as a wake candidate.
2. **Dispatch** only actuates seats that are enrolled, whose host is alive, and whose
   workspace still exists.

Filtering the unenrolled out of the pool would lie about diversity potential ("no
cross-family remedy" when the remedy exists but needs `residency on`). Inventing a
second predicate in the host loop would drift from whatever the pool claims. The
agreed shape is **mark, not filter** — one reason enum, one pure function of known
facts, used by both sides.

## Decision

### 1. `Wakeability` — four reasons, one enum

```ts
'wakeable' | 'not_enrolled' | 'enrolled_dead_workspace' | 'enrolled_host_stale'
```

- **`wakeable`** — enrolled, and no known host-side defect. The seat is a spendable
  remedy.
- **`not_enrolled`** — no `residency` row. Visible in the pool so the posture still
  names the diversity gap; not a spend target until someone runs `residency on`.
- **`enrolled_dead_workspace`** — enrolled, but the host registry points at a missing
  workspace / binding (the stale-pointer case the host loop already reports in prose).
- **`enrolled_host_stale`** — enrolled, but the host that owns the seat is not
  reachable / not polling (reserved for evidence the layer has; see below).

### 2. One pure predicate: `wakeabilityFromFacts`

Lives in `@musterd/protocol` beside `WakeCandidate`. Callers pass only what they
know; unknown host facts are omitted, never guessed:

| Caller | Facts it can supply | Reasons it can return |
| ------ | ------------------- | --------------------- |
| Server (`teamFamilyPosture`, lease path) | `enrolled` | `wakeable` \| `not_enrolled` |
| Host (`pollHostOnce`) | `enrolled: true` + `workspace_readable` (+ optional `host_reachable`) | all four |

A fact the layer does not have is not invented as a negative — the server never
marks `enrolled_dead_workspace` from the absence of a path it does not store
(ADR 131: the daemon never learns workspace paths).

### 3. `WakeCandidate.wakeability` — mark every idle seat

`WakeCandidate` gains a required `wakeability` field. `teamFamilyPosture` joins
`listWakeableMemberIds` and marks each idle agent; names stay in the pool. Ranking
for `describeFamilyPosture` prefers **wakeable cross-family** seats for the three
slots, then other wakeable, then marked-but-unwakeable — so the bounded line spends
its ink on seats dispatch can actually reach, without erasing the ones it cannot.

The posture copy shifts from the aspirational `idle & enrollable:` to `idle:` with
the reason visible on non-wakeable entries (e.g. `grokbot (grok, 20d ago, not_enrolled)`).

### 4. Dispatch uses the same enum

- **Leases** already scope to enrolled hosts; they may call the predicate for a
  consistent audit reason rather than a bespoke string.
- **Host actuation** maps the existing registry / workspace failure branches onto
  `enrolled_dead_workspace` (and `not_enrolled` when the seat is absent from this
  machine's registry despite a daemon lease — a cross-machine mismatch). The freeform
  `reason` string remains for operator prose; an optional `wakeability` on the wake
  report carries the enum so audits stay queryable.

## What deliberately does not change

- **Who gets woken today.** Inbox-driven leases are unchanged; this ADR does not spend
  a wake from the pool. ADR 179 increment 5 still owns that loop — and now has a pool
  whose spendable entries are marked.
- **The live review picker.** Still presence-only (ADR 187's structural split).
- **Daemon path ignorance.** Workspace paths stay on the host. Dead-workspace is a
  host refinement of an enrolled seat, never a server guess.

## Consequences

- Protocol schema change (ADR-gated): every `WakeCandidate` consumer updates in-repo.
- Revive's posture line will keep naming `grokbot` / `compo` but mark them
  `not_enrolled`, so ADR 179 increment 5 will not pick them until enrolled.
- Host reports gain a typed wakeability axis without replacing the human-readable
  reason.

## Observability & Evaluation

- **Traces.** `family_posture` on `lane.ready_for_review` still stores `wake_pool` as a
  count; the describe line that rides the sanction now distinguishes wakeable from
  marked-unenrolled. Wake-report audits may carry `wakeability` beside `reason`.
- **Eval.** Direct assertion: idle+unenrolled → `not_enrolled`; idle+enrolled →
  `wakeable`; describe ranking prefers wakeable cross-family over not_enrolled
  cross-family; host dead-workspace branch reports `enrolled_dead_workspace`. No
  model eval — deterministic join.
- **Experiment.** None here. The spend experiment (does waking a marked-wakeable
  cross-family reviewer catch defects worth the cost?) belongs to ADR 179 increment 5.
