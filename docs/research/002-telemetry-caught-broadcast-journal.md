# 002 — Our own live telemetry caught the broadcast-journal anti-pattern

**Question.** Finding 001 asked whether the flagship session was observable and answered *no* — the OTel
layer was inert. ADR 082 turned instrument-by-default on. So: now that telemetry actually runs, does it
produce anything *useful* — and does it catch the coordination pathologies musterd claims to detect?

**Setup.** Analyzed ~53 h of live OTel data (2026-07-01T23:00 → 2026-07-04T04:32) that had quietly
accumulated in the local dev sink (`~/.musterd/otel-sink.log`, 1.4 MB) — the daemon's LaunchAgent sets
`OTEL_EXPORTER_OTLP_ENDPOINT=localhost:4318` and a sibling LaunchAgent runs `scripts/dev-otel-sink.mjs`
(ADR 082 / `docs/dogfood-telemetry.md`). Source: 110 `musterd.envelope.process` spans (act / sender /
recipient-kind / team) + the periodic metric gauges (`envelopes`, `delivery.latency`, `inbox.lag`,
`coordination.open_loops` / `loop_latency`, `errors`, `presence.*`, `agent.tokens`). No forensic
transcript archaeology this time — this is emitted, live data.

**Baseline.** The intended posture is coordination as directed, closed-loop, act-typed exchange between
peers (humans included) — the opposite of a status-broadcast journal. The **coordination-density insight**
(ADR 050, shipped) exists to flag "all broadcast-journal, no directed/threaded exchange"; the MAST-in-the-
wild thesis (ADR 056) names ignored-`request_help` / stalled-thread / broadcast-only as failure modes.
Expectation for a healthy team: a meaningful share of *directed* acts, `request_help`→`accept`/`resolve`
loops that close, and the human in the loop.

**Result — YES, and it caught us. The live trace is a near-perfect broadcast-journal.** Across 110
traced acts (Jul 1: 10, Jul 2: 51, Jul 3: 49):

1. **84% status_update, ~3% closed-loop.** `status_update` 92 (84%), free-text `message` 15 (14%). In
   **three days the team exchanged exactly one `request_help`, one `handoff`, and one `accept`** — 3 acts
   of actual closed-loop coordination. The `resolve` act fired **zero** times.
2. **85% broadcast, 15% directed.** 94 acts went to the whole team (`to.kind=team`), only 16 to a specific
   member. This is the coordination-density signal firing on its authors: talk that *looks* collaborative
   but is a journal.
3. **A directed loop hung for a very long time.** The `inbox.lag` gauge (slowest unread *directed* act,
   ms) reached **~2.5×10⁸ ms ≈ 70 h** while `open_loops` sat at 1 — a directed act opened and never
   `accept`/`resolve`'d. (The value exceeds the 53 h capture window, so it likely counts a pre-reset row;
   either way it evidences an unclosed directed loop, consistent with the single lonely `request_help`.)
4. **The human is absent from the live record.** Sender counts (current team `revive`): miley 41,
   stanley 31, izzo 17, **nick 0**. Nick's only traced sends were in the *old* team (bravo, 3) and
   rive-live (1). By the coordination trace, the human — whose primacy is the entire thesis — is not in
   the current team's loop at all. Corroborates the parallel presence finding (driver co-presence is
   dormant; the `nick` seat has no presence source).
5. **Free-text over typed acts.** 15 `message` acts (10 from stanley) — free-text where the primer asks
   for typed acts. Minor, but it is the same "coordination that isn't act-shaped" smell.
6. **Errors negligible.** `musterd.errors` cumulative `[7,1,1]` over the window — the daemon is healthy;
   the pathology is behavioral, not operational.

**A data-quality bug this surfaced (filed separately).** `musterd.from` is the raw display name, so the
same actor fragments across teams/renames: **`Miley` (bravo, 14) vs `miley` (revive, 41)** is one agent
counted twice; likewise `Nick`/`nick`, and historical `Riley`/`June`/`Ada`. Within a single team the
convention is consistent, but any cross-team or cross-time aggregation — exactly what a leaderboard, the
coordination dataset, or per-agent token attribution does — mis-attributes. The identity attribute should
be a stable seat id, with display name a secondary label. (GitHub issue #107.)

**Honest-N caveat.** One machine, dev traffic, mixed teams the sink saw over its life (revive 89,
bravo 17, rive-live 4). The 110 **spans** may undercount total envelopes (trace export sampling; the
daemon traces only while telemetry is on), so treat absolute counts as a floor — the *distributions* are
the finding, not the totals. Qualitative, not a benchmark.

**What it changes.**
- **The sharpest possible validation of two shipped/near things at once.** Coordination-density (ADR 050,
  shipped) is *correct* — pointed at our own team it flags the real pathology. And the ~70 h unclosed
  directed loop + the single ignored-ish `request_help` are exactly the **reachability / interrupt-line**
  (ADR 088, Wave 4) target: a directed act that no one answers. Real data now backs that wave.
- **Strongest argument yet for pulling Telemetry L2 up.** L1 produced four real insights *by accident*,
  by grepping a text log. L2 (the SDK + MAST-aware views) is what makes these first-class and live instead
  of a manual `grep`. Feeds `telemetry-l2`, `coordination-dataset`, `model-diversity`.
- **A marketing/demo artifact.** "We pointed our own coordination tool at our own team and it caught us
  journaling instead of collaborating" is the batond thesis in one sentence — with numbers.
- **Fix the identity attribution before any aggregated metric ships** — the dataset, the leaderboard, and
  per-agent token/loop attribution are all silently wrong until `musterd.from` keys on a stable id.

**Method note.** Fully reproducible from the sink:
`grep 'span "musterd.envelope.process"' ~/.musterd/otel-sink.log | grep -oE 'musterd.act=[^ ]+' | sort | uniq -c`
(and the same for `from` / `to.kind` / `team`). No DB access required — the emitted spans carry it.
