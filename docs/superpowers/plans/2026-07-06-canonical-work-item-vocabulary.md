# Canonical Work-Item Vocabulary + `vocab:check` Gate Implementation Plan (ADR 096)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. **This plan shipped in the same PR as ADR 096** — boxes are checked; it stands as the record and as the template for gate adjustments (e.g. renumbering on an ADR collision).

**Goal:** Stop work-item terminology drift. New docs use the canonical vocabulary — Goal / Lane the entities, `wave` a field, Phase / "increment N" / "Task N" the sanctioned prose units — and a hermetic checker (`scripts/check-vocab.ts`) fails `format:check` when a new doc uses a banned structural noun (`epic`, `milestone`, `sprint`, `story points`). No new entity, field, or table. Spec: `docs/decisions/096-canonical-work-item-vocabulary.md` — it is the contract.

**Architecture:** A fifth sibling in the `format:check` prose-gate chain, copied from the `check-obs-evals.ts` skeleton (ADR 052): pure `node:fs`, no build, no deps. Three scan surfaces with three grandfather mechanisms — ADR number gate (`GATE_FROM = 96`), plan-doc date-prefix gate (`2026-07-06`), and a frozen `docs/design/` filename baseline. False-positive defense is masking, not clever regexes: code fences and inline code spans are mentions (always legal); `<!-- vocab:ok -->` suppresses a line.

**Tech Stack:** TypeScript on Node's native TS runner. No new runtime dependency.

**Conventions that bind every task:** ADRs are immutable — grandfathered docs are never retrofitted; docs and code agree at the end of every commit; the checker enforces presence of the rule, never rewrites prose.

---

### Task 1: ADR 096

**Files:**

- Add: `docs/decisions/096-canonical-work-item-vocabulary.md`

- [x] **Step 1:** Write the ADR per the template (`07-conventions.md`): the tiered vocabulary table, mention-vs-use rule, gate scope + grandfathering, Phase-2 seam (five dogfood signals that would justify a real entity level), and a full Observability & Evaluation section (the checker is the eval; baseline = 0 violations).
- [x] **Step 2:** Self-compliance — every banned word in the ADR is backticked (the ADR is inside its own scan scope; dogfood).
- [x] **Step 3: Verify** — `pnpm obs-evals:check` green (096 ≥ its gate 060, so shape is enforced).

### Task 2: Authority docs

**Files:**

- Modify: `docs/architecture/07-conventions.md` (§Naming — compressed table)
- Modify: `AGENTS.md` (pointer line in "Where each doc lives")

- [x] **Step 1:** Add the vocabulary bullet under §Naming (sibling of the brand-glossary rule), banned words backticked; do not churn grandfathered prose elsewhere in the file (its DoD line stays).
- [x] **Step 2:** One pointer line in `AGENTS.md` → table in `07-conventions.md`, ruling in ADR 096, gate `pnpm vocab:check`.

### Task 3: The checker

**Files:**

- Add: `scripts/check-vocab.ts`

- [x] **Step 1:** Copy the `check-obs-evals.ts` skeleton; implement the three-surface scan, fence/inline-code masking (line numbers preserved), the four banned patterns, both escape hatches, ✗/✓ voice with `file:line`, exit 1 + trailing fix-hint.
- [x] **Step 2: Red-first verification** (no vitest harness — `scripts/` has none; sibling parity):
  - [x] Append a violation line to ADR 096 → one ✗ per banned word, correct `file:line`, exit 1.
  - [x] Backticking the same line → exit 0. `<!-- vocab:ok -->` on the line → exit 0. The words inside a code fence → exit 0.
  - [x] The two existing `2026-07-06` plan docs scan clean (no `GRANDFATHERED_PLANS` entries needed).
  - [x] Revert the scratch line; checker green.

### Task 4: Wiring

**Files:**

- Modify: `package.json` (`vocab:check` script + `format:check` chain)

- [x] **Step 1:** `"vocab:check": "node --disable-warning=ExperimentalWarning scripts/check-vocab.ts"`; append `&& pnpm vocab:check` to `format:check` — that chain is the gate (no CI workflows exist).
- [x] **Step 2: Verify the gate gates** — deliberate violation fails the full `pnpm format:check`; reverted, the full chain is green.

### Task 5: Self-host sweep

- [x] **Step 1:** Checker green over ADR 096, this plan doc, and the conventions section; success summary reports the three grandfather mechanisms and the baseline count (28 design docs).

---

**Known risks recorded:** ADR-number race (renumber filename + `GATE_FROM` together, cf. the 093→094 precedent); a renamed baseline design doc becomes "new" and gets scanned (update the frozen list); prettier prose-wrap can move `<!-- vocab:ok -->` off its line — prefer backticks as the primary hatch.
