# 430 — WakeContextPacket v2 carries attributed, budgeted bodies

- Status: proposed
- Date: 2026-09-21

## Context

[ADR 209](209-portable-wake-context.md) made a fresh spawn the normal delivery for a wake and gave it a `WakeContextPacket` to orient by: server-derived metadata — wake kind, objective, a lane block, thread counts, a memory *headline*, and a `fetch` list naming what the seat should go read. It carries no Act body and no memory body, to preserve boundary #2 of that ADR: *agent-authored Act bodies and seat-memory bodies never enter a spawn prompt*, which traces to [ADR 088 §4](088-in-band-steering.md) — text injected into a model's prompt is read as instruction, so the composed line is built from structured fields and reading a body is an explicit follow-up act.

Two measurements on 2026-09-21 (lanes 01M2XD2WCE and 01M32FGSXK, [wiki](../wiki/resume-bound-is-below-one-wake-life.md)) show what v1 buys a cold spawn. dolly, woken by a steer: `team_wake_context` → `team_inbox_check` (26 KiB, the same July backlog every call returns) → `team_memory_read` → her first act — four calls, ~30 KiB, and the packet had told her nothing the line had not. ryder, measuring the packet on its own terms: *one memory headline cut at ~80 characters, `size_bytes: 2621`, and `fetch: ["inbox_thread","seat_memory"]`* — "ADR 209's WakeContextPacket today is 'what is waiting' plus a chapter title, and 'where you left off' is a second round-trip the seat must know to make."

Transcript resume ([ADR 131 §5](131-harness-residency-wake-ledger-host.md), revived on Claude Code by [ADR 427](427-resume-bound-gates-on-message-bytes.md)) gives a seat yesterday's context, but only on the harness that wrote the transcript: Codex resumes a thread id and its rung already fails ([ADR 210](210-exact-match-local-continuity.md)). The goal `seat-continuity` — every seat reachable live and picking up where it left off regardless of harness — cannot rest on it. The design that this ADR gates was brainstormed with nick and is recorded in `docs/superpowers/specs/2026-09-21-continuity-packet-design.md`.

## Problem

A seat woken cold needs, on any harness, what a resume would have given it: enough to make its first real act correctly, and a brief understanding of the conversation it was in. The v1 packet points at that context; it does not deliver it. Every seat re-derives its bearings through the same 2–4 calls, paying in cost, wall time, and — on the inbox call — 26 KiB of acts it already saw.

The rule that keeps bodies out of the packet was drawn wider than its reason. The injection concern protects the *prompt*: the spawn line and the interrupt line. The packet is read through a tool call — the same channel as `team_inbox_check`, which already returns bodies to the same recipient under the same recipient-scoped authorization (ADR 209 §4). What the rule must still guarantee is that the packet stays *bounded* (so it is not a resume by another name) and *derived at read time* (so it is not a second store).

## Decision

1. **`WakeContextPacket` v2 is v1 plus one `context` block and one `budget` field.** Every v1 field is unchanged; a v1 adapter or host reading a v2 packet ignores what it does not know. `version` becomes `1 | 2`.

   ```ts
   context: {
     thread?: { acts: Array<{ id; from; act; ts; body; truncated: boolean }>; omitted: number };
     open: Array<{ kind: 'ask' | 'request_help' | 'review' | 'handoff' | 'lane'; id; from?; title; age_ms }>;
     lane?: { detail; truncated; last_status_update?: { ts; body; truncated } };
     memory?: { body; truncated };
   };
   budget: { limit_bytes: number; used_bytes: number };
   ```

   `fetch` gains the value `open_items`, and in v2 lists only what was truncated or omitted.

2. **Bodies in the packet are attributed and addressed.** Every act body carries `from`, `act`, `ts`, and rides under the thread it belongs to; the memory body is the seat's own; `open` carries titles only. A seat is never handed unattributed prose. **The composed wake line and the interrupt line remain ids-only** — ADR 088 §4 is untouched.

3. **Derived at read time; no new store.** `thread.acts` = the last 8 acts of the waking thread (oldest first, bodies cut at 600 chars). `open` = unanswered directed acts to the seat plus lanes it owns in `claimed`/`active`/`blocked`, oldest first, ≤ 12. `lane` = the row's `detail` (cut at 1,200) and the seat's own newest `status_update` naming the lane (cut at 600). `memory` = the body whole when ≤ 3 KiB, else headline + first 3 KiB. Every field is a query against rows the daemon already holds.

4. **Hard budget: 12,288 bytes on the serialized `context` block**, filled memory (3,072) → thread (6,144) → lane (1,536) → open (2,048). What does not fit is truncated with its flag set or dropped whole, and its category named in `fetch`. `budget.used_bytes` reports the real size. One number; retuned only by a later ADR against measurement.

5. **Authorization is ADR 209 §4, unchanged.** Nothing becomes readable through the packet that was not already readable through `team_inbox_check` and `team_memory_read` by the same caller.

6. **The audit stays metadata-only.** `residency.context_read` gains `version`, `used_bytes`, per-category bytes, `thread_acts`, `omitted`, and the `fetch` categories emitted — never a body, headline, or title. The forbidden path gains `residency.context_denied` (caller, target *kind*; never the target id), closing the gap ryder recorded on #603.

7. **The packet is the orientation.** The composed wake line's instruction becomes: read `team_wake_context {…}` — it carries the thread, what else is open, and your memory; fetch more only for what it lists under `fetch`; then act. The `musterd-orient` skill and the primer's wake guidance change to match: `team_inbox_check` is not a ritual step on a wake. A seat handed `version: 1` falls back to the v1 ritual.

## Consequences

- A cold spawn on any harness arrives with the waking thread's recent acts, its open ledger, its lane and its memory in one read of ≤ 12 KiB (~3k tokens, ~6% of the 47k-token life it replaces four reads in). Codex and Claude Code receive the same packet; that is the harness-independence claim, made testable by the three-arm measurement in the spec (dolly resume / dolly fresh+v2 / gptbot fresh+v2, same task, first-act correctness judged by the sender).
- ADR 209's "no bodies in the packet" is narrowed to its reason: no bodies in the *prompt*. The two constraints that survive — bounded, derived at read time — are what §3–4 enforce.
- The memory headline stops doing retention work it was not designed for (ryder, 2026-09-21): the body travels whole when it fits.
- Increment 2 of the goal (`team_inbox_check` re-delivering the backlog) stops mattering to wake cost even before it lands, because a v2 wake does not call it unless `fetch` says so.
- `SPEC.md` Appendix A gains the unreleased contract (A.13); `02-protocol.md` and `03-server.md` update in the implementation increment that ships the code (ADR 209 §5's rule). The implementation is goal `seat-continuity` increment 4, lane `01M32FHX6JHCVNQRGRAHHMTEJN`.
- Out of scope, by decision: identity continuity across unrelated work; any summarizer; a per-team budget knob; changes to which wakes are portable vs transcript-required; the interrupt line.

- _2026-09-21 (lane 01M32FHX6J, shipped): §6's "denied-read record" is satisfied by the existing
  `residency.context_read` row with `result: 'deny'` (added after #603); no new action name was
  introduced. The allow row's `bytes` remains the whole packet; the v2 parts ride `bytes_by`._

## Observability & Evaluation

- **Traces:** `residency.context_read` rows carry `version: 2`, `used_bytes`, per-category bytes, `thread_acts`, `omitted`, and emitted `fetch` categories; `residency.context_denied` records refused reads by caller and target kind. The host log's first tool call after a wake (the `wake_turns` row) shows whether the seat's next call after the packet was a real act or a `fetch` follow-up.
- **Eval:** over v2 wakes, the count of tool calls between `team_wake_context` and the seat's first non-read act — v1 baseline is 3 (dolly, 2026-09-21); target ≤ 1. `used_bytes` distribution against the 12 KiB cap: if p95 sits at the cap with `fetch` non-empty on most wakes, the budget or the fill order is wrong. Falsifier for the harness-independence claim: in the three-arm measurement, arm C (Codex fresh+v2) materially worse than arm B (Claude Code fresh+v2) on first-act correctness or cost.
- **Experiment:** the three-arm measurement itself, run before increment 4 closes: same steer referencing an act three back in the thread, two seats per arm, recorded on the wiki page with cost, wall time, calls-before-first-act, `used_bytes`, and sender-judged correctness. Success: B ≈ A on correctness, B < A on cost, C ≈ B on both.
