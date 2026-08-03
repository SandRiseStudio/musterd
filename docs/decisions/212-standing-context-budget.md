# 212 — Standing-context budget: every injected byte is measured, gated, and trimmed with evidence

- Status: accepted
- Date: 2026-08-03
- Builds on: [ADR 144](144-mcp-tool-surface-measure-then-craft.md) (measure-then-craft; increments
  1–5 shipped — this arc extends the principle from the tool surface to the whole injected
  context), [ADR 151](151-web-perf-budgets-gate.md) (the byte-budget CI gate + raise protocol this
  reuses), [ADR 085](085-layered-guidance-surface.md) / [ADR 171](171-provisioned-workspace-currency.md)
  (the guidance surface being measured), [ADR 168](168-hook-content-drift.md) (the hook
  writer whose nudge texts become budgeted constants), [ADR 175](175-mcp-spec-2026-07-28-readiness.md)
  (deferred MCP items stay parked; untouched)
- Spec: `docs/superpowers/specs/2026-08-03-standing-context-budget-design.md` · Plan:
  `docs/superpowers/plans/2026-08-03-standing-context-budget.md`
- Prompted by: LangChain Deep Agents v0.7 (2026-08) — a 65% base-input-token cut achieved by
  trimming the harness system prompt and tool descriptions, validated by an eval suite. The
  durable lesson is not the trim; it is that standing context regrows unless a measured budget
  holds it.

## Context

musterd injects text into a seat's context at four points, and only the first was measured: the
`tools/list` render (byte-attested since ADR 144 inc 1), the AGENTS.md primer block, the
SessionStart hook output, and the UserPromptSubmit nudge — the last shipped on **every turn** of
every seat session, multiplying exactly like tool schemas do. Nothing gated growth on the guidance
surfaces, and the primer and SessionStart orientation partially restate each other.

## Decision

1. **One static budget gate, `pnpm context:check`** (CI, after Build), in the ADR 151 mold:
   measured line items vs `docs/perf/context-budgets.json`, ~5% headroom, loud failure, and a
   raise protocol — raising a budget requires replacing that item's `justification`. Line items:
   `tools/list` per role (default + muted, via the shared `measureToolSurface` in-memory connect —
   the same byte formula as the inc-1 `SurfaceRender` attestation), the rendered primer, the hook
   nudge texts (exported as `HOOK_NUDGE_TEXTS` constants so the budget reads the source of truth),
   and two derived totals. **Per-turn total (tools/list + UserPromptSubmit nudge) is the headline
   number.** A surface that fails to render fails the gate; nothing is skipped.
2. **Dynamic hook output is report-only** (`scripts/context/report.mjs`): executed against a
   fixture folder, capturing what the installed hooks actually print (init-check, label nudge).
   Machine-state-dependent, therefore never a CI gate — but recorded in the baseline.
3. **A trim increment follows, gated cheaply**: existing suites + `guidance:check` + one in-memory
   ritual probe test (join on first tool call, inbox surfacing, status_update accepted — behavior,
   not wording). No paid eval runs. After the trim, budgets are lowered to the new measured
   numbers so the win cannot silently erode.

## Consequences

- Growth in any injected surface becomes a deliberate, justified act instead of a side effect.
- The baseline (`docs/perf/standing-context-baseline.md`, 2026-08-03): per-session standing
  context 16,768 B (~4,192 est tok); per-turn 13,641 B (~3,410 est tok); and the first dynamic
  finding — the due-gated label nudge (250 B) more than doubles per-turn hook output when it
  fires.
- The hook nudge texts are now named constants; a reword is a reviewed, budget-visible change.

## Observability & Evaluation

**Traces.** The gate is itself the instrument: `context:check` prints the full measured table
(bytes + est tokens per item) on every CI run, and `docs/perf/standing-context-baseline.md` is the
dated log — the trim increment lands its before/after there. The existing ADR 144 inc-1 telemetry
(`mcp.surface_rendered` attestations, bounce rates) is the live-seat cross-check that the static
measurement tracks reality. No new emission; nothing leaves the repo.

**Eval.** The trim's gate: all existing suites + `guidance:check` green, plus the in-memory ritual
probe (join on first tool call, inbox surfacing, status_update accepted — behavior, not wording).
Success: per-turn total drops with the probe green. Failure watched: a trim that breaks the
join/inbox/status ritual is caught by the probe before merge.

**Experiment.** n/a — no paid eval runs by decision (the cheap-gate scope call in the spec); if a
future deep trim needs behavioral evidence beyond the probe, it pre-registers a cookoff-style cell
under ADR 056 rather than widening this gate.
