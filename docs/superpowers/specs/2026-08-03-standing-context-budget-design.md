# Standing-context budget — measure, gate, and trim the per-seat injected surface

- Date: 2026-08-03
- Status: design approved in conversation (nick + stanley); implementation plan to follow
- Builds on: ADR 144 (measure-then-craft MCP surface; increments 1–5 shipped), ADR 151 (byte-budget
  CI gate + raise protocol — the pattern this reuses), ADR 085/171 (the guidance surface being
  measured), ADR 175 (deferred MCP items stay parked; untouched here)
- Inspiration: LangChain Deep Agents v0.7 (2026-08) — cut base input tokens ~65% by trimming the
  harness system prompt and tool descriptions, validated by an eval suite; the durable lesson is
  that standing context regrows unless a measured budget holds it.

## Problem

musterd injects text into a seat's context at four points. Only the first is measured:

1. **`tools/list` render** — measured and byte-attested since ADR 144 increment 1
   (`SurfaceRender` / `computeSurface`; baseline ≈3,195 tok/seat, muted seat −77%).
2. **AGENTS.md primer block** — rendered from `packages/protocol/src/primer.ts` (~2.4 KB in this
   repo). Unmeasured.
3. **SessionStart hook output** — orientation + init drift check + label nudge, from
   `packages/cli/src/onboard/harnesses/claudeCode.ts`. Unmeasured.
4. **UserPromptSubmit nudge** — the status_update/inbox ritual + label nudge, shipped on **every
   turn** of every seat session. Unmeasured — and per-turn, so it multiplies exactly like tool
   schemas do.

Nothing gates growth on surfaces 2–4, and the primer and SessionStart orientation partially restate
each other (the join/inbox ritual appears in both). ADR 144's own principle — measure, then craft —
has never been applied to the guidance half of the surface.

## Goal

Every byte musterd injects into a seat's context is measured per role, budgeted in a checked-in
file, and CI-gated so it can only grow deliberately; then a one-time evidence-guided trim of the
worst offenders, with budgets lowered afterward to lock in the win.

## Design

### Increment 1 — the instrument + budget gate

**`pnpm context:check`** — a script in the ADR 151 mold, driven by a checked-in
`context-budgets.json`.

Budgeted line items, computed **statically** (no hook execution, no daemon):

- `tools/list` render bytes per role — at minimum `default` and `observer`/muted — **reused** from
  the existing `SurfaceRender` byte attestation (`computeSurface`), never recomputed by a second
  code path.
- Primer block bytes — rendered from `packages/protocol/src/primer.ts` exactly as `musterd init`
  writes it.
- Hook nudge strings — the SessionStart orientation text, the label nudge, and the UserPromptSubmit
  ritual text. Small enabling refactor: today some of these are inline string expressions in
  `claudeCode.ts`; they become exported named constants so the budget reads the source of truth.
  The hook *command* strings (shell plumbing) are not budgeted — only the text a model reads.
- A derived **per-turn total** (tools/list + UserPromptSubmit nudge) and **per-session total**
  (everything) — the per-turn total is the headline number.

Rules, matching ADR 151 conventions:

- Each budget carries ~5% headroom over the measured baseline.
- Exceeding a budget fails CI loudly. Raising a budget requires a justification line in
  `context-budgets.json` (the raise protocol).
- If a role's surface cannot render (e.g. capabilities missing), `context:check` **fails**; it
  never skips a line item.

**Report-only companion** — `context:report` (or a flag on the same script) additionally executes
the hooks against a fixture folder to capture the *dynamic* output (init-check text, label-sweep
output, autojoin banner). Informational only; never a CI gate. Its numbers land in the baseline
doc.

**Baseline doc** — `docs/perf/standing-context-baseline.md`, mirroring the web-perf log: the
measured numbers per surface per role, dated, with the method noted.

### Increment 2 — the trim

Guided by increment 1's numbers. Expected targets (to be confirmed by measurement, not assumed):

- The **UserPromptSubmit nudge** — the label clause repeats verbatim every turn; the ritual
  reminder may compress substantially.
- **Primer ↔ SessionStart redundancy** — both explain the join/inbox ritual (the Deep Agents
  "the harness already says this" finding, applied to our own two surfaces). One of them owns it.
- **Tool descriptions restating the primer** — anything in a tool description that duplicates
  guidance the primer already ships.

**Gate (deliberately cheap — no paid model runs):**

- Existing `guidance:check` and all vitest suites stay green.
- One new scripted probe test: a fixture seat session driven through the in-memory MCP client
  (same substrate as the ADR 175 canaries) asserting the ritual still happens end-to-end — join
  fires on first tool call, inbox check surfaces a waiting act, status_update is accepted.

After the trim, budgets in `context-budgets.json` are **lowered** to the new measured numbers, so
the win cannot silently erode.

## Error handling

- `context:check` exits non-zero with a per-line-item diff (measured vs budget) on any breach.
- Missing or unparsable `context-budgets.json` is a failure, not a skip.
- The enabling refactor in `claudeCode.ts` must be behavior-neutral: hook install output is
  byte-identical before/after (asserted by the existing onboard/hook tests).

## Testing

- Unit tests for the measurement script: known fixture inputs → exact byte counts; budget breach →
  non-zero exit; raise-without-justification → failure.
- The `claudeCode.ts` constant extraction covered by existing `claudeCode.hooks.test.ts` /
  `refreshHooks.test.ts` staying green.
- The increment 2 probe test as described above.

## Paperwork & sequencing

- One new ADR for the arc (number picked off origin/main at PR time, per the collision trap), with
  the `## Observability & Evaluation` section required for ADRs ≥060.
- Drive-by in the same PR: one-line ROADMAP correction — ADR 144 increment 4 is **done as a line of
  work** (the roadmap entry still says it remains; the ADR text is authoritative).
- Increment 1 and increment 2 are separate PRs; increment 2 does not start until increment 1's
  baseline is committed.

## Out of scope

- Executed-hook output as a CI gate (report-only, by decision).
- Paid eval runs (cookoff cells) as the trim gate.
- SEP-414 trace propagation and `outputSchema` adoption — parked in ADR 175, untouched.
- Any change to what the surfaces *say* beyond compression/de-duplication — no behavioral guidance
  redesign in this arc.
