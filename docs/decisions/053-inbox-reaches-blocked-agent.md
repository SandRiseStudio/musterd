# 053 — Inbox reaches a blocked agent: push delivery at the approval-prompt moment

- Status: proposed
- Date: 2026-06-25

## Context

ADR 046 made a directed act waiting for an agent surface on **every command it runs** — a one-line
stderr nudge built from the same predicate as the human comeback summary. That closes the
*heads-down* gap: an agent that keeps acting can't miss a `request_help`. It does **not** close the
*blocked* gap.

The 2026-06-25 cross-network dogfood (two Claude-Code-in-Cursor instances as two musterd agents in a
different repo) made the distinction concrete. The human regressed into being the **message bus**,
hand-relaying between the two agents. The proximate cause: with per-tool approval on, an agent parked
on a permission prompt has a **frozen main loop** — it runs no command, so ADR 046's
per-command nudge never fires, and a teammate's message sits unread until the human notices and
relays it by hand.

A tempting fix — "allowlist the musterd commands so inbox checks never prompt" — does **not** apply:
the operator had **already** allowlisted every `musterd` command. The block was on the agent's
**own work** commands (build, git, deploy) — exactly the calls the operator *deliberately* gates for
review. So:

> A single-threaded agent loop parked on **any** approval is structurally deaf to its inbox. No
> allowlist changes this, because the block is on the work the human *wants* to review. Pull-based
> inbox surfacing — ADR 046's nudge, a `/loop` poll (ADR 054), anything that needs the loop to be
> running — cannot reach a frozen loop.

The reachability tooling must reach the agent through a channel that **is not** the frozen loop.

## Problem

When an agent is blocked awaiting human approval, (a) deliver a waiting directed act to *someone who
can act on it*, and (b) let the **sender** see that the agent is blocked rather than silent —
**without** a wire change, without forcing the agent to run a resident process, and without weakening
the operator's choice to gate their own work commands.

## Decision

Two moves, both riding the one actor guaranteed to be present at a blocked prompt — **the human who
is about to approve** — and both harness-provisioned, not protocol.

### 1. Push delivery at the approval-prompt moment (receiver side)

The approval prompt is not just the problem; it is the **delivery seam**. Claude Code fires a
**`Notification` hook** exactly when the agent parks awaiting input/approval. `musterd` provisioning
(the adapters, ADRs 026/029–031) installs a Notification hook that, best-effort, runs
`musterd inbox` for the bound seat and prints any **unread directed acts** into the terminal the
human is already staring at. The dead-wait moment becomes the delivery moment.

- **Reuses the audited predicate.** Same `pendingActionSummary`/`openActionNeeded` as ADR 024/046 —
  live, nudge, and hook paths classify identically. Self-clearing via the durable cursor.
- **Recorded for exact reversal.** The hook is written the same way ADR 030's manifest already
  records `permissions`: `provisioned.json` gains a `hooks` field listing what musterd added, so
  `musterd uninstall` removes precisely the hook it installed and never the user's own.
- **Best-effort, stderr-style.** Any inbox/roster read failure is swallowed — the hook must never
  block or fail the approval it rides on. Opt-out via the existing `MUSTERD_NO_NUDGE`.
- **Harness-specific, named seam.** Claude Code has `Notification`; Cursor/Codex differ. A
  `Harness.notificationHook()` extension point (mirror of `Harness.primerPath()`, ADR 012) keeps the
  per-harness shape behind one interface; harnesses without the seam degrade to ADR 046's
  per-command nudge (the floor) plus move #2.

### 2. Blocked-on-approval visibility (sender side)

The same hook that delivers inbound emits the agent's state **outbound**: on firing it does a
best-effort presence touch marking the seat `blocked_on_approval` (an ambient-presence write, ADR
010/017 lineage — no wire change, rides an authenticated command). The roster and a sender's
`inbox`/`team_status` then show *"David — blocked awaiting human approval (since 14:17)"* instead of
silence, so the sender (or its human) knows to nudge the human rather than assume the agent is
working. The state clears on the next acting command (the loop resumed).

### Why this is the right shape

- **Preserves the operator's safety choice.** Work commands stay gated; nothing here auto-approves.
- **Push, not pull.** Reaches a frozen loop because it does not depend on the loop — it depends on
  the human who is, by definition, present at the prompt.
- **Clean core.** No server or SPEC change. Delivery and state both ride existing client paths
  (inbox cursor read; presence touch). The down-payment posture again: the governed routing of
  "Notification tiers" is the superset; this is the cheap floor for the *blocked* case.

## Open questions

- **Throttle.** The hook can fire often during a long approval-heavy session. Lean: print only when
  the cursor shows *new* unread since the last hook fire (in-process de-dupe, as ADR 035).
- **Codex/Cursor seam.** Do both expose an idle/approval hook? If not, move #2 (sender-side
  visibility) still works from any acting command; only move #1's terminal-injection is Claude-Code-
  first. Name it; don't fake parity.
- **`blocked_on_approval` vs plain offline.** Whether to model it as a distinct presence value or a
  derived "stale since last touch + a pending approval" inference — settle with the ambient-presence
  ADR (it owns presence-write semantics).

## Consequences

- A directed act can reach an agent that is blocked on its own gated work — the one case ADR 046's
  per-command nudge structurally cannot cover — closing the message-bus regression at its root.
- Senders stop reading "blocked" as "ignoring me"; the human stops hand-relaying.
- One more provisioned artifact (the hook) and one more `provisioned.json` field (`hooks`); both
  reversible by the same mechanism as MCP servers and permissions.
- Harness-dependent and best-effort by construction — honest about being a floor, not a guarantee.
- Builds on ADR 046 (per-command nudge — the heads-down floor this extends to the blocked case),
  ADR 030 (manifest reversibility), ADR 029–031 (adapters), ADR 035 (notify), ADR 010/017 (presence).
