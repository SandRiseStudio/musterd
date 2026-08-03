# Portable wake context — design

Date: 2026-08-03. From a design session between nick and stanley. This is a
proposal; an ADR is required before any protocol or wake-policy schema changes.

## Goal

Keep every wake cheap and low-context without limiting the work a woken Member
can complete. A session starts with a small, authoritative orientation index and
retrieves only the durable state it needs. Transcript resume becomes a narrow
exception for active dialogue whose meaning cannot be recovered from that state.

## Evidence and problem

The current wake ladder chooses between transcript resume and a fresh session.
The July 29 measurement recorded resume at 2.2x a fresh session at 450 KiB of
transcript and 8.0x at 3.4 MiB; fresh sessions were tightly clustered at
$0.91–1.51 allowance-equivalent. The crossover is bracketed, not precisely
estimated: each point is one run and total wake cost includes the work done.

`--resume` cannot ingest only a useful slice of a transcript. Re-ingesting it is
what resume means. The current 256 KiB ladder is therefore a sensible guard,
but it does not give all wake types a durable, low-cost alternative to history.

Work-order wakes already point toward the desired model: their spawn line names
only a lane ID, then the occupant orients through the board, inbox, and seat
memory. Reply, handoff, and review wakes need the same portable-continuity
model, while retaining a safe route for the rare case where prior dialogue is
actually the work context.

## Decision 1 — a portable context packet for every wake

Every wake type — reply, handoff, review, and work order — has a bounded,
versioned `WakeContextPacket`. It is an orientation index, not a transcript or
a second durable store.

The spawn command remains sparse: team/seat plus canonical triggering IDs. It
never embeds lane titles, act bodies, seat-memory bodies, or agent-authored
summaries. Once joined and authenticated, the recipient reads the packet from a
recipient-scoped context surface.

```ts
type WakeContextKind = 'reply' | 'handoff' | 'review' | 'work_order';

type WakeContextPacket = {
  version: 1;
  wake: {
    kind: WakeContextKind;
    laneId?: string;
    actId?: string;
    threadId?: string;
  };
  objective: {
    action: 'reply' | 'review' | 'continue_lane' | 'begin_lane';
    successCriterion: string;
  };
  state: {
    lane?: LaneSummary;
    thread?: ThreadSummary;
    memory?: MemoryEnvelope;
  };
  fetch: Array<'inbox_thread' | 'lane_detail' | 'seat_memory' | 'git_artifact'>;
  delivery: {
    selected: 'fresh' | 'resume' | 'fresh_fallback';
    reason: WakeDeliveryReason;
  };
};
```

`LaneSummary` and `ThreadSummary` are bounded, server-derived metadata: IDs,
state, ownership, branch, participants, counts, and latest-act metadata. The
packet contains no free-form message body. `MemoryEnvelope` is ADR 093's
headline, age, and size only; the private memory body remains an explicit
seat-scoped read. Full message/thread contents, lane detail, git artifacts, and
source files are likewise explicit fetches.

The packet provides the same first action for every harness: wake → join → read
context packet → fetch evidence on demand → work. It makes inherited context
bounded, but does not impose a small turn or watchdog budget on a substantial
task.

## Decision 2 — fresh by default; typed transcript necessity is the exception

All wakes default to portable, fresh delivery. Resume is allowed only when the
system has an explicit `transcript_required` classification and all operational
guards pass:

1. The previous session ended cleanly and is inside a short active-exchange
   freshness window.
2. Its transcript is at or below the conservative 256 KiB starting bound.
3. The lease has enough remaining time for a fresh fallback if resume fails.
4. Per-seat rate and allowance guards permit the attempt.

```ts
type ContinuityRequirement = 'portable' | 'transcript_required';

type ContextDeliveryPolicy = {
  defaultRequirement: 'portable';
  resumeTranscriptMaxBytes: number; // initially 256 * 1024
  resumeFreshnessMs: number;
  requireFreshFallbackBudgetMs: number; // initially 10_000
  resumeRateCap: number;
};
```

`transcript_required` is typed, server-controlled classification — never
free-form sender content. The first release permits it only for a narrowly
defined active reply edge. Handoff, review, and work-order wakes are portable.
Broader use requires evidence that the packet plus recipient-scoped retrieval
cannot reconstruct the required context.

The existing same-lease fresh fallback remains mandatory after a failed resume.
The policy limits initial inherited context and protects a fallback; normal
`max_turns` and `work_timeout_ms` remain independent seat/wake-type policy and
can support a long investigation or implementation.

## Decision 3 — safe degradation and compatibility

- Packet generation or retrieval failure records a failed/deferred wake. It
  never causes unbounded prompt injection or a broader recipient read.
- A failed resume records its cost and falls back to fresh within the lease.
- A fresh session that needs more evidence fetches it; it does not require a
  second wake merely because the initial packet was compact.
- Older adapters receive the existing canonical-ID wake and orient through
  `team_next` until their compatibility window ends. The packet is additive.
- Every packet field is derived from canonical Member, Presence, Surface, and
  Act state. It creates no new store and does not duplicate lane/thread truth.

## Observability and evaluation

For every lease, record only non-content telemetry:

- wake kind, transcript bytes and age, selected delivery, and decision reason;
- packet serialized byte size and packet version;
- explicit fetch categories and their count;
- wake duration, turns, and reported allowance-equivalent cost;
- resume failure and fresh-fallback outcome.

Do not record message bodies, memory bodies, titles, or source content.

The rollout is incremental and disabled by default where behavior changes:

1. Add decision telemetry without changing delivery.
2. Issue packets for portable work-order, handoff, and review wakes, retaining
   existing orientation surfaces as a compatibility path.
3. Trial fresh reply wakes for a small named cohort against the current ladder.
4. Enable the narrow `transcript_required` exception and observe every use.
5. Recalibrate byte, recency, and rate bounds only from repeated measurements.

Success means lower p50 and p95 allowance-equivalent wake cost and fewer
inherited-context bytes, without a material increase in failed or duplicate
wakes, incorrect replies, time-to-complete, or abandoned lanes. The strongest
packet-quality signal is which explicit fetches occur immediately after fresh
wakes: frequent seat-memory or thread reads identify the next bounded datum
worth promoting into the packet.

## Scope boundaries

- This design changes continuity delivery, not whether a loop may wake a seat.
  Existing enrolment, `flow: auto`, loop toggles, caps, watchdogs, and circuit
  breakers remain the authorization/rate-control layer.
- It does not add automatic memory summarization, transcript storage, a new
  runtime dependency, or a generic prompts-in-policy mechanism.
- It does not make sessions self-start. The installed host actuator still
  executes only daemon-leased work.
- It does not revise the current 256 KiB bound before richer measurements exist.

## Implementation sequence

1. Write an ADR that makes packet authority, recipient scoping, delivery
   vocabulary, and the transcript-required exception normative; update SPEC
   before changing protocol schemas.
2. Add protocol types and schemas for packet metadata and delivery decision.
3. Derive, validate, and expose the packet from the server without changing
   existing wake behavior; add content-free audit telemetry.
4. Add CLI/MCP context retrieval and compatibility rendering.
5. Select fresh delivery for the portable wake types behind policy; test fresh
   fallback, stale adapter behavior, and recipient scoping.
6. Add the reply-only transcript-required exception, then evaluate before any
   expansion of its classification.
