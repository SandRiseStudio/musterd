# 365 — The ledger kind: a best-effort verb crosses the wire, and decides nothing when it lands

- Status: accepted — 2026-09-03 (merged `18d250ff`, #1227; proposed 2026-09-03). Authored by ryder on lane `01M1JNY95CWSEWR3DP5XMHYSME`, gap 3 of
  stanley's residence-2 census (`01M1JNNF42NR3P2JPN8ZJEACN8`).
- Date: 2026-09-03
- Builds on: [ADR 325](325-multi-machine-federation.md) (residence 2: facts that cross without
  deciding), [ADR 331](331-ordering-substrate.md) (the `(origin_node, origin_seq)` pair),
  [ADR 335](335-sync-wire-format.md) (§8: one allocator for every replicated kind),
  [ADR 356](356-presence-replication.md) (the third kind, and the tag-per-kind shape),
  [ADR 131](131-harness-residency-wake-ledger-host.md) (§4: the `residency.*` rows ARE the rate state),
  [ADR 236](236-sleeping-host-defers.md)
- Lane: `01M1JNY95CWSEWR3DP5XMHYSME`

## Context

Three kinds cross the wire today: messages, `lane.*` and `presence.*`. All three are stamped by
`appendReplicatedEvent`, and the push selects exactly the rows carrying a stamp. Everything else in
`audit` — 80-odd verbs — stays on the machine that wrote it.

Measured on the dogfood daemon, 2026-09-03 at `8b327be3`: of the audit rows held there, `presence.*`
(2,117) and `lane.*` (213) carry a stamp; **4,953 `residency.*` rows carry none**, among them
`wake_cost` 116, `woke` 185, `wake_failed` 104, `wake_deferred` 454, `wake_exhausted` 421.

`deriveWakeMetrics` (`store/insights.ts`) — the wake-cost ledger behind `musterd report` — reads six
of those verbs straight out of `audit`. So the number the team quotes for what its wakes cost is the
number for **one daemon**, silently, and gets less true with every machine added. That is the defect.

## Problem

Make those rows cross without making a decision cross with them, and without wedging the fold.

Two things stand in the way of the obvious fix (widen the lane filter):

1. **The fold projects.** A stamped row whose action the fold has never learned to project stops it
   at `unknown_lane_event`. These verbs are precisely the ones no projector exists for — there is
   nothing to project them INTO. The lane tag would turn every wake row into a wedge.
2. **These rows decide.** ADR 131 §4 made the audit rows the rate state on purpose. Five readers
   COUNT them: the hourly cap and the cooldown (`wakesSince`), the per-act attempt cap
   (`attemptsForAct`), the terminal `isExhausted`, ADR 262's work-order re-spend breaker, and
   ADR 357's `workspace_readable`. Fold a peer's rows into those and wake caps become team-wide —
   which may well be right, but it is a decision crossing the wire, and residence 2 is defined as
   the facts that do not.

## Decision

### 1. A fourth kind, `ledger`, which the fold appends and never projects

`SyncLedgerEventSchema` is the lane event's shape under its own tag, drawn from the same allocator
(ADR 335 §8), so a node's sequence stays dense across four kinds and every gap check holds unchanged.
The fold writes the row into `audit` with the origin's stamp verbatim and does nothing else. **The
ledger IS the projection** — `deriveWakeMetrics` reads `audit`, so a row that lands in `audit` is a
row the report counts.

The tag, not the action prefix, is what licenses that: a reader that re-derived the kind from the
verb would be a second copy of the rule that shipped it, free to disagree.

### 2. An unknown ledger VERB is not a stop; a mis-tagged projected verb is

The lane and presence kinds block on a verb they cannot name, because storing a transition they
cannot project would leave state behind with nothing to find it by. A ledger row projects into
nothing, so a verb this build has never heard of is one it can hold honestly — blocking would wedge
the fold on a fact that decides nothing.

The one refusal is the inverse: a `lane.*` or `presence.*` action arriving under `kind: 'ledger'`
stops the fold as `mistagged_ledger_event`. That row would otherwise land in `audit` with its stamp,
never reach its projector, and leave this daemon's `lanes` silently behind the origin's — with the
origin sequence dense, so no gap check would ever notice.

### 3. Every deciding reader stays on rows this machine minted

`MINTED_HERE` (`store/residency.ts`): `origin_node IN ('', <this daemon's node for the team>)`. All
ten deciding reads carry it, so the rate cap, the attempt cap, the exhaustion terminal, the ADR 262
breaker and `workspace_readable` behave exactly as they did before replication existed. `''` is a row
minted here before the stamp existed; a folded row matches neither arm.

Reporting readers (`deriveWakeMetrics`) deliberately do NOT carry it. That is the whole point: the
insight is team-wide, the decision is machine-local.

**"Should wake caps be team-wide?" is left open, deliberately.** An hourly cap that counts one
machine is arguably not a cap; but that is a behaviour change needing its own falsifiers on the cap,
the breaker and wakeability, and it is residence 3. Named here so the next seat inherits the
question rather than the silence.

### 4. The set is consulted at the append, not at the call site

`REPLICATED_LEDGER_VERBS` lives in `store/audit.ts` and is checked inside `appendAudit`, not at the
~14 call sites that write these verbs. The failure mode of a per-site opt-in is a new call site that
silently does not replicate — the exact defect this ADR closes, one verb later.

A stamp failure falls through to the unstamped append. The stamp is a nice-to-have; the ROW is the
observability contract, and a daemon with no `local_node` row for the team (never enrolled, never
messaged) must still keep its own ledger.

## Consequences

- `musterd report` and the wake-cost ledger count every machine of the team. `unpriced_sessions`,
  `reports_rejected` and the per-seat economics become team-wide with them.
- Ledger events carry `actor: null` (a machine decision), so ADR 360's residence check binds nothing
  on them. Accepted: a ledger row decides nothing on arrival (§3), so the worst a mis-speaking node
  achieves is a wrong number in someone's report — visible, and attributable to its `origin_node`.
- Push volume grows by the wake verbs. On the dogfood corpus that is ~1,300 rows against ~2,300
  already replicated — the same order, not a new one.
- Three census gaps remain, and this ADR does not address them: `tool_call_stats` (additive
  counters, needing a fold-side SUM), `incident_reports` and `seed_thread_entries` (append-only
  tables with no stamp), and the unstamped `residency.*` verbs outside the wake economy
  (`host_suspended`, `wake_leased`, `session_captured`). The set in §4 is where the next verb goes,
  once someone checks §3's pinning still holds for it.

## Observability & Evaluation

**Traces.** No new span. The wake span (`musterd.residency.wake`, ADR 241) is unchanged; what
changes is that the `audit` rows it is joinable to now exist on every machine of the team rather
than only the one that wrote them. Two new log lines, both errors and both expected to be zero:
`sync_fold_mistagged_ledger` (a projected verb wearing the ledger tag — a build downstream of it is
silently behind on `lanes` with no gap to find it by) and `ledger_stamp_failed` (a row that fell
through to the unstamped append, §4 — that machine's wake economy is local again).

**Eval.** The claim has two halves, and the second is what makes the first safe:

1. **The economy is whole.** On a two-machine team, `wake.cost_usd_total`, `cost_reported`,
   `unpriced_sessions` and `reports_rejected` read the same on both daemons within one sync tick.
   Baseline before this change, measured on the dogfood daemon at `8b327be3`: 4,953 `residency.*`
   rows carried no origin stamp and none had ever crossed, so a joiner's spend read as **zero** on
   the hub — the whole ledger held zero replicated instances.
2. **No decision crossed with it.** Wakes ordered per seat per hour, and `residency.wake_exhausted`
   rows, are unchanged by the presence of folded rows. A rise in either after this lands is the
   direct falsifier of the residence-2 claim, and means a deciding read lost `MINTED_HERE`.

**Half 1 is not yet observed live.** Every number above comes from two real daemons in-process
(`sync/ledger.test.ts`), not from two machines. This team runs one daemon today, so the honest
first measurement is the first day a second one runs a wake — and until then §1 is tested, not
witnessed. Half 2 is exercised on the real decider (`claimWakeLeases` with six folded wakes past
the cap) and needs no second machine.

**Experiment.** None. No flag, no rollout: the kind is inert until a second machine exists, and on
a single-machine install every row still matches the `''`/local arm of `MINTED_HERE` exactly as it
did before.

## Falsifiers

Run between two real daemons in `sync/ledger.test.ts`, plus one on the decider in
`store/residency.test.ts`:

1. A wake paid for on the joiner is counted by the hub's `report` — `cost_usd_total` is null before
   the fold and 0.42 after. Fails without §1.
2. The row lands verbatim with the ORIGIN's stamp and projects into nothing — same id, same
   `(origin_node, origin_seq)`, no lane invented. Fails without §1.
3. A peer's wake rows do not decide here: six folded `residency.woke` rows past the hourly cap, and
   `claimWakeLeases` still orders a wake. Fails without §3 (verified by removing the predicate from
   `wakesSince`).
4. A `lane.claimed` wearing `kind: 'ledger'` stops the fold as `mistagged_ledger_event` and lands
   nothing. Fails without §2.
