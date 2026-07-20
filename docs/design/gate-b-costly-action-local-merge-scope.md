# Gate B costly-action scope: the local-merge route-around

Status: **scoping decision — measure-first** (agreed stanley + izzo, 2026-07-20; nick may override).
Follows: [ADR 150](../decisions/150-structural-inducement-pretooluse-gates.md) (Gate B),
[finding 006](../research/006-enforcement-induces-coordination-cookoff-pilot.md) (the pilot that
surfaced this), [ADR 147](../decisions/147-human-ask-stream.md) (the ask contract).

## The observation

Gate B blocks a policy-declared costly action (e.g. `git push --force*`, `gh pr merge*`) by denying the
tool call and raising an `approve` ask. The cookoff pilot (D3/D4/D5) showed the block is **porous**: of 4
Gate B push-denies, **3 were routed around** — the agent landed the same change via a **local merge**
(ff-merge into the shared branch, or a different path) and left the ask open; 1 was a genuine hold that a
teammate then ff-merged around anyway. A local merge **prices holding at zero**. Gate B is, in izzo's
phrase, "a tollbooth with a dirt road around it."

The question this note answers: **should costly-action classes cover the local-merge equivalent of a
blocked push?**

## Why "add more command globs" is the wrong shape

The reflex — extend the `merge-to-main` match set with `git merge*`, `git cherry-pick*`, `git rebase*`,
… — fails on three counts:

1. **It is unbounded.** A change reaches a shared branch through `merge`, `cherry-pick`, `rebase`→ff,
   `reset`, `format-patch | am`, a direct commit on a checked-out `main`, or an editor write to a worktree
   that _is_ `main`. No glob list closes them all.
2. **It drifts across the line ADR 150/145 draw.** Matching arbitrary git plumbing is exactly the
   "generic tool mediation / second harness-permission-prompt" the ADR forbids by construction.
3. **It gates the wrong thing.** The consequential event is an **outcome** — "an unreviewed change
   reaches the protected branch" — not any single command. And that outcome is **not PreToolUse-visible**:
   the hook sees `{tool, command}`, never the resulting git ref update, so a truly outcome-level gate
   can't be built at this seam anyway.

## The threat model settles it

ADR 150 is explicit that this is **inducement under a cooperative-agent threat model, not a security
boundary**. A cooperative agent routes around a block it doesn't understand — not one it does. So the
first lever is **phrasing, not netting**: make the deny say what the block is _for_ and that routing
around defeats it. That is [finding-006 item 1](../research/006-enforcement-induces-coordination-cookoff-pilot.md)
(shipped): the shared `askContractText` gives the deny parity with the ask contract, and the Gate B deny
now names the local-merge route-around as bypassing the review the block exists for.

## Decision: measure-first

1. **Item 1 shipped** — the clearer deny is the cheapest lever, aimed exactly at cooperative agents.
2. **Measure before gating more.** The next enforcement D-cell (rides the flagship rung, owner-gated on
   nick's spend trigger) tests whether item 1's deny moves the 3/4 route-around rate. No action is lost by
   waiting — the measurement was already queued behind the flagship.
3. **If — and only if — route-arounds persist**, adopt the _curated-default_ option, **not** an airtight
   net: document (runbook + recommended class table) that a team blocking `merge-to-main` should include
   the common land-to-shared command forms in its match set. Code-free; a recommendation, never a
   completeness claim.
4. **Do not build an outcome/branch-advance detector.** It is disproportionate for an inducement, and the
   PreToolUse seam cannot observe the ref update it would need.

Escalate past this only if a genuinely **adversarial** (non-cooperative) agent becomes the threat — which
is outside ADR 150's stated scope and would be a different design.
