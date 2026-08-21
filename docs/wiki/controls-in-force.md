# Controls in force

Every guard we believe is protecting us carries a date someone last watched it work — because an unexercised control is indistinguishable from a broken one.

## The registry

`docs/controls/registry.ts` lists each control with its claim, how to exercise it, and two separate dates. `pnpm controls:check` (in `format:check`) fails when the evidence goes stale. Eight controls registered at 2026-08-20.

**Exercised and tripped are different facts, and conflating them is the bug.** `lastExercised` is *when someone last ran this and watched what happened* — liveness. `everTripped`/`lastTripped` is *whether it has ever actually caught anything* — efficacy. ADR 272's routing gate scores well on the first (stanley ran the query twice) and zero on the second (it has never fired). Both readings are true and neither substitutes: a control exercised often and never tripping may be guarding something that cannot happen, which is worth knowing; a control that tripped once and has not been exercised since may have rotted, which is invisible without a date.

## Why a date, not a list

Four unrelated failures on 2026-08-19 were one failure — a control believed to be in force that wasn't:

- The root vitest config's 30s ceiling reached **zero of five packages**, because a package-local config inherits nothing (2026-08-19, #918; falsify: check out the parent of `0aea9d27`, add a test that sleeps 6s, run it under `packages/cli`'s own config — it fails at 5s and passes under the root's).
- ADR 272 cited ADR 227's measured gate as satisfied when it had **never fired** — zero `roster.role_query` rows have ever been written (2026-08-19, #912/#917; falsify: run ADR 227's eval SQL — a non-zero count overturns this).
- A `daemon_down` probe ate its errors in a bare `catch {}`: 22 raises, one distinct body between them (2026-08-19, #923; falsify: read the pre-#923 probe's catch block).
- A wiki falsifier could not fail (2026-08-19, #925 — this is wiki rule 3, and the page you are reading is bound by it).

Each is an **absence-class claim** in [ADR 294](../claims/README.md)'s sense — an assertion that something is being prevented. Absence claims have the longest half-life of any class because nothing contradicts them: the vitest one stood seven days and stopped everyone looking.

## The counterfactual rule

Every control answers one question in the registry: *would this have caught the incident that motivated it?* The gate rejects a stub, and **"no" is a passing answer** — a control that admits it would have missed is more useful than one that never got asked.

The rule has teeth because it has been paid. Applied to a dating check ryder had just built (2026-08-19), the honest answer was no — it would have passed on the very case that prompted it — so the check was thrown away rather than shipped as reassurance. Decoration that reads as protection is worse than nothing.

## What this does not do

**The registry does not find controls; it only keeps registered ones honest** (2026-08-20; falsify: add an unregistered guard to the repo and run `pnpm controls:check` — it passes, which is the gap). There is no auto-discovery of guards in the tree, so the registry is a floor, not an inventory, and an entry lands only when a seat exercises a control and records what they saw. Claiming completeness on day one would be the same absence-class lie one level up.

A `neverExercised` control is legal — `adr-227-infra-touch-gate` is the current one — but it is printed on every run rather than passing quietly.

Related: [running the gates](running-the-gates.md) · [shipping a PR](shipping-a-pr.md) · [claims ledger](../claims/README.md)
