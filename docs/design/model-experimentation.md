# Model experimentation — frontier cadence + our own models

> **Design direction, not built.** Captures a standing thread (prior sessions, Nick's priority): musterd
> should treat _the model itself_ as a first-class experimental variable — both by being **early to each
> new frontier model** and by **owning models end-to-end**. Extends the flywheel
> ([ADR 194](../decisions/194-flywheel-practice-not-batond.md); was ADR 051) and the
> research practice (ADR 056); the substrate is the coordination telemetry (ADR 082) already shipped.
> Corrections via ADR + update this doc.

## Why this is a musterd thread, not a distraction

The flywheel's experiment axis ([ADR 194](../decisions/194-flywheel-practice-not-batond.md)) is `model × prompt × agent-config × harness × eval × **team
topology**`. Model is the first term, and it's the one the whole field re-rolls every few weeks. musterd's
edge is that it can measure what _actually_ changes when the model changes — not on a benchmark, but on
**real human+agent coordination** (the rarest data, ADR 056): does a new model shout into the void less,
close loops more, dup work less? Those are the emitted coordination metrics (`loop_latency`,
`open_loops`, wasted-work), so a model swap is a clean A/B on the exact numbers we care about.

## Track A — bleeding edge: experiment as each frontier model lands

The habit: when a new frontier model ships, run the standard coordination experiment against it and record
a finding.

- **Cadence, not a platform.** A reproducible experiment manifest (ADR 194 / research practice) pinned to a model id, run on
  a fixed dogfood scenario, diffed against the prior model's baseline (ADR 052 baseline requirement). One
  `docs/research/NNN-*.md` finding per model, per the lab-notebook practice (ADR 056).
- **What we measure:** the coordination evals (directed-act latency, resolve-rate, dup-rate, wasted-work
  ratio) + task outcome — model as the only varied term. The point is the _delta between models on
  coordination_, which nobody else publishes.
- **Feeds:** the "MAST in the wild" thesis and the dataset ladder (ADR 056) — a per-model coordination
  leaderboard is a natural artifact.
- **Ingest side:** the research radar (`research-radar-plan.md`) is the sibling for new _research_ —
  M1–M3 hand-run (`pnpm radar:sweep --triage`); weekly schedule still M4–M5. The model cadence is the
  sibling for new _models_ — a new frontier release is a trigger to run the manifest.

## Frontier non-Claude diversity seats — the "today" path for cross-family data

Getting a **non-`claude` family onto a live team does not require the tiny model.** Model attestation
(ADR 101) resolves from `MUSTERD_MODEL` first (ahead of the Claude-only `ANTHROPIC_MODEL` fallback,
per `resolveAttestedModel`), so _any_ harness that sets that env var attests its family. A frontier
non-Claude model driven in Cursor (Grok 4.5, GPT-5.6, GLM, …) is a **resident** harness — one
long-lived MCP presence that heartbeats — so it also avoids the attestation-durability gap the thin
tiny-model CLI harness exposes ([finding 003](../research/003-guardrail-floor-tiny-model.md) G1). This
is the fastest way to turn the shipped diversity flag from untested code into observed behavior, and
it uses models that just shipped, with zero new code.

**This is separate from Track B.** The tiny model is the _guardrail-floor_ probe (a **weak** agent);
these seats are _strong_ frontier peers that supply cross-family **diversity** data. Both write to the
same substrate; neither substitutes for the other.

**Runbook** (per seat, one-time):

1. In the Cursor MCP config for that seat's musterd server, pin the model in the `env` block:
   ```jsonc
   // .cursor/mcp.json (or the seat's musterd MCP server entry)
   "musterd": { "command": "…", "env": { "MUSTERD_MODEL": "grok-4.5" } }
   ```
   Use the real id you're running (`gpt-5.6-terra`, `glm-5.2`, …). The server derives the **family**
   (`grok`, `gpt`, `glm`) from the prefix; exact ids are manifest pins, not doctrine.
2. Reconnect the musterd MCP server so the adapter reads the new env (the adapter caches its boot-time
   attestation — an in-session change is invisible until reload).
3. Verify: `musterd audit … | grep model_attested` shows a non-`claude` `new:` value; acts from the
   seat carry `musterd.model.family ≠ claude`.
4. To exercise the flag itself, form a **review/approval chain** across families (a `request_help` /
   `handoff` / `challenge` answered by `accept`/`decline` from a _different_ seat, one Claude + one
   non-Claude). `report.mast.diversity` flags a chain that is single-family end-to-end and — the case
   we most want to see — leaves a genuinely mixed chain **un**flagged.

**Caveat.** Cursor does not tell the MCP subprocess which model a message is live on, and you switch
models per-message; a static `MUSTERD_MODEL` is only honest if you **dedicate the seat to one model**.
A seat that hops models mid-session attests a stale family. Pin one model per seat.

### Harness identity and model self-identification

The MCP host already supplies `clientInfo` during initialization. The adapter should retain its
sanitized name and version as **harness context**, but must not treat either value as a model id:
`clientInfo` answers which harness launched the adapter, not which model generated an Act. The
attestation ladder remains `MUSTERD_MODEL` → `ANTHROPIC_MODEL` → binding value → `unknown`.

The next adapter increment adds a warn-only self-ID tripwire. A missing declaration stays usable and
stamps `unknown`, while the adapter reports the missing declaration with its harness context so
`init --check` and telemetry can expose the coverage gap. A future per-turn host identity seam may
replace a stale static pin; until then the adapter must never infer a model from a client name,
client version, prompt, or tool arguments. See [ADR 120](../decisions/120-harness-model-attestation-seam.md).

## Track B — four different jobs that shared one name

> **Re-evaluated 2026-07-08 — [ADR 110](../decisions/110-track-b-tiny-model-lab-re-evaluation.md).**
> Implementation of anything that trains or runs a tiny model lives in `musterd-lab`, never this
> repo. Exact model ids are experiment-manifest pins (ADR 194), not doctrine — Stage 1's executed
> pin is `qwen3:4b`; the older `qwen2.5:3b` / `llama3.2:3b` names below are historical.

"Local model," "train from scratch," and "the judge" are not one sequence. Mixing them is what made
Stage 2 look like the next coding task after the Ollama probe.

| Name | What it is | Where it lives | Status |
| --- | --- | --- | --- |
| **Stage 1 — local instruct probe** | A *weak* off-the-shelf model (Ollama) reads the `AGENTS.md` primer, claims a seat, and coordinates. Guardrail-floor test. **Not training.** | `musterd-lab` | **Done.** [Finding 003](../research/003-guardrail-floor-tiny-model.md). |
| **Learning GPT** | Train a tiny GPT from scratch (MLX / `mlx-lm`, ~10–30M, TinyStories/Shakespeare) to own the internals; optionally teach it the musterd command grammar so it can drive the Stage 1 harness. | `musterd-lab` | **Ungated.** Personal learning track — not a product deliverable, not research-spine, no ADR, no dataset required (ADR 110 §2 last bullet). |
| **Coordination-traces dataset v1** | Public, structural-only export of *this team's* act log ([ADR 184](../decisions/184-dataset-consent-and-redaction.md)). Seat names, models, act types, timings — **no message bodies**. Not a model. | **This repo** (`scripts/dataset/` — unbuilt). Private raw snapshot is a different artifact (`pnpm corpus:snapshot`). | **The product next step.** Open lane `01M091J5CW02QTKJGBJG9705GV`. Corpus preservation already shipped. |
| **Coordination-judge** | Fine-tune on *our* traces to score coordination quality. Last rung of the produce ladder (ADR 056: dataset → benchmark → paper → **judge**). A research artifact, and if ever built a batond eval component — not a dependency of the research practice ([ADR 194](../decisions/194-flywheel-practice-not-batond.md)). | `musterd-lab` when it happens | **Gated.** This is what ADR 110 calls Stage 2 NO-GO. Re-open when the dataset ships with honest N and the ADR 184 DoD holds. |

Not Track B, and not a substitute for any row above:

- **Frontier non-Claude seats** (section above) — strong models supplying *diversity* data.
- **Native harness phase 4** — a second `AgentLoopEngine` so `musterd host` can *run* a local model. That is a harness engine, not a training run.

## How these connect

Track A measures frontier models on coordination. Stage 1 probed the floor with a weak local model
we did not train. The learning GPT is how we come to *own* a model's internals. The dataset is the
public artifact this team's coordination log becomes. The judge is trained on that dataset — so it
cannot start before the export exists.

The next step **in this repo** is the dataset, not a training run. A from-scratch GPT, if you want
one this week, is `musterd-lab` and does not wait on the dataset.

## Related

- [ADR 194](../decisions/194-flywheel-practice-not-batond.md) (flywheel — experiment axis; supersedes
  ADR 051), ADR 056 (research as first-class — produce/ingest, the dataset ladder), ADR 052
  (obs-evals gate — baselines), ADR 082 (the coordination telemetry it measures on),
  [ADR 184](../decisions/184-dataset-consent-and-redaction.md) (dataset publication gate).
- `docs/design/research-foundation.md` (external evidence), `docs/research/README.md` (the lab notebook),
  `docs/design/research-radar-plan.md` (ingest half), `docs/design/brand-coordination-observability.md`
  (batond name/brand — parked product per ADR 194).
