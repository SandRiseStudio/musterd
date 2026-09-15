# 305 — Counterpart close does not rewrite the worker merge attestation

- Status: accepted
- Date: 2026-08-21
- Lane: `01M0K33HMXEPB1NSJXT09Z6ZR7`
- Relates to: [ADR 109](109-seat-git-attribution.md), [ADR 192](192-outcome-acceptance.md),
  [ADR 300](300-awaiting-acceptance-means-landed.md)

## Context

`lane_submit` persists the worker's merge attestation on the lane (`pr`, `sha`, `authorized_by`,
and since ADR 300 a `verification` tier). ADR 192 says a counterpart's later accept carries that
claim into the close. `updateLane` implements `merged` as wholesale replace:
`patch.merged !== undefined ? patch.merged : existing.merged`.

MCP `lane_resolve` and `musterd lane resolve` build `{pr, sha, authorized_by}` from the flags the
caller passed. They have no `verification` field. A counterpart who re-attests — the tool
description used to tell them to — sends a strict subset of the submit stamp.

## Problem

A counterpart close that includes `merged` replaces the worker's attestation with that subset.
Observed 2026-08-21 on izzo's lanes and again on miley `01M0JVEWAG`: before accept, `merged` carried
`{pr, sha, authorized_by}`; after, `{pr, sha}` only. ADR 109's authorizer and ADR 300's
`verification` disappear at the moment the lane becomes a permanent record. ADR 300's eval reads
`merged.verification` over closed lanes, so the instrument measures falsely low — the ADR 294
shape, an instrument broken by an unrelated code path.

The schema invites a partial re-attest and nothing warns.

## Decision

A **counterpart** terminal PATCH (closer ≠ owner, state moving to `done`/`abandoned`) does not
write `merged`. The HTTP handler strips `merged` from the patch before `updateLane` and passes no
fresh attestation into `recordLaneClose`, so `git.pr_merged` flows from the stage-one stamp with
`attested_by` crediting the worker.

A **worker's** own terminal PATCH may still rewrite `merged` (ADR 109 self-attest). An `accept` act
already PATCHes `{state:'done'}` with no `merged` and is unchanged.

Clients still *may* send a partial `merged` on counterpart resolve; the server ignores it. The MCP
and CLI descriptions tell a counterpart to omit the flags.

## Consequences

- Counterpart accept can no longer destroy `authorized_by` or `verification` by using the documented
  resolve flags. Historical rows already stripped stay stripped.
- A counterpart cannot correct a wrong submit stamp at close. That is the cost of freezing the
  worker's claim. Fix the stamp with a worker `lane_submit` repeat, not an acceptor overlay.
- Merge-keys and refuse-loudly were the rejected alternatives: overlay would still let a sent key
  clobber; refuse would 400 today's MCP/CLI.

## Amendment 1 — strip only what stands (2026-09-14, lane `01M1VHGVBWYM4S73D68SJ5BG7D`)

The decision presumed a stage-one stamp exists. On a lane the worker never submitted — stanley told
delta to skip `lane_submit` and closed `01M1VEMAKX` (#1370, `d2a0f0fe`) as a non-owner with the
flags the tool told him to pass — the unconditional strip discarded the only attestation anyone
would ever offer: the row closed `done` with `merged` null and `git.pr_merged` carrying nothing but
the lane id (measured by delta 2026-09-06, re-read from the row 2026-09-14). The Consequences'
remedy, a worker `lane_submit` repeat, is unavailable on a terminal lane, so the loss was permanent,
and ADR 300's instrument read the lane unattested forever — the ADR 294 harm this ADR was written
to prevent, arriving through this ADR.

**Amended:** the counterpart strip applies only when `before.merged` is non-null. A counterpart may
**establish** an attestation on a lane that has none; it may not **replace** one that stands. Every
case the Problem cites had a standing stamp and is unchanged. The `git.pr_merged` row then carries
the closer's flags with `attested_by` the closer — true, since the worker attested nothing.

The Decision's last line also claimed "the MCP and CLI descriptions tell a counterpart to omit the
flags"; the shipped `lane_resolve` description said the opposite. It now says which case is which.

Falsify: a non-owner `lane_resolve {pr, sha, authorized_by}` on a never-submitted lane that closes
with `merged` null.

## Amendment 2 — a verb for NONE, and whose SHA it is (2026-09-14, lane `01M2GR04348JNWDAKJGSMJQZJS`)

**Observed.** delta's lane `01M2GBGA03` was closed at 18:25:16Z from the VM with stanley's PR 1376 /
`23ae48bb` — the attestation of stanley's twin lane `01M2GB4WZP`, which was still awaiting
acceptance. The seat's own `lane_resolve` did it: the SHA is on `origin/main`, so the ancestor check
passed, and nothing asked whose merge it was. delta published the correction an hour later and the
row never moved, because **a merge attestation could not be cleared through any exposed path**:
`updateLane` honours `merged: null`, but `UpdateLaneSchema.merged` was `.optional()` without
`.nullable()`, `lane_update` and `musterd lane update` exposed no `merged` at all, and the live
daemon answered `PATCH {"merged": null}` with `400 merged: Expected object, received null`
(stanley, 20:00Z). This ADR's strip/establish rules decide *which* attestation a lane ends up with;
there was no verb for none.

**Amended, two rules, both in `decideLanePatch` so the hub's arbitration and the local path agree:**

1. **`merged: null` clears.** The wire accepts it (`.nullable()`), `lane_update {merged: null}` and
   `musterd lane update --clear-merged` send it, and the clear is a `lane.updated` row with
   `changes.merged.to: null`, so a peer folds it. **Owner or admin only** — a counterpart's clear is
   refused `forbidden`, for the reason the strip rule exists: a counterpart neither replaces nor
   removes the worker's stamp.
2. **A SHA that already attests a different seat's lane is refused** (`conflict`, naming that lane
   and its owner) on any patch carrying `merged.sha`. A squash SHA lands one branch. The same seat's
   twin lanes may share one PR — measured on the live db 2026-09-14: 657 distinct attested SHAs, 10
   on two lanes, nine of them one owner's twins closed by one PR, the tenth this defect — so the
   rule is cross-owner, not cross-lane.

Not amended: `lane_resolve`'s ancestor check stays what it is. It answers "did this land on main",
which is the question it was built for; "is it *this* lane's landing" is rule 2's question and is
answered where the other lanes are visible, on the daemon.

Falsify: on a daemon past this amendment, `PATCH {merged: null}` from the owner returns 200 with
`merged: null`; from a non-owner, 403; and a `lane_resolve` naming a SHA another seat's lane carries
returns 409 naming that lane.

## Observability & Evaluation

**Traces.** No new audit action. `lane.closed` + `git.pr_merged` keep their shapes. After this,
a counterpart confirm's `git.pr_merged` must still carry `authorized_by` when submit did, and the
lane row must still carry `verification` when submit did.

**Eval.** Dataset: lanes that entered `awaiting_acceptance` with `merged.verification` set, then
closed `counterpart_confirm`. Success: the closed row still has that `verification`. Baseline
2026-08-21: at least two live counterpart closes dropped fields (izzo's pair; miley `01M0JVEWAG`).

**Experiment.** The integration test replays the MCP patch shape (partial `merged` on a non-owner
`done`) and asserts the submit stamp is intact. A second test locks that an *owner* close with the
same patch still replaces.
