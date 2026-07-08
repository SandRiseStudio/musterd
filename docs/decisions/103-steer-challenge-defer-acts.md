# 103 — Steer, challenge, defer: first-class steering acts on the interrupt line (ADR 088 increment 2)

- Status: accepted — freezes increment 2 of the interrupt-line arc; shipped 2026-07-06 (PRs #138/#143, /live render #158)
- Date: 2026-07-06

## Context

[ADR 088](088-interrupt-line-tool-boundary-inbox-check.md) shipped increment 1 of the interrupt line
(design arc: [interrupt-line-mid-loop-reachability.md](../design/interrupt-line-mid-loop-reachability.md)):
`musterd inbox --interrupt-check`, a sub-50ms probe a PostToolUse hook runs at every tool boundary, so a
waiting **urgent** directed act reaches a busy agent at its next tool call instead of its next task
boundary. The delivery channel exists and is scarce by construction — `pendingInterrupts` gates on
directed-at-me-or-`request_help` + `meta.urgent` (which `can_flag_urgent` already governs upstream) +
not-resolved. ADR 088 §3 explicitly reserved the next step: _"Future steering acts (design §4.2–4.3:
`steer` / `challenge`) are interrupt-class by definition — they arrive in increment 2 and need no change
here beyond act names."_

Today a change of direction is a free-text `message`. The model can't tell "keep going" from "stop, the
interface changed" from "why are you doing this at all" — they are all `message`, all the same salience,
all un-superseding. The interrupt line can carry them, but it has no vocabulary for them.

This ADR freezes **increment 2**: the steering _vocabulary_ that rides the increment-1 line. Design
§4.2–4.3 splits "change of direction" into three verbs — **steer** (directive), **challenge**
(epistemic), and **reorder/defer** (plan mutation on the Goal spine). Increment 3
([stale-plan-detection](../design/interrupt-line-mid-loop-reachability.md) §5 — goal epochs + dependency
invalidation) is the semantic backstop for the deaf window the line can't close; it is **not** in scope
here.

## Problem

Give steering first-class semantics on the _existing_ interrupt line — new act names the daemon,
protocol, MCP, and CLI all recognize — **without new delivery machinery** (no new route, no new table,
no wire-version bump; `pendingInterrupts` simply recognizes the new acts), and without letting the new
verbs weaken the "scarce by construction" property that keeps the line from becoming noise.

Three sub-decisions:

1. **Which acts, and how many.** The design names a slash-joined pair "reorder/defer"; how does that map
   to the append-only [`ACTS`](../../packages/protocol/src/acts.ts) enum?
2. **Interrupt class per act.** `steer` is "always interrupt-class"; `challenge` is "tier-configurable";
   plan mutation is "warn-never-block". What, concretely, raises the ⚡ line?
3. **Supersession.** `steer` must "supersede prior direction ([ADR 017](017-newest-session-wins.md)) so a
   late-waking agent sees only the current direction, never a contradictory stack." Where does that live
   without building a message-supersede subsystem?

## Decision

### 1. Three acts append to `ACTS`: `steer`, `challenge`, `defer`

The append-only act enum (`packages/protocol/src/acts.ts`, "new acts append") grows by three, and
`ActSchema` (and through it envelope validation, the CLI, and every consumer that derives from it) picks
them up for free:

- **`steer`** — a directive: "do this instead." Always interrupt-class (§2). Supersedes prior direction
  (§3).
- **`challenge`** — epistemic: "justify this task/assumption or reconsider it." Warn-never-block, peer-
  shaped (a human or an agent can challenge anyone), answered with evidence — an `accept` carrying the
  justification, or a plan change. Interrupts only when its sender flags it (§2). The Co-Gym
  humans-as-peers finding operationalized to steer _thinking_, not just tasks.
- **`defer`** — the plan-mutation act (the design's "reorder/defer"). It names a Goal on the spine
  ([ADR 048](048-plan-goal-work-item-model.md)/[084](084-lanes-join-the-plan.md)) via a required
  `meta.goal_id`, and carries an optional `meta.wave` target: absent or `"later"` **defers** the Goal
  (sorts last), a numeric wave **reorders** it. One act covers both operations the design pairs, and it
  stays honest with the Goal model — `wave`/`"later"` is exactly the ordering field `nextGoal` already
  reads.

We ship **three acts, not four** (no separate `reorder`): reorder and defer are one operation over the
same `wave` field, distinguished by the target, so a second verb would be redundant surface.

`defer` is the _vocabulary and the signal_ — a first-class, auditable, structured message that a Goal
should move. Automatic re-sequencing of `nextGoal` on receipt (and the goal-epoch bump a `steer`/`defer`
implies) is **increment 3's** semantic layer; wiring it into the write path here would be the "new
delivery machinery" this increment is defined against. Until then `defer` is a legible coordination
signal that a human or the Goal's owner acts on, not an executed mutation.

### 2. Interrupt class: only `steer` is unconditional; `challenge`/`defer` ride the tier

The only change to the interrupt predicate (`pendingInterrupts`,
`packages/server/src/store/messages.ts`) is that **`steer` is interrupt-class by definition** — it raises
the line whether or not it is flagged `urgent`, because steering is definitionally worth an interrupt
(design §4.2). Everything else is unchanged:

- **`challenge`** is _tier-configurable_: it interrupts only when its sender flags it `urgent` — exactly
  today's directed-act behavior, no special case. This is the "warn-never-block" default: a challenge
  waits for the natural task-boundary inbox check unless the sender pays the `urgent` cost.
- **`defer`** likewise interrupts only when urgent — a plan reshuffle is rarely worth breaking deep work.

So the scarcity property is preserved: the only _new_ thing that can raise the line without the
capability-gated `urgent` flag is `steer`, the one verb the whole arc exists to deliver. The audit row
and the composed line now name the raise class (`steer` vs `urgent`) instead of hardcoding `urgent`, so
"who grabbed the mic, and by what right" stays legible (§Observability).

### 3. Supersession lives in the read predicate, not a new subsystem

[ADR 017](017-newest-session-wins.md) is _newest-same-identity-session-wins_, implemented as connection
displacement. This increment borrows the **primitive, applied to direction**: among the `steer` acts
still waiting for a recipient, **only the newest survives**; older steers are superseded and neither
interrupt nor count. A late-waking agent that checks its line sees one current direction, never a
contradictory stack — the exact ADR 017 guarantee, moved from sessions to steers.

Crucially this is a **pure read-side collapse inside `pendingInterrupts`**, mirroring how a `resolve`
already closes a thread there (messages.ts) — no supersede column, no write-path side-effect, no new
frame. That is what "`pendingInterrupts` just recognizes the new acts" means: newest-steer-wins is a
filter over the same envelope list the predicate already reads. Supersession is scoped to
`steer`-supersedes-`steer` (a "direction", not every directed act); a `challenge` or an urgent `handoff`
is not a direction and is never silently dropped.

### 4. The acts are selectable everywhere the vocabulary is surfaced

- **MCP `team_send`** stops hand-duplicating the act list (`packages/mcp/src/tools/send.ts`) and derives
  its `act` input from `ActSchema`, so the enum can never drift from `ACTS` again; the tool description
  gains the three verbs.
- **CLI `musterd send --act`** needs no list edit — it already validates through `ActSchema` — and gains
  `--act steer|challenge|defer` for free.
- **`accept`/`decline` auto-targeting** (ADR 067) extends to answer a `challenge`: an `accept` with no
  explicit target now auto-points at the latest open `request_help`/`handoff`/**`challenge`** for the
  member, so "answer a challenge with evidence" is one command.
- `defer` requires `meta.goal_id` (a non-empty Goal id), enforced in `actMetaRules` alongside the
  existing accept/decline/resolve/urgent rules — the same "structured meta or reject" posture.

## Consequences

- Steering has a vocabulary. A busy agent's interrupt line can now say **`steer` from june** — a
  directive that supersedes the last one — distinct from an urgent `handoff` or a `challenge` to its
  reasoning. The free-text-`message` ambiguity that made every direction change look the same is gone.
- **No new delivery machinery, no wire-version bump.** Three additive enum entries, one predicate branch
  (`steer` bypasses `urgent`), one read-side collapse (steer supersession), one `actMetaRules` clause
  (`defer.goal_id`), and the MCP enum de-duplicated. The increment-1 route, hook, audit, and telemetry
  carry it unchanged.
- **Scarcity holds.** Only `steer` gains unconditional interrupt rights; `challenge`/`defer` stay behind
  the `can_flag_urgent`-gated `urgent` flag. Nobody gains a new way to thrash deep work.
- **`defer` is a signal, not yet an actuator.** It records and surfaces a plan mutation but does not
  re-sequence `nextGoal` on its own — that (and goal epochs) is increment 3. Named honestly so the seam
  is visible, not a silent gap.
- **A latent drift closed.** The MCP act enum was a hand-maintained copy of `ACTS`; deriving it from
  `ActSchema` means the next act to land is selectable from MCP without a second edit.

## Observability & Evaluation

**Traces** — the new acts ride the increment-1 instrumentation with no new emitter: they flow through the
`musterd.tool.call` / `musterd.cli.command` spans (ADR 089) on the way in, and a `steer` that raises the
line reuses the `musterd.interrupt.check` counter (`result = raised`) and the deduped `interrupt.raised`
audit row (ADR 088). Two fidelity improvements land here so a steer is distinguishable from an urgent
ping in the trace: the audit `detail.tier` and the composed line now carry the **raise class** (`steer`
when steer-always-class fired, `urgent` otherwise) instead of the hardcoded `urgent`, and
`detail.act_kind` already records the act. The raised→read pair (an `interrupt.raised` for a `steer`
followed by the recipient's inbox read of that act) is the steer delivery-confirmation signal.

**Eval** — the headline metric this arc exists to move, now measured on the first-class verb:
**steering latency** — time from a `steer` being sent to the recipient's next act acknowledging it.
_Dataset:_ the message DB (every `steer` and the acknowledging act are persisted envelopes; no new
capture). _Baseline:_ the P3 dogfood, where a direction change delivered as free-text arrived a full work
cycle late and produced the dependency-revert that was 53% of that session's waste, plus increment 1's
urgent-handoff steering latency. _Targets:_ median `steer` latency ≤ one tool-call boundary for hooked
agents; and a **supersession-correctness** check — the count of acts taken against a _superseded_ steer
(the contradictory-stack failure) should be zero, measurable by joining each post-steer act to the
current-vs-superseded steer at its timestamp.

**Experiment** — the built-in A/B, an extension of ADR 088's hook-on/hook-off demo: same two-agent task
with a mid-task direction change, delivered once as a free-text `message` (control — today's vocabulary)
and once as a `steer` (treatment). Compare steering latency, rework attributable to stale assumptions,
and whether the late agent acted on the _current_ or a _stale_ direction (the supersession payoff). This
is a coordination-traces benchmark scenario (ADR 056) and the launch demo for the steerable-team wave.
