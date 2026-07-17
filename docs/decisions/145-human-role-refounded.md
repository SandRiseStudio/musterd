# 145 — The human role, re-founded: membership by default, authority as a human-only overlay

- Status: accepted — design frozen; the build arc is the re-sequenced human-loop backlog (roadmap:
  `dogfood-approval-grant` → `human-ask-stream` → `ask-surfaces` → `human-presence-ladder` →
  `human-work-identity` → `two-stage-close` → `web-steering-console` → `multi-human-admin`)
- Date: 2026-07-17
- Builds on: [ADR 010](010-single-active-grace.md) / [ADR 021](021-driver-co-presence.md) /
  [ADR 042](042-humans-multi-presence.md) / [ADR 057](057-ambient-agent-presence.md) (the presence
  model this re-sequences), [ADR 025](025-resolve-act-thread-close.md) (the self-asserted `resolve`
  this splits in two), [ADR 069–070](069-v0.3-governance-build-plan.md) (the grant/capability
  substrate the admin overlay and dogfood-mode policy sit on),
  [ADR 044](044-notification-tiers-localhost.md) / [ADR 024](024-human-reachability-nudge.md) /
  [ADR 035](035-localhost-notify-daemon.md) (the notification ladder the ask stream supersedes as the
  human-reachability path), [ADR 103](103-steer-challenge-defer-acts.md) (the steering vocabulary
  humans must wield), [ADR 098](098-canonical-work-item-vocabulary.md) (Goal → Lane; no new nouns)
- Contract: [human-role-reevaluation.md](../design/human-role-reevaluation.md) — the founder
  interview (verbatim transcript in its Appendix A) and the mined dogfood record this ADR freezes
  into a decision.

## Context

The human-loop layer shipped rung by rung — nudge → availability/urgent → tiers → interrupt line →
steer/challenge/defer — each rung fixing a local dogfood wound. The founding thesis (*humans are
members, not approvers*; Co-Gym's 2× win from the notification protocol,
[research-foundation.md](../design/research-foundation.md)) was never re-examined whole against how
the one real human actually shows up in the record. The wave-7 `human-role-reevaluation` item
mandated that re-examination as a founder interview, evidence-first. It was run 2026-07-16/17; this
ADR is its frozen conclusion.

**What the record shows** (mined before the interview, all-time over the daemon's own store):

- **In-band, the human is an approver, not a peer.** 637 agent acts vs 6 nick acts on the dogfood
  team (three of the six are literal test fixtures); against 44 authorization events (19 decides +
  25 grants). ~7:1 approver:communicator, and the communicator half is test traffic.
- **Agents never reach for the human.** Directed at nick all-time: 90 accept, 78 status_update, 1
  message, **0 request_help**. The 7d unblock median is 6 days; coordination is 12% exchange / 57%
  broadcast journal.
- **The approval wall is friction without protection.** 27 seat-claim requests: 7 expired
  unanswered at the 1h TTL; 7 approvals of the *same seat* in four days; `team_join` is the slowest
  tool on the team (76s avg) because it waits on a human who isn't looking. The reported (and,
  during the interview, live-re-performed) workaround is telling the gated agent to approve itself
  `--as nick` — audit rows reading `authorized_by: nick` for decisions nick never saw.
- **The human is invisible exactly while most present.** The real practice — several harness
  sessions, non-auto, watching and approving every tool call, plan-mode-first, pacing, dialing
  model/effort against a usage budget — is Co-Gym dual-control participation that musterd cannot
  see: `MUSTERD_DRIVER` appears in none of 903 provenance rows, the roster reads him offline while
  steering, and he owns 0 of ~84 lanes (the one human-only work item, npm publish, is parked and
  invisible). The CLI inbox was never opened once.

**Diagnosis:** musterd gates what the human does not value and cannot see what he actually controls.

## Problem

Before more human-loop features ship piecemeal, freeze *what the human's role is* — so the backlog
is re-sequenced from a decision, not accreted from local wounds. The thesis needs a restatement that
survives the record, and the surface needs a shape that routes the human's real labor and the team's
real asks through musterd instead of around it.

## Decision

### 1. Membership by default; authority is a human-only overlay

The thesis survives, restated: **a human on a team wears a member hat always, and an admin hat
optionally.** The member hat owns lanes/Goals, shows presence by the agent ladder, sends and
receives the same acts. The admin hat holds the approve/decide/grant powers *and* receives the
traffic addressed to authority. The record's failure was not that nick was an approver — it is that
the approver hat was the only one with a surface.

- Admins are **human-only** (agents never); a team may have several humans and several admins; **at
  least one human admin always exists** (defaults to the team creator).
- A **non-admin human** does everything a member does and *sends* into the to-human stream exactly
  as agents do, but does not *receive* approvals/escalations/asks by default.
- **Humans wield the full steering vocabulary** (challenge / stop / wake / rescope / redirect,
  ADR 103) as first-class abilities on human surfaces. Non-admin steering scope is an open question
  (§ Consequences).

### 2. The to-human ask stream (the spine)

One stream of directed-to-human traffic, **three species**: consultative asks ("what do you think" —
wanted even in full-auto), escalations (true blockers/disputes), and approvals (the admin gate).
**Harness permission prompts are excluded** — they stay with the harness; the team layer carries
asks between members, not tool-wielding safety prompts.

Every item carries a **tier**; each tier sets a **timeout** (wait before invoking the no-answer
policy) and a **no-answer policy**:

- **Top tier** (extremely costly/destructive): ~15 min, then **hold** — pause, keep re-notifying,
  never proceed.
- **Below top**: ~3 min scaling by importance, then **proceed with a recorded risk-acceptance** —
  the act records the risk, that the human was unreachable, and the chosen approach.

Two invariants: escalations **always technically reach** the human (delivery unconditional, response
not); **nothing below the top tier can wedge** — an unanswered ask becomes an auditable
risk-acceptance, never a silent stall and never an invisible ignore. Routing goes to **admins** by
default, with a **configurable (never automatic)** fallback to non-admin humans on admin silence,
riding the same timeout/risk machinery. A human may answer any ask with **"deciding — check back in
⟨duration / indefinitely⟩"** — the human symmetric of the agent `wait` act, so a thinking human
stops reading as an ignoring one.

### 3. Deliver on surfaces the human inhabits

The record's clearest lesson is that a channel the human does not live in is a dead letter box. The
ask stream ships **with** its surfaces, not after: a **Slack message** naming what needs a decision,
and a **loud, prominent asks/approvals element on /live**. The CLI inbox demotes to a power tool.

### 4. The human presence ladder

Humans get agent-equivalent presence from signals humans emit: **online** (web UI open — the /live
browser tab's observer seat becomes the human's own — or `inbox --watch`), **working** (steering a
session, doing acts, or holding a claimed lane — *steering marks you working*, which is the answer
`driver-copresence-gap` was blocked on), **idle**, plus intentional **away/dnd/working-hours**.
Presence **informs** the stream's behavior; **absolute time is the end driver** of timeouts.

### 5. Human work identity

No new hierarchy nouns (ADR 098 holds). What changes is the affordance: humans **create and claim
lanes from the web UI** (the board becomes writable; `owner_seat: nick` is already legal and has
simply never happened), so blockers, human-only work, and self-defined human work are captured,
measured, and auditable like agent work. First dogfood: a real `publish-to-npm` lane owned by nick.

### 6. Two-stage close (this ADR absorbs the resolve-as-state-gate question)

`resolve` (ADR 025) conflates two claims. Split them: the **worker's** claim ("technically complete")
becomes a lane state **`ready for review`**; the **owner's** claim ("this is what I wanted") requires
a **different seat** to confirm before the lane is `done`, with a failed review marking it
**`unverified`**. The review request is an ordinary ask-stream item with a timeout — a missing
reviewer degrades to self-close-flagged-`unverified`, never a wedge. Every settled constraint holds:
musterd runs no verifiers, threads can't wedge, verified-ness is *derived* from a counterpart act,
never a stored second flag.

### 7. Configurability & dogfood mode (ship first, stop the bleeding)

The approval/steering level is **policy per team**. The first policy shipped is the one the record
demands: **a standing grant for re-seating known agents** — the seat-claim wall exists because a gate
meant for strangers fires on teammates. Re-occupying a seat you already held becomes a notification,
not a decision; brand-new member admission stays gated. This also retires the `--as nick`
impersonation hole: with the routine case ungated, the admin decisions that remain can insist on a
real human surface.

## Consequences

- **The human-loop backlog is re-sequenced** into eight roadmap items (see the Status line), waves
  7–later, replacing the single `human-role-reevaluation` design item; `driver-copresence-gap` is
  now *answered by* `human-presence-ladder` rather than a standalone patch.
- **Sequencing rule:** bleeding first (7.1), the spine before its riders, **surfaces before more
  acts** (the record proves acts without a lived-in surface are dead letters), work-identity and
  close-semantics once the human is reachable, **multi-human last** because it cannot be honestly
  designed with one human — musterd has never had two real humans on a team.
- **Open, deferred by name:** the multi-admin race (decision-maker designation vs single-admin
  cap); the exact non-admin human steering scope; the human idle heuristic; whether two humans
  coordinate through musterd or around it (the through-musterd value proposition for a human pair).
  All gated on a second-human dogfood.
- **Guards carried forward (this ADR rejects):** harness permission prompts in the team layer; any
  stored relationship/autonomy/posture field on a member (ADR 021 maxim — tiers live on asks,
  policies on teams, never postures on people); new work-item nouns; agent admins; volume-counting
  metrics; treating human presence as monitoring rather than ops input.
- Each build item is shaped to be a small, independent PR when the owner pulls it forward; renames
  or new lane states land with the guidance-surface and provisioning-verify drift checks in the same
  PR, per the ADR 085 / ADR 060 conventions.

## Observability & Evaluation

**Traces** — the ask stream is the instrument. Each to-human item emits a span carrying `species`
(ask | escalation | approval), `tier`, `timeout`, delivery surface(s), and its terminal outcome
(`answered` | `risk_accepted` | `held` | `deferred`) with time-to-terminal. Risk-acceptances are
first-class audit rows (the "human was unreachable, proceeded with X" record), and the two-stage
close emits the counterpart-confirm vs self-closed-`unverified` distinction. ADR 051 posture: tool
and act shapes, never message bodies.

**Eval** — headline: **time-to-human-answer** per tier (and the fraction of below-top asks that
reach `risk_accepted` because no human responded — the reachability failure the whole stream exists
to drive down, today effectively 100% since 0 request_help ever reached nick). Secondary:
**risk-acceptances later reversed** (a proceed the human would have blocked — the cost of the
no-wedge property), **unverified-close rate** and **review-catch rate** (closes a counterpart sent
back), and **human presence accuracy** (roster-online while genuinely absent, or offline while
steering — the driver-copresence bug, measured). Dataset: the dogfood team's live stream. Baseline:
captured in this ADR's Context (6 acts, 0 request_help, 6-day unblock median, 7 TTL-expired claims,
`MUSTERD_DRIVER` absent from 903 provenance rows).

**Experiment** — per-item before/after on the headline metric as each ships: dogfood-mode grant vs
the TTL-expiry + `--as nick` rate; the ask stream + surfaces vs time-to-human-answer and the
broadcast-journal ratio; the presence ladder vs roster-accuracy while steering. One pre-registered
conditional: if `risk_accepted` stays high after surfaces land, the timeouts are miscalibrated (too
short) rather than the human unreachable — re-tune per tier from the measured answer-latency
distribution before adding louder delivery.
