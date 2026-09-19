# Governed Launcher Adapter Handoff Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the first local Claude Code and Codex governed-launch handoff adapters without activating required enforcement or mutating Tailscale, Aperture, or provider state.

**Architecture:** The existing server-owned `msla_` authorization remains the source of truth. The CLI adds typed HTTP methods for the governed policy/launch routes and a pure adapter that turns a validated one-shot launch mint into a process plan: harness command, exact model arguments, an explicit MCP Surface marker, the Aperture endpoint, and an allow-listed child environment with no direct provider credential variables. The adapter does not issue, consume, cache, log, or apply credentials; the later live bridge/MCP correlation work remains outside this increment.

**Tech Stack:** TypeScript, Zod schemas from `@musterd/protocol`, global `fetch`, Vitest, existing CLI `HttpClient` and integration-module conventions.

**Spec:** `docs/superpowers/specs/2026-09-02-tailscale-aperture-paved-road-design.md` §§6–10, 11 Increment 3, and 13; decision record reserved as ADR 425.

## Global Constraints

- Governed enforcement remains `off` by default; this slice must not wire an `off`→`required` cutover.
- The server remains authoritative for Member, node, launch, work-context, and model-policy decisions; the CLI must not read workspace files to authorize a request.
- Direct provider credentials, node credentials, launch tokens, prompt/response bodies, and hook secrets must not appear in logs, Acts, audit details, or tracked generated files.
- All HTTP response bodies and launch mints are validated with existing `@musterd/protocol` Zod schemas at the boundary.
- The adapter supports exactly `claude-code` and `codex`; another Surface needs its own adapter test and decision.
- No new runtime dependency, external control-plane mutation, provider request, or live Tailscale/Aperture test is in scope.
- The implementation stays out of Stanley’s `packages/cli/src/host/backends/claudeCode.ts` and `packages/cli/src/commands/residency.ts` overlap unless a tested interface requires a separately coordinated change.

## Review Focus

- A malformed or floating model must be rejected by the existing governed mint schema before a process plan is built; Task 1 pins the parsed response path.
- A URL containing credentials, a non-HTTPS remote URL, or an invalid loopback URL must be rejected before environment construction; Task 2 pins all three.
- An inherited provider credential must not survive the child environment, while safe runtime paths and the exact Aperture endpoint remain; Task 2 pins the allow-list.
- Claude Code and Codex must receive different, documented endpoint variables and Surface markers, with no unsupported harness accepted; Task 2 pins the matrix.
- An older daemon or malformed response must fail with a schema error instead of returning an unvalidated shape; Task 1 pins the client methods.

## File Map

- Create `packages/cli/src/integrations/governed-launch.ts` — pure URL validation, environment sanitization, and Claude/Codex process-plan builders.
- Create `packages/cli/src/integrations/governed-launch.test.ts` — failing-first adapter matrix, secret stripping, URL refusal, and stable plan tests.
- Modify `packages/cli/src/client.ts` — parsed governed policy read/write, launch issue, and launch revoke methods over the existing wire routes.
- Modify `packages/cli/src/client.test.ts` or a focused client test beside the existing client suites — malformed response and request-shape tests for the new methods.
- Modify `packages/cli/src/args.ts` and `packages/cli/src/help/catalog.ts` only if a public command is added; this slice intentionally keeps the handoff API pure and does not add a CLI command.
- Modify `docs/architecture/04-cli.md` — describe the new adapter module and its non-mutating boundary.
- Modify `docs/superpowers/specs/2026-09-02-tailscale-aperture-paved-road-design.md` — record the new partial Increment 3 state without claiming live acceptance.
- Modify `docs/implementation-plan.md` — update the current-state snapshot and leave the complete §13 acceptance open.
- Create `docs/decisions/425-governed-launcher-adapter-handoff.md` — record why this handoff slice stops before live launch/consumption.

### Task 1: Wire the governed HTTP client surface

**Files:**
- Modify: `packages/cli/src/client.ts` near the existing policy and node methods.
- Test: `packages/cli/src/client.governed.test.ts`.

**Interfaces:**
- Consumes: `GovernedPolicySchema`, `GovernedPolicyResponseSchema`, `GovernedPolicyReadResponseSchema`, `GovernedLaunchAuthorizationIssueSchema`, and `GovernedLaunchAuthorizationMintSchema` from `@musterd/protocol`.
- Produces: `getGovernedPolicy(slug)`, `setGovernedPolicy(slug, policy)`, `issueGovernedLaunch(slug, body)`, and `revokeGovernedLaunch(slug, launchId)` on `HttpClient`.

- [ ] **Step 1: Write the failing tests.** Assert that policy read/write and launch issue call the exact governed paths, that the launch body is passed unchanged to the server request seam, that a mint response is parsed as `GovernedLaunchAuthorizationMint`, and that a malformed response throws a protocol-schema `CliError`.
- [ ] **Step 2: Run the focused client test to verify it fails.** Run `pnpm --filter @musterd/cli exec vitest run src/client.governed.test.ts`; expected failure is missing methods or missing response validation.
- [ ] **Step 3: Implement the minimal methods.** Use the existing private `request` helper, parse every returned body with the corresponding protocol schema, and keep revoke’s `{ ok: boolean }` response narrow. Do not print or include the plaintext launch token in errors.
- [ ] **Step 4: Re-run the focused client test.** Run the same command; expected result is PASS.

### Task 2: Build the Claude Code and Codex handoff adapters

**Files:**
- Create: `packages/cli/src/integrations/governed-launch.ts`.
- Test: `packages/cli/src/integrations/governed-launch.test.ts`.

**Interfaces:**
- Consumes: a validated `GovernedLaunchAuthorizationMint`, explicit `server`, `team`, `agentKey`, `apertureBaseUrl`, `model`, `workspace`, and a small base `ProcessEnv`.
- Produces: `buildGovernedLaunchPlan(input): GovernedLaunchPlan`, where `command` is `claude` or `codex`, `args` are harness-specific, and `env` is the sanitized child environment.

- [ ] **Step 1: Write the failing adapter matrix.** Cover Claude Code (`ANTHROPIC_BASE_URL`, `MUSTERD_LAUNCH_SURFACE=claude-code`, `claude --model …`), Codex (`OPENAI_BASE_URL`, `MUSTERD_LAUNCH_SURFACE=codex`, `codex exec --json --model … -C …`), provider-key stripping, safe runtime-variable retention, exact governed handoff variables, URL rejection, and unsupported Surface rejection.
- [ ] **Step 2: Run the focused adapter test to verify it fails.** Run `pnpm --filter @musterd/cli exec vitest run src/integrations/governed-launch.test.ts`; expected failure is the missing module/export.
- [ ] **Step 3: Implement the minimal pure builder.** Validate the mint with `GovernedLaunchAuthorizationMintSchema`; validate the endpoint as HTTPS unless it is loopback; copy only the safe runtime allow-list (`HOME`, `PATH`, `TMPDIR`, locale/terminal values, and harness config-home paths); set the exact `MUSTERD_*` identity and one-shot handoff values; set only the harness-specific Aperture base URL; and never log, persist, or redact-and-reprint secrets inside the builder.
- [ ] **Step 4: Re-run the focused adapter test.** Run the same command; expected result is PASS with deterministic plan bytes for both supported Surfaces.

### Task 3: Update implementation-facing documentation and decision record

**Files:**
- Create: `docs/decisions/425-governed-launcher-adapter-handoff.md`.
- Modify: `docs/architecture/04-cli.md`.
- Modify: `docs/superpowers/specs/2026-09-02-tailscale-aperture-paved-road-design.md`.
- Modify: `docs/implementation-plan.md`.

**Interfaces:**
- Consumes: the implementation in Tasks 1–2 and the approved paved-road design.
- Produces: a synchronized record that calls this a partial handoff/preflight slice, not a live governed-launch acceptance.

- [ ] **Step 1: Write ADR 425 with Context, Problem, Decision, Consequences, and Observability & Evaluation.** State that the adapter builds an ephemeral process plan only; it does not activate policy, consume a launch, launch a provider request, apply external configuration, or claim a complete §13 result.
- [ ] **Step 2: Update the CLI architecture tree and paved-road status.** Add the new source file with its one-job description and state that Increment 3 now includes the typed client/adapter handoff while live bridge/MCP/provider/cost execution remains open.
- [ ] **Step 3: Rewrite the current implementation snapshot.** Keep the status derivable and concise; link ADR 425 rather than duplicating its rationale.
- [ ] **Step 4: Run `pnpm vocab:check` and `pnpm format:check`.** Expected result is PASS with no architecture-tree or canonical-vocabulary drift.

### Task 4: Package verification and handoff

**Files:**
- Modify: none beyond Tasks 1–3.

- [ ] **Step 1: Run the protocol gate.** Run `pnpm --filter @musterd/protocol test` because the adapter consumes protocol contracts even though it adds no schema.
- [ ] **Step 2: Run the CLI gate.** Run `pnpm --filter @musterd/cli test` and confirm the existing integration/help suites remain green.
- [ ] **Step 3: Run the required fast gates.** Run `pnpm typecheck && pnpm format:check`, then `pnpm -r build` if the local change requires a generated dist verification.
- [ ] **Step 4: Inspect the diff for secrets and scope.** Run `git diff --check` and a targeted search for `msla_`, `msnode_`, `mskey_`, `ANTHROPIC_API_KEY`, and `OPENAI_API_KEY` in tracked output; only tests/fixtures and code-level variable names may contain them, never generated artifacts or logs.
- [ ] **Step 5: Commit the implementation with the seat trailer.** Use a focused commit message ending with `Co-authored-by: big-body (musterd seat) <big-body@revive.musterd>` and `Refs ADR-425`.

