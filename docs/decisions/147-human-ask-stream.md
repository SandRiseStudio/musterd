# 147 — The to-human ask stream: one act, three species, a tier that owns the clock

- Status: accepted — 2026-07-17. Implements the second backlog item ADR 145 re-sequenced
  (`human-ask-stream`) — the spine every later human-loop item rides.
- Date: 2026-07-17
- Builds on: [ADR 145](145-human-role-refounded.md) §2/§3.1 (the decision this executes — the
  three-species stream with per-tier timeout + no-answer policy), [ADR 103](103-steer-challenge-defer-acts.md)
  (the worked example of appending acts to the vocabulary with no wire-version bump; the `steer`
  interrupt-class precedent), [ADR 088](088-interrupt-line-tool-boundary-inbox-check.md) (the interrupt
  line the ask rides toward a busy human), [ADR 044](044-notification-tiers-localhost.md) (the `meta.urgent`
  pattern this mirrors: an additive optional meta pair, capability-gated, audited), [ADR 077](077-v0.3-p3.2-claim-handshake-and-request-lane.md)
  (the requests/approval lane — the *specialized* approval for seat admission this stream sits beside),
  [ADR 146](146-dogfood-reseat-grant.md) (which retired routine re-seats from that lane so the
  remaining admin traffic can insist on this surface)

## Context

ADR 145 re-founded the human role and froze a build arc; item 1 (ADR 146) stopped the seat-claim
bleeding. Item 2 is the **spine**: the one path by which agents actually reach a human, and by which a
human's answer — or silence — becomes a fact the team routes around.

The record is unambiguous (ADR 145 Context): all-time on the dogfood team, **0 `request_help` ever
reached nick**, and the whole notification ladder (ADR 024/035/044) carries no traffic to him. The
human is reachable only as an approver of seat claims, never as a peer an agent consults. Meanwhile the
one thing agents most need — "is this direction right?" / "only you can decide this" — has no act that
carries a *contract*: a promise about how long the agent waits and what it does when no answer comes.

## Problem

Express "directed-to-human traffic with a timeout and a no-answer policy" on the existing substrate
**without** (a) a server scheduler firing decisions on the agent's behalf, (b) a stored posture/autonomy
field on a member (the `human-agent-dynamics.md` maxim, ADR 145 §5), or (c) a pile of new acts ahead of
their surface (ADR 145's "surfaces before more acts" sequencing rule).

## Decision

**One new act — `ask` — carrying two meta fields, `species` and `tier`. Everything else reuses the
existing vocabulary.** The agent owns the clock; the daemon delivers, records, and supplies the tier
contract. Nothing below the top tier can wedge.

### 1. `ask` — the one new act (three species as a discriminator, not three acts)

Append `ask` to `ACTS` (ADR 103's additive pattern — no wire-version bump). A single act keeps the
"one stream" the design names; the three species live in `meta.species`:

- `consult` — "what do you think / which direction." Not an emergency; wanted even in full-auto.
- `escalate` — a true blocker or dispute only a human can settle.
- `approve` — the admin gate: costly/destructive/out-of-scope actions. (Seat *admission* keeps its
  specialized lane, ADR 077; this is the **general** approval the requests table never modelled.)

`meta.species` and `meta.tier` are **required on `ask`** (enforced in `actMetaRules`, mirroring how
`defer` requires `meta.goal_id`). This is the *only* act added — the resolution and the "deciding" reply
below reuse `status_update` and `wait`, so the guard "surfaces before more acts" is honored: exactly one
new verb, and it ships riding today's surfaces (admin live-push + inbox + `/live` firehose), with its
loud surface following in item 3 (`ask-surfaces`).

### 2. The tier owns the clock — a derived contract, not a stored policy

`meta.tier` is an **ordered** scale; each tier maps to a **timeout** and a **no-answer policy**, both
*derived* from the tier (ADR 145 §6 posture — derived, never a second stored flag). The shipped default
spectrum (protocol constants, `ASK_TIER_DEFAULTS`, one place):

| Tier | Timeout | No answer ⟹ |
|---|---|---|
| `blocking` (top) | 15 min | **Hold** — pause, keep re-notifying, never proceed |
| `standard` | 5 min | **Proceed with recorded risk-acceptance** |
| `advisory` | 3 min | **Proceed with recorded risk-acceptance** |

`noAnswerPolicy(tier)` is `hold` **iff** the tier is the top tier, `proceed_with_risk` otherwise — so the
two load-bearing invariants (ADR 145 §3.1) fall out by construction: **only the top tier can wedge**, and
**everything below it turns silence into an auditable risk-acceptance, never a silent stall.** The
confirmed reading (ADR 145 Appendix A, A6): *the timeout is how long the agent waits before invoking that
tier's no-answer policy.* The daemon runs no timer for this — "proceed with a chosen approach" is
inherently the agent's act, not something a server can do for it. The daemon's job is to hand the agent
the contract (`askContract(tier)` → `{ timeout_ms, no_answer }`, surfaced at send time) and to record what
the agent then does.

### 3. Delivery is unconditional; the human's answer is not

On `env.act === 'ask'`, `routeEnvelope` audits `ask.raised` (`detail: { species, tier }`) and, on top of
normal persistence + delivery, **live-pushes to every admin connection** (`hub.deliverToAdmins`, the
claim-pending primitive). The append-only message row is the durable reach (every admin's inbox derives
from it); the admin push is the loud reach. Together they satisfy "escalations always technically reach
the human" — delivery is guaranteed, response is not. Routing is **to admin humans by default** (ADR 145
§1: admins are human-only); the configurable, never-automatic fallback to non-admin humans on admin
silence rides one team-policy flag, §5.

### 4. The no-answer resolution reuses `status_update` (no new act)

When the timeout elapses unanswered, the agent invokes the tier's policy by emitting a `status_update`
carrying `meta.ask_ref` (the ask's id) and `meta.ask_outcome`:

- `held` (top tier) — the agent stays paused and re-notifies; audits `ask.held`. It does **not** proceed.
- `risk_accepted` (below top) — the agent proceeds, and the act records the risk: `meta.risk` +
  `meta.chosen_approach` are **required** when `ask_outcome === 'risk_accepted'`; audits
  `ask.risk_accepted` with `detail: { ask_ref, risk, chosen_approach, human_unreachable: true }`. This
  row **is** the auditable risk-acceptance ADR 145 §3.1 promised — the human's silence becomes a fact in
  the record, attributable and later-reviewable.

### 5. The "deciding — check back in ⟨dur⟩" reply reuses `wait`

A human answers any ask with `wait` carrying `meta.ask_ref` + `meta.until` (a duration like `1h`, or
`indefinite`) — the human symmetric of the agent `wait` act (ADR 145 §3.1, A6): a deferral with an owner
and a clock, so a thinking human stops reading as an ignoring one. It audits `ask.deferred`
(`detail: { ask_ref, until }`) and tells the waiting agent to extend its clock rather than fire the
no-answer policy. `wait` already existed with no server handling; this gives it the one meta shape it
needed.

### 6. One team-policy flag — the fallback, the only genuinely-configurable behavior

Add `ask_fallback_to_nonadmin: boolean` (default `false`) to the team `PolicySchema` (ADR 076), rides the
existing policy verb + `policy.change` audit. It expresses ADR 145 §3.1's "configurable (never automatic)
fallback to non-admin humans when admins don't respond." Off by default — admin-only routing until a team
opts in. The tier→timeout spectrum is **not** a knob in this increment: it ships as a default the founder
asked to be held to (Appendix A interviewing note — everything-configurable is his instinct; hold a
shipped default), tunable per team only when a team actually asks.

### What this deliberately does not build (carried to later items)

- **The loud surfaces** (Slack message + prominent `/live` asks/approvals panel) — item 3 (`ask-surfaces`),
  which ADR 145 §3.2 says ships *with* the stream. This increment rides today's surfaces (admin push,
  inbox, firehose) so the stream is real and testable before its surface is loud.
- **"Only an admin's answer counts" for the `approve` species** — the admin overlay (ADR 145 §1) makes
  admins the routing target and the loud recipients here; hard enforcement that a non-admin `accept`
  cannot *close* an approval is the multi-human governance work, gated on a second real human
  (`multi-human-admin`).
- **Server-assisted re-notify of a held ask** across sessions — that is harness residency (ADR 131); a
  held ask is re-notified by the still-alive holding agent.

## Consequences

- **One new act, four new audit actions, one policy field, no schema change.** `ask` appends to `ACTS`;
  `ask.raised`/`ask.held`/`ask.risk_accepted`/`ask.deferred` append to the `AuditAction` union; species,
  tier, ask_ref, outcome, risk, until, chosen_approach all ride the free-form `meta` (as `urgent`,
  `goal_id`, `in_reply_to` already do) — no migration, no wire-version bump.
- **No server scheduler.** The reaper (`presence/reaper.ts`) is untouched; the ask clock is the agent's.
  A daemon that never fires a timeout cannot wedge a team by mis-firing one.
- **No posture on people.** Tier lives on the ask, the fallback policy on the team — never an
  autonomy/relationship field on a member (ADR 145 §5).
- **`request_help` is unchanged.** It stays the informal intra-team "anyone, I'm blocked" act; `ask` is
  the to-human act that carries a contract. The ADR 145 finding (0 request_help reached nick) is answered
  by *routing* (`ask` pushes to admins), not by overloading the old act.
- **Re-gating / reconfiguring is a flip.** The fallback is one boolean; turning it off returns the team to
  admin-only routing with no residue.

## Observability & Evaluation

**Traces** — the four `ask.*` audit rows are the instrument, one append-only row per lifecycle event
(tool/act shapes only — species, tier, ask_ref, until, and the risk/approach *that the agent authored*;
never message bodies, ADR 051). `ask.raised` sits beside the delivery it triggered; `ask.deferred`,
`ask.held`, and `ask.risk_accepted` are the three terminal outcomes. The stream's whole life is a single
query over the audit log: raised → (answered | deferred | held | risk_accepted).

**Eval** — headline (ADR 145 §Observability, made concrete): **latency-to-human-answer**, measured as
`ask.raised.ts` → the answering reply's ts, cut by species and tier — the metric the dead notification
ladder could never move off zero traffic. Secondary: **risk-acceptances-later-reversed** — an
`ask.risk_accepted` whose `chosen_approach` a subsequent `steer`/`challenge` overturns (the Goodhart-proof
success signal ADR 145 §5 named: not message *volume*, but how often proceeding-without-the-human turned
out wrong). Guard metric (must **not** move): **no `ask.held` ever precedes the agent proceeding** — a
top-tier ask that proceeds is a wedge-guard breach; and **every `ask.risk_accepted` carries a non-empty
`risk` + `chosen_approach`** (enforced at validation, asserted in the data). Dataset: the dogfood team's
live audit log. Baseline: ADR 145 Context (0 request_help to nick; the escalation channel dead in the
record).

**Experiment** — pre-registered per ADR 145: on the dogfood team, does a tiered ask stream produce
non-zero human-answer traffic where the ladder produced none, and do below-top asks *never* wedge (every
unanswered one resolves to `risk_accepted`, never a silent stall)? One conditional: if `ask.risk_accepted`
rows accumulate with a high later-reversed rate, the default timeouts are too short (agents proceeding
before a present human could answer) — a signal to make the spectrum team-tunable, exactly the knob §6
deferred until a team asks.
