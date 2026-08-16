# Codex Supported-Parity Evidence Implementation Plan

> **For agentic workers:** Use `superpowers:executing-plans` task-by-task. Do not dispatch subagents: repository policy keeps writes in the lane-owning seat.

**Goal:** Prove Codex CLI and desktop coordination outcomes that the products actually support.

**Architecture:** Repair the isolated, owner-gated Codex CLI acceptance so it proves a current fixed-seat claim and daemon-observed Presence. Record desktop evidence in a versioned manual matrix; desktop daemon wake/resume remains unsupported.

**Tech Stack:** TypeScript, Vitest, `@musterd/protocol`, in-process server, Codex CLI JSONL, Codex desktop MCP.

## Global Constraints

- No protocol changes or runtime dependencies.
- Paid CLI execution remains gated by `MUSTERD_REAL_CODEX=1` and `MUSTERD_REAL_CODEX_CONFIRM=1`.
- Parse local binding with `BindingSchema`; derive fixed seats with `bindingSeat()`.
- Keep fixture daemon, workspace, and credentials isolated; never log secrets.
- Do not claim desktop daemon wake/resume without a supported API proving task target, lifecycle observation, and safe resume.

---

### Task 1: Repair the real Codex CLI join proof

**Files:**

- Modify: `tests/codex-cli.acceptance.test.ts`
- Test: `tests/codex-cli.acceptance.test.ts`

**Consumes:** The isolated fixture's `claim: { mode: 'seat', name: 'Ada' }` and roster endpoint.

**Produces:** A real acceptance proof for binding policy, `codex` Presence, inbox drain, and exact thread resume.

- [ ] **Step 1: Write the failing contract assertion**

Replace the removed `binding.member` assertion with:

```ts
const binding = BindingSchema.parse(JSON.parse(readFileSync(bindingPath, 'utf8')));
expect(binding.claim).toEqual({ mode: 'seat', name: 'Ada' });
expect(bindingSeat(binding)).toBe('Ada');
```

- [ ] **Step 2: Add the daemon Presence assertion**

After the first Codex turn and before the unread-inbox read, query the fixture roster as Ada and assert an online `Ada` Member has a Presence whose Surface is `codex`. Use the existing typed response shape; no ambient machine binding reads.

- [ ] **Step 3: Verify gate-closed behavior**

Run `pnpm test:codex-cli-real`. Expect the two hermetic checks to pass and the paid turn to skip.

- [ ] **Step 4: Verify the approved real run**

Run `MUSTERD_REAL_CODEX=1 MUSTERD_REAL_CODEX_CONFIRM=1 pnpm test:codex-cli-real`. Expect all three tests to pass: join, inbox drain, and same-thread resume.

- [ ] **Step 5: Commit**

```bash
git add tests/codex-cli.acceptance.test.ts
git commit -m "test: prove real Codex CLI join against current binding" -m "Co-authored-by: gptbot <gptbot@revive.musterd>"
```

### Task 2: Record supported Codex desktop parity

**Files:**

- Modify: `tests/codex-desktop.md`
- Modify if needed: `docs/architecture/06-testing.md`

**Consumes:** A trusted desktop project, its project-local MCP entry, the assigned Member, and a second Surface.

**Produces:** Dated, versioned evidence for every supported desktop coordination outcome.

- [ ] **Step 1: Record actual run metadata**

Record date, desktop version, operator, Team, workspace, daemon build, and adapter build before marking a result.

- [ ] **Step 2: Verify desktop attachment and identity**

In the trusted project, verify `/mcp`, explicit join, claim behavior, and `team_status` Presence/model/build state. A pass requires the expected `codex` Presence and no untracked Member.

- [ ] **Step 3: Verify coordination and supersession**

Send a directed Act from a second Surface. Record one delivery and a subsequent empty inbox read. Reload a second desktop session using the same seat and record newest-wins rather than parallel autonomous Presences.

- [ ] **Step 4: Verify isolation and manual reopen**

Verify an unrelated unbound project does not inherit identity. Close desktop, send an Act, reopen manually, and record durable delivery. Mark daemon wake/resume `unsupported`, not pass.

- [ ] **Step 5: Commit the evidence**

```bash
git add tests/codex-desktop.md docs/architecture/06-testing.md
git commit -m "docs: record supported Codex desktop parity evidence" -m "Co-authored-by: gptbot <gptbot@revive.musterd>"
```

### Task 3: Publish and close

- [ ] **Step 1: Run fast local gates**

Run `pnpm typecheck && pnpm format:check` and require both to pass.

- [ ] **Step 2: Publish the branch**

Push `fix/codex-parity-evidence`, open a squash-auto-merge PR, and let CI run the full gates.

- [ ] **Step 3: Submit outcome acceptance**

After merge, submit lane `01M040DH9X52BJP0VXNZ7CQR6K` with the PR, merge SHA, branch, and authorizing human. A counterpart accepts the landed outcome.

## Plan self-review

- Task 1 covers the stale CLI assertion and all real CLI acceptance outcomes.
- Task 2 covers supported desktop coordination while preserving the desktop wake boundary.
- Task 3 follows the repository landing and acceptance workflow.
