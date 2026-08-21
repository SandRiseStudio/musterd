# 301 — The per-act stamp says whether its model was observed or declared

- Status: accepted
- Date: 2026-08-21
- Deciders: nick (directed: mark the tier, do not attest `unknown`)
- Builds on: [ADR 101](101-model-as-a-variable.md) (per-occupancy model, per-act stamp,
  attested-never-verified), [ADR 158](158-model-attestation-truth.md) (observation outranks
  declaration), [ADR 236](236-sleeping-host-defers.md) (absence is not an assertion),
  [ADR 268](268-clear-model-observed-on-session-change.md) (a leftover observation is a stopped
  clock)
- Amends: ADR 101 Consequences only (the Decision stands). Does not supersede 101.

## Context

ADR 101 stamps `meta.model` on every act from the occupancy attestation. The id does not say
**which tier produced it**. Three tiers already exist in `resolveAttestation` (`observed` /
`environment` / `binding`); only `observed` is a measurement. Cursor and Codex both have
`observeModel` probes wired, and both still fall through to `binding.model` — Cursor **drops** a
stale observation when a new conversation carries no model (ADR 268), Codex never writes one
unless PostToolUse carries `model`. Honest degradation therefore degrades **into** the
least-verified tier, and the act log cannot tell.

Attesting `unknown` when the probe produced nothing would flip the ADR 101 family posture: on
2026-08-21 wanderer is the only live non-claude family, and its `grok-4.6` is an unverified
declaration. That change would be a measurement gap, not a change in who is working. Nick
chose **mark the tier**.

## Problem

A protocol field that other implementations depend on (`ClaimFrame.model`, `Request.model`,
per-act `meta.model`) grew a companion (`model_source`) in code without an ADR and without a
SPEC.md change. Hard rule 1 forbids that. The product also cannot land while its PR is behind
`main`.

## Decision

### 1. The wire carries `model_source` beside `model`

Optional, additive, `musterd/0.3` MINOR. Values on the wire are `observed` | `environment` |
`binding`. `unknown` is **not** a wire value: an unattested occupancy omits both fields
(ADR 101 warn-never-block; absence is not an assertion, ADR 236).

It rides:

- `claim.model_source` (and the grant-less `requests.model_source` so the tier crosses the
  approval gap)
- `heartbeat.model_source` (same never-clear rule as `model`: absent ⇒ no change)
- per-act `meta.model_source`, **server-controlled**

The pair never travels split. Every write gates the source on the model (`model` present ⇒
source may be set; no model ⇒ source is null). Heartbeat `COALESCE`s both on one condition.
Re-attestation compares both — a heal that only corrects the tier is a real change.

### 2. Server-controlled, stripped like `model`

`routeEnvelope` strips client-supplied `meta.model` **and** `meta.model_source`, then stamps
from the sending occupancy. A session that could stamp its own tier could launder a
declaration into an observation, which is the substitution this field exists to prevent. The
case that needs the strip is an occupancy whose tier is **unknown**: nothing overwrites, so a
spoofed `observed` would otherwise ride out labelled as measured.

### 3. Absence is a third answer, never defaulted to `binding`

Pre-migration-42 rows and older clients do not know their tier. That is not the same fact as
"it was declared." Unrecognised values read as unknown rather than propagating.

### 4. What this does not do

- Does not attest `unknown` when a probe produced nothing (nick's call, Context).
- Does not surface the tier on the roster. A field on the summary without a reader is the
  dead-field pattern (`modelDrift`).
- Does not change the observation probes, ADR 268's drop, or the fallback ladder.

## Consequences

- Schema **v42**: `ALTER TABLE presence ADD COLUMN model_source TEXT` + the same on
  `requests`. NULL for every pre-existing row.
- The MCP adapter sends `model_source` on claim and heartbeat when it has a model.
- Wiki `model-attestation.md` records the finding and nick's call; this ADR is the protocol
  record.
- Product code originated on dolly's `01M0JT5NVG` / #975; this ADR plus SPEC.md is the
  missing protocol record. Land vehicle: #981.

## Observability & Evaluation

**Traces.** Every delivered act may carry `meta.model_source` beside `meta.model`. Occupancy
audit `occupancy.model_attested` still records id switches; the tier is on the presence row
and the act stamp. No new span.

**Eval.** _Dataset:_ acts after this lands, split by `meta.model_source`. _Baseline:_ every
act before today has no tier and cannot acquire one. _Metric:_ share of live stamps that are
`observed` vs `environment`/`binding` vs absent. _Target:_ the three-way split is countable;
an aggregate that mixes measurement with assumption is a detectable query, not a silent
default. _Falsifier:_ an occupancy that attested `binding` delivers `meta.model_source:
observed`, or a pre-v42 row reads as `binding`.

**Experiment.** The integration test `the act stamp carries WHICH TIER attested it — observed
vs declared, server-controlled, never defaulted` pins three mutations: not stamping the
tier, defaulting unknown to `binding`, and dropping the client-tier strip (the last initially
passed wherever occupancy had a tier to overwrite with).
