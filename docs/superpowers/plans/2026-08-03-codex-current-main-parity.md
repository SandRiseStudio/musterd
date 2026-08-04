# Codex current-main parity implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Codex CLI a second safe residency backend on current mainline, while separately verifying Codex desktop and documenting its manual-resume fallback unless a stable supported app API is proven.

**Architecture:** Reuse the existing `ActuatorBackend` and host-loop seam: Codex supplies binary/capability discovery, session identity/capture, liveness enumeration, argv construction, and a bounded child lifecycle. The host retains lease derivation, work-order policy, Presence verification, reporting, and rate accounting. Desktop stays outside the host registry unless a versioned stable-API probe passes.

**Tech Stack:** TypeScript, Node child processes/filesystem, Vitest, existing `@musterd/protocol` schemas, existing `musterd host` wake infrastructure, Codex CLI JSONL output.

## Global Constraints

- Parity means equal user-visible coordination outcomes, with harness-specific fallbacks only for a missing stable capability.
- Codex CLI and Codex desktop are separate verified surfaces.
- Preserve current work-order, wake-pool, local-session, and model-attestation behavior.
- Keep session IDs and transcript paths local; daemon telemetry never receives either.
- Parse Codex JSONL/config input at boundaries. Never infer identity from prose output.
- Production wake never passes `--dangerously-bypass-hook-trust` or any sandbox/approval bypass.
- Real Codex execution is double-gated by explicit owner variables and never runs in default CI.
- Never put agent keys, grants, raw bindings, or generated profiles/configuration into argv or assertion diagnostics.
- Add no runtime dependency. Do not amend accepted ADRs; use the next available ADR number when this plan runs.
- Preserve the user’s `.gitignore` and untracked local `.codex/` configuration.

---

### Task 1: Declare the current-main Codex parity Lane

**Files:**

- Modify: `content/roadmap.data.ts`
- Regenerate: `ROADMAP.md`
- Create: `docs/decisions/216-codex-cli-residency-backend.md`
- Test: `content/roadmap.data.test.ts`

**Interfaces:**

- Consumes: `RoadmapItem` in `content/roadmap.data.ts`; ADR 179’s second-harness seam.
- Produces: one `near-term` roadmap item and an accepted ADR defining the Codex CLI backend boundary.

- [ ] **Step 1: Add the failing roadmap-data assertion**

Add a test that loads the item whose id is `codex-current-main-parity` and requires:

```ts
expect(item).toMatchObject({
  id: 'codex-current-main-parity',
  plan: 'near-term',
  category: 'harness',
});
expect(item.detail).toContain('Codex CLI');
expect(item.detail).toContain('desktop');
```

- [ ] **Step 2: Confirm the assertion fails**

Run: `pnpm vitest run content/roadmap.data.test.ts`

Expected: FAIL because no item has that id.

- [ ] **Step 3: Add the roadmap item and regenerate the rendered roadmap**

Insert the declared item beside `harness-residency`. It must state that CLI parity is a current-main implementation using the host backend seam, and that desktop wake is manual until stable app control is proven. It must reference the new ADR and [the approved design](../specs/2026-08-03-codex-current-main-parity-design.md). Run `pnpm roadmap:gen`; do not edit generated `ROADMAP.md` by hand.

- [ ] **Step 4: Write ADR 216**

Run `pnpm adr-numbers:check` immediately before creating the file. ADR 203 is the current high-water mark, so create ADR 216; if the gate reports a collision, stop this Lane and allocate the next free number before proceeding. The ADR must establish:

```markdown
## Decision

Codex CLI is the second `ActuatorBackend`. It uses the existing host loop and reports the
same wake outcomes as Claude Code. Codex desktop is not a backend unless a versioned capability
probe proves stable session targeting, lifecycle observation, and safe wake/resume.
```

Its consequences must name: no protocol schema change, local-only session identity, production no-trust-bypass, and the three-layer verification model.

- [ ] **Step 5: Run the roadmap and documentation gates**

Run: `pnpm vitest run content/roadmap.data.test.ts && pnpm roadmap:gen && pnpm format:check`

Expected: PASS; the generated roadmap is in sync and ADR numbering is valid.

- [ ] **Step 6: Commit**

```bash
git add content/roadmap.data.ts content/roadmap.data.test.ts ROADMAP.md docs/decisions/216-codex-cli-residency-backend.md
git commit -m "docs: declare current-main Codex parity" \
  -m "Refs ADR-216" \
  -m "Co-authored-by: revive <revive@revive.musterd>"
```

### Task 2: Establish Codex CLI capability, identity, and local liveness seams

**Files:**

- Create: `packages/cli/src/codexBin.ts`
- Create: `packages/cli/src/codexBin.test.ts`
- Create: `packages/cli/src/session/codex.ts`
- Create: `packages/cli/src/session/codex.test.ts`
- Modify: `packages/cli/src/session/liveness.ts`
- Modify: `packages/cli/src/session/liveness.test.ts`
- Modify: `packages/cli/src/onboard/harnesses/codex.ts`
- Modify: `packages/cli/src/onboard/harnesses/codex.test.ts`

**Interfaces:**

- Produces `resolveCodexBin(): Promise<string | null>` with the same PATH-safe semantics as `resolveClaudeBin`.
- Produces `probeCodexCli(run): CodexCapability`, where `CodexCapability` is `{ supported: true; version: string } | { supported: false; reason: string }`.
- Produces `parseCodexThreadStarted(line): { threadId: string } | undefined` and `enumerateCodexSessions(workspace, codexHome?): SessionFile[] | undefined`.
- Extends local liveness with a harness-selected enumerator; Claude remains the default and existing callers preserve behavior.

- [ ] **Step 1: Write failing capability and JSONL parser tests**

Use injected command output, never a real model call. Cover the installed CLI’s observed surface:

```ts
expect(parseCodexThreadStarted('{"type":"thread.started","thread_id":"abc"}')).toEqual({ threadId: 'abc' });
expect(parseCodexThreadStarted('{"type":"item.completed"}')).toBeUndefined();
expect(probeCodexCli(fakeRun('codex-cli 0.146.0', execHelp, resumeHelp))).toMatchObject({ supported: true });
expect(probeCodexCli(fakeRun('codex-cli 0.146.0', missingJsonFlag, resumeHelp))).toMatchObject({ supported: false });
```

The capability probe must require `exec --json`, `exec resume`, and a session-id argument; it must return a redacted reason, never raw command output.

- [ ] **Step 2: Write failing session-enumeration/liveness fixtures**

Create a temporary `CODEX_HOME/sessions` fixture containing JSONL records with `cwd`, thread id, model, and mtime. Assert workspace attribution uses recorded `cwd` plus `findWorkspaceDir`, not a decoded directory name. Assert unreadable session storage returns `undefined`, and a parseable but unattributable record is ignored.

- [ ] **Step 3: Implement the minimal seams**

Mirror the defensive patterns in `claudeBin.ts` and `session/enumerate.ts`:

```ts
export function parseCodexThreadStarted(line: string): { threadId: string } | undefined {
  const parsed = CodexJsonlRecordSchema.safeParse(JSON.parse(line));
  return parsed.success && parsed.data.type === 'thread.started'
    ? { threadId: parsed.data.thread_id }
    : undefined;
}
```

Keep the schema local to the CLI package because it parses an external harness format. Add a harness-aware enumerator parameter to `localSessionLiveness`; preserve `enumerateClaudeSessions` as its default so Claude tests and callers stay unchanged.

- [ ] **Step 4: Add Codex onboarding capability reporting**

`codex.detect()` must distinguish installed-but-not-wake-capable from wake-capable. It may inspect `codex --version`, `codex exec --help`, and `codex exec resume --help`; it must not invoke `codex exec` itself. `init --check` and `residency on` can then name a capability failure without treating Codex configuration as evidence of safe wake.

- [ ] **Step 5: Verify hermetically**

Run: `pnpm vitest run packages/cli/src/codexBin.test.ts packages/cli/src/session/codex.test.ts packages/cli/src/session/liveness.test.ts packages/cli/src/onboard/harnesses/codex.test.ts`

Expected: PASS with no process invocation beyond injected test doubles.

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src/codexBin.ts packages/cli/src/codexBin.test.ts packages/cli/src/session/codex.ts packages/cli/src/session/codex.test.ts packages/cli/src/session/liveness.ts packages/cli/src/session/liveness.test.ts packages/cli/src/onboard/harnesses/codex.ts packages/cli/src/onboard/harnesses/codex.test.ts
git commit -m "feat(cli): probe and enumerate Codex CLI sessions" -m "Refs ADR-216" -m "Co-authored-by: revive <revive@revive.musterd>"
```

### Task 3: Add the bounded Codex CLI wake backend

**Files:**

- Create: `packages/cli/src/host/backends/codex.ts`
- Create: `packages/cli/src/host/backends/codex.test.ts`
- Modify: `packages/cli/src/commands/host.ts`
- Modify: `packages/cli/src/commands/host.test.ts`
- Modify: `packages/cli/src/commands/residency.ts`
- Modify: `packages/cli/src/commands/residency.test.ts`
- Modify: `packages/cli/src/host/loop.test.ts`

**Interfaces:**

- Produces `codexBackend(deps?: CodexDeps): ActuatorBackend` with `harness === 'codex'`.
- Produces exported pure builders `buildCodexFreshArgs()` and `buildCodexResumeArgs()` for invariant tests.
- Consumes `WakeSpec`, `BackendContext`, `wakeEnv`, `localSessionLiveness`, `enumerateCodexSessions`, and the capability result from Task 2.

- [ ] **Step 1: Write failing pure argv/environment tests**

Assert fresh uses `codex exec --json -C <workspace>`; resume uses `codex exec resume <captured-thread> --json` and does **not** invent `-C` (Codex 0.146 does not accept it). The spawned child’s `cwd` is the enrolled workspace for both paths. Both use the daemon-composed line verbatim, existing `MUSTERD_PROVENANCE=wake`, and no secret-bearing argv. Assert neither builder contains:

```ts
'--dangerously-bypass-hook-trust'
'--dangerously-bypass-approvals-and-sandbox'
'--ephemeral'
```

Use a hostile parent env containing every `MUSTERD_*` credential/identity override and Git redirect variable. Assert the spawned child receives only explicit fixture binding/provenance values plus the minimal launch allowlist; none of the hostile values survives.

- [ ] **Step 2: Write failing lifecycle tests with an injected child**

Cover exact thread capture, nonmatching resume identity, nonzero child exit, spawn error, fresh fallback after an ordinary resume miss, a clean exact resume lacking fresh wake Presence, watchdog process-group termination, and work-order bounds. For every success case assert `ctx.verifyOccupied` is the authority; JSONL output may establish thread identity but never occupancy.

- [ ] **Step 3: Implement the backend**

Reuse the structure of `claudeCodeBackend`, but keep Codex-specific logic in its own file. The two key result branches are:

```ts
if (resumed && exactThread && verified.occupied) {
  return { outcome: { occupied: true, session: 'resumed' }, settled };
}
if (resumed && exactThread && !verified.occupied && cleanExit) {
  return { outcome: { occupied: false, reason: 'clean exact resume lacks fresh wake Presence' }, settled };
}
return startFreshWithinThisLease();
```

Record a newly emitted thread id only after it parses as `thread.started`; save it in the workspace binding through the existing safe binding writer. Do not send it to the server. Ensure every spawned child is detached and receives the same watchdog/kill-grace discipline as Claude.

- [ ] **Step 4: Register and gate the backend**

Register `codexBackend()` in `hostCommand`. Before `residency on` writes a host-registry entry for `harness: 'codex'`, require the Task 2 capability probe; a configured-but-incompatible CLI may still coordinate manually but cannot advertise wakeability. Add a regression that `codex` entries route through the new backend and that unknown harnesses retain today’s loud failure.

- [ ] **Step 5: Verify backend and host integration**

Run: `pnpm vitest run packages/cli/src/host/backends/codex.test.ts packages/cli/src/commands/host.test.ts packages/cli/src/commands/residency.test.ts packages/cli/src/host/loop.test.ts`

Expected: PASS; no test launches a real Codex turn.

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src/host/backends/codex.ts packages/cli/src/host/backends/codex.test.ts packages/cli/src/commands/host.ts packages/cli/src/commands/host.test.ts packages/cli/src/commands/residency.ts packages/cli/src/commands/residency.test.ts packages/cli/src/host/loop.test.ts
git commit -m "feat(host): wake Codex CLI seats" -m "Refs ADR-216" -m "Co-authored-by: revive <revive@revive.musterd>"
```

### Task 4: Make capture, model observation, and stale-session protection Codex-aware

**Files:**

- Modify: `packages/cli/src/commands/session.ts`
- Modify: `packages/cli/src/commands/session.test.ts`
- Modify: `packages/mcp/src/sessionLiveness.ts`
- Modify: `packages/mcp/src/sessionLiveness.test.ts`
- Modify: `packages/mcp/src/binding.ts`
- Modify: `packages/mcp/src/binding.test.ts`
- Modify: `packages/cli/src/onboard/harnesses/codex.ts`

**Interfaces:**

- Extends local capture with a Codex-specific `captureCodexSession({ threadId, transcriptPath?, cwd, model? })` path.
- Preserves the existing Claude and Cursor capture APIs unchanged.

- [ ] **Step 1: Write failing capture and overwrite-race tests**

Assert Codex capture writes `{ harness: 'codex', id: threadId }` only to the matching workspace binding; preserves a newer capture; marks only the matching ended session; and leaves daemon attestation harness-only. Assert a booting MCP adapter cannot erase the Codex capture it races with.

- [ ] **Step 2: Implement a Codex-specific capture boundary**

Do not overload the Claude hook payload into an undocumented Codex hook contract. Add a named, parser-backed capture entry point called by the backend and by a vetted Codex integration only after the capability probe confirms the needed event source. Reuse `saveBinding` and the existing best-effort `attestSession` behavior.

- [ ] **Step 3: Make model observation and liveness selection honest**

Use the Task 2 session record parser to read the latest Codex model evidence. In MCP liveness, a Codex capture is local evidence only; it must not falsely keep an ended adapter online or suppress a newer session. Add cross-harness tests proving a Claude capture is never resumed as Codex and vice versa.

- [ ] **Step 4: Verify**

Run: `pnpm vitest run packages/cli/src/commands/session.test.ts packages/mcp/src/sessionLiveness.test.ts packages/mcp/src/binding.test.ts`

Expected: PASS with session ids absent from daemon request assertions.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/commands/session.ts packages/cli/src/commands/session.test.ts packages/mcp/src/sessionLiveness.ts packages/mcp/src/sessionLiveness.test.ts packages/mcp/src/binding.ts packages/mcp/src/binding.test.ts packages/cli/src/onboard/harnesses/codex.ts
git commit -m "feat(session): capture Codex CLI continuity locally" -m "Refs ADR-216" -m "Co-authored-by: revive <revive@revive.musterd>"
```

### Task 5: Add the owner-gated real Codex CLI acceptance rig

**Files:**

- Create: `scripts/harnesses/codex-cli-smoke.mjs`
- Create: `tests/codex-cli.acceptance.test.ts`
- Modify: `package.json`
- Modify: `docs/architecture/06-testing.md`

**Interfaces:**

- Produces `pnpm test:codex-cli-real`, skipped unless both `MUSTERD_REAL_CODEX=1` and `MUSTERD_REAL_CODEX_CONFIRM=1` are supplied.
- Produces a hermetic test mode that validates all spend gates, profile cleanup, isolation, command construction, and redaction without invoking `codex`.

- [ ] **Step 1: Write no-spend boundary tests first**

Assert missing either gate means no Codex child is spawned. Assert unsupported platforms fail before profile creation. Assert the generated temporary workspace is a Git repository; the child environment is allowlisted; `MUSTERD_BINDING` points only to the fixture; profile/config assertion failures redact `mskey_`, `msgr_`, `mscr_`, bearer values, and raw environment values.

- [ ] **Step 2: Implement the isolated runner**

The runner must build current CLI/MCP artifacts, create a private fixture and temporary `CODEX_HOME` profile, use a temporary musterd server, and restore every owned resource. Direct first-turn automation may use `--dangerously-bypass-hook-trust` only after exact generated hook-file verification and only behind both gates. Hosted wake invocations must not receive it.

- [ ] **Step 3: Write real acceptance assertions**

When gated, require actual Codex evidence for:

```ts
team_join({ name: 'Ada', as: 'Ada' })
team_status()
team_inbox_check()
```

Then assert directed inbox drain, exact reconnect `threadId`, duplicate-seat protection during predecessor/successor overlap, fresh successor Presence, and a host-driven resume/fresh outcome. Every completion must wait for `close`, not merely `exit`; every descendant must be owned by a watchdog path.

- [ ] **Step 4: Verify default and opt-in boundaries**

Run: `pnpm vitest run tests/codex-cli.acceptance.test.ts`

Expected: all hermetic checks pass and the paid scenario is skipped.

Owner-only follow-up command (never run by an implementation worker):

```bash
MUSTERD_REAL_CODEX=1 MUSTERD_REAL_CODEX_CONFIRM=1 pnpm test:codex-cli-real
```

- [ ] **Step 5: Commit**

```bash
git add scripts/harnesses/codex-cli-smoke.mjs tests/codex-cli.acceptance.test.ts package.json docs/architecture/06-testing.md
git commit -m "test: add gated real Codex CLI acceptance" -m "Refs ADR-216" -m "Co-authored-by: revive <revive@revive.musterd>"
```

### Task 6: Publish desktop evidence and synchronize current documentation

**Files:**

- Create: `tests/codex-desktop.md`
- Modify: `docs/design/harness-residency.md`
- Modify: `docs/architecture/04-cli.md`
- Modify: `docs/architecture/05-mcp.md`
- Modify: `docs/architecture/06-testing.md`
- Modify: `docs/implementation-plan.md`

**Interfaces:**

- Produces a versioned desktop verification matrix and current runtime/documentation contract.

- [ ] **Step 1: Write the desktop matrix**

Include exact, independently checkable steps for: trusted-project open; `/mcp` proves musterd loaded; explicit join and approval; duplicate-seat refusal; directed message appears and drains; project isolation; reload/reconnect; model/build attestation; and offline manual resume. Each row needs `expected evidence`, `pass`, and `failure interpretation` fields.

- [ ] **Step 2: Record the capability boundary**

State exactly: desktop daemon wake is unsupported until a stable supported API proves session targeting, lifecycle observation, and safe resume. Do not call a manual app reopen a wake backend.

- [ ] **Step 3: Synchronize architecture docs**

Update the CLI tree for new Codex files, document the host’s two backends, explain the direct-acceptance versus hosted-wake trust distinction, and point the flagship/testing docs at the hermetic plus owner-gated CLI evidence and separate desktop matrix.

- [ ] **Step 4: Run final gates**

Run:

```bash
pnpm -r build
pnpm typecheck
pnpm lint
pnpm test
pnpm format:check
```

Expected: all default checks green; no real Codex process is launched.

- [ ] **Step 5: Commit**

```bash
git add tests/codex-desktop.md docs/design/harness-residency.md docs/architecture/04-cli.md docs/architecture/05-mcp.md docs/architecture/06-testing.md docs/implementation-plan.md
git commit -m "docs: define Codex CLI and desktop evidence" -m "Refs ADR-216" -m "Co-authored-by: revive <revive@revive.musterd>"
```

## Final review gate

Before authorizing the owner-gated real CLI command, run a whole-branch review focused on: session identity, Presence causality, child ownership, cross-process binding writes, hostile environment isolation, credential redaction, hook-trust separation, and desktop claims. Any defect in these boundaries blocks the paid run until corrected and re-reviewed.
