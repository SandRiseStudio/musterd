# 417 — A seat attests the guidance it is running

- Status: proposed — 2026-09-17
- Date: 2026-09-17
- Builds on: [ADR 408](408-a-workspace-repair-is-an-audit-row.md) (repair at session start), [ADR 101](101-model-as-a-variable.md)
  and [ADR 301](301-per-act-model-source-tier.md) (the attestation route this field rides),
  [ADR 148](148-feature-epoch-roster-skew.md) (the sibling counter), [ADR 135](135-build-provenance-every-runtime.md)
  (absent is unknown, never a guess)
- Relates to: [ADR 171](171-provisioned-workspace-currency.md), [ADR 085](085-layered-guidance-surface.md),
  [ADR 236](236-sleeping-host-defers.md) (deferred to increment 2)
- Lane: `01M2NTZ9WVS525MDRH8PJRPPM5`
- Spec: `docs/superpowers/specs/2026-09-17-guidance-currency-receipt-design.md` §3
- Increment 1 of 3. Increment 2 (the refresh receipt and the session-start line) carries its own ADR;
  increment 3 (the gate) is deferred and unscheduled.

## Context

ADR 408 workspace self-heal landed 2026-09-16 and works: it repairs a seat's guidance files before
the skill is read, and it cut the stale-workspace census from 7 of 9 to 4 of 9 in a day.

It repairs a seat to match **the local build**. `inspectClaudeHookDrift` states the rule in its own
comment — compare "against what THIS build would write." On this laptop the global `musterd` is a
pnpm link into `/Users/nick/agents/packages/cli`, so every seat's guidance authority is one shared
dist. **Nothing ties that dist to `origin/main`, and `composeLine` never names the build it repaired
from**: `WorkspaceRepairBody.build` is set in the report (`selfHeal.ts:89`) and never read by the
line (`:111`). A seat repaired from a stale dist prints `repaired 1 guidance file` and runs a stale
rule, green.

The codebase already names the defect one layer down. `runtime.ts:59`:

> the doctor's guidance check is SELF-REFERENTIAL: `inspectGuidance` compares each file's stamp
> against `GUIDANCE_CONTENT_VERSION`, the constant compiled into the CLI doing the comparing. A
> binary that writes v21 therefore pronounces v21 files current — correctly, and uselessly, if v22
> is on main.

Its mitigation is gated behind `isPackagedCliInstall`, and every seat on this laptop is a source
checkout, so none of them receive it.

**Why this survived ADR 408's review.** `composeLine` has a `behind` state — "a hook here was written
by a NEWER musterd" — which would have caught a stale repair. It cannot fire here: when the one
linked dist is stale, all nine seats are stale *together and consistently*, and `checkoutBehindHooks`
compares each seat against the very build that made it stale. **A guard that detects disagreement is
blind to uniform error.** That is the near-miss, and it is the reason this ADR exists rather than a
bug fix to `composeLine`.

**Measured, not assumed.** stanley's #1545 bumped guidance v24 → v25 at ~15:45 on 2026-09-17. A
census taken twenty minutes later:

| epoch | seats |
| --- | --- |
| v25 (current) | izzo — and only because it ran `--refresh-guidance` by hand |
| v24 | big-body, dolly, miley, ryder, sloane, stanley |
| v23 | ghost, kimi |

One of nine current — and stanley, who *authored* v25, was running v24 in their own workspace. That
census took a shell script across nine checkouts. Nothing in the daemon could answer it.

## Decision

**One optional field, `guidance_epoch`,** on the claim handshake (`ClaimFrame`), the heartbeat frame
(`HeartbeatFrame`) and the presence row (`PresenceSchema`). It rides the path model attestation
already uses, so the member carries it and acts inherit it at send time. No new plumbing: `epoch`
(ADR 148) and `build` (ADR 135) are the exact siblings it copies.

**It is the installed stamp, never the compiled constant.** `installedGuidanceEpoch` parses the
`<!-- musterd:content vN -->` stamps out of the guidance files present in the workspace.
`GUIDANCE_CONTENT_VERSION` is deliberately not consulted. The constant is the build's *ceiling* —
what it would write; the stamp is what is *actually in the model's context*. Attesting the constant
would attest a capability rather than a fact, and would lift `runtime.ts:59`'s self-referential
defect onto the wire, where it would be far harder to see.

Three sub-rulings, each pinned by a test:

1. **Disagreeing stamps attest the minimum.** A workspace whose files carry different versions ran
   the weakest rule in the set, and the weakest rule is the one a census exists to find.
2. **An unstamped file is skipped, not zeroed.** No stamp is an absence of evidence, not evidence of
   epoch 0. Zeroing would drag the minimum to 0 and report every hand-edited workspace as maximally
   stale.
3. **Nothing readable ⇒ the field is omitted.** Absent is unknown. It must never default to 0, on
   the wire or in the column, because 0 and unknown would then be indistinguishable — and 0 is the
   loudest possible value for a field whose whole job is to be read.

**Re-attested on the heartbeat, and absent never clears.** A `--refresh-guidance` mid-session is
real, so a heartbeat may carry a new epoch; a heartbeat without the field means no change, the same
`COALESCE` rule `model` carries.

### What is deliberately NOT here

**No `seat_knew_it_was_behind`.** A gate would need it — "you were told and proceeded" is a different
act from "nobody told you" — so omitting it guarantees a *second* wire change when increment 3 is
built. That cost is accepted knowingly.

The reason is not the usual don't-ship-unconsumed-fields argument, which would be weaker. It is that
the field's **meaning** depends on the receipt's verdict being trustworthy, and the measurement that
produced this increment's ordering proved it is not yet: over 20,884 ticks across 44.1 days, **35.75%
of wall-clock time sits inside a >15-minute gap between refresher ticks**, because the laptop sleeps.
A naive staleness reader would call the refresher dead on about a third of session starts,
disproportionately at the first session of the morning. Until the reader can separate a suspended
host from a stopped refresher (ADR 236's `HOST_SUSPEND_GAP_MS` is the repair, and it lands in
increment 2), `seat_knew_it_was_behind` would be a field whose semantics we would have to redefine.
A second migration is a real cost; a field that attests something we cannot yet define correctly is
a worse one.

## Observability & Evaluation

**Traces.** The field is carried on the claim handshake, the heartbeat frame and the presence row,
and read back through the roster. It logs no file contents and no paths — only an integer version
already public in every guidance file's stamp. No new audit row: a guidance epoch is occupancy state,
not an event, and `presence` is where occupancy state lives. (Increment 2, which can *observe a
change* in that epoch mid-session, is where an audit row would earn its place.)

**Eval.** Dataset: the nine seat workspaces on this machine, whose installed stamps were counted by
shell script on 2026-09-17 and found at v25×1 / v24×6 / v23×2 twenty minutes after v25 landed; plus
the `installedGuidanceEpoch` fixtures — agreeing stamps, disagreeing stamps, an unstamped file, an
empty workspace, and a workspace written by `writeGuidance` itself. Baseline: the census required a
shell loop across nine checkouts and the daemon could not answer it at all; every seat's
`guidance_epoch` was structurally absent. The repaired baseline is `musterd status --json` returning
the same nine numbers the files carry — and the falsifier is that the query must agree with the
files, because the files are ground truth and a census that argues with them has no standing.

**Experiment.** None in this increment; it is a deterministic schema and store change. The experiment
this increment *exists to enable* is increment 3's: measure the false-positive rate of a currency
verdict before any gate is allowed to refuse an act on one.

## Consequences

**Self-reported, and nothing proves it.** A seat says which epoch it ran; no signature, no
verification. This is exactly the limit `model_source: 'observed'` already carries — honest
bookkeeping, not attestation in the cryptographic sense. A reader who treats it as proof is assuming
something this ADR denies.

**Visibility, not prevention.** This increment makes staleness *detectable*; it does not make acting
on a stale rule impossible. The lane's filed acceptance — "a guidance correction landed on main is
provably running in every live seat workspace within one session boundary" — cannot be met by it, and
is amended to what warn-plus-attest can actually deliver:

> A seat that acts on a superseded rule is detectable without forensics: the nine-workspace census is
> answerable as a query rather than a script.

The sentence was also unachievable as written: a seat whose session never starts can never be
guaranteed current, so the guarantee can only exist at the boundary where the seat acts.

**The gate stays deferred and unscheduled** (spec §4). Shipping a fail-closed check on the acts that
close other people's work, with no data on its false-positive rate, risks a failure worse than the
drift it prevents — stale guidance plus a dead refresher would mean nobody can close anything. This
increment is what produces that data.

**Cost.** One nullable column, one optional field on two frames, and a second wire change later when
the gate is built. Old clients, thin harnesses and unstamped workspaces stay legal throughout:
absent is unknown, and unknown never blocks.
