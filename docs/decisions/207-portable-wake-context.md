# 207 — Portable wake context: fresh by default, transcript by exception

- Status: accepted
- Date: 2026-08-03
- Builds on: [ADR 093](093-persistent-seat-memory.md) (headline-first seat memory),
  [ADR 128](128-recipient-scoped-message-reads.md) (no message body in a wake prompt),
  [ADR 131](131-harness-residency-wake-ledger-host.md) (lease/host actuator and resume fallback),
  [ADR 179](179-board-triggered-work-order-wakes.md) (work-order wake),
  [ADR 191](191-review-loop-wake.md) (review work-order wake), and
  [ADR 199](199-dispatch-loop-wake.md) (dispatch work-order wake).

## Context

musterd has two continuity mechanisms. A fresh wake starts with the Team’s durable orientation
surfaces: the lane board, Inbox, and ADR 093 seat memory. A resumed Claude Code wake re-ingests the
Member’s prior transcript. The latter is valuable only when the dialogue itself is the missing
context, but it consumes both allowance and context window in proportion to transcript size.

The 2026-07-29 wake-ledger sample brackets the first expensive resume between 373 KiB and 450 KiB:
the 450 KiB resume cost 2.2x a fresh session and the 3.4 MiB resume cost 8.0x. Fresh sessions were
tightly grouped at $0.91–1.51 allowance-equivalent. The sample is deliberately not over-read: each
point is one whole wake, so work done contributes to cost. It is nevertheless enough to establish
that transcript size is not a free continuity channel.

The existing 256 KiB resume ladder protects against the worst cases, but it still makes the
transcript the primary continuity source for ordinary directed wake Acts. Work-order wakes already
demonstrate a better shape: their prompt carries a canonical lane ID only, and the recipient orients
through governed surfaces after it occupies.

## Problem

Every wake type needs enough context to begin correctly without automatically filling the new
context window or charging for stale dialogue. At the same time, a compact start must not limit a
Member’s ability to undertake a long review, implementation, or investigation.

The solution must preserve three existing boundaries:

1. The daemon leases work; the installed host actuator spawns it. No Member self-starts.
2. Agent-authored Act bodies and seat-memory bodies never enter a spawn prompt.
3. A Member may read only the Inbox/thread context it is authorized to receive.

## Decision

### 1. A portable context packet is the continuity index

Every reply, handoff, review, and work-order wake has a versioned, bounded
`WakeContextPacket`. The spawn line remains canonical identifiers only: Team/seat plus one
`act_id` or `lane_id`. A freshly occupied Member explicitly reads the packet through an authenticated,
recipient-scoped surface; the packet is not prompt text.

The packet contains only server-derived metadata:

```ts
type WakeContextPacket = {
  version: 1;
  wake: {
    kind: 'reply' | 'handoff' | 'review' | 'work_order';
    act_id?: string;
    lane_id?: string;
  };
  objective: { action: 'reply' | 'review' | 'continue_lane' | 'begin_lane' };
  state: {
    lane?: { id: string; state: string; owner_seat: string | null; branch?: string };
    thread?: { id: string; participant_count: number; unread_count: number; latest_act?: string };
    memory?: { headline: string; saved_at: number; size_bytes: number };
  };
  fetch: Array<'inbox_thread' | 'lane_detail' | 'seat_memory' | 'git_artifact'>;
  delivery: {
    requirement: 'portable' | 'transcript_required';
    intended: 'fresh' | 'resume';
  };
};
```

The packet contains neither an Act body nor a memory body. Full Inbox/thread contents, lane details,
git artifacts, and the private seat-memory body remain explicit recipient-scoped reads. The packet is
derived at read time; it is not a new store or a second home for Team facts.

### 2. Fresh is the normal delivery choice

`portable` is the default continuity requirement and selects a fresh spawn. A fresh Member may use
the normal wake-type watchdog and turn policy, then fetch as much relevant evidence as the work
needs. Context compactness limits inherited history only; it does not cap the work.

`transcript_required` is a typed, server-controlled exception. The initial release may classify only
an active, directed reply edge this way. Handoff, review, and work-order wakes are always portable.
Sender text never selects the exception.

The host enforces a transcript-required order locally: it attempts resume only when the capture is
recent, under the effective transcript byte bound, within the resume rate cap, and leaves time for a
fresh fallback. Otherwise it starts fresh. The daemon never receives a session ID or transcript path.

### 3. Report decision and actual outcome separately

Each Wake Order carries an additive `continuity_requirement` and `intended_delivery` when the daemon
has made a portable-context decision. The host reports the observed outcome separately:

- `fresh` — a fresh spawn was selected or local resume eligibility failed before an attempt;
- `resumed` — a resumed session occupied;
- `fresh_fallback` — resume was attempted but did not occupy, and the same lease’s fresh fallback
  occupied.

The report may carry only non-content local measurements: transcript bytes/age examined, packet byte
size/version, fetch category/count, duration, and allowance-equivalent cost. Existing additive-field
compatibility applies: orders without the new fields retain the legacy resume ladder until their
daemon/host pair is upgraded.

### 4. Packet reads are authorized by their canonical target

`POST /teams/:slug/wake-context` accepts exactly one of `act_id` or `lane_id`. A caller may read an
Act-targeted packet only when that Act was delivered to the caller. A caller may read a Lane-targeted
packet only when it is the Lane owner or the recipient of the live review/handoff derivation for the
Lane. Other requests return `forbidden` without disclosing the target’s existence.

### 5. Rollout is evidence-led and reversible

The implementation lands in this order:

1. additive protocol and packet-read surface with no delivery behavior change;
2. portable/fresh work-order, handoff, and review delivery behind existing loop/seat controls;
3. an off-by-default portable reply cohort;
4. the reply-only transcript-required exception.

No byte, freshness, or rate bound is retuned from a single wake. Architecture chapters describe the
shipped system, so they update in the implementation increment that changes the corresponding code;
this ADR and `SPEC.md` carry the accepted, not-yet-shipped contract.

## Consequences

- Woken Members can recover continuity without routine transcript re-ingestion.
- Resume remains available where dialogue is demonstrably the work context, but it is no longer the
  default definition of continuity.
- A compatible new context endpoint and optional order/report fields allow daemon, host, CLI, and MCP
  adapters to roll forward independently.
- The first implementation touches protocol schemas and therefore updates `SPEC.md` in the same PR.
- No runtime dependency, generic prompt policy, transcript store, or automatic memory summarizer is
  introduced.

## Observability & Evaluation

**Traces.** `residency.wake_leased`, `residency.woke`, `residency.wake_failed`, and
`residency.wake_cost` gain only delivery/measurement detail. `residency.context_read` records wake
kind, packet size/version, fetch categories/count, and delivery selection; it never records an Act,
memory, or source body.

**Eval.** Compare a named fresh-reply cohort to the legacy resume ladder: p50/p95
allowance-equivalent cost and inherited-context bytes must fall without a material increase in failed
or duplicate wakes, incorrect replies, abandoned Lanes, or completion latency. Read-after-packet
fetches identify which bounded datum is actually useful.

**Experiment.** Keep one small dogfood cohort on portable reply delivery. Enable the
transcript-required exception only after repeated observations show a class of active replies whose
correct handling cannot be recovered from packet plus recipient-scoped fetches. Retain its
reply-only scope unless a future ADR records contrary evidence.
