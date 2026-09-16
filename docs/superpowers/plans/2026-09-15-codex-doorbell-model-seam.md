# Codex doorbell model seam implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this
> plan task by task.

**Goal:** Deliver a raised interrupt-class Act to an active Codex model at its supported
`PostToolUse` boundary, while retaining causal model observation and making hook-command drift
deterministic and visible.

**Architecture:** `codex-hook post-tool-use` will first persist its local model observation, then
reuse the existing lease-authenticated hook interrupt reader and render Codex's structured
`hookSpecificOutput.additionalContext` response only when the daemon raises a line. A single desired
hook-spec source will render command text with the feature epoch and drive both reconciliation and
doctor comparison.

**Tech stack:** TypeScript, Vitest, Zod, Node filesystem APIs, `@musterd/protocol` feature epoch.

**Spec:** `docs/superpowers/specs/2026-09-15-codex-doorbell-model-seam-design.md`

**Decision record:** ADR 397 (`docs/decisions/397-codex-doorbell-model-seam.md`)

## Constraints

- Do not add a Stop hook, idle prompt, peer injection, wake behavior, dependency, protocol schema,
  endpoint, authentication, or permission change.
- Preserve fail-open hook behavior: malformed input, quiet responses, missing local state, and read
  failures emit no output and complete successfully.
- Only handlers carrying the musterd Codex marker may be replaced or removed. Preserve every
  user-owned hook group and handler byte-for-byte.
- A higher installed epoch is evidence that this checkout is behind; doctor must not prescribe a
  downgrade. A missing, lower, duplicate, or text-different owned handler is repairable drift.

### Task 1: Add a testable Codex PostToolUse delivery seam

**Files:**
- Modify: `packages/cli/src/commands/codexHook.ts`
- Modify: `packages/cli/src/commands/codexHook.test.ts`
- Modify: `packages/cli/src/commands/session.ts`
- Modify: `packages/cli/src/commands/session.test.ts`

1. Write failing tests that prove a valid `post-tool-use` event:
   - preserves the model-observation callback;
   - returns exactly one JSON line when an injected interrupt reader raises `"Ada: please review"`;
   - returns no line for quiet and failed readers; and
   - does not invoke the reader for `start`, `end`, malformed, or mismatched events.
2. Run the focused test file and confirm the delivery assertions are red:

   ```bash
   pnpm --filter @musterd/cli test -- src/commands/codexHook.test.ts
   ```

3. Refactor the cursor-named reader in `session.ts` to a surface-neutral exported helper without
   changing its lease, model attestation, mute, or fail-open behavior. Keep the Cursor formatter
   specific to Cursor's wire shape.
4. In `codexHook.ts`, make the `post-tool-use` branch observe first and then call the shared reader
   for the resolved bound workspace. Render a raised line exactly as:

   ```ts
   JSON.stringify({
     hookSpecificOutput: {
       hookEventName: 'PostToolUse',
       additionalContext: line,
     },
   })
   ```

   Have `codexHookCommand` write that returned string plus one newline only when it is non-null.
   Keep `SessionStart` orientation output as its existing direct side effect.
5. Re-run the focused tests and the existing session-reader tests:

   ```bash
   pnpm --filter @musterd/cli test -- src/commands/codexHook.test.ts src/commands/session.test.ts
   ```

6. Commit the completed task with `Refs ADR-397` and the workspace-seat trailer.

### Task 2: Make Codex hook rendering, reconciliation, and doctor comparison exact

**Files:**
- Modify: `packages/cli/src/onboard/harnesses/codexHooks.ts`
- Modify: `packages/cli/src/onboard/harnesses/codexHooks.test.ts`
- Modify: `packages/protocol/src/feature-epoch.ts`
- Modify: `packages/protocol/src/acts.test.ts`

1. Write failing fixtures for all of these cases:
   - a marker-owned command with altered text is stale even if it names the right subcommand;
   - duplicate marker-owned handlers are stale;
   - reconciliation replaces only stale marker-owned handlers and retains a user handler unchanged;
   - an older marker epoch receives refresh guidance;
   - a newer marker epoch says this checkout is behind and does not prescribe a hook refresh; and
   - common-dir inspection applies the same exact comparison.
2. Run focused tests and confirm the new assertions fail:

   ```bash
   pnpm --filter @musterd/cli test -- src/onboard/harnesses/codexHooks.test.ts
   pnpm --filter @musterd/protocol test -- src/acts.test.ts
   ```

3. Bump `FEATURE_EPOCH` from 19 to 20 and append its reason: Codex marker-owned hooks now deliver
   the supported PostToolUse context seam, so an old checkout must not rewrite the new command set.
4. Replace the scattered desired-hook logic with one typed specification that renders every exact
   event/type/command tuple, including `# musterd-codex-hook:v2 e20`.
5. Make health require exactly one marker-owned tuple for every desired event and no extra
   marker-owned handlers. On repair, remove marker-owned handlers across the file, preserve all
   remaining groups, then add the desired tuples. Use this same predicate for workspace and
   git-common-dir doctor checks.
6. Parse marker epochs from owned commands. For an observed epoch above `FEATURE_EPOCH`, return
   explicit checkout-behind guidance; otherwise return repairable drift guidance that identifies the
   expected supported configuration.
7. Re-run focused tests:

   ```bash
   pnpm --filter @musterd/cli test -- src/onboard/harnesses/codexHooks.test.ts
   pnpm --filter @musterd/protocol test -- src/acts.test.ts
   ```

8. Commit the completed task with `Refs ADR-397` and the workspace-seat trailer.

### Task 3: Align the operating documentation and verify the integrated change

**Files:**
- Modify: `docs/architecture/04-cli.md`
- Modify: `docs/design/daemon-doorbell-contract.md`
- Modify: `docs/wiki/codex-live-doorbell-eval.md`
- Modify: `docs/decisions/397-codex-doorbell-model-seam.md` (Consequences only, if evidence needs
  recording)

1. Change the CLI architecture entry to describe the causal model write followed by the supported
   PostToolUse context response and exact epoch-aware doctor comparison.
2. Change the doorbell contract's Codex clause-1 row from implementation failure to implemented,
   with a clear distinction between unit proof and unavailable live callability evidence. Leave
   clause 8 as unavailable/unmeasured unless a newly authorized, reproducible run proves otherwise.
3. Update the live-evaluation wiki with the implementation state and the exact remaining live
   evidence gap; do not infer tool callability, deferral, or reconnect behavior from registration.
4. Run the directly affected tests, the repository fast gates, and the full required verification:

   ```bash
   pnpm --filter @musterd/protocol test
   pnpm --filter @musterd/cli test
   pnpm typecheck
   pnpm format:check
   ```

5. Commit documentation and integration changes with `Refs ADR-397` and the workspace-seat trailer;
   push the draft PR branch, then inspect its diff before requesting outcome acceptance.
