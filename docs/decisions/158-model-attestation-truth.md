# 158 — Model attestation truth: an observation outranks a declaration

- Status: accepted — 2026-07-24. Founder approved the design (both increments, "even contract" across
  harnesses, observation and declaration kept as separate fields). Number **158 pinned** — next free on
  `origin/main` (highest is 157), enforced by `adr-numbers:check` (#350).
- Date: 2026-07-24
- Builds on: [ADR 101](101-model-as-a-variable.md) (harness-attested model, attested-never-verified —
  the attestation this corrects), [ADR 018](018-workspace-binding.md) (the `env > binding.json >
workspace.json` ladder whose top rung was the defect), [ADR 119](119-ambient-model-attestation.md)
  (re-attest on ambient HTTP touches), [ADR 120](120-harness-attestation-seam.md) (never infer a model
  from MCP `clientInfo`), [ADR 121](121-model-attestation-agent-only.md) (agent seats only),
  [ADR 131](131-harness-residency.md) §5–6 (the SessionStart capture seam this rides, and newest-wins
  re-attestation), [ADR 135](135-build-provenance.md) (a separate field per attested fact),
  [ADR 143](143-seat-identity-workspace-anchor.md) (local MCP config keyed by repo root — how a
  sibling seat's provisioning overwrites this one's entry), [ADR 056](056-research-as-first-class-practice.md) (the
  diversity research a wrong model poisons).

## Context

Seat `ryder` reported `grok-4.5` on the roster for weeks while the session was in fact running
`claude-opus-4-8` under Claude Code. Every obvious repair failed, each for a different reason:

- Editing `.musterd/binding.json` — overwritten. `saveBinding` rebuilds the binding from **boot-time
  config**, so the live adapter's next autojoin wrote the stale value straight back over the edit.
- `team_send` with `meta.model` — ignored. Attestation is per-occupancy, not per-message.
- `MUSTERD_MODEL=… musterd send` from the shell — no effect on the roster. An ambient HTTP touch
  re-attests only the _ambient_ presence row (`conn_id IS NULL`, ADR 119); the roster renders the
  _connected_ MCP occupancy.

The cause was one line in the harness MCP entry, written at provisioning time:

```
MUSTERD_MODEL=grok-4.5
```

## Problem

**A precedence inversion.** The adapter's ladder is `env > binding.json > workspace.json`, and
provisioning wrote a wire-time snapshot into `env` — the **top** rung. A guess therefore outranked
every later observation, and nothing downstream could correct it.

`onboard/mcpEntry.ts` already contained the argument against this, written about a different field.
Its comment explains why `MUSTERD_CLAIM` is deliberately _not_ baked: doing so froze "a _copy_ that
outranks binding.json and can never be updated by a re-claim." Eight lines later the same function
baked `MUSTERD_MODEL` in exactly that shape. The principle was known and applied inconsistently.

Model is the _worse_ field to snapshot. A claim changes only when musterd acts (`musterd claim`), so a
stale copy is at least explicable. A model changes when the **harness** changes, with no musterd
action at all — so a baked copy begins rotting the moment it is written.

**Why the existing tripwire missed it.** The harness attestation tripwire (#273) classifies
declarations as `environment` / `binding` / `unknown` and warns on `unknown`. It detects _absent_
attestation only. A confidently wrong declaration is indistinguishable from a correct one to it, so
this failure passed silently — the mode most damaging to ADR 056 conclusions, since a wrong value
poisons a chain while looking healthy.

## Decision

### 1. Two tiers, ordered by kind of claim

| tier        | source                                | meaning                                          |
| ----------- | ------------------------------------- | ------------------------------------------------ |
| 1. observed | harness probe (`observeModel()`)      | what the harness _is_ running, seen this session |
| 2. declared | `MUSTERD_MODEL`, then `binding.model` | what a human or config _says_ it runs            |
| 3. unknown  | nothing                               | honest absence — legal, never blocks             |

Observation beats declaration, newest-wins (the rule ADR 131 §6 already uses for provenance);
env still beats binding _within_ the declared tier (ADR 018). `resolveAttestation()` in
`@musterd/protocol` is the single resolver, shared by the adapter and the CLI so the two cannot drift.

### 2. Provisioning stops baking `MUSTERD_MODEL`

Deleted from `buildMcpEnv`. `MUSTERD_MODEL` remains a supported **manual** override for headless/CI,
exactly as `MUSTERD_CLAIM` does — it simply is not materialized by default provisioning. A regression
test asserts the env is never emitted, whatever the caller passes.

### 3. An even contract across harnesses

Every harness declares the same `observeModel(payload) → string | undefined` slot, with the same
never-throw rule and the same `undefined` degradation. Fidelity behind the slot differs because
harnesses differ — that is a property of the harness, not of musterd's guarantees:

- `claude-code` — reads `message.model` from the tail of the hook-provided `transcript_path`.
- `codex` — the same JSONL shape from its rollout log; a `musterd host`-spawned Codex seat is
  authoritative from its spawn arguments.
- `cursor` — `undefined`. A declared, visible gap rather than a silent pretence of knowledge.

`session/transcript-model.ts` is the only module that knows any harness's on-disk format. The _path_
is a documented hook input; the _format_ is not, so a format change degrades the whole tier to
`undefined` (back to declaration-only) instead of breaking a hook.

### 4. Observation and declaration stay separate fields

`binding.model_observed` never overwrites `binding.model`. Three reasons decide it:

1. **Self-laundering.** A session that observed nothing would read the previous session's observation
   as a _declaration_ — the field's epistemic status becomes unknowable, recreating the original
   question one level down.
2. **The rot metric dies.** §Observability makes `observed ≠ declared` the health signal; if
   observations overwrite declarations, every mismatch is silently repaired _in the record_ the
   instant it is detected.
3. **Three writers, one slot.** `saveBinding`'s merge guard exists because two writers clobbering one
   field caused the ADR 101 model-wipe. Both copies of `saveBinding` (CLI and MCP) now carry
   `model_observed` through a rebuild-from-boot-config save, exactly as they carry `session`.

This also matches house style: ADR 135 keeps build attestation in its own field.

### 5. The tripwire gains the case it was missing

`observed ≠ declared` now fires in `musterd init --check`, naming both values and where the stale one
lives. The doctor additionally reports, from the harness's own read-back: a legacy baked
`MUSTERD_MODEL`, a `MUSTERD_GRANT` that disagrees with this workspace's binding, and an adapter
launched from another seat's workspace.

### 6. Increment 2, scoped to what it can prove

The incident's _planting_ mechanism was a second defect: this seat's entry launched
`/Users/nick/agents-miley/packages/mcp/dist/index.js` and carried a grant from another provisioning
run. `resolveMcpLaunch()` resolves the adapter from the **provisioning process's own location**, and
Claude Code keys local MCP config by **repo root** (ADR 143), so every seat worktree of one repo
shares a single entry that the next seat's provisioning overwrites.

Two limits emerged while building the guard, and the design was narrowed to match:

- **The adapter path cannot be a refusal.** The adapter anchors identity on its cwd, walking up to
  that folder's `binding.json` — so whose _copy_ of the binary runs never decided which seat gets
  claimed. And a refusal is indistinguishable from the canonical flow, where provisioning is run from
  another checkout that is itself a bound seat (`/Users/nick/agents` holds seat `nick`). It is a note:
  the real cost is running another checkout's build, and breaking if that folder moves.
- **The secret check cannot run at write time.** `buildEntry` derives an entry's env _from_ the same
  binding it is written beside, so a comparison there is tautological. The mismatch appears later,
  when the shared entry is overwritten. So it runs on the **inspection** path, comparing an entry the
  harness reports back against the binding of the workspace it is meant to serve.

`assertEntryIdentity` therefore throws on a **secret** mismatch (a genuine cross-run identity leak
with no benign reading) and is called from the doctor, not from `buildEntry`.
(Corrected by ADR 165: it never was — the doctor re-implemented the grant comparison inline and the
agent_key half never ran. ADR 165 removed the function and made a baked secret drift on presence.)

### 7. Observation happens at the tool boundary, not at SessionStart

Increment 1 observed only in the SessionStart capture, and that was the wrong moment — caught in
dogfood the session after this ADR merged. The `transcript_path` a SessionStart hook is handed names
the **new** session's transcript, which carries no assistant turn yet, so `observeModel` returned
`undefined` on every fresh session. The §4 never-erase rule then did exactly what it promised and kept
the prior observation, which meant the observation was never made and the carry-forward never expired.

Measured on seat `ryder`: the roster attested `claude-opus-4-8` from an observation timestamped 64
minutes before the session began, while both of the seat's most recent transcripts were 100%
`claude-opus-5` — and the probe returned `claude-opus-5` correctly when run against either. The parse
was right; only the timing was wrong. The stale declaration this ADR set out to kill had simply moved
one field over, from `model` to `model_observed`.

So the observation now also runs at the **tool boundary**, on the PostToolUse interrupt hook (ADR 088)
— the first moment the running model is knowable, and a probe that already fires there. It re-reads
when the stored observation predates the session (the carry-forward) or has aged past
`OBSERVATION_REFRESH_MS`; the second case is what lets a mid-session `/model` switch surface at all,
which the backwards-walking read in `readModelFromTranscript` was always written to support and a
once-per-session observation quietly discarded. Cost is a bounded 256 KiB tail read at most once every
five minutes per seat, skipped entirely while the observation is current.

The never-erase, never-clobber, and never-fail contracts carry over unchanged, plus one more: an
**ended** session is not re-observed. What it last attested is the truth about it.

## Consequences

- A wrong model self-heals within one tool call of the session starting instead of surviving weeks,
  with no human edit — and a mid-session model switch self-heals within five minutes.
- Claude Code seats gain real attestation without anyone setting an env var; Cursor seats are
  honestly `unknown` until Cursor exposes something to read.
- `unknown` may become _more_ common than under the old bake, and that is the point: constraint A is
  that musterd would rather say nothing than say something false, because ADR 056 conclusions are
  built on this field.
- One new coupling: an undocumented transcript format, isolated to one module with an `undefined`
  fallback.
- The observed tier requires the SessionStart capture hooks (ADR 131 §5) to be wired. A workspace
  missing them falls back to the declared tier — `musterd init --check` already reports their absence.

## Observability & Evaluation

**Traces.** Three signals, all already on the wire:

- `occupancy.model_attested` records `old → new` per occupancy. After this change a correction is
  attributable to an _observation_ rather than a human edit, so the audit distinguishes "musterd
  noticed" from "someone fixed it by hand."
- `McpConfig.modelSource` now carries `observed` alongside `environment` / `binding` / `unknown`, so
  every attested act is traceable to the tier that produced it.
- `musterd init --check` reports per-workspace attestation state, making poisoned entries countable
  across all seats instead of discovered one at a time.

**Eval.** _Dataset:_ the seat roster — every live occupancy, its attested model, and its tier —
joined with `occupancy.model_attested` history and a doctor sweep across the seat worktrees on the
dogfood machine. \_Baseline, measured via a fleet sweep of all thirteen worktrees (2026-07-27,
`binding.model` vs `binding.model_observed` read directly off each `.musterd/binding.json`): four
Claude Code seats (ryder, izzo, miley, stanley) carry both tiers and agree 4/4 — zero tripwire hits,
the target this metric was built to reach. Two Cursor seats (compo, wanderer) declare a model with no
observed tier, the honest §3 gap for a harness with nothing to probe. Five seats (dolly, gptbot,
grokbot, help, kimi) carry neither field, having sat unlaunched since this pass — absence, not a
mismatch. The originating incident's workspace (`ryder`: a baked `MUSTERD_MODEL`, a grant from
another provisioning run, an adapter path into a sibling seat — none of which any pre-158 check
reported) is inside this same sweep and no longer reproduces: its declaration now matches its
observation.

_Metric:_ the `observed ≠ declared` tripwire rate, which measures how often provisioning
snapshots rot. _Target:_ trends to zero as legacy entries are rewritten — met on this sweep (0/4 among
seats with both tiers); a non-zero rate on a later sweep means something is writing declarations
again. _Counter-metric:_ the share of Claude Code seats attesting `unknown` — a rise means the
transcript format moved and `transcript-model.ts` needs updating; none did on this sweep. Degradation
is therefore visible rather than silent, which is the point of preferring `unknown` to a stale value.

**Experiment.** No A/B is warranted: this is a correctness fix against a known-wrong baseline, so a
holdout arm would deliberately keep seats lying to the ADR 056 diversity research this feeds.
Verification is adversarial-by-construction instead —
`tests/scenarios/model-attestation-truth.test.ts` proves the correction end to end through the DB and
was confirmed to **fail** (`expected 'grok-4.5' to be 'claude-opus-4-8'`) with the observation tier
disabled, then pass with it restored, so it is not a vacuous pass. The natural experiment worth
watching: whether the tripwire rate across the dogfood seats actually reaches zero once the doctor
sweep in §6 is acted on — which tests the claim that provisioning was the only writer of stale
declarations.
