# Exact-Match Local Continuity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this
> plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Per this repository's
> `AGENTS.md` hard rule 8, the lane owner implements in their own seat; do not dispatch subagents.

**Goal:** Resume a wake only when the host can prove the captured transcript is the very dialogue the
wake is answering. Every other wake stays on ADR 209's portable/fresh path.

**Architecture:** The daemon may mark a wake `resume_eligible` — permission to consider resume, never
an instruction. A gitignored per-workspace continuity registry keyed by `(team, seat, thread_id)`
holds the local harness session id, transcript path, harness class, and timestamps; it never reaches
the daemon, telemetry, audit, workspace manifest, or a prompt. The host resumes only when an eligible
wake meets an exact registry binding that also passes the existing byte/age/rate/watchdog ladder.

**Tech Stack:** TypeScript, zod, better-sqlite3, Vitest. Decision:
`docs/decisions/210-exact-match-local-continuity.md`.

## Global Constraints

- **The daemon must never learn a session id, transcript path, or workspace path.** Every increment
  is reviewed against this first. The daemon's `resume_eligible` bit is derived from message rows it
  already holds; nothing flows back but the outcome enum and non-content byte/age numbers.
- **`resume_eligible` is permission, not instruction.** A host that ignores it entirely must stay
  correct — fresh is always a valid answer to any wake.
- Handoff, review, and work-order wakes remain portable/fresh. Only a directed threaded reply may be
  marked eligible. Sender text never selects eligibility.
- The registry supports **multiple bindings** per workspace. One Member is not one session (`AGENTS.md`
  hard rule 7): a seat may hold several threads across several harness sessions.
- A failed attempted resume retains the existing same-lease fresh fallback (ADR 131 §5).
- The registry ships **off by default**. No numeric bound (byte, age, rate, freshness) is retuned in
  this plan — ADR 210's Eval gate governs that, and it needs observations that do not exist yet.
- No new runtime dependency. Update architecture file trees and behavior docs in the same PR.
- Run `pnpm build` before `pnpm typecheck`. Before push: `pnpm lint` **and** `pnpm format:check` —
  they are separate gates and `format:check` does not cover import order.

## Lane coordination

**Resolved 2026-08-04 — both dependencies cleared.** `packages/cli/src/host/backends/**` was owned by
gptbot (harness residency increment 6); that work landed as ADR 216 (#621), so Task 4's backend diff
proceeded. `packages/cli/src/commands/session.ts` was released by izzo on 2026-08-03.

The recorded Codex blocker is also resolved, but not as written: it said `captureSession` hardcodes
`claude-code` and there is **no Codex hook path**, so a Codex seat could never hold a binding. ADR 216
landed a Codex backend that is its own harness authority and writes `binding.session` directly,
without a hook. The lane that named the hook gap is still open but is about Codex model/surface
attestation, not this.

**The precondition it guarded is still unmet for a sharper reason**, now recorded in ADR 210's
Consequences: `codex.ts` resumes on its slot capture unconditionally, consulting neither
`intended_delivery` nor `resume_eligible`. Inert while the switch is off; a causality violation the
moment it is flipped on. `exact_match_resume` must not be enabled until the Codex backend routes
eligible wakes through the same exact-match rung — raised to gptbot rather than patched here.

**Discovered during Task 4:** the wake order carried `resume_eligible` but no `thread_id`, and the
registry is keyed by thread — so the mark was unusable on its own. Task 4 therefore also added
`thread_id` to `WakeOrder`, sent only alongside the mark. This is the safe direction of travel: the
daemon already owns thread ids, and the invariant it must never cross is the reverse one.

---

### Task 1: The local registry contract and its privacy invariant

**Files:**

- Create: `packages/protocol/src/continuity.ts`
- Create: `packages/protocol/src/continuity.test.ts`
- Modify: `packages/protocol/src/index.ts`
- Modify: `docs/architecture/02-protocol.md` (file tree)

**Interfaces:**

```ts
export const ContinuityBindingSchema = z.object({
  thread_id: z.string().min(1).max(120),
  harness: z.string().min(1).max(40),
  session_id: z.string().min(1).max(120),
  transcript_path: z.string().optional(),
  bound_at: z.number().int(),
  captured_at: z.number().int(),
});
export const ContinuityRegistrySchema = z.object({
  version: z.literal(1),
  team: z.string(),
  seat: z.string(),
  bindings: z.array(ContinuityBindingSchema).max(64),
});
```

- Produces `matchBinding(registry, {team, seat, thread_id, harness})` — exact match on all four, no
  fuzzy or most-recent fallback. Returns the binding or `null`.
- Produces `pruneRegistry(registry, {now, transcriptExists, resolvedThreads, maxAgeMs})` — drops
  bindings whose transcript is missing, whose thread has resolved, or which exceed the age horizon.

- [ ] **Step 1: Write failing contract tests**

  Assert exact-match semantics and the privacy invariant that keeps this ADR honest:

  ```ts
  expect(
    matchBinding(reg, { team: 'revive', seat: 'stanley', thread_id: 'T1', harness: 'claude-code' }),
  ).toEqual(b1);
  // Wrong seat, wrong team, wrong harness, or unknown thread must all miss — never fall back.
  expect(matchBinding(reg, { ...exact, seat: 'izzo' })).toBeNull();
  expect(matchBinding(reg, { ...exact, thread_id: 'T-unknown' })).toBeNull();
  // The registry is never a wire type: no schema in the protocol's HTTP surface may embed it.
  expect(Object.keys(WakeOrderSchema.shape)).not.toContain('session_id');
  expect(JSON.stringify(WakeReportBodySchema.shape)).not.toMatch(/transcript_path|session_id/);
  ```

  Add a pruning case per drop reason, and one proving a live, matching binding survives all of them.

- [ ] **Step 2: Run the focused test and confirm it fails**

  ```bash
  pnpm exec vitest run packages/protocol/src/continuity.test.ts
  ```

  Expected: FAIL — the module does not exist.

- [ ] **Step 3: Implement the schemas and the two pure functions**

  Both functions stay pure and filesystem-free; `transcriptExists` is injected so the host owns all
  I/O. This is what makes the exact-match rule testable without a real transcript.

- [ ] **Step 4: Verify**

  ```bash
  pnpm build && pnpm typecheck && pnpm exec vitest run packages/protocol
  ```

- [ ] **Step 5: Commit**

  ```bash
  git commit -m "protocol: add local continuity registry contract (ADR 210)"
  ```

### Task 2: Mark eligibility on the daemon, without learning anything new

**Files:**

- Modify: `packages/protocol/src/residency.ts` (`WakeOrderSchema` gains optional `resume_eligible`)
- Modify: `packages/protocol/src/residency.test.ts`
- Modify: `packages/server/src/store/residency.ts`
- Modify: `packages/server/src/store/residency.test.ts`
- Modify: `packages/server/src/store/audit.ts`
- Modify: `docs/architecture/03-server.md`

**Interfaces:**

- `WakeCandidate` gains `thread_id?: string`, read from the message row's existing thread column —
  no new table, no new column, no new write.
- Produces `isResumeEligible(candidate, policy, now)`: true only when the candidate is a directed
  reply (`to_kind === 'member'`), carries a `thread_id`, is unanswered, and is newer than
  `policy.resume_eligible_ms`. Work-order, review, and handoff derivations are never eligible.

- [ ] **Step 1: Write failing store tests**

  Cover each of the four wake kinds, plus: a threaded reply older than the horizon (not eligible), an
  un-threaded directed reply (not eligible), and a handoff inside a live thread (not eligible — the
  derivation wins). Assert `resume_eligible` never appears on a portable order's report path, and
  that the `residency.wake_leased` audit row records the eligibility bit and nothing else new.

- [ ] **Step 2: Run and confirm failure**

  ```bash
  pnpm exec vitest run packages/server/src/store/residency.test.ts packages/protocol/src/residency.test.ts
  ```

- [ ] **Step 3: Implement**

  Add `resume_eligible_ms` to `ResidencyPolicySchema` (default 5 minutes, min 60s, max 15m) and the
  registry's master off switch `exact_match_resume: z.boolean().default(false)`. When the switch is
  off, `isResumeEligible` returns false for every candidate — the flag is checked first, so an
  un-enrolled team cannot be marked eligible by any path.

- [ ] **Step 4: Verify and commit**

  ```bash
  pnpm build && pnpm typecheck && pnpm exec vitest run packages/server packages/protocol
  git commit -m "server: mark recent threaded replies resume-eligible (ADR 210)"
  ```

### Task 3: The registry on disk, and the binds that fill it

**Files:**

- Create: `packages/cli/src/session/continuity.ts`
- Create: `packages/cli/src/session/continuity.test.ts`
- Modify: `packages/cli/src/config.ts` (registry path + 0600 write, reusing the atomic-write helper)
- Modify: `packages/cli/src/commands/send.ts` (auto-bind on a successful threaded send)
- Modify: `packages/cli/src/commands/session.ts` (`session bind --thread <id>`) — **sequenced after
  izzo's lane**
- Modify: `.gitignore`
- Modify: `docs/architecture/04-cli.md`

**Interfaces:**

- `readRegistry(workspace)` / `writeRegistry(workspace, registry)` — `.musterd/continuity.json`,
  mode 0600, gitignored beside `binding.json`, atomic temp-then-rename like `config.ts` already does.
- `bindThread(workspace, {thread_id, capture})` — upserts one binding from the current
  `binding.session` capture. Never invents a session id; a workspace with no capture is a no-op that
  says so.

- [ ] **Step 1: Write failing tests**

  Cover: a fresh registry round-trips; a second thread adds a second binding rather than replacing
  the first (multi-session isolation — the ADR names this explicitly); re-binding the same thread
  updates in place; a workspace with no capture binds nothing; the file is written 0600; and a
  registry file containing a hand-added unknown field is rejected rather than silently trusted.

  Add a test asserting `.gitignore` covers `**/.musterd/continuity.json` — the privacy claim is a
  file-layout fact, so it gets a test, not a comment.

- [ ] **Step 2: Run and confirm failure, then implement**

  ```bash
  pnpm exec vitest run packages/cli/src/session/continuity.test.ts
  ```

- [ ] **Step 3: Auto-bind on threaded send**

  A successful `send` carrying a `thread` binds the current capture to that thread. Binding failure
  is never fatal to the send — the registry is an optimization, and a send that succeeded must not
  report failure because a local cache write did.

- [ ] **Step 4: Verify and commit**

  ```bash
  pnpm build && pnpm typecheck && pnpm lint && pnpm exec vitest run packages/cli
  git commit -m "cli: local continuity registry + auto-bind on threaded send (ADR 210)"
  ```

### Task 4: Exact-match resume in the host

**Files:**

- Modify: `packages/cli/src/host/backends/claudeCode.ts` — **sequenced after gptbot's lane**
- Modify: `packages/cli/src/host/backends/claudeCode.test.ts`
- Modify: `packages/cli/src/host/loop.ts`

**Interfaces:**

- Consumes `resume_eligible` from the order and `matchBinding` from Task 1.
- The decision order is fixed and testable: **not eligible → fresh** (no registry read at all);
  eligible but no exact match → fresh, reason `missing`; exact match failing the existing
  byte/age/rate/watchdog ladder → fresh, reason from that ladder; otherwise resume.

- [ ] **Step 1: Write failing backend tests**

  One test per branch above, plus the two that protect the existing contract: an eligible exact match
  whose resume child fails to occupy still reports `fresh_fallback` via the same-lease fallback, and
  a non-eligible order never touches the registry file at all (assert the read is not called — proof
  the daemon's bit gates the local lookup, not the other way round).

- [ ] **Step 2: Implement, verify, commit**

  ```bash
  pnpm build && pnpm typecheck && pnpm lint && pnpm test
  git commit -m "cli: resume only on an exact local thread match (ADR 210)"
  ```

### Task 5: Pruning, docs, and the rollout note

**Files:**

- Modify: `packages/cli/src/session/continuity.ts` (prune on write + on `session end`)
- Modify: `docs/decisions/210-exact-match-local-continuity.md` (Consequences only)
- Modify: `docs/architecture/03-server.md`, `docs/architecture/04-cli.md`

- [ ] **Step 1: Prune on every write and on session end**

  Drop bindings for missing/expired transcripts, resolved threads, and workspace/team/seat mismatch —
  the last is the ADR 143 seat-leak posture applied to this file: a registry found under the wrong
  seat is discarded, never adopted.

- [ ] **Step 2: Record the rollout state, not a result**

  ADR 210's Consequences gets a dated note saying the registry shipped **off**, and that its Eval
  comparison is still pending because the ADR 209 fresh baseline does not exist yet. Do not write
  numbers that have not been measured.

- [ ] **Step 3: Full verification and PR**

  ```bash
  pnpm build && pnpm typecheck && pnpm lint && pnpm format:check && pnpm test
  ```

  Then the ADR 106 loop: PR, squash auto-merge, `lane_submit` after it lands.

## Plan self-review

- **Spec coverage:** Task 1 fixes the contract and its privacy invariant as executable tests. Task 2
  gives the daemon the one bit it is allowed to have. Task 3 builds the local registry and fills it
  from the two sources the ADR names (auto-bind, manual repair). Task 4 spends the bit. Task 5 prunes
  and records the rollout honestly.
- **The load-bearing risk** is the daemon learning something it must not. It is covered twice: a
  protocol-level test that no wire schema can name a session id or transcript path, and a host-level
  test that a non-eligible order never reads the registry.
- **No placeholders:** every task names files, interfaces, tests, commands, and a commit. Numeric
  defaults are fixed here; retuning them is explicitly out of scope until ADR 210's Eval gate has
  data.
- **Known sequencing debt:** Tasks 3 and 4 each end on a contended file. Both are deliberately the
  smallest diff in their task so they can wait on another seat without blocking the rest.
