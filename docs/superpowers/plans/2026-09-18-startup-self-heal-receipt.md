# Startup self-heal receipt Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ensure every installed harness startup path executes the shared workspace self-heal probe and leaves a trustworthy drift receipt, so the MCP adapter never mistakes an unprobed workspace for a clean one.

**Architecture:** Add one CLI-local, best-effort startup-probe seam that lazily invokes `runSessionProbe` with the hook-reported workspace. Call it from Codex `SessionStart`, Claude/Grok capture `SessionStart`, and Cursor’s orienting `sessionStart` hook path. Make `runSessionProbe` refresh the drift cache in a `finally` path so a probe failure still records what the CLI can inspect. Preserve the existing Claude global probe and fail-open hook contract; duplicate probes are harmless because cache inspection is idempotent.

**Tech Stack:** TypeScript, Node 22 ESM, Vitest, `@musterd/cli` onboarding/doctor code, existing `.musterd/drift.json` cache.

**Spec:** `docs/superpowers/specs/2026-09-16-workspace-self-heal-design.md`, ADR 408, and ADR 419.

## Global Constraints

- The startup hook remains best-effort, bounded, silent on ordinary failures, and always exits successfully.
- Hook-reported workspace paths are the anchor; never fall back to an ambient sibling workspace when a payload names a workspace.
- No protocol schema or runtime dependency changes.
- Every external hook payload continues through the existing parser before use.
- Docs and code stay aligned; the accepted ADR 408 decision is not rewritten.
- Work remains in this seat and on the claimed Lane; no subagent edits, claims, builds, or commits.

---

### Task 1: Add the shared startup-probe seam

**Files:**
- Create: `packages/cli/src/commands/sessionProbe.ts`
- Create: `packages/cli/src/commands/sessionProbe.test.ts`

**Interfaces:**
- Consumes: `runSessionProbe` from `packages/cli/src/onboard/doctor.ts`, plus an optional injected probe for tests.
- Produces: `runSessionStartProbe(cwd: string | undefined, probe?)`, an async best-effort helper that passes the workspace string to the injected probe, swallows probe failures, and never throws into a harness hook.

- [x] **Step 1: Write the failing test**

  Add tests that call `runSessionStartProbe('/workspace', probe)` and assert the injected probe receives `'/workspace'`, and that a rejected probe resolves without throwing.

- [x] **Step 2: Run the focused test to verify it fails**

  Run `pnpm --filter @musterd/cli exec vitest run src/commands/sessionProbe.test.ts`.
  Expected: FAIL because `sessionProbe.ts` and `runSessionStartProbe` do not yet exist.

- [x] **Step 3: Write the minimal implementation**

  Implement the injected seam and a default lazy import of `runSessionProbe`; call the default with `{ cwd }` when a workspace is present, and wrap the entire call in `try/catch`.

- [x] **Step 4: Run the focused test to verify it passes**

  Run `pnpm --filter @musterd/cli exec vitest run src/commands/sessionProbe.test.ts`.
  Expected: PASS.

### Task 2: Make Codex SessionStart run the probe

**Files:**
- Modify: `packages/cli/src/commands/codexHook.ts`
- Modify: `packages/cli/src/commands/codexHook.test.ts`

**Interfaces:**
- Consumes: `runSessionStartProbe` from Task 1 and the existing parsed Codex event.
- Produces: `CodexHookDeps.probe?`, used only by the `start` event to test and isolate the startup boundary.

- [x] **Step 1: Write the failing test**

  Extend the existing SessionStart test with a probe spy and assert it receives the event workspace before the capture completes. Add a local-binding test that invokes the real handler with an injected probe and verifies the workspace path is passed.

- [x] **Step 2: Run the focused test to verify it fails**

  Run `pnpm --filter @musterd/cli exec vitest run src/commands/codexHook.test.ts`.
  Expected: FAIL because `handleCodexHook` currently invokes capture only and has no probe dependency.

- [x] **Step 3: Write the minimal implementation**

  Add `probe?: (cwd: string | undefined) => Promise<void> | void` to `CodexHookDeps`; on a valid `start` event, invoke the shared helper with `event.cwd` before `captureStart`. Keep malformed/mismatched events silent.

- [x] **Step 4: Run the focused test to verify it passes**

  Run `pnpm --filter @musterd/cli exec vitest run src/commands/codexHook.test.ts`.
  Expected: PASS.

### Task 3: Make session-based harness startup paths run the probe

**Files:**
- Modify: `packages/cli/src/commands/session.ts`
- Modify: `packages/cli/src/commands/session.test.ts`

**Interfaces:**
- Consumes: `runSessionStartProbe` from Task 1 and the already parsed, anchored capture directory.
- Produces: optional `SessionCommandDeps.probe` injection for tests; `session start --stdin` and `session observe --stdin --orient` invoke the probe before model-facing orientation output.

- [x] **Step 1: Write the failing tests**

  Add one test for `session start --stdin` with a Grok-shaped payload and one for `session observe --stdin --orient` with a Cursor-shaped payload. Inject a probe spy and assert each receives the payload’s workspace, not the mocked process cwd.

- [x] **Step 2: Run the focused tests to verify they fail**

  Run `pnpm --filter @musterd/cli exec vitest run src/commands/session.test.ts`.
  Expected: FAIL because the command currently captures/observes without invoking a startup probe and does not accept test dependencies.

- [x] **Step 3: Write the minimal implementation**

  Thread `SessionCommandDeps` through the two command branches. For `start`, resolve the capture directory and run the probe before `captureSession`; for `observe --orient`, run it before emitting Cursor orientation. Preserve the existing stdout and fail-open semantics.

- [x] **Step 4: Run the focused tests to verify they pass**

  Run `pnpm --filter @musterd/cli exec vitest run src/commands/session.test.ts`.
  Expected: PASS.

### Task 4: Always write the drift receipt after probe attempts

**Files:**
- Modify: `packages/cli/src/onboard/doctor.ts`
- Modify: `packages/cli/src/onboard/doctor.test.ts`

**Interfaces:**
- Consumes: existing `runSessionProbe` dependency seams.
- Produces: cache refresh in a `finally` path, after any repair/report attempt and even when the repair callback throws.

- [x] **Step 1: Write the failing test**

  Add a `runSessionProbe` test whose injected `selfHeal` throws and whose injected `refreshDrift` records its call. Assert the probe returns `0` and refreshes the cache with the fetched daemon build.

- [x] **Step 2: Run the focused test to verify it fails**

  Run `pnpm --filter @musterd/cli exec vitest run src/onboard/doctor.test.ts -t "refreshes the drift cache when self-heal throws"`.
  Expected: FAIL because the current outer `try` skips the cache refresh after a thrown repair.

- [x] **Step 3: Write the minimal implementation**

  Keep repair/report output in the existing best-effort `try`, move the injected/default cache refresh into `finally`, and retain the always-zero hook exit contract.

- [x] **Step 4: Run the focused test to verify it passes**

  Run `pnpm --filter @musterd/cli exec vitest run src/onboard/doctor.test.ts -t "refreshes the drift cache when self-heal throws"`.
  Expected: PASS.

### Task 5: Record the correction and verify the complete change

**Files:**
- Create: `docs/decisions/419-startup-probe-runs-at-every-sessionstart.md`
- Modify: `docs/architecture/04-cli.md`
- Modify: `docs/superpowers/specs/2026-09-16-workspace-self-heal-design.md`

**Interfaces:**
- Consumes: the implementation and tests from Tasks 1–4.
- Produces: an accepted decision documenting that harness-specific capture/observe entry points are the runtime backstop, plus architecture/spec text that no longer claims only a particular hook string is responsible.

- [x] **Step 1: Write the ADR and doc updates**

  Record the observed Codex/Grok/Cursor gap, the shared helper decision, the `finally` receipt guarantee, the fail-open consequence, and observability/evaluation. Add the new CLI file to the architecture tree and state that each harness’s SessionStart execution path calls the shared probe.

- [x] **Step 2: Run focused and static verification**

  Run `pnpm --filter @musterd/cli test`, `pnpm --filter @musterd/mcp test`, `pnpm typecheck`, and `pnpm format:check`.

- [x] **Step 3: Inspect the diff and status**

  Run `git diff --check`, `git status --short`, and `git diff --stat`; confirm only the planned source/tests/docs plus the reservation/plan files changed, while existing managed `.grok`/`.musterd` state remains uncommitted.

- [x] **Step 4: Commit with the ADR reference and seat trailer**

  Use `cli: make every SessionStart write a self-heal receipt` and include `Refs ADR-419` plus `Co-authored-by: big-body <big-body@revive.musterd>` in the commit body.
