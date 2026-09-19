# 422 — Relocating the hub is a transplant, not a re-point

- Status: proposed
- Date: 2026-09-19
- Lane: `01M1T3HKKBZ3BKSB2EZXKS7ZFX`
- Closes: [ADR 376](376-the-hub-is-the-machine-the-team-was-created-on.md) decision 4 ("deliberately not decided")
- Builds on: [ADR 325](325-multi-machine-federation.md) (hub authority, offline semantics), [ADR 328](328-machine-credential.md) (§4 seat→node residence), [ADR 360](360-push-level-residence.md) (push-level residence), [ADR 390](390-the-cloud-seat-holds-what-its-job-needs.md) (the cloud seat)

## Context

[ADR 376](376-the-hub-is-the-machine-the-team-was-created-on.md) made the hub a rule rather than an
inference: the creator's machine is the hub, an enrolled joiner cannot mint an invite, and a hub
cannot enroll. Its decision 4 named the remaining question and refused to answer it — *"Relocating
the hub is its own increment … a ceremony, with an ADR. Named here so the cloud-seat lane inherits
the question; deliberately not decided here."* The cloud-seat lane ([ADR 390](390-the-cloud-seat-holds-what-its-job-needs.md))
inherited it and did not decide it either.

The concrete case exists today. The laptop is the hub. `delta` is an always-on Fly VM in `sjc`
(`musterd-seat-delta`, machine `850e40a4499168`, `started`), enrolled over a tailnet, holding the
team's full replicated history. [ADR 325](325-multi-machine-federation.md)'s offline rule means that
while the laptop sleeps, every hub-authoritative act on delta refuses `hub_unreachable` — and the
laptop sleeps: `pmset -g custom` reports `sleep 1` on both AC and battery (verified 2026-09-19).

## Problem

Two problems, and the second is the one that makes this an ADR rather than a runbook.

### 1. The instrument this decision was told to wait on cannot answer the question

The lane says to instrument first: *"count `hub_unreachable` refusals on the VM per day … and let the
number say whether relocation is worth its ceremony."* That instrument is **confounded, in the
direction that produces a false negative.**

A refusal is emitted only when delta *attempts* a hub-authoritative act. `delta` is a **wakeable**
seat — it acts when woken, and its wake schedule is driven by the same human and the same team
activity that keep the laptop awake. The count therefore measures `delta's activity × hub
unavailability`, not hub unavailability. The hours when the hub is most reliably down — overnight —
are exactly the hours when delta is least likely to be trying. A near-zero count would be read as
"relocation is not needed" when it may mean only "nothing was awake to be refused."

This is the shape [finding 007](../research/007-compliance-under-deny-retro-audit.md) already
recorded once: a deny-row count that cannot separate *complied* from *never-attempted*. We should not
buy it a second time.

The three emission sites are real and greppable (`sync_claim_hub_unreachable`,
`sync_trust_hub_unreachable`, `sync_policy_hub_unreachable` in `packages/server/src/sync/claim.ts`),
so the numerator is cheap. What is missing is the **denominator**.

### 2. Relocation is not a re-point, and the code says so in three places

ADR 376 §4 describes the ceremony as "re-pointing every joiner's `node.json`, handing the canonical
`sync_log` over with its `hub_seq` intact, and re-binding residence." Read against the code, that
understates it. Three mechanisms make a naive swap fail, two of them **silently**.

**(a) The demoted hub cannot re-enroll under its own node id.** `bindNode`
(`packages/server/src/store/nodes.ts`) answers an id conflict with `DO NOTHING`, and its own comment
names case 2: *"The hub's own row for this team. A hub never enrolls with itself, so its `local_node`
row is unbound permanently. Binding it would let the joiner stamp events as the hub."* Node
**identities** replicate — the pull response carries a `nodes` summary (`id`, `label`,
`last_seen_at`) applied by `upsertForeignNode` — so delta already holds the laptop's node id. When
the laptop tries to enroll into delta with that id, the guard refuses it, correctly and permanently.
The demoted hub must therefore enroll as a **new node id**, which orphans every `seat_nodes` row and
every historical `origin_node` that names the old one.

**(b) The residence ledger does not replicate at all.** `seat_nodes` appears in
`db/migrations.ts` and `store/nodes.ts` and **nowhere in `sync/`**. Delta's copy is empty. Since
`bindSeatToNode` is first-writer-wins (`INSERT … WHERE NOT EXISTS (any row for this seat)`), a
relocated hub starts with every seat unbound and binds each one to *whoever speaks for it first* —
with no error, because that is the designed happy path for a new seat. Worse, [ADR 360](360-push-level-residence.md)
decision 2 says the hub binds its residents on **loopback** too, and that the hub writes rows *as* a
joiner's seat on purpose (`arbitrateClaim` writes `lane.claimed` under the claiming seat). So a
freshly promoted delta will capture bindings for seats that live on the laptop simply by arbitrating
their claims. The release valve is an admin `unbindSeat`, which means the failure is recoverable —
but it is discovered late and looks like a permissions bug.

**(c) A joiner whose cursor outruns the new hub fails permanently, not transiently.** `fetchPage`
(`packages/server/src/sync/pull.ts:200-212`) treats a `409` — hub head below this daemon's pull
cursor — as impossible: it logs `sync_pull_impossible_resume` at **error** and throws *"hub head is
below this daemon's pull cursor … impossible, refusing"*. The comment is explicit that this is not
something a retry fixes. This is the correct guard and it is also the sharpest ordering constraint on
the ceremony: if any joiner is re-pointed at a new hub whose `sync_log` head is below that joiner's
cursor, that joiner is wedged until an operator intervenes.

## Decision

**Relocating the hub is a transplant of hub-local state under a freeze, not a re-point of
configuration. It is authorized by a measurement of hub availability, not of refusals.**

### 1. The trigger is hub availability, measured independently of what delta was doing

The refusal count stays as a **secondary** signal and is never the trigger on its own. The
authorizing measurement is `packages/server/src/…` daemon **reachability from delta**, sampled on
delta's own timer, independent of whether delta has work: one probe of the hub's `/health` per
minute, recorded locally, reported as *fraction of wall-clock hours per day the hub did not answer*.
That is the denominator problem (2)(1) names, and it is the number that says what relocation buys.

Relocation is warranted when hub unavailability is both **material** (the threshold is nick's, set
before the data is read, per the pre-registration habit the cookoff manifest already uses) and
**not cheaply removable** — a `caffeinate` or a power-setting change that keeps the laptop awake is a
strictly smaller act than moving the team's authority, and must be ruled out first.

### 2. The ceremony, ordered, with the freeze explicit

No step may be reordered; steps 3–6 happen inside one freeze window.

1. **Pre-flight.** Confirm delta's `sync_log` head ≥ **every** joiner's pull cursor, and record both.
   This is the (2)(c) guard, checked before anything moves rather than discovered by a wedged joiner.
2. **Announce and freeze.** All seats stop acting. The freeze is what makes the transplant a
   snapshot rather than a moving target; every invariant below is stated against a quiet ledger.
3. **Drain.** Every joiner pushes to exhaustion and pulls to exhaustion against the *old* hub, so no
   event exists only on a joiner. Verify: each joiner's cursor equals the old hub's `hub_seq` head.
4. **Transplant the hub-local state that does not replicate.** From the old hub to the new:
   `sync_log` in full, `sync_meta.next_hub_seq`, and `seat_nodes`. The first two preserve order; the
   third is what (2)(b) requires, and it is a **transplant, not a re-mint** — re-minting is the
   silent-capture failure.
5. **Re-identify the machines.** The new hub's `local_node` row becomes its own; the demoted hub
   enrolls as a **new node id** ((2)(a)), and the `seat_nodes` rows naming its old id are rewritten
   to the new one as part of the same transaction as step 4. The old id is retained, unbound, so
   historical `origin_node` references still resolve to a labelled node.
6. **Move the authority.** The creator's admin credential is re-minted on the new hub rather than
   copied — a credential that has existed on two machines is a credential with two custodians, and
   the ADR 328 posture is that secrets are held where they are used.
7. **Re-point joiners and unfreeze, one at a time.** Each joiner's `node.json` entry for the team is
   rewritten to the new `hub_url` with its new credential. Re-point **one** joiner, verify it pulls
   past its recorded cursor with no `sync_pull_impossible_resume`, and only then continue.
8. **Rollback.** Until step 7 completes for the last joiner, the old hub is still intact and quiet:
   rollback is re-pointing the re-pointed joiners back. After the first *new* event is accepted on
   the new hub, rollback is no longer a re-point — it is this ceremony run in reverse, and the ADR
   says so rather than pretending the window stays open.

### 3. What this ADR does not decide

Whether to relocate. That is nick's, on the §1 measurement, and this ADR is deliberately written so
that the ceremony exists **before** the decision rather than being designed under the pressure of
wanting it. The `hub` flag ADR 376 rejected "can still come with decision 4 if relocation needs it" —
on this design it does not: the two refusals plus `local_node` already carry the rule, and the
ceremony moves state rather than announcing a role.

## Consequences

- **The ceremony is writable today and the trigger is not.** That asymmetry is the point: the
  expensive, error-prone part is the transplant, and it can be specified, reviewed and rehearsed
  while the question of whether to run it is still open.
- **`seat_nodes` is now known to be hub-local.** That fact was implicit in the absence of a fold
  case; it is now a named property with a consequence attached. If a future increment replicates it,
  step 4's third item and step 5's rewrite both change, and this ADR gets a dated note.
- **A rehearsal is possible and cheap.** The whole ceremony can be run on a scratch team with two
  daemons and no cloud spend. Until it has been, the ordering in §2 is reasoned from code, not
  observed — see Observability.
- **The offline cost stays until relocation or a power change.** Recording that plainly is the
  honest half of ADR 376 §4's option (b): the laptop remains hub, and hub-authoritative acts on delta
  keep refusing while it sleeps.

## Observability & Evaluation

- **Traces:** the three existing `sync_*_hub_unreachable` warns
  (`packages/server/src/sync/claim.ts`) carry the refusal side already — no new span. The ceremony
  adds none: its steps are operator acts, and their trace is the `nodes`/`seat_nodes` rows before and
  after, plus `sync_pull_impossible_resume` as the single error that says a joiner was wedged.
- **Eval — dataset and baseline.** *Dataset:* one week of paired daily samples from delta — the
  per-minute hub `/health` probe (unavailable hours/day) beside the daily count of the three
  `hub_unreachable` warns. Neither series exists yet; collecting them is the first increment behind
  this ADR. *Baseline:* the current refusal count alone, which is what the lane originally proposed
  and what §1 argues is insufficient. *Falsifier:* if the daily ratio of refusals to unavailable
  hours is stable across that week, the confound asserted in Problem 1 is not material and §1 should
  collapse to the cheaper instrument. The prediction is that it is **not** stable — refusals
  clustering in working hours, unavailability clustering overnight. Stated before the data, so it can
  lose.
- **Experiment — the ceremony rehearsal.** Run §2 on a scratch team with two daemons and a third
  joiner, no cloud spend. *Pass:* the joiner pulls past its pre-freeze cursor with no
  `sync_pull_impossible_resume`; no seat's binding names a node it did not live on before the move;
  the demoted hub's first push is accepted. *Per-step falsification:* each of Problem (a), (b) and (c)
  must be reproducible as a failing run by skipping its corresponding step — a ceremony whose steps
  cannot each be shown to matter has steps in it nobody needs.
- **Not yet measured, stated rather than buried.** Hub availability has never been sampled. The
  figures in Context are the laptop's *settings*, not its behaviour, and no claim about what
  relocation would buy appears anywhere in this ADR.
