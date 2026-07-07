# 101 — Model as a variable: per-occupancy attestation, the diversity flag, and the frontier cadence

- Status: accepted — increment 1 SHIPPED 2026-07-07 (PR #144). Track B (own models) stays reserved (§5).
- Date: 2026-07-06 (design frozen, nick + stanley); increment 1 built + merged 2026-07-07
- Builds on: ADR 087 (durable seat, model-agnostic), ADR 082 (coordination telemetry), ADR 089–091
  (telemetry L2 — the SDK + views this reads through), ADR 050/084 (insight projections), ADR 051/056
  (experiment axis + research practice), issue #107 (telemetry keyed on display-name)

## Context

The roadmap holds two reserved items that were parked pending one design session:
**model-experimentation** (frontier cadence + own models, `model-experimentation.md`) and
**model-diversity** (same-model consensus is weak evidence, `agent-ontology.md` §5). The session was
held 2026-07-06 and kept them **bundled** under one thesis:

> musterd is the model-agnostic coordination layer — so _which model sits in each seat_ is data only
> musterd holds, and coordination quality is the only axis on which model differences matter to a
> _team_.

Everything in both items follows from that sentence. Because musterd records model-per-seat,
single-model consensus becomes visible and can be flagged (diversity). Because it records
model-per-seat _and_ emits coordination metrics, a model swap is a clean A/B on the numbers we care
about (experimentation). Both halves rest on **one missing piece of product code: `model` as a
first-class attribute musterd captures** — which today it does not, anywhere.

Two constraints shape how it can be captured. The durable seat is model-agnostic by design (ADR 087):
a different harness can occupy the same chair tomorrow with a different model, so model is not a seat
property. And the daemon cannot observe the model directly — only the harness knows, so any value is
**self-reported**. A diversity flag raised on a lied-about or stale model is worse than no flag.

## Decision

Increment 1 of the arc, frozen as: **foundation + diversity flag + cadence manifest**. Track B of
model-experimentation (own models, the coordination-judge) stays reserved research-spine — see §5.

### 1. `model` attaches per-occupancy on the binding, harness-attested

The harness adapter reports its model id at claim/occupy time, the same way it already reports
identity and workspace. It is stored on the **binding/occupancy record**, never on the durable seat —
the chair stays model-agnostic; the _occupancy_ has a model.

- **Re-attestation is allowed.** A mid-occupancy model switch (a `/model` command, a fast-mode
  toggle) is real; the adapter may update the attested value, and the occupancy record keeps the
  small history.
- **`unknown` is legal and never blocks.** Thin harnesses and old adapters won't attest; a missing
  model renders as `model: unknown` (warn-never-block doctrine). Unknown poisons conclusions
  _honestly_: a chain with an unknown link is "diversity unverifiable," never "diverse."
- **Attested, not verified.** Reports and insights carry that epistemic status; musterd believes the
  adapter because the adapter is the only party that knows.

### 2. The per-act stamp is the dataset; the stable seat id rides along

The occupancy attestation is the _source_; what diversity and experimentation actually consume is the
**model stamped on each act/span at act time** (current attested value). This lands on the same seam
as the **issue #107 fix**: telemetry currently keys actors by display-name, which fragments the same
actor across teams and renames. This increment keys spans and act attribution on the **normalized
stable seat id** (raw name demoted to a label) and adds the model attribute beside it — the
known-blocker for any aggregated per-agent metric dies inside the foundation instead of before it.

### 3. The diversity flag: family-level, review/approval chains only

One new insight on the ADR 050/084 projection seam, surfaced through the existing report surfaces
(`musterd report coordination`, `team_report` health block):

> This approval chain was single-model-family end-to-end (all `claude-*`) — treat agreement as weak
> evidence.

- **Scope: review/approval/challenge-response chains only** — not every directed loop. Scarce by
  construction, matching the claim it makes; a broader net risks nag fatigue in a small team.
- **Granularity: model family** (the prefix — `claude-*`, `gpt-*`, `gemini-*`), derived server-side
  from the attested id. Family is the decorrelation boundary that matters: intra-family variants are
  presumed correlated until the ADR 056 correlation research (agreement rates of same-family vs
  cross-family reviewer pairs on real traces) says otherwise.
- **Warn-never-block, watcher-not-gatekeeper** — the flag informs the human's weighting of the
  evidence; it never gates a merge or an approval.

### 4. The frontier cadence manifest (Track A)

A reproducible experiment manifest (ADR 051): pinned model id, fixed dogfood scenario, the emitted
coordination metrics (loop latency, dup-rate, wasted-work, resolve-rate) diffed against the prior
model's baseline (ADR 052). Each new frontier model triggers one run and one
`docs/research/NNN-*.md` finding — the per-model coordination leaderboard accretes from findings, it
is not a platform. The cadence is process riding this increment's stamps; it needs the foundation,
not new machinery.

### 5. Out of scope for this increment

**Track B — own models** (the tiny local seat probing the guardrail floor; the from-scratch MLX
model; the fine-tuned coordination-judge) stays **reserved** in the separate lab repo, per
`model-experimentation.md` — it is the research tail of the same thesis, not a dated build item.
Likewise any _verification_ of attested models (challenge-response fingerprinting) is a further seam
only worth opening if dogfood shows attestation being gamed.

## Consequences

- The roster can show the current occupant's attested model; the act log becomes a model-attributed
  coordination dataset — the substrate both roadmap items and the ADR 056 dataset ladder need.
- Same-family review chains become visible the day the flag ships; the first frontier release after
  shipping produces the first leaderboard entry with zero new code.
- Issue #107 is closed as a side effect of the foundation, unblocking every aggregated per-agent
  metric behind it.
- A new honesty surface to keep: adapters that stop attesting degrade to `unknown` silently — `init
--check` should verify the adapter attests (ADR 060 pattern), so drift is caught, not discovered in
  a report.
- The bundle's roadmap items move reserved → near-term together, led by this shared kernel, without
  pretending the lab track is dated.

## Observability & Evaluation

**Traces** — the model attribute lands on every act/span this increment (that _is_ the feature);
attestation changes emit an `occupancy.model_attested` audit event (occupancy id, old → new, source).
The diversity flag emits `musterd.insight.diversity_flag` (counter, dimensions: chain kind,
family, verdict = flagged | unverifiable) so flag scarcity is measurable.

**Eval** — headline: **flag precision** — the fraction of raised diversity flags a human judges
worth knowing at decision time (guard metric: nobody mutes the flag; its scarcity budget is the
review/approval scope). Secondary: **attestation coverage** — fraction of acts carrying a non-unknown
model (target: every first-party adapter attests; the drift check keeps it there). Baseline for both:
today, 0% of acts carry a model.

**Experiment** — the built-in first run: the next frontier model release runs the §4 manifest against
the current baseline — the leaderboard's first diff is the launch demo. For the flag: the ADR 056
correlation study (same-family vs cross-family reviewer agreement on real coordination traces) is the
evidence that either upgrades the family boundary to exact-id or confirms it.

## Increment 1 — as built (2026-07-07, PR #144)

Shipped as designed, with these refinements the build surfaced (mostly hardening from a two-round
Cursor Bugbot review):

- **Storage (§1).** `model` rides the **occupancy** as the `presence.model` column (schema **v15**),
  not "the binding" — the occupancy is the presence row. Attestation is captured at claim, re-attested
  on **heartbeat** (MCP + CLI clients re-affirm it each beat; the server no-ops on an unchanged value),
  and kept **sticky** across ambient touches (`COALESCE`), so an authed HTTP request never clears it.
- **Switch history (§1).** The occupancy record keeps only the _current_ value; the switch history is
  the append-only **audit log** (`occupancy.model_attested`, `{ occupancy, old, new, source: claim|heartbeat }`),
  not a column on the row.
- **Grant-less approval gap.** A grant-less claimant's attestation is carried across the admin-approval
  lane on `requests.model` (also v15), so an approved occupancy is attested, not born `unknown`.
- **Per-act stamp integrity (§2).** `meta.model` is **fully server-controlled**: `routeEnvelope` strips
  any client-supplied `meta.model` and stamps the sender's attested occupancy value, keyed on the
  **sending** occupancy (the WS `send` path passes its presence id; the stateless HTTP `POST /messages`
  path falls back to the member's newest-attested presence). A session cannot stamp an act with a model
  its occupancy did not attest — the integrity the diversity flag rests on. Span attributes are
  `musterd.model` + `musterd.model.family`, beside `musterd.from.id` (issue #107 closed).
- **The metric is a gauge, not a counter (Obs & Eval).** A diversity flag is _derived state_, so a
  counter emitted per report-derive would have measured poll frequency. Shipped as the observable
  gauge **`musterd.insight.diversity_flags`** (cross-team live count, sampled each collection cycle —
  the `open_loops` pattern). The report surfaces (`musterd report coordination`, `team_report` health
  block, `report.mast.diversity`) are the per-flag detail.
- **Chain scope (§3).** The flag covers `request_help`/`handoff`/**`challenge`** (ADR 103) chains
  answered by an `accept`/`decline` from a _different_ seat.
- **Drift check.** `init --check` carries a warn-only note when a live session here attests no model
  (covers stateless HTTP sessions with a null workspace; warns only when _no_ live session attests).
