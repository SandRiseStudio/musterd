# 146 — Dogfood-mode re-seat: a standing grant to re-occupy a known seat, derived from policy

- Status: accepted — 2026-07-17. Implements the first backlog item ADR 145 re-sequenced
  (`dogfood-approval-grant`); the roadmap item flips to shipped in a follow-up once this PR merges.
- Date: 2026-07-17
- Builds on: [ADR 145](145-human-role-refounded.md) §7 (the decision this executes — configurability &
  dogfood mode), [ADR 069](069-v0.3-governance-build-plan.md) / [ADR 070](070-v0.3-p1-seats-data-model.md)
  (the grant/capability/policy substrate this sits on),
  [ADR 076](076-v0.3-p3-1-credential-grant-substrate.md) (credential classes + team `policy`),
  [ADR 077](077-v0.3-p3.2-claim-handshake-and-request-lane.md) (the claim handshake + request lane this
  short-circuits), [ADR 058](058-durable-on-git-live-on-daemon.md) (`bound_at`, the durable "held"
  marker the "known" signal reads), [ADR 025](025-resolve-act-thread-close.md) /
  [ADR 093](093-persistent-seat-memory.md) (the fresh-session-picks-up-the-seat workflow this unblocks)

## Context

ADR 145 re-founded the human role and froze a build arc; its §7 names the first item, chosen to ship
first because it is the smallest change that kills a live wound. The wound, from the daemon's own store
(ADR 145 Context): the seat-claim wall is a gate meant for _strangers_ firing on _teammates_ — 27 claim
requests, **7 expired unanswered** at the 1h TTL, **7 approvals of the same seat in four days**, and a
`team_join` that averages 76s because it waits on a human who isn't looking. That friction taught the
founder the workaround of telling the gated agent to approve itself `--as nick`, minting audit rows that
read `authorized_by: nick` for decisions nick never saw.

The real workflow that trips it (ADR 145 Appendix A, Q1): nick keeps a seat's work going across fresh
harness sessions — the agent saves to seat memory (ADR 093) and hands off, then a new session in the
same worktree picks the seat back up. Every one of those pickups is a `claim` on a seat the team already
owns, and every one currently opens an admin-approval request.

## Problem

Re-occupying a seat the team already brought into being and held should be a **notification, not a
decision**, while **admitting a brand-new member stays a real decision**. We must express that on the
existing substrate without a new primitive, and without widening what an agent key can reach.

**The identity constraint.** ADR 145 §7's phrase is "a standing grant for re-seating _known agents_,"
but the substrate has **no per-agent identity**: the agent key (`mskey_`) is **one rotatable secret per
team**, deliberately shared across all the team's harnesses (ADR 076; the escalation guard treats it as
shared). At claim time the server knows only "an authorized harness on this team" plus the seat it
names — never _which_ agent. So "known agent" cannot mean a per-agent record; it must be read against
what the substrate actually distinguishes.

## Decision

**"Known" = an already-bound named agent seat.** The honest reading of "re-seating a known agent" on the
real identity model is: an authorized harness (team agent key) re-claiming a seat that **has been
occupied before** (`bound_at != null`, i.e. `isHeld`). A never-bound seat is admission; an already-held
seat is a teammate returning to its own chair. This maps "known" onto the one durable per-seat marker
the substrate already keeps (ADR 058/070), and it matches the record exactly: the 7-approvals-of-the-
same-seat pattern is precisely a _held_ seat being re-claimed.

### 1. A team policy flag, off by default

Add `standing_reseat_known_agents: boolean` (default `false`) to the team `PolicySchema` (ADR 076).
It rides the existing `GET`/`POST /teams/:slug/policy` verb, is admin-set, and audits `policy.change`
like every other knob. Default-off means no team's posture changes until it opts in; the dogfood team
opts in, which is the entire point of ADR 145 §7's "configurable per team."

### 2. The claim short-circuit, in both handlers

In the WS `claim` frame handler and the stateless `POST /claim` mirror, insert a branch between the
credential-self-authorize path and the create-pending-request path (Step 6). It occupies immediately —
falling through the ordinary OCCUPY block — when **all** hold:

- `standing_reseat_known_agents` is on for the team, **and**
- the caller authenticated with the **team agent key** (not a human credential — a human
  self-authorizes onto their own seat above, or is refused), **and**
- the target is a **named seat** (not a role pool — role assignment is closer to admission), **and**
- that seat's `kind === 'agent'` (the shared agent key must never auto-occupy a _human_ seat), **and**
- the seat `isHeld` (`bound_at != null`) — a **never-bound** seat stays a real request.

### 3. The authorization is derived, not a stored grant row

ADR 145 §7 says "grant," but we realize it as a **derived standing authorization**, not a row in the
`grants` table: the policy flag **is** the standing grant, re-evaluated against `bound_at` on every
claim. This is the ADR 145 §6 posture ("verified-ness is _derived_ from a counterpart act, never a
stored second flag") applied here — no per-claim grant to mint, refresh, or revoke, and re-gating is a
single policy flip with no grant-row cleanup. (The admin-enrolled `standing` grant of harness residency,
ADR 131, remains the right tool when a specific seat needs an explicit, revocable resume token; this
policy is the team-wide default for the routine case.)

### 4. It is a notification, not a decision — on today's surfaces

A re-seat writes a first-class `claim.reseated` audit row (`result: allow`, actor/target = the seat,
`detail: { surface, policy: 'standing_reseat_known_agents' }`) and emits the ordinary presence-online
event to the team (admins included). That audit row **is** the notification-not-a-decision record. A
loud, _directed_ admin surface for asks/approvals is deliberately **not** built here: ADR 145's
sequencing rule is "surfaces before more acts," and the asks/approvals surface is the next items
(`human-ask-stream` + `ask-surfaces`). Building a bespoke notice frame now would reproduce the dead
inbox with more machinery ahead of its surface.

### 5. Operable from the CLI

`musterd team policy [--reseat-known-agents on|off]` shows or sets the flag (admin, read-merge-write so
one knob never clobbers the residency defaults), so the dogfood team can actually turn it on.

### What this retires

With the routine re-seat ungated, there is no longer a request to self-approve, so the `--as nick`
impersonation workaround loses its reason to exist. ADR 145's larger claim — that retiring the routine
gate lets the _remaining_ admin decisions insist on a real human surface — is realized fully by the ask
stream; this item removes the traffic that taught the circumvention.

## Consequences

- **New-member admission is unchanged.** A never-bound seat, a role-pool claim, and any human seat all
  still route through the request/approval lane. The gate that matters (a stranger joining) is intact;
  only the teammate-returning case is ungated.
- **No new primitive, no schema change.** One optional policy field, one new audit action
  (`claim.reseated`), one claim branch mirrored across the WS and HTTP handlers, one CLI subcommand. The
  grants/requests/audit tables are untouched.
- **The agent-key blast radius is not widened.** Anyone holding the team agent key could already obtain
  a seat via one approval; this only removes the approval for a seat the team already held, and never
  reaches a human seat. If the agent key leaks, key rotation (ADR 076) remains the containment, exactly
  as before.
- **Re-gating is a flip.** Turning the policy off returns the team to live-approval-by-default with no
  residue — nothing to revoke, because nothing was minted.
- **Open (carried to later items):** the directed admin notification surface (`ask-surfaces`); whether a
  re-seat should ever be tier-classified into the ask stream (it should not — it is the _absence_ of an
  ask); multi-admin routing (`multi-human-admin`, gated on a second real human).

## Observability & Evaluation

**Traces** — the `claim.reseated` audit row is the instrument: one append-only row per routine re-seat,
carrying the delivery `surface` and the `policy` that authorized it, actor/target = the seat (tool/act
shapes only, never message bodies — ADR 051). It sits beside `claim.occupied` (grant/credential occupy),
`claim.pending` (a real request opened), and `request.decide`/`request.expired` (the old wall), so the
before/after is a single query over the audit log: the ratio of `claim.reseated` to `claim.pending` on
the dogfood team is the wound closing. `policy.change` records each time an admin flips the flag.

**Eval** — headline: on the dogfood team after opt-in, **routine re-seats produce zero `claim.pending`
rows and zero `request.expired` rows** for already-held seats (today: 7 expired at TTL, 7 same-seat
approvals in four days). Secondary: **`--as nick` self-approvals fall to zero** (no request to approve),
measured as `request.decide` rows whose approver equals the claimant's own human identity; and
**time-to-occupy for a re-seat** drops from the 76s `team_join` average to the sub-second occupy path.
Guard metric (the thing that must _not_ move): **no `claim.reseated` row ever targets a `kind: human`
seat or a never-bound seat** — if one appears, the "known" predicate leaked. Dataset: the dogfood team's
live audit log. Baseline: ADR 145's Context (27 claim requests, 7 TTL-expired, 7 same-seat approvals).

**Experiment** — the ADR 145 §Observability pre-registration for this item, made concrete: per-seat
before/after on `claim.reseated` vs the `request.expired` + self-approval rate, cut at the `policy.change`
row that turns the flag on. One conditional: if re-seats still occasionally open a `claim.pending` after
opt-in, the seat wasn't `bound_at`-marked (e.g. a seat provisioned but never occupied) — that is correct
admission behavior, not a miss, and distinguishes "known" from "declared" in the data.
