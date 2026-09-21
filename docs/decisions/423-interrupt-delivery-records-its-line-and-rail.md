# 423 — The delivery row carries the line it delivered and the rail that asked

- Status: accepted
- Date: 2026-09-19
- Builds on: [ADR 088](088-interrupt-line-tool-boundary-inbox-check.md) (the interrupt line, and the `interrupt.raised` row this amends), [ADR 391](391-refused-interrupt-probe-attribution.md) (its twin: who was *refused*), [ADR 082](082-instrument-by-default-telemetry.md) (the request log carries no headers)
- Lane: 01M2NH5WT9ENQ68WPNK6ZKT32S (opened by izzo 2026-09-16; claimed and corrected by dolly 2026-09-19)

## Context

The lane that produced this ADR was opened on a finding that turned out to be false, and the
correction is the more useful half of the record.

**The finding.** `GET /inbox/interrupt-check` composes a one-line notice, returns it, and discharges
the act. The lane reported that nothing durable records the delivery: "verified 2026-09-16 on the
laptop daemon: 39 tables in `~/.musterd/musterd.db`, none of them a delivery record." Three
consequences were drawn from it — that every doorbell eval must win a race against its own consumer,
that native is the only rail whose delivery is provable, and that a production miss is
unattributable.

**What is actually there.** `interrupt.raised` — an audit row written in that same handler, twenty
lines below ADR 391's refusal block, deduped per (recipient, act):

```
detail: { act, act_kind, tier, count }   actor = sender, target = recipient
```

It has been written since **2026-07-05** (ADR 088 increment 1, #109). The laptop daemon holds **253
rows, 2026-07-06 through 2026-09-19**.

The search was for a *table*; the record is a *verb*. `audit` already carries a family of them —
`interrupt.refused` (ADR 391), `inbox.rendered` (ADR 088 Amendment 3), `interrupt.raised` — and a
`.schema` listing shows none of them. This is the same shape as
[correct-by-coincidence](../wiki/correct-by-coincidence.md): the instrument agreed with the truth
until the question changed.

So of the three consequences, the first does not hold and has not for two and a half months: the row
outlives the race, for every rail, and a doorbell eval is already a query rather than a stopwatch.
The second holds but points the other way — the **contract** is stale, not the code. The third is
real, and is what remains.

## Problem

Two fields are missing from a row that has everything else.

1. **The verbatim line.** The row records that a line was composed; it does not record *which*. The
   line is the one field that cannot be reconstructed afterwards — it is derived from the queue
   state at that instant (`count`, the class mix, which act won `headlineInterrupt`), and that state
   is gone the moment the act discharges. Recomposing it later from the acts table yields a
   plausible string, not the one the seat received. That is the difference between evidence and a
   reconstruction, and it is exactly what a doorbell eval needs to compare against what a harness
   actually surfaced.

2. **The rail.** `musterd inbox --interrupt-check --hook <harness>` has always taken the harness
   name, but the flag only ever selected the CLI's own stdout seam (`HOOK_SEAMS`) and was **never
   sent to the server**. The lane assumed it was already in hand at the handler; it was not. Every
   one of those 253 rows is rail-blind, so `docs/design/daemon-doorbell-contract.md` clause 1 still
   cites `wake_turns` for native and a measurer's name and date for the other five rows — when a
   daemon-side delivery row has existed for all of them since July.

## Decision

1. **The line is composed once, returned and recorded.** `composeInterruptLine` is called into a
   local before the audit write; the response and `detail.line` are the same string by construction,
   not by two calls that agree today.

2. **The caller declares the rail; the server parses it.** A `?rail=` query parameter, forwarded by
   the CLI from the `--hook` flag it already resolves. Parsed through `HarnessIdSchema` at the
   boundary (AGENTS.md rule 4) — this is caller-supplied text landing in a durable log. An
   unparseable value is recorded as **absent**, never echoed, and never costs the seat its bell.
   Absent also means absent: a probe run outside a hook records no rail rather than a guess.

3. **No new verb, no new table, no migration.** The record exists; this adds two fields to its
   `detail`. A second verb beside `interrupt.raised` would have been a duplicate delivery record,
   which is how the first one came to be missed.

4. **Retention is `audit`'s retention, and this ADR does not change it.** `audit` is unpruned today
   — `footprint` is the only table in the store with a prune. Measured 2026-09-19: `audit` ingests
   9,159–15,197 rows/day and holds 178,816; raiseable directed acts run 13–73/day, median ~29. This
   verb is ~0.3% of audit's daily growth, and it does not grow with the probe rate — it grows with
   the act rate. A bespoke bound on the smallest row class in an unpruned table would put the bound
   where the problem is not. Audit-wide retention is a real question and is **out of scope here**,
   named rather than solved.

5. **Not replicated**, for ADR 391's reason exactly: a local daemon's observation of a local seat's
   delivery. This also contains the privacy question — the record never leaves the machine that
   observed it.

6. **No dedupe window is added.** ADR 391 needed one because the probe rides every tool boundary;
   deliveries are bounded by act count. A window here would silently drop real deliveries, which is
   the one thing this row exists to prove.

### Rejected

- **A new `interrupt.delivered` verb (the lane's proposed shape).** Two rows for one event, written
  in the same handler, differing only in fields. The reason to reject it is the reason the lane was
  opened at all: a second record is how you get a third search that misses both.
- **A bounded retention window on this verb alone.** See decision 4 — it would set a precedent in
  `audit` sideways, through the row class with the least to answer for.
- **Recomposing the line at read time instead of storing it.** The queue state it depends on is
  gone; the result would be a reconstruction presented as a receipt.
- **Inferring the rail server-side from the seat's surface or user-agent.** The surface is what the
  seat claimed at attach, not what is driving this probe, and ADR 082 keeps headers out of the log.
  A declared, schema-parsed value that can be absent beats a guess that is always present.

## Consequences

- The doorbell contract's clause-1 table can cite a delivery row per rail, for every harness, back
  to 2026-07-06 for everything but the rail field itself. Rows written before this change carry no
  `rail`; absence there means "not recorded", not "no rail".
- **2026-09-21 — absence is written as `null`, not omitted** (lane 01M32G1MAVT9KCYJB40ZK0N2TJ). As
  first landed, a caller that declared no rail (no hook running, or a value `HarnessIdSchema`
  rejected) produced a `detail` with no `rail` key at all — indistinguishable from the 253 pre-423
  rows above, which is exactly the distinction the bullet above relies on. Corrected on izzo's
  challenge: the handler now always emits the key, `null` when there is nothing to record. So a
  missing `rail` key means "this daemon predates the field", and `rail: null` means "recorded, and
  the caller declared none" — decision 2's "absent also means absent" is now provable per row rather
  than only true of the pre-423 baseline. Falsifier: any `interrupt.raised` row written after this
  change whose `detail` has no `rail` key.
- **2026-09-21 — the falsifier was run, and it holds.** Grouping every `interrupt.raised` row on the
  hub daemon by the JSON type of `detail.rail`: **258 rows with the key ABSENT**, spanning
  2026-07-06 01:24:33 to 2026-09-21 17:53:15, and **not one after that instant**; **8 rows with the
  key present as `null`**, 18:28:24 onward; **5 rows carrying a rail** (`claude-code`), from
  2026-09-20 19:41:47. The absent/`null` boundary falls exactly at the daemon refresh that picked
  this change up, so the two shapes separate cleanly by time as well as by meaning, and the bullet
  above is now a measurement rather than an intention. Re-run:
  `sqlite3 ~/.musterd/musterd.db "select coalesce(json_type(detail,'\$.rail'),'KEY ABSENT') as shape, count(*), datetime(min(created_at)/1000,'unixepoch'), datetime(max(created_at)/1000,'unixepoch') from audit where action='interrupt.raised' group by shape;"`
  — a `KEY ABSENT` row whose max timestamp is later than 2026-09-21 17:53:15 disproves it.
- `interrupt.raised` still dedupes per (recipient, act), so **repeat rings of the same act are
  invisible** — the row answers "was it delivered", never "how many times did it ring". Unchanged by
  this ADR and recorded here so the next reader does not mistake one row for one ring.
- A privacy note, stated because it was asked: the row records who was interrupted, when, and about
  which act. `messages` already holds every directed act with sender, recipient and timestamp, so
  this adds a delivery receipt on correspondence the daemon already keeps. Per ADR 088 §4 the line
  is daemon-composed from structured fields only and never carries `env.body`.
- The lane's own premise is corrected in its title and in this Context, rather than quietly dropped.
  The parent lane (01M2GQG86D) downgraded native's contract row to "holds in unit; live unmeasured";
  that downgrade may have been unnecessary, and re-reading it against these rows is follow-on work,
  not this lane's.

## Observability & Evaluation

- **Traces:** `interrupt.raised` gains `line` and `rail` in its existing `detail` — `rail` always
  present, `null` when the caller declared none (see the 2026-09-21 consequence). No new span, no
  new table, no wire change to the response.
- **Eval:** the falsifier is a query, which is the point — for a window in which a harness is known
  to have been hooked, every `interrupt.raised` row for its seats carries a non-null `rail` and a
  non-empty `line`. Fixed means a doorbell eval for that harness reads the row instead of racing its own
  PostToolUse hook for the act. Baseline: 253 rows, 0 with a rail, 0 with a line.
- **Experiment:** none. The open question this cannot answer — whether the harness actually
  *surfaced* the line it was handed — needs the harness's own transcript, and no daemon-side record
  can settle it. That limit is why clause 1's wording still matters after this change.
