# 275 — Occupancy attests the observed harness, not the declared surface

- Status: accepted
- Date: 2026-08-14
- Relates to: ADR 158 (model observation outranks declaration), ADR 120 (never infer model
  from MCP `clientInfo`), ADR 251 (native `musterd` surface is host-declared), the
  surface-drift warning in `@musterd/mcp` (2026-08-03: warn, do not re-rank)

## Context

`presence.surface` is what the roster, the OTel `musterd.presence.active` series, and
`occupancy.model_attested` readers treat as "which harness this seat is on." The MCP adapter
resolves `surface` as `env > binding.json > workspace.json` and then **believes it**. Capture
(`binding.session.harness`, `model_observed.harness`) is a separate fact. When they disagree,
the adapter prints `warnContestedSurface` and still attests the declaration.

That was a deliberate 2026-08-03 choice: the then-measured lie was a baked `MUSTERD_SURFACE`
at the top of the ladder, and re-ranking would not have reached it. The warning made the
contradiction visible and prescribed a per-file repair.

On 2026-08-14 the live fleet was measured again, this time looking at Cursor and Codex
capture end-to-end:

- wanderer's slot was `harness: cursor` (ADR 270 healed it). Binding `surface` was still
  `claude-code`. Occupancy after the 15:59 bounce had **no presence row**; when it did, it
  would have said claude-code. `occupancy.model_attested` carries `{occupancy, old, new,
  source}` — the model string, never the harness.
- gptbot's presence was `surface: codex` + `model: claude-opus-5` while the slot was an
  *ended* Claude Code session and a live Codex rollout sat uncaptured. The declaration said
  Codex; the capture said Claude; occupancy believed the declaration.
- The dogfood OTel sink was listening on `:4318`; the daemon plist had no
  `OTEL_EXPORTER_OTLP_ENDPOINT`; `otel-sink.log` was four startup lines. Even a correct
  `musterd.surface` attribute would not have landed.

Cursor-specific leftovers (hookless `model_observed`; grokbot never captured) and
Codex-specific leftovers (no `.codex/hooks.json`; live rollout not in the slot) are other
seats' lanes. This ADR is the harness-agnostic lie: occupancy attests configuration.

## Problem

A warning that the roster will lie does not stop the roster lying. Tool-call stats and act
`meta.model` still land; harness identity does not. Asking "are Cursor and Codex captured"
cannot be answered from occupancy or OTel, only from gitignored bindings.

The 2026-08-03 warning is still right about a baked `MUSTERD_SURFACE` — env is an explicit
override and must stay one. It is wrong about a stale `binding.surface` when a capture
exists: that is the same class of evidence ADR 158 already trusts for **model**, and leaving
surface on the declaration is how a Cursor slot keeps looking like Claude Code.

## Decision

### 1. Occupancy surface follows capture, the same way model does

When `binding.session.harness` or else `model_observed.harness` is a valid `Surface`, the MCP
adapter attests **that** value on claim, heartbeat, and ambient touch — not `binding.surface`.
`refreshAttestation` updates `config.surface` when the slot changes (ADR 270 heals a Cursor
id mid-session; the next heartbeat must not keep sending `claude-code`).

Session harness wins over model-observation harness: it is what is running *now*.

### 2. Two declarations still win, and they are the only ones

- **`MUSTERD_SURFACE` in env** — explicit operator override. Occupancy uses it. The existing
  contested-surface warning still fires when capture disagrees, and still names the env as
  the culprit. Do not promote observation above env.
- **`surface: musterd`** — ADR 251. A native occupancy is host-declared. Capture must not
  clobber it. `claimAndJoin` already refuses a binding re-read that would; this ADR does not
  change that.

A capture-less Codex (or any) seat stays on its declaration. Warning-on-absence stays
forbidden — that would fire forever on every unhooked seat.

### 3. The warning remains for the cases occupancy will still lie

When occupancy *follows* capture, the binding/declaration mismatch is corrected, not
warned. Warn only when occupancy will still attest the stale value (env override, or
native `musterd` vs a capture). Same prescription: name the file that holds the stale
value; never `musterd wire` / `musterd agent` / `musterd init`.

### 4. What this does not do

- Does not parse Cursor transcripts for a model. Does not install Codex hooks. Does not
  add `harness` to the `occupancy.model_attested` detail shape (presence.surface becomes
  the harness when this adapter is the client; a protocol change for the audit row is a
  later lane if CLI/other clients still lie).
- Does not bounce the shared daemon to restore `OTEL_EXPORTER_OTLP_ENDPOINT` on the
  dogfood plist. That env is machine-local (ADR 082) and the installer surface is another
  seat's lane. Named leftover: sink running, daemon not exporting.

## Consequences

- A Cursor slot (`session.harness: cursor`) occupies as `cursor` even when
  `binding.surface` is still `claude-code` from MCP default provisioning.
- A Codex-provisioned worktree whose slot is an ended Claude Code session occupies as
  `claude-code` until Codex capture replaces the slot — honest, not a Codex-looking Claude.
- `warnContestedSurface`'s "this warns, it does not re-rank" test inverts for the
  binding-vs-capture case. The env-override case stays warn-and-do-not-re-rank.
- OTel `musterd.surface` becomes meaningful *once the daemon actually exports*. Until the
  plist leftover is restored, occupancy in SQLite is the instrument.

- **2026-08-14 implementation.** Heartbeat gained optional `surface` (same never-clear rule as
  `model`) so a mid-session capture heal updates the presence row without a reconnect. MCP HTTP
  sends `x-musterd-surface` for the no-WS ambient path. No new audit action.

## Observability & Evaluation

**Traces.** Existing `occupancy.model_attested` + `presence.surface`. No new audit action.
Falsify: a seat whose `binding.session.harness` is `cursor` and whose `binding.surface` is
`claude-code` must show `presence.surface = cursor` after the next claim/heartbeat, with
no `MUSTERD_SURFACE` in env.

**Eval.** Dataset: the 2026-08-14 audit query (`presence.surface` grouped, plus wanderer /
gptbot bindings). Baseline: occupancy attested `binding.surface` (wanderer would occupy as
`claude-code` while the slot was `cursor`). Pass: wanderer's occupancy is `cursor` while the
28c22bee slot is live. Codex remains declaration-only until that seat's hooks exist — this ADR
must not invent a Codex surface from a missing capture.

**Experiment.** n/a — closes a measured lie mode; no A/B.
