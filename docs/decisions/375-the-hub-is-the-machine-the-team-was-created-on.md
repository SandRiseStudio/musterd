# 375 — The hub is the machine the team was created on, until someone moves it

- Status: accepted
- Date: 2026-09-03
- Relates to: ADR 325 (one team, one authority; "the engine is chosen when the hub is built"),
  ADR 328 (the machine credential and the invite ceremony), ADR 358 (a human seat trusts a set of
  machines), ADR 360 (push-level residence), ADR 361 (every ownership edge is the hub's)
- Decided by: nick, 2026-09-03 ("whichever machine the first human creates the team on is the hub
  by default"), recorded by stanley

## Context

ADR 325 made a team one authority and any number of replicas, and deliberately left "which machine
is the hub" to the build. The build answered it only by implication: a hub is *the daemon that has
enrolled joiners* (`hasEnrolledJoiners`, `sync/log.ts`), and a joiner is *the daemon whose
`node.json` names a hub*. Nothing said which machine should be which, and nothing stopped a machine
from being both.

Measured 2026-09-03 on main at `17706ff9`:

- `POST /teams/:slug/nodes/invite` checks only `authAdmin`. An admin on an **enrolled joiner** can
  mint an invite, a third machine can join *it*, and the joiner now hosts joiners. Its pull loop
  runs the joiner branch (`enrollment` is set, so `isHub` is false and `readStaged` never runs), so
  every event the third machine pushes is staged in the joiner's `sync_log` and folded by nobody.
  Silent — no error line names it.
- `POST /node/enroll` checks only that this daemon has a node row. A daemon that already hosts
  joiners can enroll itself at some other hub, which is the same hole from the other side: its
  joiners' events strand the moment its loop flips to the joiner branch.

The residence-2 census closed today, and the first real second machine (a Fly VM, the cloud-seat
lane) is about to enroll. The question needs an answer before it does, and the answer needs teeth
before someone finds the hole by accident.

## Decision

**The hub is the machine the first human created the team on. That default is enforced at the two
doors, not inferred from a table. Moving the hub is a named future act, not something that happens
by enrolling in the wrong direction.**

1. **The creator's machine is the hub by default.** `POST /teams` runs where the human is; that
   daemon holds the creator's admin credential and mints the first invite; every other machine
   joins it. No new column, no flag: "hub" stays what ADR 325 defined it as — the authority — and
   this ADR says whose machine that is until told otherwise.
2. **An enrolled joiner cannot mint an invite.** `POST /teams/:slug/nodes/invite` refuses
   `conflict` on a daemon whose `node.json` names a hub for the team, and the refusal names the hub
   URL to invite from. There is exactly one door into a team's federation and it is the hub's.
3. **A hub cannot enroll.** `POST /node/enroll` refuses `conflict` on a daemon that already hosts
   an enrolled joiner for the team, before any secret leaves the machine. A machine with joiners is
   the authority; it does not get to become a replica of something else while they are attached.
4. **Relocating the hub is its own increment.** Promoting a joiner (say, an always-on Fly VM) to hub
   and demoting the laptop means re-pointing every joiner's `node.json`, handing the canonical
   `sync_log` over with its `hub_seq` intact, and re-binding residence — a ceremony, with an ADR.
   Named here so the cloud-seat lane inherits the question; deliberately not decided here.

### Rejected

- **Infer the hub from the data ("whoever has joiners").** That is what the code did, and it
  produced the two holes above: a table fact is not a rule until something refuses to violate it.
- **A `hub` flag on `teams`, replicated.** Would need its own kind, its own origin rule, and a
  story for what a flag that says "not me" does to a daemon's loops. The two refusals give the same
  guarantee with no new state, and the flag can still come with decision 4 if relocation needs it.
- **Let a joiner host joiners (a tree).** Every hub-authoritative act (claims, policy, the incident
  pool) assumes one authority; a tree would need forwarding at every level. ADR 325 chose a hub for
  a reason.

## Consequences

- A single-machine team is unchanged: never enrolled, no joiners, both refusals are unreachable.
- The two-machine case — the laptop that created the team plus one Fly VM — is unambiguous: the
  laptop is the hub, the VM enrolls. When the laptop sleeps, hub-authoritative acts refuse on the VM
  by ADR 325's offline rule; that is the pressure decision 4 exists to answer, and the cloud-seat
  lane will measure how much of it there is.
- `musterd node invite` on a joiner prints the hub to run it from instead of minting a code that
  strands a third machine.
- No protocol change. No schema change. Two `conflict` refusals and their tests.

## Observability & Evaluation

**Traces.** No new span. Both refusals are ordinary `MusterdError('conflict')` responses; the CLI
prints them. Falsify on two live daemons: run `musterd node invite` on the enrolled one — it must
refuse and name the hub; run `musterd node join <other>` on the hub — it must refuse before any
request leaves the machine (no `nodes/join` line in the other daemon's log).

**Eval.** The claim is "no daemon is ever both". Baseline before this ADR: both directions were
open and one produced silent stranding. After: `node-enroll-http.test.ts` holds both doors shut on
two real daemons. The landed-outcome check is the first Fly enrollment: `SELECT COUNT(*) FROM
sync_log` on the VM must stay 0 (a joiner stages nothing) and the laptop's must grow.

**Experiment.** None — no flag, no rollout. Decision 4 is the experiment this ADR leaves open: if
the first two-machine week shows hub-authoritative acts refusing on the VM often enough to hurt
(asks and status complaints naming `hub_unreachable`), relocation gets built and this ADR's
default gets a successor.

## Falsifiers

In `transport/node-enroll-http.test.ts`, two real daemons:

1. After the joiner enrolls, `POST /teams/bravo/nodes/invite` on the joiner (as the admin) answers
   409 `conflict` naming the hub URL, and mints nothing (`node_invites` unchanged). Fails without
   decision 2.
2. After the hub has one enrolled joiner, `POST /node/enroll` on the hub pointed at any URL answers
   409 `conflict` and never calls out — the target's `nodes/join` is never hit. Fails without
   decision 3.
3. A never-enrolled, never-hosting daemon still does both (the existing enroll and invite tests).
   Fails if either refusal fires on a single-machine install.
