# 112 — The steward seat: a standing agent teammate that keeps the declared record honest

- Status: proposed — design freeze; runtime activation gated on secrets/permissions Nick provisions
- Date: 2026-07-08

## Context

[ADR 111](111-stale-plan-detection.md) and the roadmap-truth work (PR #174) closed part of a gap that
surfaced when `stale-plan-detection` sat at `reserved` after it shipped: **`roadmap:check` passing only
means ROADMAP.md is in sync with `roadmap.data.ts`, not that the data reflects reality.** PR #174 added
two static guards — the roadmap now *derives* its shipped-status from a `shipped: { prs }` anchor (the
ADR 084 declared-skeleton/derived-status pattern applied to the roadmap itself), and
`roadmap-truth:check` verifies that anchor against git history and the referenced ADR's own `Status:`
line, so the data can't *silently* overclaim or contradict its ADR.

Static checks have a ceiling. They reason only about what is *already declared*: an item with a
`frozenBy` ADR, an anchor that names a PR. They are structurally blind to **undeclared reality** —

- **shipped-but-unanchored**: a feature that landed with no dedicated ADR, or an ADR nobody flipped to
  `accepted`, so no anchor points at it;
- **undeclared entirely**: a whole feature that merged with no roadmap item — a linter over
  `roadmap.data.ts` cannot see what is not in `roadmap.data.ts`;
- **ADR-status rot**: `frozenBy` now makes an ADR's `Status:` line load-bearing, but *who flips it to
  `accepted` when its PR merges?* Today a human remembers (three were flipped by hand in PR #174).

All three are **discovery** problems — scan reality, find what the record doesn't mention — which a
static check is bad at and an agent is good at. A scheduled bot could open a draft PR, but a bare draft
PR **rots**: it lands in the void with no owner and is forgotten. The reachability ladder
([046](046-agent-side-reachability.md)/[053](053-inbox-reaches-blocked-agent.md)) already solved
"a directed act reaches a peer and is chased if ignored" — which is exactly the property a forgotten
draft PR lacks. A *cron* fires and forgets; a *seat* is accountable and reachable. That is the case for a
seat.

## Problem

Close the discovery half — keep the declared record (roadmap, ADR statuses, prose) honest against reality
— **without** a fire-and-forget bot whose output rots, without an orchestrator that manages other seats
(musterd's `no-orchestrator` principle — "one member does the work; the team does the coordination"), and
without handing an automated process broad write authority over the repo.

## Decision

### 1. A steward seat — one standing teammate, a registry of same-shaped tasks

Provision a first-class musterd seat (`musterd agent steward`) whose charter is **"keep the declared
record honest against reality."** It is an ordinary teammate — a persistent identity + worktree + binding
+ [seat memory (ADR 093)](093-persistent-seat-memory.md) — not a supervisor. It never spawns or manages other seats (that would
be the orchestrator musterd rejects); it does its own work and coordinates in-band like any member.

Its work is a **registry of tasks, every task the same shape**:

> **discover** a reality signal → **diff** it against the declared record → **draft** a change → **shepherd**
> it (open a PR *and* a directed act to the responsible human peer) → **chase** it (the reachability ladder
> re-pings if the PR sits unreviewed) → **remember** what it proposed (seat memory as the seen-file).

Each run of a task is a **lane the steward owns** (dogfooding the lane lifecycle), resolved when its PR
lands. This is a coherent charter, not a junk drawer: a task qualifies iff it is *discover→diff→propose*
over a declared record.

### 2. Per-task autonomy is configurable — `auto-merge` (mechanical) vs `propose` (draft PR)

Each task declares an **autonomy level**, so the same framework serves both a trusted mechanical flip and
a judgment-laden narrative change — and so **future specialized seats can set their own** (the knob is the
reusable primitive, not a property of this one seat):

- **`propose`** (default) — the change is a **draft PR a human merges**; the seat only opens, shepherds,
  and chases. Keeps "curated is a feature" ([ADR 048](048-plan-goal-work-item-model.md)) intact for
  anything touching roadmap narrative or prose.
- **`auto-merge`** — the seat may arm auto-merge on a **purely mechanical, statically-guarded** change
  (e.g. flip an ADR `Status:` to `accepted` once its PR merged). It is still a PR through the same
  protected-main gates (`gates` + Bugbot, squash, no force-push); nothing bypasses CI. `auto-merge` is
  only ever granted to a task whose correctness a static check (like `roadmap-truth:check`) already
  guarantees — the check is the seat's **seatbelt**.

The autonomy level lives in task config, not code, so raising or lowering a task's trust — or giving a
new task a bespoke level — is a config edit, reviewed like any other.

### 3. Substrate: GitHub Action cron now, daemon-triggered residency later

"Standing" is **identity + a trigger**. v1's trigger is a **scheduled GitHub Action** (weekly) that
launches the seat in its worktree, runs the task registry, opens/updates PRs and posts to the team, then
exits — it lives in CI, already has `git`/`gh`, and needs no always-on local machine. The seat's
*identity, worktree, binding, and memory are stable across substrates*, so when the **harness-residency**
primitive lands (the reserved roadmap item — "musterd gives any harness residency," the daemon resurrects
a seat's session on a trigger) the cadence source swaps underneath the same seat with no charter change.
Cron is the bootstrap; residency is the destination.

### 4. v1 task set — one of each autonomy mode

- **`roadmap-reconcile`** (`propose`) — diff merged PRs since the last reconciled SHA + ADR statuses
  against `roadmap.data.ts`; draft a PR flipping unambiguous items to `shipped` (with the real PR anchor)
  and listing PRs that map to *no* item as candidate entries. Guarded by `roadmap-truth:check`.
- **`adr-status-hygiene`** (`auto-merge`) — an ADR referenced by a merged PR but still `proposed` → flip
  its `Status:` to `accepted`. Purely mechanical, guarded, and the exact rot that makes `frozenBy`
  trustworthy.

Later, same shape, `propose`: stale prose headers ("not yet built" after shipping), memory-index /
dead-link hygiene, dependency/CVE bumps ([#73](https://github.com/SandRiseStudio/musterd/pull/73)
precedent), coverage-floor ratchet nudges.

### 5. Least-privilege, human-in-the-loop by construction

- The seat runs under a **scoped token** (contents + pull-requests write only); no admin, no protection
  bypass. Every change is a PR that clears the same required checks as a human's.
- `auto-merge` is reserved for statically-guarded mechanical tasks; everything with judgment is
  `propose`. The seat **proposes; humans dispose.**
- Secrets (the API key for the CI-launched session, the scoped token) are provisioned by Nick — this ADR
  freezes the design; **runtime activation is gated on that provisioning**, deliberately, so granting an
  automated writer its keys is a human act.

## Consequences

- The discovery half of "keep the record honest" gets an owner. Drift that a static check cannot see
  (shipped-but-unanchored, undeclared, un-flipped ADRs) is surfaced weekly as a shepherded, chased PR —
  not a rotting draft.
- **`no-orchestrator` holds.** The steward is a teammate with a task list, not a manager of seats. The
  configurable-autonomy knob generalizes to *other* specialized seats without any of them supervising
  another.
- **The static checks become the safety rail for automation.** `roadmap-truth:check` (PR #174) is why
  `roadmap-reconcile` can trust its own output and why `adr-status-hygiene` can auto-merge — the reason to
  keep investing in cheap static guards is that they are what make agentic maintenance safe.
- A standing steward seat is the product **dogfooding itself**: it exercises seats, scheduling/residency,
  seat memory, reachability/notify, and lanes at once — "musterd teams include standing agents that keep
  your repo's declared record honest" becomes a demoable story, not a slogan.

## Observability & Evaluation

**Traces** — the steward is an ordinary seat, so its runs already emit the coordination spans
([ADR 089](089-telemetry-l2-client-sdk.md)): each task run is a `musterd.tool.call`/lane lifecycle, each shepherding act a directed
message, each chase a reachability event. No new emitter.

**Eval** — the metric this seat exists to move is **record-drift latency**: time from a reality change
(a PR merges / an ADR is accepted) to the declared record reflecting it. Baseline: the days
`stale-plan-detection` sat mismarked. Target: under one steward cadence. Guard metric: **steward PR
acceptance rate** — if humans routinely reject its proposals, its discovery precision is too low (and, as
with any interrupt surface, the disable rate is the ceiling on how noisy it may be).

**Experiment** — inject a known drift (mark a shipped item `reserved`, leave an ADR `proposed` after
merge) and confirm the next steward run opens the corrective PR and chases it to review.

## Honest edges

- **It proposes; it cannot judge "works."** The steward can say "a PR merged that looks related to item
  X" and "ADR Y is accepted" — never "this feature is complete and correct." That judgment stays with
  tests / `verify` / the metric layer (ADR 088 increment 4). Curation survives because the human still
  approves the narrative.
- **Noise is the failure mode.** Too tight a cadence or too many eager tasks turns it into PR spam.
  Mitigation: start weekly, two tasks, `propose`-by-default, and watch the acceptance rate.
- **Auto-merge is a trust surface.** It is granted only where a static check fully determines
  correctness; widening it is a deliberate per-task config change, reviewed.
- **Mapping PRs → items is heuristic.** ADR refs and PR numbers are strong signals; keyword matches are
  not. Ambiguous matches are *listed for a human*, never auto-applied.
