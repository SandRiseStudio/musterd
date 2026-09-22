# Bootstrap Migration Expiry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this
> plan task-by-task. Write work remains in the claimed musterd seat; do not delegate edits, builds,
> claims, or commits to subagents.

**Goal:** Make every newly migrated seat-scoped bootstrap credential expire 90 days after creation.

**Architecture:** Keep the wire contract unchanged and establish the lifetime invariant in the
server store, where migration credentials are constructed. Pin both first migration and safe retry
with deterministic store tests, then reconcile the server/CLI architecture and operations runbook.

**Tech Stack:** TypeScript, better-sqlite3, Vitest, pnpm.

**Spec:** `docs/decisions/440-bootstrap-migration-credentials-expire.md`

## Global Constraints

- Do not change an `@musterd/protocol` schema.
- Never print, log, audit, or commit plaintext credentials or hashes.
- Use the server's `now` value as the sole expiry clock.
- Preserve the rule that only an unused migration successor may be replaced.
- Add no runtime dependency.
- Keep CLI output byte-compatible with the terminal brief.
- Follow red-green-refactor and include `Refs ADR-440` in the implementation commit.

## Review Focus

- A first migration at a fixed time expires exactly 90 days later.
- A retry refreshes the replacement's lifetime from the retry time.
- A used successor remains non-replaceable.
- Cutover readiness still rejects expired successors through its existing predicate.
- Migration output remains redacted and exposes only the existing expiry metadata.

---

### Task 1: Establish the migration lifetime invariant

**Files:**
- Modify: `packages/server/src/store/store.test.ts`
- Modify: `packages/server/src/store/teams.ts`

**Interfaces:**
- Produces: `MIGRATED_BOOTSTRAP_TTL_MS = 90 * 24 * 60 * 60 * 1000`
- Preserves: `migrateLegacyBootstrapCredential(db, { legacyKey, seatCredential, now? })`

- [ ] **Step 1: Write the failing first-migration assertion**

Add a fixed `now` to the existing ADR 350 migration test and assert:

```ts
expect(migrated.credential.expires_at).toBe(now + 90 * 24 * 60 * 60 * 1000);
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
pnpm --filter @musterd/server exec vitest run src/store/store.test.ts -t "migrates a legacy key"
```

Expected: FAIL because the received expiry is `null`.

- [ ] **Step 3: Implement the minimal server-side lifetime**

Define the named 90-day millisecond constant beside the bootstrap credential store logic and set
the migration-created credential's `expires_at` to `now + MIGRATED_BOOTSTRAP_TTL_MS`.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run the Step 2 command. Expected: PASS.

- [ ] **Step 5: Pin retry lifetime and existing safety behavior**

Extend the retry test to migrate at two fixed times and assert the replacement expiry is based on
the second time. Keep the existing assertion that a used successor rejects another migration.

- [ ] **Step 6: Run the store suite**

Run:

```bash
pnpm --filter @musterd/server exec vitest run src/store/store.test.ts
```

Expected: PASS.

### Task 2: Reconcile documentation and verify

**Files:**
- Modify: `docs/architecture/03-server.md`
- Modify: `docs/architecture/04-cli.md`
- Modify: `docs/operations/legacy-bootstrap-cutover.md`

**Interfaces:**
- Documents the unchanged migration request and the new server-selected 90-day deadline.

- [ ] **Step 1: Update the implementation-facing docs**

State that Workspace migration successors receive a server-selected 90-day expiry, retries refresh
that deadline only while the prior successor remains unused, and the response/inventory expose the
redacted timestamp.

- [ ] **Step 2: Run focused package verification**

Run:

```bash
pnpm --filter @musterd/server test
```

Expected: PASS.

- [ ] **Step 3: Run the repository fast gates**

Run:

```bash
pnpm typecheck && pnpm lint && pnpm format:check
```

Expected: PASS.

- [ ] **Step 4: Commit and publish**

Commit the ADR, plan, code, tests, and docs together with the seat trailer and `Refs ADR-440`, push,
mark the draft ready, and arm squash auto-merge after the required CI gate is queued.
