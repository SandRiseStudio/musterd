# 150 — Structural inducement: PreToolUse enforcement gates (lane-ownership + policy-classed action→ask)

- Status: **draft** — 2026-07-17. Co-designed by izzo (lane-ownership gate) + stanley (action→ask
  gate). Number **150 pinned** — verified free on `origin/main` (highest is 149), 2026-07-17.
- Date: 2026-07-17
- Builds on: [ADR 088](088-interrupt-line-tool-boundary-inbox-check.md) (the adapter-installed
  PreToolUse/PostToolUse hook this reuses as its actuator — the one place a headless agent is reachable
  mid-task), [ADR 083](083-lanes-warn-not-block.md) (lanes warn, never block — the default this ADR
  preserves and makes escalatable), [ADR 147](147-human-ask-stream.md) (the `ask` species/tier/hold
  contract the action→ask gate routes through, adding no new daemon state), [ADR 145](145-human-role-refounded.md)
  §6 (opt-in policy posture; and §-boundary: harness permission prompts stay with the harness),
  [ADR 085](085-layered-guidance-surface.md) (the guidance layer this ADR sits _below_ as enforcement),
  [ADR 109](109-seat-git-attribution.md) (seat identity the gate keys ownership on).

## Context

Coordination substrate on musterd has, until now, been **advisory**: lanes warn on overlap (ADR 083),
the primer/skill _direct_ agents to claim work and raise asks (ADR 085, ADR 147), and the tools are
available. Two findings, one from each side of the coordination relationship, show advice alone does
not always produce the behavior:

1. **Agent↔human (ADR 147 founding datum):** all-time on the dogfood team, **0 `request_help` ever
   reached the human** despite the act existing.
2. **Agent↔agent (cookoff cell-D A/B, 2026-07-17):** with 8 lanes seeded and 3 agents, **0 lanes were
   ever claimed** — each agent soloed the whole backlog (65.5% wasted work). We then shipped an
   _active-direction_ primer (ADR 085 / PR #319: "claim a lane before you build") and re-ran the
   **same apparatus**, verifying in-transcript that all three agents received the new primer. Result:
   **still 0 lanes claimed, 0 asks, 82.6% wasted.** Guidance changed nothing.

### The scoped claim (do not overclaim)

Wording is **not** universally exhausted. The dogfood team's **interactive** agents use lanes and acts
every day — this ADR was itself coordinated over them. What the A/B proves is narrower and sharper:

> **Guidance loses to the task prompt in single-pass, headless agents that have no task boundary at
> which the guidance can bind.** An interactive agent re-reads its situation at every turn; a headless
> `-p` agent handed "deliver the backlog, stop when done" executes that instruction and treats ambient
> coordination guidance as non-binding background, because nothing forces it to stop and consult the
> team.

The one place such an agent is _reachable mid-task_ is the **tool boundary** — every edit, every
command goes through it. That is where enforcement must live, and it is exactly the seam ADR 088
already actuates (the interrupt-line PreToolUse/PostToolUse hook). Enforcement is therefore not "guidance
failed, coerce everyone" — it is "**for the case where no boundary exists for guidance to bind, create
one at the tool call.**"

## Problem

Add a _forcing function_ that makes a coordination primitive a **precondition** of an action, such that:

- it binds the case guidance cannot (headless, no-boundary agents) without punishing the case guidance
  already serves (interactive agents who coordinate fine);
- it preserves musterd's **warn-never-block default** (ADR 083) — enforcement is a deliberate,
  scoped, opt-in choice, never the out-of-box posture;
- the human-facing half **never rebuilds harness permission prompts** — ADR 145's drawn line ("those
  stay with the harness") is not crossed by smuggling generic tool mediation into musterd;
- it adds **no new daemon scheduler/state** — reuses the ADR 088 hook actuator and the ADR 147 ask
  contract.

## Decision

**One mechanism, two gates, one policy model.** An adapter-installed **PreToolUse hook** (the ADR 088
interrupt-line precedent, pointed at the pre-action seam) intercepts a tool call and requires a
declared coordination primitive to be satisfied before the action proceeds. Which actions are gated,
and whether the gate _warns_ or _blocks_, is a **team-policy declaration** — opt-in, default warn.

### Gate A — lane-ownership (agent↔agent) — _izzo_

**An edit to a policy-declared contended surface requires the acting seat to own a claimed lane whose
`surface_globs` cover the target path.**

- **Trigger:** PreToolUse on `Edit`/`Write` (and write-shaped `Bash` where detectable) whose target
  path matches a **contended-surface class** declared on the team policy (a list of globs, same shape
  as lane `surface_globs` — e.g. `src/tariff.ts`, `src/config.ts`).
- **Check:** does this seat (ADR 109 identity, resolved from the workspace binding) own a **claimed**
  lane whose `surface_globs` cover the target? Query is one lane-board read against the daemon.
- **Outcome (per policy posture):**
  - `warn` (default): allow the action, surface "⚠ you're editing `src/tariff.ts` with no claimed lane
    covering it — claim one so the team can see it" (advisory, ADR 083 preserved).
  - `block` (opt-in escalation for that surface-class): deny the tool call with a repair string —
    "claim a lane for `src/tariff.ts` first (`lane_claim <id>` or `lane_open … --surface src/tariff.ts
--claim`); it is owned by `<seat>` / it is open." The agent must claim (or take a different lane)
    to proceed. Claiming becomes the _only_ path to the edit — the forcing function.
- **Why it binds where guidance didn't:** the headless agent that ignored "claim a lane" in its primer
  cannot ignore a denied `Edit` — the denial is in its action loop, not its background context.
- **Non-goals:** does not gate reads, does not gate non-contended surfaces, does not adjudicate _who_
  should own a lane (still a warn-and-coordinate, ADR 083). It gates only "you are editing a declared
  contended surface without having claimed it."

### Gate B — policy-classed action→ask (agent↔human) — _stanley_

**A tool call matching a team-declared costly-action class requires an answered `approve` ask before
it proceeds.** The gate does not _advise_ asking (the A/B shows advice loses); it **routes** the action
through the ask stream: the deny **is** the emission, so the ask exists whether or not the agent would
have raised one.

**Boundary constraint (load-bearing, ADR 145).** This gate covers **team-policy-declared action
classes only**. The declaration is the team saying "these specific actions are team-consequential —
the shared branch, shared infra, money." It is **never generic tool mediation** and **never a
re-implementation of harness permission prompts** (nick's line: those stay with the harness). Two
structural guards keep the creep out: the class table lives on the **team policy** (admin-set, audited
`policy.change`) — never in harness settings — and a call matching **no declared class passes through
untouched**, always. If a design change would make this gate fire on an undeclared call, it is out of
scope by construction.

- **Declaration schema:** costly-action classes ride the same policy table as Gate A's
  contended-surface classes — one `enforcement` policy field, two class kinds. A costly-action class
  is `{ class, match, posture }`:
  - `class` — a short name (`merge-to-main`, `force-push`, `deploy`, `spend`) that appears in every
    denial, ask body, and audit row — the legible unit the team declared.
  - `match` — per tool shape: for `Bash`, a list of **command globs** matched against the normalized
    command (first line, collapsed whitespace — e.g. `git push --force*`, `gh pr merge*`,
    `terraform apply*`); for `Edit`/`Write`, **path globs** (e.g. a production config). First matching
    class in declaration order wins; matching consumes only what the harness already hands a
    PreToolUse hook (tool name + input) — the gate gains no new visibility into the session.
  - `posture` — `warn` (default) | `block`, per class, exactly as Gate A.
- **On match, posture `block` — deny _is_ emit:** the hook (1) **denies** the call, (2) checks for an
  **existing open gate-ask** for the same class + action fingerprint (a hash of the normalized
  command/path — so retries converge on ONE ask instead of spamming one per attempt), (3) if none,
  **emits** the ask itself through the seat's own credential: `species:approve`, `tier:blocking`, body
  naming the class and the exact action, `meta.gate = { class, fingerprint }` so a gate-emitted ask is
  distinguishable from an agent-authored one in the record. The emission lands on every ADR 147/149
  surface for free — admin push, the loud `/live` strip, the Slack webhook. (4) The denial's repair
  text hands the agent its ADR 147 contract verbatim-intent: _"blocked pending human approval — ask
  `<id>` raised (blocking: wait up to 15m; on silence HOLD, record `status_update` with
  `meta.ask_ref` + `ask_outcome:'held'`, do NOT proceed). Do other work or re-try the action to
  re-check; a human accept releases it."_
- **Release — re-check on re-attempt, no timer anywhere:** the gate keeps ADR 147's clock discipline —
  the daemon runs no timer, and neither does the hook. Each **re-attempt of the action** re-runs the
  hook, which re-checks the ask thread: an **`accept`** (from a human seat) referencing the `ask_ref`
  → the call passes, once-per-fingerprint standing until the policy or fingerprint changes; a
  **`decline`** → stays denied with "declined by `<seat>` — do not re-raise; take a different
  approach or hand off"; **no answer** → stays denied, contract restated. Re-attempting is the
  natural agent move after a denial, so the cadence is agent-owned exactly like the ask clock itself.
  ("Only an _admin's_ accept releases" is deliberately NOT hard-enforced here — same deferral as
  ADR 147's approve species, gated on `multi-human-admin`; the release check requires a **human**
  seat's accept.)
- **Posture `warn`:** the action **proceeds** and the hook surfaces the advisory ("heads-up:
  `merge-to-main` is a declared costly action — raise an `ask` species:approve before this when it's
  irreversible") — no ask is emitted (an approval nobody requested is noise, and warn means the team
  chose visibility over consent). The decision row below preserves the trace.
- **Audit shape:** symmetric with Gate A — one **`action.gate`** decision row per intercepted call
  (class, seat, posture, outcome: `warned` | `denied_ask_raised` | `denied_awaiting` |
  `denied_declined` | `released`), posted through the same small daemon ingest Gate A's `lane.gate`
  rows use (member-authed; decisions are shapes only, never command text beyond the class +
  fingerprint). The ask lifecycle itself needs nothing new: `ask.raised` (with `meta.gate` in its
  detail) → accept/decline → `ask.held` if the agent records the elapsed hold — all existing ADR
  147 rows. "Which costly actions proceeded un-asked" is then one query: `action.gate` rows with
  outcome `warned`, beside the `ask.*` rows the block posture provoked.
- **Why it binds where guidance didn't:** the primer said "ask before costly actions" and produced 0
  asks; the gate makes the ask **exist as a side-effect of attempting the action** — the agent's
  cooperation is required only for the _waiting_ (which the blocking contract already governs and the
  hold outcome makes auditable), not for the _raising_.
- **Non-goals:** no gating of reads or undeclared calls; no interactive approval UI in the hook (the
  human answers on the ADR 149 surfaces, not at the tool boundary); no agent-side override — release
  paths are a human accept or an admin flipping the class posture, both audited.

### The policy model (both gates)

Enforcement is an **opt-in, team/enrollment-scoped policy** (same knob family as residency and ask-tier
config). The declaration is a small table:

| class kind        | matcher (globs / command classes) | posture (`warn` \| `block`) |
| ----------------- | --------------------------------- | --------------------------- |
| contended-surface | `src/tariff.ts`, `src/config.ts`  | `warn` (default)            |
| costly-action     | `merge-to-main`, `force-push`     | `warn` (default)            |

- **Default is `warn`** for every class — warn-never-block (ADR 083) remains the out-of-box posture.
- **`block` is a per-class escalation** a team deliberately turns on. No global "strict mode"; a team
  gates exactly the surfaces/actions it has decided are worth the friction.
- Distribution: the hook ships via the harness adapters (ADR 088 precedent, ADR 038 adapters); the
  policy lives on the team and the hook reads it, so the gate is consistent across a team's seats.

## Observability & Evaluation

**Traces** — both gates fire at the ADR 088 hook seam and record through existing audit rows, no new
instrument. Gate A: a `lane.gate` decision row per intercepted edit (surface, seat, `warn`|`block`,
owned-lane-id or none) sits beside the `claim.*` it does or doesn't provoke. Gate B reuses the ADR 147
`ask.*` lifecycle rows verbatim (`ask.raised` → accept/decline → proceed/held) — the deny-emit-hold is a
hook behavior, not a new act. The whole experiment is one query over `lane.gate` + `claim.*` + `ask.*`.

**Eval** — headline: **lane-claim rate** (fraction of contended-surface edits preceded by a claim by the
same seat) and **ask-raise rate** (policy-classed actions that emitted an `ask.raised`). Secondary:
**wasted-work %** (the cookoff archaeology metric — does forcing a claim cut the duplicate-work floor).
Guard metric (must **not** move): enforcement must not raise **interventions-to-done** via agents wedging
on a gate they cannot satisfy (a `block` that strands an agent is a regression, not a success). **Dataset:**
the cookoff cell-D run audit (fixture `ea5c6d4`, artifacts `~/cookoff-run/`). **Baseline:** the 2026-07-17
A/B — **0/8 lanes claimed, 0 asks, 65.5%→82.6% wasted under guidance-only** (run 1 and run 2 both).

**Experiment** — pre-registered as the enforcement arm of the cell-D A/B, two cells:
(1) **Gate A cell** — re-run cell-D with contended surfaces declared, posture=`block`; does claim-rate
lift off **0/8** and does wasted-work drop below the 65–82% floor? (2) **Gate B cell** — cell-D's backlog
has **no genuinely costly action**, so seed a ticket whose completion requires a policy-classed action
(force-push / destructive migration); does the gate fire, does `ask.raised` become non-zero (the first
datum for ADR 147's own pre-registered question), and does the agent **hold** or bypass? Success is
**directional, not a threshold** — enforcement lifts claim/ask off zero where guidance did not. Conditional:
if `block` raises interventions (agents strand rather than claim), the gate is too blunt for headless
agents and the finding becomes "structure the work, don't gate the tool." Honesty caveat inherited from
the A/B: **n is small; report the mechanism — did the gate fire, did the agent comply — beside every
count**, never a headline rate alone.

## Consequences

- **Reconciles enforcement with the founder ethos:** warn-never-block stays the default; block is a
  scoped, opt-in team decision. A team that wants a swarm keeps warn; a team that wants guardrails
  escalates specific classes.
- **No daemon growth:** both gates are adapter hooks reading existing state (lane board, ask audit);
  the ask half adds nothing to the ADR 147 contract.
- **Respects the harness boundary:** Gate B is confined to declared action classes, so musterd never
  becomes a second permission-prompt system.
- **Risk — headless compliance is unproven:** the A/B shows guidance is ignored; it does **not** yet
  show a _block_ is obeyed rather than worked around (an agent could edit a different file, or abandon).
  The pre-registered arm is exactly what tests this — the ADR is a hypothesis with its experiment
  attached, not a settled result.
- **Risk — over-declaration friction:** a team that blocks too many surfaces recreates the approval
  tax the whole product argues against. The default-warn posture and per-class opt-in are the guard;
  the docs must frame block as a scalpel.

## Related

Cookoff A/B evidence: [`docs/design/cookoff-cell-runbook.md`](../design/cookoff-cell-runbook.md),
[`cookoff-run-manifest.md`](../design/cookoff-run-manifest.md), run artifacts `~/cookoff-run/`.
Guidance layer this sits below: [ADR 085](085-layered-guidance-surface.md). Actuator:
[ADR 088](088-interrupt-line-tool-boundary-inbox-check.md). Ask contract: [ADR 147](147-human-ask-stream.md).
