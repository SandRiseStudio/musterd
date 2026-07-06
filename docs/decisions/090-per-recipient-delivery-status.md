# 090 — Telemetry Layer 2, increment 2: per-recipient delivery status, derived not stored

- Status: accepted — built 2026-07-06 (`store/delivery.ts` read model, `seen_latency` + delivery span events, the `/messages/:id/delivery` endpoint, `report.open_directed`, `musterd report delivery`, the `team_report` ledger block; `countOpenLoops` gained the resolve-exclusion so the gauge and the ledger reconcile)
- Date: 2026-07-06

## Context

ADR 089 froze the Layer 2 arc and named increment 2: per-recipient delivery status on each directed
act. The want comes from three directions at once:

- **Our own data.** Finding 002's sharpest single number was an ~70 h unclosed directed loop — an
  `inbox.lag` gauge value with no way to ask _which_ act, _which_ recipient, _seen or ignored_. The
  gauges aggregate; nothing answers the per-act question "did stanley ever read the handoff I sent
  him?"
- **ADR 088's seam.** The interrupt line defined the raised→read pair (a `musterd.interrupt.raised`
  audit event followed by the inbox read that covers the act) as its delivery-confirmation signal —
  a two-state ledger for the urgent tier only. Generalizing it to every directed act is exactly this
  increment.
- **The market reference.** band.ai ships per-recipient `delivered / processing / processed /
failed` with attempt history as first-class routing telemetry (`landscape.md` §5) — the one
  observability primitive worth mirroring. But band's states describe _executions_ (their unit);
  ours must describe _seats_ (ADR agent-ontology), so the taxonomy is borrowed, not copied.

## Problem

For any act and recipient, answer — cheaply, after the fact, and without a second source of truth —
**where in the delivered → seen → answered journey did it stop**, with whatever attempt history
exists (live push, interrupt raises). And do it without violating the standing principle that
insight is **derived views over the message log, never stored beside it** (observability.md §5b,
ADR 050).

## Decision

**Derive the ledger; store nothing new.** Every state below is already recoverable from durable
state the daemon keeps today. A `delivery_status` table would be a second source of truth that can
drift, adds N writes per broadcast, and contradicts §5b for no informational gain. Increment 2 is a
read model plus two emission points — no migration, no SPEC change.

### 1. The state ladder, and where each state already lives

Per (act, recipient), the status is the furthest rung reached:

| State      | Meaning                                                                  | Derived from                                                                                                                                                         |
| ---------- | ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `logged`   | persisted to the append-only log = durably delivered to the seat's inbox | `messages` row (always true once routed — see "failed", below)                                                                                                       |
| `seen`     | an inbox read advanced the recipient's cursor past the act               | `inbox_cursors.last_read_ts >= message.ts`                                                                                                                           |
| `answered` | the loop closed                                                          | an `accept`/`decline` whose `meta.in_reply_to` names the act, or a `resolve` on its thread — the exact predicate `countOpenLoops`/`recordLoopClosure` already encode |
| `stale`    | unseen (or seen-but-unanswered for loop-opening acts) past a threshold   | derived label over the above + age; diagnostic, never stored                                                                                                         |

Attempt history per (act, recipient) is the union of: the **live-push outcome** at route time
(delivered to a resident session vs. landed-in-inbox — emitted, see §3), and **interrupt raises**
(the `interrupt.raised` audit rows ADR 088 already writes, matched by act id).

**There is no local `failed`.** In musterd's model durability _is_ the log: once `routeEnvelope`
persists the row, the act is delivered — a recipient with no live session is the normal case, not a
failure. band's `failed` describes a push to a remote execution that can bounce; our equivalent
(remote/cross-network seats, v0.3 P4) is named as a future rung, not modeled now.

**`seen` is a watermark inference, honestly labeled.** The cursor is a per-member high-water mark,
so (a) `seen` is exact as a boolean, but (b) `seen_at` is only as precise as the cursor update that
crossed the act — a client that reads 10 messages in one check gives all 10 the same `seen_at`, and
history before this ADR has only the current watermark. The read model reports `seen_at` as the
cursor's `updated_at` with that caveat in the field name (`seen_by`), rather than pretending to a
per-message receipt we do not have.

### 2. The read model: `store/delivery.ts`

A pure read module (the `countOpenLoops` pattern) computing, for one act:
`{ recipients: [{ seat, seat_id, state, seen_by?, answered?: { act, id, ts }, raises: n }] }` —
per-recipient rows for `member` acts, fan-out rows for `team` acts (broadcast follows the same
rule; observers are not recipients). And, for a seat or team: the **open directed ledger** — every
loop-opening act (`request_help`/`handoff`, plus urgent-flagged directed acts) not yet `answered`,
with per-recipient state and age. That ledger row is finding 002's "~70 h, open_loops=1" made
answerable: which act, whose inbox, seen or not.

### 3. Emission: complete the raised→read pair as first-party telemetry

Two additions to the existing Layer 1 surface (both attribute-keyed per #107 — normalized seat id,
raw name as label):

- **`musterd.coordination.seen_latency`** (histogram; send → the cursor advance that covered the
  act; by act, urgent flag). Emitted at the `markRead` path when a cursor crosses directed acts —
  the read-side twin of `loop_latency` (ADR 082 slice 3), and the generalization of ADR 088's
  raised→read confirmation from the urgent tier to every directed act.
- **Per-recipient live-push outcome** as span events on the existing `musterd.envelope.process`
  span (`delivery.live` / `delivery.inboxed`, one event per recipient with the seat id) — attempt
  history in telemetry, where attempt history belongs; the DB stays a message log.

### 4. Surfaces

- **HTTP:** `GET /teams/:slug/messages/:id/delivery` (the per-act ledger) and the open directed
  ledger folded into the existing report payload — both server-derived so every client shares one
  implementation.
- **CLI:** `musterd report delivery [<id>]` — no id: the open directed ledger ("what's waiting on
  whom, how long, seen or ignored"); with id: the per-act journey.
- **MCP:** the same ledger block on `team_report`, so an agent can check whether its handoff was
  seen before assuming silence means consent.
- Notification tiers, nudges and the interrupt line stay the _actuators_; this is the _instrument_
  panel. No new acts, no auto-escalation — escalation stays a human/agent decision informed by the
  ledger (human-agent-dynamics §4 applies: diagnostic, not a score).

## Consequences

- The ~70 h-class failure becomes diagnosable in one query, and the inc3 MAST views (unanswered
  `request_help`, stalled threads) get their substrate — the open directed ledger _is_ the
  ignored-input detector's data.
- No migration, no new table, no SPEC bump; the log/cursors/audit remain the only truth. The cost
  is honest imprecision (`seen_by` watermark semantics) — accepted and labeled rather than fixed
  with a receipts table nobody else needs.
- `seen_latency` + `loop_latency` bracket a directed act's whole journey (sent → seen → answered)
  as first-party series — the coordination-dataset (ADR 056) and batond get the full funnel.
- The cursor becomes load-bearing for diagnostics: a client that fetches without marking read shows
  as unseen. That is the correct semantic (the agent's model never saw it), but it makes the
  adapter's mark-read discipline worth a drift check.
- Cross-network delivery (v0.3 P4) will want a real `failed`/retry rung; the taxonomy here leaves
  that slot open instead of inventing local failure states.

## Observability & Evaluation

**Traces** — the `delivery.live`/`delivery.inboxed` span events land on the envelope span, so a
single trace now shows route → per-recipient outcome; the ADR 089 cross-agent link then connects
the recipient's eventual read on the same timeline.

**Eval** — headline: **seen-latency** distribution for directed acts (median and p95), with the
finding-002 window as the retroactive baseline (one act pinned at ~70 h unseen). Guard: on the
`request_help`/`handoff` subset (the acts both derivations cover — the ledger additionally lists
urgent directed acts; the gauge is daemon-wide, the ledger per-team), the ledger count must
reconcile with the `open_loops` gauge — two derivations of one truth agreeing is the no-drift
check. Making them agree required giving `countOpenLoops` the same resolve-exclusion the ledger's
`answered` rung has (a resolved thread is not an open loop) — a strictly-more-truthful gauge,
applied with this ADR's build (bugbot on #113 caught the pre-fix mismatch).

**Experiment** — the ADR 088 steering A/B gains a measured middle: with the ledger, "hook on"
sessions should show seen-latency collapsing to one tool-call duration while "hook off" shows the
task-boundary lag — the interrupt line's value expressed in the funnel it was built to move.
