# 198 — Cursor hooks supply live `model_id` for observeModel

- Status: accepted
- Date: 2026-07-31
- Builds on: [ADR 158](158-model-attestation-truth.md) (observation > declaration; even
  contract; Cursor declared as `undefined` until a readable signal existed),
  [ADR 120](120-harness-model-attestation-seam.md) (never infer from MCP
  `clientInfo`), [ADR 088](088-interrupt-line-tool-boundary-inbox-check.md)
  (tool-boundary observation timing)
- Lane: `01KYSYYWBP4VXX0K7YD01HQ2AS`

## Context

ADR 158 §3 left Cursor's `observeModel` as an honest gap: "undefined until Cursor
exposes something to read." Research 004 named the failure — a Cursor seat whose
dropdown switches mid-session keeps attesting a stale declaration (or `unknown`).
Claude Code already observes from the transcript at the tool boundary; Cursor
agent transcripts still carry no `message.model`.

Cursor Agent hooks now include `model` / `model_id` on the common stdin schema
([cursor.com/docs/hooks](https://cursor.com/docs/hooks)), including
`postToolUse` / `afterMCPExecution` / `sessionStart` / `sessionEnd`. That is the
readable signal ADR 158 was waiting for. Extension APIs and MCP env still do not
push live model; transcripts still do not.

## Problem

Without wiring those hook fields into musterd:

1. Cursor seats cannot self-heal after a dropdown switch (the exact rot ADR 158 bans).
2. The even contract still holds (`undefined` is legal) but the fidelity gap is
   no longer forced by the host — only by our missing install path.
3. `CAPTURE_HARNESS = 'claude-code'` and transcript-only refresh cannot serve Cursor:
   Cursor ids sessions as `conversation_id`, and observation arrives as hook fields,
   not JSONL.

## Decision

1. **`cursor.observeModel`** reads `payload.model_id ?? payload.model`, never
   `transcript_path` (still no model on Cursor JSONL). Empty payload → `undefined`.
   Never throws.
2. **Extend `ModelObservationInput` / hook stdin parse** with optional `model_id`,
   `model`, and `conversation_id` (mapped to `session_id` when absent).
3. **`musterd session observe --stdin`** — Cursor-oriented capture+observe: stamps
   `binding.session` with `harness: 'cursor'` and `id: conversation_id`, writes
   `model_observed` under the existing never-erase / `OBSERVATION_REFRESH_MS`
   rules. Always exit 0.
4. **Install project `.cursor/hooks.json`** on Cursor `configure` / `refreshHooks`:
   `sessionStart`, `postToolUse`, and `sessionEnd` pipe stdin to
   `musterd session observe|end --stdin` (marker-tagged, idempotent upsert,
   never-fail one-liners — same contract as Claude Code hooks). Prefer
   `postToolUse` over `afterMCPExecution` so every tool boundary refreshes, not
   only MCP.
5. **Do not** infer from `clientInfo`, scrape `state.vscdb`, or re-bake
   `MUSTERD_MODEL`.

## Consequences

- A Cursor occupancy re-attests the live dropdown model on the next tool boundary
  after a switch (MCP heartbeat already re-reads `model_observed` — ADR 158
  follow-up). Unknown remains legal when hooks are absent or the payload omits
  model fields.
- Claude Code / Codex paths unchanged.
- Docs: this ADR; ADR 158 §3 note that the Cursor gap is closed by hooks; even-
  contract tests assert Cursor observes when `model_id` is present.

## Observability & Evaluation

- **Traces:** n/a — local binding write + existing occupancy attestation path.
- **Eval:** n/a — mechanical host-signal plumbing; no agent-facing model decision.
- **Experiment:** n/a — closes a known attestation lie mode (research 004); no A/B.
