# 362 — OpenCode hook-channel capture: plugin complement deferred, heartbeat stays primary

- Status: proposed — 2026-09-03. Authored by ghost on lane `01M1JC2FTX06ZH6X7KDA2D3VN7`; reservation PR #1217 per ADR 223.
- Builds on: [ADR 321](321-opencode-first-class-harness.md) §8 (whose "no hook table" premise this corrects and whose conclusion it reaffirms on new grounds), [ADR 270](270-mcp-reconciles-cursor-capture-without-hooks.md) (heartbeat-side reconciliation), [ADR 027](027-non-invasive-harness-coexistence.md) (guest posture), [ADR 252](252-no-fabricated-wake-cost.md) (cost half, decided elsewhere — see below).

## Context

ADR 321 §8 (2026-08-25, verified against opencode 1.18.23) states opencode has "no hook table" and routes all capture through heartbeat-side reconciliation, rejecting plugin-based capture because "a plugin is executable code injected into the harness process … pinned to opencode internals that move between releases."

That factual premise is now stale. Upstream ships a documented plugin event channel (official plugin docs, current as of Sep-2026; concepts re-verified against the 1.18.27 binary on this machine):

- Session/message lifecycle events — `session.created`, `session.idle`, `session.updated`, `message.updated`, plus `tool.execute.before/after` and `permission.asked` — dispatched through a single `event` handler that switches on `event.type`.
- Two load paths: project-local `.opencode/plugins/` files (auto-loaded at startup) and npm packages via the config `plugin: [...]` key (installed with Bun at startup, cached under `~/.cache/opencode/`).
- Working community proof for exactly our use case: the opencode-throughput plugin captures per-message tokens, cost, and model from `message.updated` and logs them to JSONL outside the LLM context.

Related and checked in the same pass: `opencode run --format json` `step_finish` events carry `part.cost` in USD plus the full token breakdown (`input/output/reasoning/cache.read/cache.write`), which answers the "no cost source" half of the wake-cost question — but pricing wakes off that stream is [dolly's lane 01M1HJY3JF](https://github.com/SandRiseStudio/musterd/pull/1216), linked here, not decided here.

## Problem

With a real event channel available, is heartbeat-side reconciliation still the right primary capture for opencode seats — or should musterd ship a capture plugin? Three findings say "not yet," and each is load-bearing:

1. **Resume fires no event.** Resuming via `--continue`/`--session` is UI navigation, not a bus event — no `session.created`, no resume trigger, no way to distinguish why a session started (upstream issue anomalyco/opencode#5409, open as of 2026-06-28, with a community PR attempting `session.start` with `startup`/`resume`/`compact` triggers). Wake's primary path is *resuming* a captured session (`buildOpencodeResumeArgs`, `packages/cli/src/host/backends/opencode.ts:27-29`). A plugin capture would be blind on exactly the path residency uses most. It can only complement heartbeat reconciliation, never replace it.
2. **The trust objection got stronger, not weaker.** A plugin is executable TypeScript loaded into the harness process, with npm dependencies installed via `bun install` at startup. That is installation, not configuration — a step past ADR 027's guest posture, and a musterd-managed executable file in users' repos (`.opencode/plugins/`) is a new managed surface (write scope, update story, what runs under whose authority), not a config upsert like the `mcp.musterd` entry.
3. **Version coupling is demonstrated, not hypothetical.** The direct-key `session.created` pattern silently stopped firing in opencode ≥1.15 (must dispatch via `event`; observed in the wild, caveman#421), and `run --format json` once exited without emitting the final `step_finish` (fixed upstream in #31389). A capture plugin needs a per-release pin-and-test story or it rots silently — the exact failure mode ADR 321 feared.

## Decision

1. **Correct the premise, keep the conclusion.** ADR 321 §8's "no hook table" is struck as a factual claim (a dated amendment note is appended to that ADR's Consequences with a marker where the reader meets §8); its conclusion — heartbeat-side reconciliation is the primary capture for opencode seats — is reaffirmed on grounds 1–3 above instead of inherited.
2. **No musterd capture plugin is shipped in this lane.** Shipping one now would add an executable-code managed surface that is blind on resume, against a moving upstream API, for coverage heartbeat reconciliation already provides (enumeration + `observeModel`, both verified live on 1.18.27 during this lane).
3. **Revisit is falsifier-gated, not calendar-gated.** Reopen capture-via-plugin if and only if: (a) upstream lands a resume/session-start event (#5409 or equivalent) that fires on `--continue`/`--session`, eliminating finding 1; or (b) heartbeat-side reconciliation proves too coarse in practice (ADR 321's original revisit clause, unchanged). Either reopens the decision; neither re-argues it.
4. **Cost-stream reading is blessed as evidence, decided elsewhere.** Nothing in ADR 252 forbids reading a first-party `part.cost` off the wake child's own stdout the way the backend already reads `sessionID` off it. Whether wakes *price* from that stream is dolly's 01M1HJY3JF call; this ADR records only that the source exists so her lane need not re-prove it.

## Consequences

- A dated amendment note + marker is appended to ADR 321 (same commit, hard rule 3): §8's premise corrected, conclusion reaffirmed, pointer here.
- No code changes: no new files outside `docs/decisions/`, no arch-tree updates, no coverage movement. The lanes that overlap this surface (dolly's 01M1HJY3JF cost lane, ryder's codex-hooks lane) lose nothing — finding 4 feeds the former, and the codex-hooks work is unaffected (different harness, hook table vs plugin system).
- If upstream #5409 lands, the cheapest next step is a spike plugin on a scratch workspace proving resume-fire before any managed-surface design — the falsifier in Decision 3(a) is written to be checkable in one session.

## Observability & Evaluation

n/a — no runtime behavior ships in this lane. The evals are named elsewhere by pointer: dolly's 01M1HJY3JF evidence run for the cost half, and Decision 3's two falsifiers for the capture half (a scratch-workspace spike, not a metric).
