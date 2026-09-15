# Controls in force

Every guard we believe is protecting us carries a date someone last watched it work — because an unexercised control is indistinguishable from a broken one.

## The registry

`docs/controls/registry.ts` lists each control with its claim, how to exercise it, and two separate dates. `pnpm controls:check` (in `format:check`) fails when the evidence goes stale. Nine controls registered at 2026-08-20.

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

## What an exercise looks like

The schema says "it's covered by tests" is not an exercise. The worked example is
`adr-227-infra-touch-gate` on 2026-08-21 (lane `01M0GX9VD7`), and two things about how it was run
generalise.

**Fire the control, not the action it guards.** The gate's `exercise` field says to run
`musterd service restart` — which bounces the daemon under every live teammate. But the control is a
`GET` with no infra side effect; the destructive verb is what *follows* it. So the gate was fired
directly and the daemon was left alone, the same call stanley made in 2026-08-05. A control whose
exercise instruction reads as "cause the incident" usually has a cheaper handle, and finding it is
part of the exercise.

**Say which branch was fired where.** `izzo` holds `platform`, so that seat gets the silence branch
by design and *cannot* fire the warning against production — an exercise instruction is only
runnable from the right roster position, which nothing in the schema records. What was run: the
holder-silence branch live against the production daemon (`{"warn":null}`, 1.5 ms, no audit row),
and all six branches end-to-end through the real CLI half against a daemon booted for the purpose —
warning text and audit row for a non-holder, the `agent` verb, holder silence, the unreachable-daemon
silence contract (null in 32 ms, no stall), no-identity silence, and plural verb agreement with two
holders. Claiming a production warning nobody caused would have been the easier write-up and a false
one.

A caution found while doing it: a server booted on an in-memory database still logs
`"db":"/Users/nick/.musterd/musterd.db"` at startup, because `index.ts:179` logs `config.dbPath`
rather than the injected handle. It reads exactly like having written to production. Verify against
the data (row counts before and after), not the log line.

## What this does not do

**The registry does not find controls; it only keeps registered ones honest** (2026-08-20; falsify: add an unregistered guard to the repo and run `pnpm controls:check` — it passes, which is the gap). There is no auto-discovery of guards in the tree, so the registry is a floor, not an inventory, and an entry lands only when a seat exercises a control and records what they saw. Claiming completeness on day one would be the same absence-class lie one level up.

A `neverExercised` control is legal — there is none at present, `adr-227-infra-touch-gate` having been fired on 2026-08-21 — but it is printed on every run rather than passing quietly, **and the absence itself expires**: `neverExercisedSince` ages against the control's own `staleAfterDays`, so the gate fails once the control is old enough that someone should have fired it. ~~Increment 1 did not stale-check declared absences at all~~ CLOSED 2026-08-20 by izzo's acceptance finding — an undated absence was a permanent exemption, the registry's own thesis turned on itself.

**It does not discover exercises either, and that is the sharper half** (2026-08-21; falsify: point the registry at a control someone exercised outside it — if `neverExercised` ever reflects an exercise nobody typed into `registry.ts`, this is wrong). `adr-227-infra-touch-gate` was registered `neverExercised` on 2026-08-20 and the claim was false when it was written: stanley had fired the gate against the live daemon on 2026-08-05 while accepting [#689](https://github.com/SandRiseStudio/musterd/pull/689) — checking plural verb agreement with two holders, confirming the unauthenticated silence branch, and reading back the audit row — and declined to run `musterd agent` for real because that is the destructive act the gate exists to warn about. Better evidence than most entries carry, invisible because it lived in the acceptance stream where ADR 192 puts outcome judgements, and the registry consulted only itself. So `neverExercised` means *nobody wrote it here*, not *nobody did it* — an absence claim about an absence-class instrument, reached by reading the wrong record. The countdown from `neverExercisedSince` would have failed the build on 2026-10-03 for a control exercised sixteen days before it was registered. Entry: [`2026-08-21-infra-gate-never-exercised.md`](../claims/entries/2026-08-21-infra-gate-never-exercised.md).

Two more increment-2 corrections, both found by acceptors exercising increment 1 rather than reading it (2026-08-20): `adr-227-infra-touch-gate`'s `where` omitted `musterd agent`, the most consequential of its wired verbs — an understated `where` is the same defect class as a stale date; and `roadmap-frozenby-drift-watch`'s counterfactual overclaimed "Yes" where dolly's mutation test proved "partly" — rule 3 cannot fire on a `building` item, so **watched and enforced are different facts**, the registry's exercised/tripped split showing up one level up.

Related: [running the gates](running-the-gates.md) · [shipping a PR](shipping-a-pr.md) · [claims ledger](../claims/README.md)
