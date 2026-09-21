# The continuity packet — design

> Goal `seat-continuity`, increment 3 (lane `01M32FHKKQXKH9W96XF3G4CT3J`). Brainstormed with nick on 2026-09-21; every decision below was put to him and approved in that conversation. Implementation is increment 4 (lane `01M32FHX6JHCVNQRGRAHHMTEJN`); the protocol delta lands as its own ADR before any schema moves.

## What this is for

A seat that is asleep is woken by a fresh spawn — a blank model that knows nothing, handed one line: *you are dolly, a steer from stanley is waiting.* Transcript resume (ADR 131 §5) would have reopened its previous session so it started already knowing what it knew; but resume is inherently per-harness (Claude Code resumes a `.jsonl`, Codex a thread id, and ADR 210's Codex rung already fails), so "every seat reaches every seat live, regardless of harness" cannot rest on it. What a fresh spawn receives instead is the [ADR 209](../../decisions/209-portable-wake-context.md) `WakeContextPacket` — and v1 of that packet is **metadata only**: a memory headline, thread counts, a `fetch` list. Measured 2026-09-21, a woken seat then spends 2–4 tool calls (~30 KiB) re-orienting before its first real act, and the largest of those calls (`team_inbox_check`, 26 KiB) told it nothing the packet had not.

This document defines **v2**: what a seat is handed on a cold spawn, on any harness, so that it has what a resume would have given it.

## The bar (decided)

**The seat does the right thing on its first real act, and arrives with a brief understanding of the conversation it was in.** Not the whole history; not identity continuity across unrelated work. Concretely (shape **B** of the three offered): the recent acts of the thread it was woken for, plus a one-line ledger of everything else open against it, plus its own seat memory.

## The rule that changes, and why it may (decided)

ADR 209's packet carries no bodies. Its stated reason is boundary #2 — *agent-authored Act bodies and seat-memory bodies never enter a spawn prompt* — which traces to [ADR 088 §4](../../decisions/088-in-band-steering.md): text injected into a model's **prompt** (the spawn line, the interrupt line) is read as instruction, so a compromised seat could steer every teammate it can reach; reading a body must be an explicit follow-up act whose result arrives as a tool result with sender attribution.

The packet is already read through a tool call (`team_wake_context`), the same channel as `team_inbox_check`, which returns bodies to the same recipient under the same authorization (ADR 209 §4). The injection reasoning protects the spawn line; it never required the packet to be text-free. **The spawn line stays ids-only. The packet may carry attributed, budgeted bodies.** The other two reasons behind v1 survive as constraints: the packet is *bounded* (that is what distinguishes it from a resume), and it is *derived at read time* (not a second store).

One new consideration: the packet is the seat's **first** read, before it has any bearings. So every body in it carries the same structured framing the inbox uses — sender, act, timestamp, thread — and the seat is never handed unattributed prose.

## Approaches considered

1. **v2 = v1 + bounded, attributed bodies, derived at read time.** Chosen. Harness-independent by construction: acts are the seat's words regardless of which harness typed them, so a Codex cold spawn receives the same "brief understanding" a Claude Code resume would.
2. A daemon-side LLM summarizer producing a "where you were" paragraph. Rejected: ADR 209 excludes an automatic summarizer; a model call per wake; and it produces exactly the unattributed prose §4 warns about.
3. A daemon-written mini-transcript per seat, resumable by each harness. Rejected: a second store, and per-harness format work — the thing being escaped.

## 1. Packet schema — `WakeContextPacket` v2

Every v1 field is unchanged (additive; a v1 host or adapter keeps working). v2 adds one block and one field:

```ts
version: 2;
wake / objective / state / delivery        // as v1
context: {
  thread?: {                               // the waking thread's recent acts, oldest → newest
    acts: Array<{ id: string; from: string; act: string; ts: number; body: string; truncated: boolean }>;
    omitted: number;                       // older acts in the thread not included
  };
  open: Array<{                            // the ledger: everything else waiting on this seat
    kind: 'ask' | 'request_help' | 'review' | 'handoff' | 'lane';
    id: string; from?: string; title: string; age_ms: number;
  }>;
  lane?: {                                 // lane / review / handoff wakes only
    detail: string; truncated: boolean;
    last_status_update?: { ts: number; body: string; truncated: boolean };  // the seat's OWN last word on it
  };
  memory?: { body: string; truncated: boolean };
}
budget: { limit_bytes: number; used_bytes: number };
fetch: [...]                               // v2 meaning: only what was truncated or omitted
```

`context` bodies are the seat's own or were addressed to it; the ledger carries titles only, never bodies.

## 2. Derivation — at read time, from rows the daemon already holds

- **`thread.acts`** — the last 8 acts where `id = thread OR thread_id = thread`, oldest first, sender-attributed, each body cut at 600 characters with `truncated: true`. The seat's own acts in the thread are included: that is how it "remembers what it said."
- **`open`** — unanswered directed acts to the seat (`ask`, `request_help`, review and handoff asks with no reply from the seat in their thread) plus lanes it owns in `claimed` / `active` / `blocked`. Sorted oldest first, capped at 12 entries.
- **`lane`** — the lane row's `detail` cut at 1,200 characters, plus the newest `status_update` **from this seat** whose body names the lane id (cut at 600). The cheapest honest "where I left off."
- **`memory`** — the seat's memory body, whole when ≤ 3 KiB, else the headline plus the first 3 KiB with `truncated: true`. The v1 `state.memory` envelope stays as is.
- **Authorization** — unchanged from ADR 209 §4. Act-targeted packets require the act to have been delivered to the caller; lane-targeted packets require ownership or the live review/handoff derivation. Nothing becomes readable that was not already readable through `team_inbox_check` and `team_memory_read`.
- **No new store.** Every field above is a query against `messages`, `lanes`, and the memory row at read time. Nothing is persisted as a packet.

## 3. Budget and truncation

Hard cap **12,288 bytes** on the serialized `context` block. Fill order, each category with its own ceiling: memory (3,072) → thread (6,144) → lane (1,536) → open (2,048). A category that does not fit is truncated with its flag set or dropped whole, and its name lands in `fetch` (`seat_memory`, `inbox_thread`, `lane_detail`, `open_items`). `budget.used_bytes` reports the real size so the eval sees what packets weigh in practice. One number, no per-team knob in this increment; it is retuned by ADR against measurement, never from a single wake.

Grounding: the four orientation reads measured on 2026-09-21 cost ~30 KiB; a 12 KiB packet is ~3k tokens, ~6% of the 47k-token life it replaced the reads in.

## 4. Audit

`residency.context_read` stays metadata-only — ADR 209's "never records a body" is a rule about the ledger and it holds. The row gains `version`, `used_bytes`, per-category byte counts, `thread_acts`, `omitted`, and the `fetch` categories emitted. The forbidden path, unaudited today (ryder, #603 acceptance note), gains a `residency.context_denied` row carrying the caller and the target *kind*, never the target id.

## 5. What a woken seat is told to do

The composed wake line (`composeWakeLine`, `packages/server/src/store/residency.ts`) currently ends *"Orient via `team_wake_context {…}`, read it via `team_inbox_check` (or 'musterd inbox'), and respond."* — the instruction that produced four calls. It becomes:

> …a steer from "stanley" is waiting. Read `team_wake_context {act_id: "…"}` — it carries the thread, what else is open, and your memory. Fetch more only for what it lists under `fetch`. Then act.

The line remains ids-only (ADR 088 §4 untouched). The `musterd-orient` skill and the primer's wake guidance change to match: **the packet is the orientation; `team_inbox_check` is not a ritual step on a wake**, only a `fetch` follow-up. A seat that receives `version: 1` (a daemon not yet upgraded) falls back to the old ritual; the primer says so in one clause.

## 6. Measurement — the three arms

Same task, three deliveries, two seats each, run before increment 4 closes:

| arm | seat | delivery |
| --- | ---- | -------- |
| A | dolly (Claude Code) | transcript `--resume` (possible again after ADR 427) |
| B | dolly (Claude Code) | fresh spawn + v2 packet |
| C | gptbot (Codex) | fresh spawn + v2 packet |

The task: a steer that refers to something said **three acts earlier** in the thread and asks the seat to act on it — the "brief understanding" bar made literal. Recorded per wake: cost, wall time, tool calls before the first real act, `used_bytes`, and whether the first act was correct as judged by the sender, written on `docs/wiki/resume-bound-is-below-one-wake-life.md`. Increment 4 succeeds when B ≈ A on correctness, B < A on cost, and C ≈ B on both — the last equality being the "regardless of harness" claim made measurable.

## Out of scope

Identity continuity (insights, working style, history distilled — bar C); any summarizer; a per-team budget knob; changes to which wakes are portable vs transcript-required (ADR 209 §2, ADR 210); the interrupt line.

## Next

1. Protocol ADR for v2 (this lane's remaining acceptance item), number from `pnpm adr:next`, reservation pushed first (ADR 223).
2. Increment 4, lane `01M32FHX6JHCVNQRGRAHHMTEJN`: implement per the plan written from this spec.
