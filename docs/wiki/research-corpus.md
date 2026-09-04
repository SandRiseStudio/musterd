# Research corpus — what we have measured, and where it lives

Every number in findings 001–009 comes from two directories on one laptop, none of it committed; this page is the map of what exists, what produces it, and what is designed but not built.

The split this page assumes is ADR 056's: **produce** (our own dogfood data — this page) versus
**ingest** (outside literature — the research radar, `docs/design/research-foundation.md`). A fact
we measured is a finding; a fact we read is foundation. They do not share storage.

## The live stores (measured 2026-08-18; falsify: `pnpm corpus:snapshot --dry-run`)

Nothing here is in git. `git ls-files` returns no `.db`, `.jsonl`, `.ndjson` or `.parquet` in this
repo — the only committed structured data are `docs/perf/budgets.json`,
`docs/perf/context-budgets.json`, and an empty `docs/research/radar/seen.json`.

| Store                                          | Size                 | Holds                                                                                                       |
| ---------------------------------------------- | -------------------- | ----------------------------------------------------------------------------------------------------------- |
| `~/.musterd/musterd.db`                        | 16 MB, schema v41[^v42] | messages/acts, audit, lanes, seat_memory, residency, wake_leases, wake_turns, tool_call_stats, footprint    |
| `~/.musterd/research/adr-166-slot-sweep.jsonl` | 48 MB, 4,714 samples | [ADR 166](../decisions/166-session-liveness-by-enumeration.md) fleet liveness, every 5 min since 2026-07-27 |
| `~/.musterd/otel-sink.log` + `.log.1`          | 12.6 MB              | the OTLP capture behind findings 002 and 005                                                                |
| `~/.musterd/daemon.log` + `.log.1`             | 13.1 MB              | structured `http_request` log (ADR 082 slice 2)                                                             |
| `~/cookoff-run/*.db`                           | 3.8 MB, 19 files     | per-cell cookoff daemons — the raw results behind findings 006/007                                          |
| `~/cookoff-run/cell-*/`                        | 4.2 GB, 28 clones    | **reproducible** from `SandRiseStudio/cookoff-scenario`; not evidence                                       |
| `~/Library/LaunchAgents/studio.sandrise.*`     | 7 plists             | the measurement _schedule_ — which instrument ran, how often                                                |

Row counts in `musterd.db` at 2026-08-18: messages 5,518 · audit 11,028 · lanes 541 ·
tool_call_stats 3,440 · wake_leases 310 · seat_memory 8 · members 26. The audit table carries
**2,256 `occupancy.model_attested` rows** — the [ADR 101](../decisions/101-model-as-a-variable.md)
record of which model actually occupied which seat, and the reason this corpus is unusual rather
than merely large.

**The corpus is 94 MB, not 4.3 GB** (2026-08-18; falsify: re-run the dry-run). The headline size is
git clones. Everything irreplaceable gzips to **5.7 MB in 2.7 seconds**, because the sweep series is
4,714 near-identical snapshots and compresses 79×. That number is why
[ADR 280](../decisions/280-the-evidence-base-lives-on-one-laptop.md) keeps every snapshot forever
instead of writing a retention policy — and it is a property of _this_ corpus, not a general law.

## Preservation status (2026-08-18; falsify: `ls ~/.musterd/corpus-snapshots/`)

`pnpm corpus:snapshot` captures all of the above into a dated, checksummed directory, using
`VACUUM INTO` for live SQLite so the daemon keeps running. Restore drilled the same day: integrity
`ok`, every table's row count identical, schema v41 preserved, sweep series 4,714 lines intact.

~~No backup newer than 2026-06-29 (2026-08-17)~~ FIXED 2026-08-18 by ADR 280 — but the snapshot is
**still on the same disk as its source**. Off-machine destination is nick's decision and is not yet
made, so the exposure today is "one disk, current" rather than "one disk, two months stale."

The [sibling corpus](#the-sibling-corpus-exploring-next) has the same disease and no rail at all.

## The findings register — what has actually been concluded

Full writeups in [`docs/research/`](../research/). Each is prose over data that mostly lives outside
the repo, which is what makes the preservation rail load-bearing rather than tidy.

| #   | Finding                              | The number it produced                                                        |
| --- | ------------------------------------ | ----------------------------------------------------------------------------- |
| 001 | Telemetry gaps in the P3 dogfood     | ~37% wasted work, reconstructed forensically → caused ADR 082                 |
| 002 | Broadcast-journal traffic caught     | 84% `status_update`, 85% broadcast, one ~70 h hung directed loop              |
| 003 | Guardrail floor on a tiny model      | `qwen3:4b` pass matrix; gaps G1 (attestation nulls) and G2                    |
| 004 | Cross-family diversity flag, live    | first grok/gpt cross-family coordination data                                 |
| 005 | Multi-model parallel work            | 34/34 attestation; 32% directed exchange vs revive's 8%                       |
| 006 | **Enforcement induces coordination** | 8/8 lanes claimed vs 0/8; **1.9% vs 72.2% waste at equal correctness (~38×)** |
| 007 | Compliance under deny                | Gate A n=4, 13 lane-block denies, zero forced; Gate B confounded              |
| 008 | Subagent-write detector recall       | 67.7% recall, 0 false positives on 15 reads                                   |
| 009 | Repeat wakes, unchanged reason       | half of every non-landing wake repeats one the rail already made             |

Finding 006 is the one the pitch rests on, and it comes with a standing rule recorded in
[cookoff.md](cookoff.md): **compare D to uncoordinated N, never to solo** — solo wins on both cost
and wall-clock, so solo is the honest denominator and the cost objection is real.

## The recurring instruments

| Instrument              | Cadence                   | Writes                        | Status                                                                                                                   |
| ----------------------- | ------------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| ADR 166 slot sweep      | every 5 min (launchd)     | `~/.musterd/research/*.jsonl` | live since 2026-07-27; series **never yet read** — that is lane `01KYJXFXEM5EGAVC4HETG15SZJ`, blocked on data it now has |
| OTel sink               | continuous                | `~/.musterd/otel-sink.log`    | live; 13 instruments (see `docs/design/observability.md`)                                                                |
| Roster-diversity        | on demand                 | stdout only                   | `scripts/research/roster-diversity.ts` — conditional 92.0%, unconditional floor 32.3%                                    |
| ADR 260 acceptance eval | on demand, windows pinned | stdout only                   | pre-registered, re-runnable                                                                                              |
| ADR 259 memory reads    | scheduled one-shots       | prose                         | T+5 fired 2026-08-18; **the 30-day evaluation fires 2026-09-12**                                                         |

Three of these print to stdout and persist nothing, which is fine for a re-runnable instrument over
a preserved corpus and fatal for one over a corpus that moves. It is a second reason the rail comes
first.

## What is designed and not built (2026-08-18; falsify: grep the ADRs named)

- **The dataset itself.** ADR 184 decided the gate (structural fields only, no agent prose). The
  export path shipped 2026-08-19 (`pnpm dataset:export`; falsify: `ls scripts/dataset/export.ts`).
  Each public dir now includes a filled `README.md` card (falsify: `ls scripts/dataset/card.md`).
  A HuggingFace upload of a live release has not been cut (2026-08-19; falsify: a dataset card
  under the Sandrise org on HF). Roadmap item `coordination-dataset`.
- ~~**ADR 056 is still `proposed`** — the charter that eight findings, the obs-eval CI gate, and ADR
  184 all build on has never been accepted.~~ **ACCEPTED 2026-08-24** (nick; amended on acceptance).
  The two roadmap items it freezes (`research-intake`, `coordination-dataset`) are unshipped-with-
  `building`, which is the only shape `roadmap-truth:check` rule 3 permits once the ADR flips.
- **Per-model leaderboard** — still not built, but **not for the reason recorded here until
  2026-08-21** (corrected; falsify: run `packages/server/src/telemetry.test.ts` and read the
  `#207` case, or drop the `model.family` spread in `recordLoopClosure` and watch it fail). This
  list said the coordination gauges carry no team/model dimension. They have carried both since
  `24c7350b` (#207/#208, 2026-07-09) — the *same day* finding 005 named the gap, which is why the
  claim was written and why nobody re-checked it. On main: `coordination.loop_latency` carries team
  + the closer's `model.family` (absent, never guessed, when the closer didn't attest);
  `agent.tokens` carries team + member + raw id + family; `open_loops` and `insight.diversity_flags`
  carry team. `delivery.latency` carries team and act and deliberately omits model, with the reason
  stated at the call site — it measures server work, not the sender. All of it is pinned at the
  **export** layer (the test asserts over `reader.collect()` data points, not over the record call).
  What actually blocks the leaderboard is **N**, not instrumentation: finding 005's own honest-N
  caveat (one team, ~4h, 41 acts, two vendors). The cookoff A/B/C2/C3/D cells *did* run
  (finding 006 flagship, 2026-07-20); what remains unauthorised is D-res and cell E, which do not
  add a second model family.
  Two open design questions, neither of them a gap: whether `open_loops`/`diversity_flags` should
  carry model at all (a loop is *between* seats, so "model X's open loops" may not be well-defined),
  and whether `delivery.latency`'s omission should be revisited.
  **Sharpened 2026-08-21:** N is not only small, it is **not uniform in quality**. A per-act model
  stamp may be an observation or an unverified declaration, and nothing in the act log says which —
  see [model attestation](model-attestation.md), which also records that nick switches models
  mid-session, so a seat's model is not constant even within one session. Read before computing any
  per-model aggregate over this corpus.
- **Frontier cadence manifest** — protocol written, zero runs recorded.
- **Cookoff D-res and cell E** — defined, spend not authorised. A/B/C2/C3/D already ran (finding
  006 flagship); the wiki line that listed them as unauthorised was stale as of 2026-07-20.
- **ADR 250's weekly reads** (asks-to-founder per merged PR; repeat wakes with unchanged reason;
  capability-miss count) — prose instructions, no instrument, no schedule.
- **Radar M4/M5** — ~~sweep and triage built, but `seen.json` is empty and no digest has ever been
  emitted~~ (2026-08-18). **Corrected 2026-09-03:** M4 IS built — `emitDigest` in
  `scripts/radar/digest.ts` writes the weekly digest and appends `seen.json`, landed with
  [#1049](https://github.com/SandRiseStudio/musterd/pull/1049). What is still true is the half that
  matters, and it is the half nobody can see from the code:
  **the instrument has never been run** (2026-09-03; falsify: a non-empty `seen.json`, or any digest
  file committed under `docs/research/radar/`). `seen.json` is verbatim `{"arxiv": [], "hf": []}`,
  there is no `radar:sweep` LaunchAgent, and `package.json` wires no `--emit` script. What remains is
  M5 plus a first real run. That is the ingest side; see the goal `research-radar`, marked shipped.
  Follows-up: 01M1MMJKBYJ4DDD4S9QCF02TD9

## The sibling corpus: Exploring Next

`/Users/nick/sandrise` runs a second, independent measured corpus that this repo's research
programme can draw on (surveyed 2026-08-17; falsify: query `exploring_next` at the Supabase project
in that repo's config):

- **883 human-curated AI sources** (2025-10-02 → 2026-08-17), facet-tagged against a closed
  vocabulary — ~421 `agents`, ~34 `agent-observability`. A hand-labelled relevance set, and the
  calibration data the radar's LLM triage does not otherwise have.
- **876 episodes / 806 scripts**, each carrying ~76 keys of generation metadata: script model from a
  ~20-model rotation, TTS vendor and fallback reason, search provider, latency. Model-as-a-variable
  in content production, where musterd's corpus is model-as-a-variable in coordination.
- **A versioned weekly landscape brief** (`exploring_landscape_brief`, evolve-don't-reset, dated
  markers, source URLs retained) — feedstock for [positioning](positioning.md) work, though it is
  framing rather than citable specifics: verify at the original source and cite that.

Durability there is worse, not better: all of it plus 4.99 GB of audio sits in one Supabase project
with no export script (folded into goal `research-corpus`). Its audio will not compress, so this page's
5.7 MB economics do not transfer.

[^v42]: Measured at v41 on 2026-08-18. Migration 42 (`presence.model_source`, 2026-08-21) lands with [#975](https://github.com/SandRiseStudio/musterd/pull/975) — the dated measurement above stands; the live schema moves past it. See [model attestation](model-attestation.md).
