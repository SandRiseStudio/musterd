# 401 — Ask eligible-set refusal names the unshipped increment

- Status: accepted
- Date: 2026-09-16
- Relates to: ADR 254 (eligible set; `ELIGIBLE_ACTS` stays `message` / `request_help` / `challenge`),
  ADR 260 (quiet-set increment 2 is parked, not implied by increment 1)
- Lane: `01M2HM0K2C6YD543HQ3VPJA1YB`

## Context

ADR 254 lets `message`, `request_help`, and `challenge` carry `meta.eligible` — 2–4 named seats, first
answer wins. `ask` is not on that set. `actMetaRules` already refused an `ask` that carried it.

The MCP `team_send` tool description still advertised "2–4 to names mean any may answer" with no act
filter, and `normalizeTo` composed `meta.eligible` act-blind, one layer above that act-aware guard.
A seat that followed the tool text hit a protocol refusal. The refusal text was the same line used
for `handoff`: *"an act with one owner cannot have several"*.

That sentence is true for `handoff`. It is false as a reason for `ask`. Quiet-set fan-out of an
acceptance ask is ADR 260 increment 2, parked after the increment-1 Eval could not be read as a
before/after. The protocol was describing a parked increment as a design principle.

## Problem

Two layers could disagree on *why* `ask` cannot carry an eligible set, and the wire-facing reason
taught the wrong lesson: "don't fan out an ask because an ask has one owner" rather than "don't fan
out an ask because that increment is unshipped." `ELIGIBLE_ACTS` itself was not the bug; the copy
and the MCP advertisement were.

## Decision

1. **`ELIGIBLE_ACTS` is unchanged.** `ask` still cannot carry `meta.eligible`. This ADR does not
   ship increment 2. No schema, no union member, no envelope field.

2. **One refusal string, act-aware.** `eligibleSetRefusal(act)` is the single home. For `ask` it
   names the unshipped increment (ADR 260) and tells the caller to name one seat in `to`. For every
   other act not on `ELIGIBLE_ACTS` it keeps the structural line (*one owner cannot have several*).
   `actMetaRules` and MCP `normalizeTo` both throw that string, so the compose layer cannot advertise
   a shape the envelope then refuses for a different reason.

3. **The MCP tool text matches the guard.** `team_send`'s description lists eligible-set addressing
   on `message` / `request_help` / `challenge` only, and names the parked increment for `ask`.

### Rejected

- **Move the helper out of `@musterd/protocol`.** That would satisfy `change-adr:check` by leaving
  `envelope.ts` untouched, and would put two refusal strings back on two sides of the same rule.
- **Put `ask` on `ELIGIBLE_ACTS`.** That *is* increment 2. Parked; not this lane.

## Consequences

- Other implementations that match the refusal text will see a different string for `ask` than they
  did yesterday. The wire shape is the same. Implementations that only check `ELIGIBLE_ACTS` are
  unaffected.
- A future increment-2 ADR amends `ELIGIBLE_ACTS` and deletes the `ask` arm of `eligibleSetRefusal`
  in the same commit. Until then, a 2–4 `to` on `ask` is a caller error, not a quiet-set.

## Observability & Evaluation

**Traces.** The refusal string itself, on `team_send` and on any client that composes an envelope
with `meta.eligible` for `ask`. No new act, no new audit verb.

**Eval.** `packages/protocol/src/envelope.test.ts`: an `ask` with `meta.eligible` throws
`/unshipped increment/` and does not throw `/one owner cannot have several/`. MCP
`send.eligible.test.ts` and `tools.test.ts`: `normalizeTo(..., 'ask')` and a 2-name `ask` send
nothing and surface the same copy. Baseline: the previous suite asserted the "one owner" line for
every non-eligible act, including `ask`.

**Experiment.** None. This is honesty of a refusal, not a new path. Increment 2 remains the
experiment ADR 260 named, still unrun.
