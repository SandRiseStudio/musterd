# 153 — Reachability-gated hold: strand, don't stall, when a top-tier ask has no unblocker

- Status: proposed — 2026-07-20. Amends [ADR 147](147-human-ask-stream.md) §2/§4 (the tier→no-answer
  contract). Closes the guard-metric gap the cookoff flagship surfaced (finding 006 §7, FB3).
- Date: 2026-07-20
- Builds on: [ADR 147](147-human-ask-stream.md) (the ask stream, the tier-owns-the-clock contract, the
  `hold` / `risk_accepted` terminal outcomes this refines), [ADR 145](145-human-role-refounded.md) §3.1
  (the two load-bearing invariants — *only the top tier can wedge*, *silence below-top is auditable
  risk-acceptance*), [ADR 150](150-structural-inducement-pretooluse-gates.md) (the Gate B costly-action deny that raises the
  ask a headless seat then has to resolve), [ADR 057](057-ambient-agent-presence.md) (the presence
  signal reachability is derived from)

## Context

ADR 147 shipped the to-human ask stream: one `ask` act, a `tier` that owns the clock, and a no-answer
policy *derived* from the tier — `hold` iff top tier (`blocking`), `risk_accepted` otherwise. The design
names two invariants (ADR 145 §3.1): **only the top tier can wedge**, and **everything below turns
silence into an auditable risk-acceptance, never a silent stall.**

The cookoff flagship (finding 006 §7, 2026-07-20) ran that contract in an unattended cell and found the
one shape the design did not price:

> **FB3** — a musterd *solo* seat — hit the Gate B `push-remote` block, raised the ask via the item-1
> deny contract, and, headless with no human to answer, **held and delivered nothing** (100% wasted,
> 0% acceptance). Unlike the pilot's D5 hold, *no teammate existed to land the tree*, so the hold became
> a dead end.

The item-1 deny worked exactly as designed: it produced a **hold**, not a route-around. That is correct
— the seat must not push to a shared remote without authorization. The regression is narrower and real:
**`hold` silently assumes an unblocker will eventually exist.** When it cannot — no admin human on the
team, no teammate who can adopt the lane — the hold is a guaranteed dead-end. In outcome it is
indistinguishable from the silent stall the design promised to abolish, and it is *worse* in one way: it
pins the seat forever and emits no terminal signal that anyone could act on.

## Problem

Refine the top-tier no-answer policy so that a hold with **no reachable unblocker** does not degrade into
a silent, seat-pinning, signal-less stall — **without** breaching either ADR 145 invariant, and without
adding a server timer (ADR 147 §2: the agent owns the clock; the daemon supplies the contract).

## Decision considered and rejected

**Downgrade a solo, no-human-reachable top-tier ask to `risk_accepted` (izzo's proposal (a)).** Rejected.
The top tier is *precisely* the class of action only a human may settle — push to a shared remote, a
destructive or irreversible op. "Proceed because nobody is home" inverts the wedge-guard exactly when it
is load-bearing: an unattended team would silently execute every costly action it was built to gate. It
moves ADR 147's stated guard metric (*no `ask.held` ever precedes the agent proceeding*) and defeats the
reason the seat raised a `blocking` ask at all. Absence of a human is not consent.

## Decision

**Gate the hold on reachability, and give an un-unblockable hold a *terminal, non-proceed* outcome:
`stranded`.** The wedge-guard stays absolute — a top-tier ask *never* risk-accepts. What changes is only
what a top-tier ask does when it can prove no unblocker exists.

### 1. Reachability is a derived fact the daemon supplies (agent still owns the clock)

Extend the contract the daemon already hands the agent (`askContract(tier)` → `{ timeout_ms, no_answer }`,
ADR 147 §2) with one derived boolean, computed at send time and re-checkable at the terminal moment:

- `unblocker_reachable(ask)` = **(any admin human is present or notifiable on the team)** OR **(a live
  teammate seat other than the raiser exists *and* the blocked action's class has a legitimate
  teammate-completable path open — see below)**.

The two terms are *not* symmetric, and the asymmetry is the load-bearing correction (thanks to izzo's
review):

- **The human term is a *settle*.** A top-tier (`blocking`) ask is human-only-settleable by definition —
  an admin can grant the authorization the gate exists to require.
- **The teammate term is a *route-around*, not a settle.** A teammate cannot grant a Gate B push
  authorization; what a reachable teammate can do (the pilot D5 case — `del`'s local ff-merge) is *land
  the work by a path the gate does not cover*. That only helps **iff that path is sanctioned and open**.
  So the teammate term is gated on the blocked action's class still having an open, legitimate
  teammate-completable route — precisely the scope [item 2](../design/gate-b-costly-action-local-merge-scope.md)
  governs. Today local-merge bypass is open, so for the Gate-B-push class the teammate term is live; if
  item 2 later gates teammate merges for a class, the term drops for that class and reachability
  **collapses to human-only** for it — which is the coherent end state for a genuinely human-only-settleable
  tier anyway.

Both terms are already known to the daemon: the admin roster (ADR 145 §1), ambient presence (ADR 057),
and the enforcement policy that says whether a class's route-around is open (ADR 150 / item 2). No new
timer, no new stored field on a member — a pure projection of current team + policy state, exactly like
the tier→timeout contract it rides beside.

### 2. The terminal branch on a top-tier ask

When a `blocking` ask's timeout elapses unanswered, the agent picks its terminal outcome from
reachability — **never `risk_accepted`**:

| `unblocker_reachable` | terminal outcome | meaning |
|---|---|---|
| `true` | **`held`** (unchanged) | pause, keep re-notifying — an admin can still *settle* it, or a teammate can *land it by an open sanctioned path* (the pilot D5 case) |
| `false` | **`stranded`** (new) | stop holding; do not proceed; record that the work required a human and none was reachable |

Because the teammate term is route-around-gated (§1), the `held`-on-teammate case is exactly as sound as
item 2 leaves it: while local-merge bypass is open, a present teammate legitimately lands the work and the
hold pays off; once item 2 closes that bypass for a class, the teammate term drops and a top-tier ask of
that class with no admin present resolves to `stranded` — the two ADRs move together instead of
contradicting.

`stranded` is emitted the same way `held`/`risk_accepted` are — a `status_update` carrying
`meta.ask_ref` and `meta.ask_outcome = 'stranded'` (ADR 147 §4, no new act) — plus a new audit action
`ask.stranded` with `detail: { ask_ref, reason: 'no_reachable_unblocker' }`. Before releasing, the agent
**records its WIP on the lane** — the lane's `branch` field is set to the seat's working branch (and the
branch is left pushed to the seat's own worktree / not deleted) so the released lane carries the commits,
not just the title. It then **releases the lane** back to `open` so a later-arriving human or teammate
picks the work up with full context, and closes its unit of work. It does **not** execute the blocked
action.

### 3. Why `stranded` and not "hold forever"

Both a forever-hold and a strand "deliver nothing" on the blocked action. The difference is everything
that matters after:

- **Auditable & terminal.** `ask.stranded` is a single queryable fact — *this seat legitimately could not
  proceed, and no unblocker existed* — where a forever-hold is silence.
- **Frees the seat.** A stranded seat stops re-notifying an empty room and stops consuming a session; a
  held seat pins itself.
- **Produces the one actionable signal.** A strand is the honest surface of "this team is missing a
  reachable admin for a decision it needs" — the thing a human reviewing the log can act on (attach a
  human, widen the fallback, re-scope the task). A forever-hold hides that.

Both `held` and `stranded` sit on the **non-proceed** side of the wedge-guard. The guard — *a top-tier
ask never proceeds unanswered* — is untouched; `stranded` is a second way of *not proceeding*, not a way
of proceeding.

### What this deliberately does not build

- **Auto-attaching a human or auto-widening the fallback on a strand.** A strand *surfaces* the missing
  reachability; deciding to route to a non-admin is still the `ask_fallback_to_nonadmin` flip (ADR 147
  §6), never automatic.
- **Cross-session strand recovery.** If a human arrives after a strand, they pick up the released lane
  through the normal board — not a resurrected ask. Server-assisted re-notify across sessions remains
  harness residency (ADR 131).
- **Changing below-top behavior.** `standard`/`advisory` still risk-accept on silence, unchanged;
  reachability gates only the top tier.

## Consequences

- **One new terminal outcome, one new audit action, one derived contract field. No new act, no schema
  change.** `ask.stranded` appends to the `AuditAction` union beside `ask.held`; `ask_outcome` gains the
  `'stranded'` value; `unblocker_reachable` rides the same derived contract as `timeout_ms` — no
  migration, no wire-version bump (ADR 147's additive pattern).
- **Wedge-guard preserved exactly.** A `blocking` ask has two terminal outcomes, `held` and `stranded`,
  and *neither proceeds*. The invariant "only the top tier can wedge, and it wedges by not proceeding"
  becomes "…and when it cannot even usefully wait, it strands rather than proceeds."
- **No server timer added.** Reachability is a projection the daemon computes on demand; the clock stays
  the agent's (ADR 147 §2).
- **A strand is a signal, not a failure to hide.** On an attended team it should be near-zero; a strand
  *with* a reachable human present is a reachability-detection bug, not correct behavior (see Eval).

## Observability & Evaluation

**Traces** — `ask.stranded` joins the existing four `ask.*` rows as a fifth terminal, one append-only row
carrying `ask_ref` + `reason` (tool/act shapes only, never bodies — ADR 051). A top-tier ask's life is
still one query: raised → (answered | deferred | held | **stranded**).

**Eval** — new headline: **strand rate**, `ask.stranded` / top-tier asks, cut by *was a human reachable
at strand time*. A strand on a headless solo team (FB3) is **correct** behavior and the signal to attach
a human; a strand on a team **with** a reachable admin present is a defect in the reachability projection
and must be driven to zero. Guard metric extended (must **not** move): **no `ask.stranded` is ever
followed by the blocked action executing** — a strand that proceeds is the same wedge breach as a `held`
that proceeds.

**Experiment** — pre-registerable on the next enforcement run that seeds a costly action on the critical
path (the D-cell item 2 is still waiting for): a solo/headless cell should now emit `ask.stranded` and
release its lane instead of pinning the seat; a coordinated N-cell with a live teammate should still
`hold` and let the teammate land the work (D5 preserved). Dataset: the dogfood + cookoff audit logs.
Baseline: FB3 (finding 006 §7) — a forever-hold, 100% wasted, no terminal signal.

## Relationship to item 2 (route-around scope)

**Coupled, not orthogonal** (izzo's review corrected an earlier overclaim). Item 2
(`gate-b-costly-action-local-merge-scope.md`, decision: measure-first) governs whether a class's
local-merge *route-around* stays open. A top-tier ask is human-only-*settleable*, so the only way a
*teammate* helps is by that route-around — which means this ADR's `held`-on-teammate branch is sound
**only while item 2 leaves the route-around open for that class**. The two must move together, and §1's
teammate term is written to do so: it is gated on the route-around being open, so if item 2 later closes
local-merge bypass for a class, the teammate term drops and reachability collapses to human-only for that
class — the coherent end state for a human-only-settleable tier. Without that gating the two ADRs would
silently contradict (teammate present ⇒ `held`, but teammate can no longer legitimately land the work).

What *is* independent: this ADR's `stranded` terminal (what a seat that honors the deny does when the
hold cannot pay off) does not wait on item 2's measurement. The flagship left item 2's own question
unexercised at N=3 (D-cells coordinated via Gate A and merged locally, never firing Gate B) — the same
run that produced this ADR's FB3 datum; item 2 still waits on a future D-cell that fires a costly action
on the critical path.
