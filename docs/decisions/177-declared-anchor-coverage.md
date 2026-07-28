# 177 — Declared anchor coverage: a drift check that watches 13% of its subject

- Status: accepted — 2026-07-28. Authored by ryder (lane `01KYNBYEW84Z72GPJJS00Z64WY`), directed by
  nick after [PR #472](https://github.com/SandRiseStudio/musterd/pull/472) found two shipped arcs
  filed as unbuilt. Number **177** — 176 left free for izzo's install-topology L4, announced in-band
  to avoid the third numbering collision of the day.
- Date: 2026-07-28
- Builds on: [ADR 112](112-steward-seat.md) (the keep-the-record-honest decision that birthed
  `roadmap-truth:check`), [ADR 173](173-absent-is-not-unknown.md) (the principle this applies —
  absent is not unknown), [ADR 084](084-lanes-join-the-plan.md) (derive status, never store a
  second flag), [ADR 052](052-traces-evals-first-class-gate.md) (the check-in-`format:check` pattern).

## Context

`roadmap-truth:check` anchors the declared roadmap to reality. Its rule 3 is the drift detector, and
it is **bidirectional** by design: a shipped item whose freezing ADR is not accepted is an error, and
— the drift that motivated writing it — an _unshipped_ item whose freezing ADR _is_ accepted is
flagged as a stale roadmap.

The rule is sound. It was also, in practice, nearly inert.

PR #472 found two items sitting in "Reserved (in v0.1, built later)" with ten merged PRs between
them: `human-work-identity` (six) and `two-stage-close` (four). The check was green throughout. On
first look this read as the detector being blind in that direction; it is not, and that first
diagnosis was wrong. Rule 3 is guarded by `if (item.frozenBy !== undefined)`, and **only 11 of 82
items declared `frozenBy`**. The detector watched 13% of its subject, and both drifted items were in
the unwatched 71.

## Problem

The field's own documentation named the flaw without noticing it: _"Optional: only items with a
dedicated freezing ADR set it."_ Under that rule `frozenBy: undefined` carries two different facts:

1. **no single ADR freezes this item** — true and knowable (`python-sdk` is a port with nothing to
   freeze; `no-orchestrator` is a principle, not a build; `human-work-identity` was frozen in a spec);
2. **nobody recorded whether one does** — an omission.

The check cannot distinguish them, so it skips both identically. This is exactly the failure
[ADR 173](173-absent-is-not-unknown.md) names: an absent value read as a known-empty one. ADR 173
registered an experiment — _does the next derived read ship three-valued at introduction? two
consecutive corrections ⇒ replace the prose with a mechanism_ — and this is the next one. The prose
("Optional: only items with…") is precisely what failed.

A second, subtler problem surfaced on contact with the data. Rule 3's second half assumes an accepted
ADR implies a shipped item. That does not hold here: ADRs go `accepted` when the **decision** is
frozen, and the build may land over many increments. ADRs 104, 122, 131, 144 and 145 are all accepted
against items still marked unbuilt. For a mismarked item, "mark it shipped" is the right instruction.
For an item honestly five-increments-into-six, it is not — and the binary `shipped`-xor-`plan` schema
has no way to say so. Left unaddressed, backfilling the anchor would force the author to either mark
unfinished work shipped (a lie) or drop the anchor (defeating the point).

## Decision

**Every roadmap item declares exactly one of `frozenBy` or `unfrozen`.** The negative becomes a
stated fact carrying its reason, not an omission:

- `frozenBy: N` — the ADR that _is_ this item, distinct from the `refs` it merely builds on.
- `unfrozen: '<why>'` — no single ADR freezes it, and why (a reserved stub with no design, a
  principle rather than a build, a design frozen somewhere that is not an ADR).

Declaring neither is an error. This mirrors the `shipped`-xor-`plan` invariant `resolveItem` already
enforces, and lands in the same place: **thrown at import**, so the data cannot be authored wrong,
with `roadmap-truth:check` re-asserting it defensively and reporting coverage on every run.

**A third value carries the mid-arc case: `building: '<what remains>'`,** set alongside `frozenBy`
when the ADR is accepted and increments have merged but the item is not finished. It suppresses the
stale-roadmap error — which would be a false positive there — and is counted and reported, so
mid-flight arcs are visible rather than silent. It is rejected on a shipped item (a finished item has
no remainder) and without `frozenBy` (a remainder needs an arc to be a remainder of).

`building` is deliberately **not** a new status: the roadmap still renders `shipped` xor `plan`, and
`status` stays derived (ADR 084). It annotates the anchor, it does not become a third column.

### What this does not do

It does not require an ADR per item — `unfrozen` is a first-class answer, and 18 items take it. It
does not verify that a declared anchor is the _right_ ADR (a plausible-but-wrong anchor still passes;
review is the control, and one such anchor was caught by review here — `install-topology` had been
auto-assigned ADR 170, which freezes one of its increments, not the item). It does not backfill
`shipped` for the arcs the new coverage exposed.

## Consequences

- Coverage went from **11 to 64 items under rule 3 (13% → 78%)**; the remaining 18 are declared
  unfrozen with a reason, so the whole roadmap is now accounted for either way.
- **Six items were immediately exposed** as having an accepted freezing ADR while reading unbuilt:
  `harness-residency`, `cookoff-value-experiment`, `insight-dashboard`, `tool-call-telemetry`,
  `mcp-tool-surface`, `human-role-reevaluation`. Each names merged PRs in its own prose. They are
  declared `building` with a named remainder rather than silently marked shipped — an honest holding
  state, not a resolution. **Each is genuinely under-marked and wants an audit by whoever owns the
  arc.** That work is deliberately not in this ADR: marking something shipped requires verifying what
  actually landed, and doing that for six arcs from the outside is how false anchors get written.
- Authoring a new item costs one more decision. That is the intended tax: the omission it replaces was
  invisible and cost a wrong roadmap for weeks.
- `roadmap.data.ts` ships in the web bundle, so anchors cost bytes. Reasons are held short and a test
  caps them at 120 characters.

## Observability & Evaluation

**Traces.** No runtime telemetry — this is a build-time gate, like `obs-evals:check` (ADR 052). Its
observable output is the `roadmap-truth:check` summary line, which now reports anchor coverage
(`N frozenBy ADRs consistent (P% under drift watch; U declared unfrozen, B mid-arc)`) on every CI run
and every local `format:check`.

**Eval.** _Dataset:_ the 82 items in `roadmap.data.ts`, and the drift history in git. _Baseline,
exact by construction:_ 11 of 82 items (13%) under rule 3 at the moment of writing, with two known
escapes (#472) and six more found the day coverage was added. _Metrics:_ **anchor coverage** (items
with `frozenBy` / all items — now 78%, and it cannot silently fall, because an undeclared item throws
rather than degrading the ratio); **escaped drift** (items found shipped-but-unmarked by a human or a
steward run rather than by the check — target zero, and the honest read is that this was 2 before and
6 more are outstanding); **mid-arc count** (items declaring `building` — a queue, and one that should
shrink as arcs finish, not a steady state). _Counter-metric:_ **`unfrozen` share.** If it climbs, the
invariant is being satisfied by declaring the negative rather than by naming real ADRs, and the check
returns to watching a shrinking slice — the exact failure this ADR corrects, wearing a compliant face.
18 of 82 (22%) is the baseline to judge that against.

**Experiment.** No A/B: the baseline arm is the recorded history, measured not assumed — coverage was
13% and two items escaped. Verification is adversarial-by-construction: the tests assert that an item
declaring _neither_ anchor throws and that one declaring _both_ throws, each against the error text
the new code introduces, so removing the invariant fails them. The natural experiment worth watching
is whether the six `building` items shrink or calcify: if they are still mid-arc in a month, the
declaration has become a place to park drift instead of a way to name it, and the right response is to
require a review date on `building` rather than to loosen rule 3 further.

## Related

- [ADR 173](173-absent-is-not-unknown.md) — the principle. This is its second application, and the
  one its registered experiment predicted.
- [ADR 112](112-steward-seat.md) — the steward hunts the drift a linter is blind to. It did not flag
  these two, which is its own signal: the static check's coverage gap and the steward's miss were
  independent failures of the same guarantee.
- [ADR 084](084-lanes-join-the-plan.md) — status stays derived; `building` annotates the
  anchor rather than becoming a stored third state.
