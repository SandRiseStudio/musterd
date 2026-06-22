# 024 — human-reachability nudge: recipient-side salience + comeback summary

- Status: accepted
- Date: 2026-06-22

## Context

`research-foundation.md` records the Co-Gym result (arXiv:2412.15701): the notification-protocol
ablation more than doubles the collaborative win rate (**30% → 70%**) — notification _is_ the
mechanism, not a nicety. `implementation-plan.md` §4.A0 item 2 names the matching gap in musterd:
today a human sees an agent's `request_help`/`handoff` **only if** they are running `inbox --watch`,
and even then the act can be buried in a stream of team `status_update`s. That is the turn-taking-like
failure the paper measured — the single thinnest spot on the human side of the loop.

The gap splits in two postures:

- **(A) The supervising human is watching**, but the signal is lost in the stream (the dominant
  posture).
- **(B) The human is away**, and needs a true push — but nothing human-side is resident to push from.
  The only durable human attachment is `inbox --watch`, the very thing they aren't running.

The full v0.3 notification tiers (away/dnd + scarce `urgent`, designed in `spec-v0.3-draft.md` /
`membership-model.md`) are gated on the daemon leaving localhost (ADR 007). This ADR is the
**minimal, recipient-side** fast-follow — it changes only how the CLI _surfaces_ already-delivered
messages. Delivery semantics (at-least-once, cursor-based) are unchanged, so there is **no SPEC bump**.

## Decision

Two CLI-side pieces, cheapest first, sharing one predicate.

**The shared predicate — `isActionNeeded(env, me)`** (`render/rows.ts`): an act needs the human now
iff it is a `request_help` (a call for help anyone on the team can answer) **or** it is addressed
specifically to them (`to.kind === 'member' && to.name === me`, covering a directed
`handoff`/`message`/`wait`). Pure, so the live and comeback paths classify identically.

**Piece A — salience in the watch stream.** In `inbox --watch`, an action-needed delivery is preceded
by a sticky `⚑ ACTION NEEDED` banner (`theme.actionNeeded`, inverse-yellow so it outranks the plain
bold-yellow `accent` and survives a stream of status updates) and, on a real TTY, rings the terminal
bell — the cheapest true "push" available to a watching-but-distracted human. The bell is gated on
`process.stdout.isTTY` and suppressible with `--no-bell`. Solves (A) almost for free.

**Piece B — comeback / pending summary.** `musterd status` now leads with
`⚑ N requests waiting for you since <t>` (`renderPendingSummary`), counted off the existing durable
inbox cursor via `pendingActionSummary` (unread messages, filtered by `isActionNeeded`, oldest
timestamp). Returns nothing when zero, so the common path stays quiet. Zero daemon requirement, zero
cross-platform cost — it catches (B)'s return path and the driver-co-presence human whose terminal
is the agent's harness session musterd can't push into.

The "is the human watching?" branch the two postures imply is **cleanly derivable** and was verified:
a human running `inbox --watch` sends a WS `hello` → the server `attach()`es a live presence — exactly
the signal the `presence.active` gauge and the roster read. Present routes to (A) in the live stream;
absent is served by (B) on return. The pieces are complementary, not gated on each other.

## Scope — explicitly deferred to v0.3

**OS-native push** (`osascript`/`notify-send`/toast) is out of scope. It needs a resident human-side
process that does not exist today, and the tempting "let the daemon fire it" shortcut would couple the
clean coordination core to the host desktop and break under the now-designed remote topology
(`docs/design/deployment-topology.md`) — built only to be torn out. Both chosen pieces are
complementary to the full v0.3 notification tiers, not a replacement for them.

## Consequences

- **No SPEC/protocol-version bump.** Recipient-side rendering only; the wire is untouched. The
  `--no-bell` flag and the `status` banner are additive.
- **The notification half the evidence rewards is now wired on the human side** at near-zero cost,
  without a resident process or any desktop coupling.
- **The summary reads the durable cursor**, so it self-clears: once the human reads their inbox (the
  cursor advances), `status` stops nagging. `inbox --watch` does not advance the cursor (pre-existing),
  so a watched-then-quit session may still summarize on the next `status` — acceptable, and honest.
- **Salience is bounded by what's delivered.** `request_help` to team/broadcast and any directed act
  are flagged; a plain team `status_update` is not — matching "waiting _for you_".
- **`status` does one extra best-effort inbox read** (swallowed on failure). The plan's "ideally any
  invocation" is intentionally narrowed to `status` for now — the natural "where do things stand"
  command — to avoid an inbox round-trip on every CLI call; widening it later is additive.
