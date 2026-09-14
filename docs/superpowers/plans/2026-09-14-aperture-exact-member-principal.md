# Aperture Exact Member Principal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task in one claimed seat. Repository policy forbids subagent-driven write work.

**Goal:** Make the read-only Aperture doctor accept only one exact Member source with the standard
`user` role, correcting the broad two-source readiness claim before generator work starts.

**Architecture:** Keep permissive Aperture response parsing and the stable doctor report schema intact.
Tighten only the pure posture analyzer, then update every fixture, help string, architecture statement,
security statement, snapshot, and Figma terminal frame that presents the corrected ready posture.

**Tech Stack:** TypeScript, Zod-owned parsed vendor types, Vitest, the existing CLI renderer, Markdown,
and the existing Figma terminal design.

**Spec:** `docs/superpowers/specs/2026-09-14-aperture-governed-model-generator-design.md`

## Global Constraints

- ADR 394 is the decision authority for this correction; do not change `ApertureConfigSchema`.
- One qualifying grant source is exactly `tag:musterd-member-<lowercase-id>`.
- Every qualifying grant contains role `user`; `admin`, `agent`, unknown, and absent roles do not pass.
- Preserve the six check keys, their order, report version 1, exit codes, redaction, and enforcement
  `off` wording.
- Do not add a runtime dependency, network call, write path, activation state, or provider mutation.
- Use Team, Member, Presence, Surface, Act, Role, Harness, Driver, Permissions, and Capability only
  with their canonical meanings.
- Follow TDD: observe each focused failure before changing production code.

---

### Task 1: Pin the corrected analyzer contract

**Files:**

- Modify: `packages/cli/src/integrations/aperture.test.ts`
- Modify: `packages/cli/src/commands/integration.test.ts`
- Modify: `packages/protocol/src/integrations.test.ts`

**Interfaces:**

- Consumes: existing `inspectApertureConfig(observation: ApertureObservation): IntegrationCheck[]`
- Produces: fixtures in which a ready grant has `src: ['tag:musterd-member-a7f3c2']` and a `user`
  role; regression cases that fail the old implementation

- [ ] **Step 1: Replace the positive reference fixtures**

In all three test files, replace the shared-plus-exact source with:

```ts
const exactSource = ['tag:musterd-member-a7f3c2'];
```

Use `role: 'user'` in every positive Aperture capability fixture. Keep the protocol parser assertion
permissive: it proves the vendor response parses, not that it is ready.

- [ ] **Step 2: Add focused identity regression cases**

Add these cases to the identity-source table in `aperture.test.ts`:

```ts
it.each([
  ['shared plus exact', ['tag:musterd-agent', 'tag:musterd-member-a7f3c2']],
  ['two exact Members', ['tag:musterd-member-a7f3c2', 'tag:musterd-member-b8e4d3']],
  ['shared only', ['tag:musterd-agent']],
])('rejects %s identity source', (_name, src) => {
  const grants = [{ ...config().grants[0], src }];
  expect(states(observation(config({ grants })))['aperture-identities']).toBe('fail');
});
```

Retain the wildcard, group, human, uppercase-ID, and malformed-source cases already present.

- [ ] **Step 3: Add focused role regression cases**

Add a table that constructs an otherwise valid exact-source grant and varies the role:

```ts
it.each([
  ['missing', undefined],
  ['legacy agent', 'agent'],
  ['admin', 'admin'],
  ['unknown', 'operator'],
])('rejects the %s Aperture role', (_name, role) => {
  const capability = {
    models: ['claude'],
    quotas: [{ bucket: 'daily:<user>' }],
    ...(role === undefined ? {} : { role }),
  };
  const grants = [
    {
      src: exactSource,
      app: { 'tailscale.com/cap/aperture': [capability] },
    },
  ];
  expect(states(observation(config({ grants })))['aperture-identities']).toBe('fail');
});
```

Add a positive case with a floating `{ role: 'user' }` capability and a separate model/quota
capability to pin the shape Increment 2 will render.

- [ ] **Step 4: Run the focused tests and observe the old behavior fail**

Run:

```bash
pnpm --filter @musterd/cli test -- src/integrations/aperture.test.ts src/commands/integration.test.ts
```

Expected: FAIL because the old helper requires two sources and accepts non-admin or absent roles.

- [ ] **Step 5: Commit the red contract**

```bash
git add packages/cli/src/integrations/aperture.test.ts packages/cli/src/commands/integration.test.ts packages/protocol/src/integrations.test.ts
git commit -m "test(cli): pin exact Aperture Member principals

Refs ADR-394

Co-authored-by: big-body <big-body@revive.musterd>"
```

### Task 2: Enforce one exact source and the user role

**Files:**

- Modify: `packages/cli/src/integrations/aperture.ts`
- Test: `packages/cli/src/integrations/aperture.test.ts`

**Interfaces:**

- Consumes: parsed `ApertureConfig` with permissive vendor-owned fields
- Produces: unchanged `inspectApertureConfig(observation): IntegrationCheck[]`, with corrected
  `aperture-identities` readiness semantics

- [ ] **Step 1: Replace the source predicate**

Replace `hasExactMemberIdentity` with the exact singleton rule:

```ts
function hasExactMemberIdentity(src: string[]): boolean {
  return src.length === 1 && /^tag:musterd-member-[a-z0-9]+$/.test(src[0] ?? '');
}
```

- [ ] **Step 2: Add the standard-role predicate**

Add a helper beside the source predicate:

```ts
function hasStandardUserRole(
  capabilities: Array<{ role?: string | undefined }>,
): boolean {
  const roles = capabilities.flatMap((capability) =>
    capability.role === undefined ? [] : [capability.role],
  );
  return roles.length > 0 && roles.every((role) => role === 'user');
}
```

- [ ] **Step 3: Tighten the identity check and its safe evidence**

Resolve each grant's Aperture capabilities once and require both predicates:

```ts
const identitiesReady =
  (config.grants?.length ?? 0) > 0 &&
  config.grants?.every((grant) => {
    const capabilities = grant.app['tailscale.com/cap/aperture'] ?? [];
    return hasExactMemberIdentity(grant.src) && hasStandardUserRole(capabilities);
  });
```

Use these strings:

```ts
ok('aperture-identities', 'one exact Member tag; standard user role')
```

```ts
fail(
  'aperture-identities',
  'grant source is broad or its role is not standard user',
  'Use one lowercase opaque tag:musterd-member-<id> source and role user.',
)
```

- [ ] **Step 4: Run the focused analyzer and command tests**

Run:

```bash
pnpm --filter @musterd/cli test -- src/integrations/aperture.test.ts src/commands/integration.test.ts
```

Expected: PASS. Temporarily change `src.length === 1` to `src.length >= 1`; the shared-plus-exact
case must fail. Restore it. Temporarily change `roles.every((role) => role === 'user')` to
`roles.every((role) => role !== 'admin')`; the legacy-agent case must fail. Restore it.

- [ ] **Step 5: Commit the analyzer correction**

```bash
git add packages/cli/src/integrations/aperture.ts
git commit -m "fix(cli): require exact Aperture Member principals

Refs ADR-394

Co-authored-by: big-body <big-body@revive.musterd>"
```

### Task 3: Align every human-facing representation

**Files:**

- Modify: `packages/cli/src/integrations/report.test.ts`
- Modify: `packages/cli/src/help/catalog.ts`
- Modify: `docs/architecture/04-cli.md`
- Modify: `docs/design/security.md`
- Modify: `docs/design/figma-brief-terminal.md`
- Modify in Figma: existing `cmd/integration-doctor` terminal frame linked from the brief

**Interfaces:**

- Consumes: the corrected success detail and repair from Task 2
- Produces: snapshots, help, architecture, security language, and terminal design that state the same
  one-source/standard-user rule

- [ ] **Step 1: Update the report fixture and exact snapshot**

In `report.test.ts`, replace the identity detail everywhere with:

```text
one exact Member tag; standard user role
```

Run:

```bash
pnpm --filter @musterd/cli test -- src/integrations/report.test.ts
```

Expected: PASS with the corrected exact no-color output.

- [ ] **Step 2: Correct CLI help**

In the `integration` catalog detail, replace `exact Member workload grants, rejecting quotas, and
non-admin identities` with `single-source Member workload grants, rejecting quotas, and standard-user
roles`.

- [ ] **Step 3: Correct architecture and security claims**

Update `docs/architecture/04-cli.md` and the Aperture paragraph in `docs/design/security.md` to cite ADR
394 and state that readiness requires one exact Member workload tag and role `user`. Remove any prose
that presents shared-plus-exact sources or merely non-admin roles as ready. Do not change enforcement
from `off`.

- [ ] **Step 4: Update the Figma terminal source of truth**

Use the repository's Figma skills before editing. In the existing `cmd/integration-doctor` frame, change
only the Aperture identity success row to:

```text
✓ identity prerequisites — one exact Member tag; standard user role
```

Keep the frame 80-column-safe and retain every other row, order, color, font, spacing, and LIMITS line.
Update `docs/design/figma-brief-terminal.md` item 14 to name the corrected ADR 394 identity wording.

- [ ] **Step 5: Run focused tests and documentation gates**

Run:

```bash
pnpm --filter @musterd/cli test -- src/integrations/aperture.test.ts src/integrations/report.test.ts src/commands/integration.test.ts
pnpm vocab:check
pnpm format:check
```

Expected: all commands PASS and the terminal snapshot matches the updated frame character-for-character.

- [ ] **Step 6: Commit aligned representations**

```bash
git add packages/cli/src/integrations/report.test.ts packages/cli/src/help/catalog.ts docs/architecture/04-cli.md docs/design/security.md docs/design/figma-brief-terminal.md
git commit -m "docs: align Aperture principal readiness wording

Refs ADR-394

Co-authored-by: big-body <big-body@revive.musterd>"
```

### Task 4: Verify and publish the correction

**Files:**

- Modify: `docs/decisions/394-aperture-grants-use-one-exact-member-principal.md` only if observed
  evidence belongs in Consequences or Observability & Evaluation
- Verify: all files changed in Tasks 1–3

**Interfaces:**

- Consumes: completed correction and aligned representations
- Produces: one reviewable correction PR whose failure tests bite the production predicates

- [ ] **Step 1: Run the repository fast gates**

Run:

```bash
pnpm typecheck && pnpm format:check
```

Expected: PASS. If `dist:check` reports stale build output, run `pnpm -r build` and rerun the same fast
gates; do not report stale declarations as a product failure.

- [ ] **Step 2: Review the complete diff for boundary drift**

Run:

```bash
git diff origin/main...HEAD -- packages/cli/src/integrations packages/cli/src/commands/integration.test.ts packages/protocol/src/integrations.test.ts packages/cli/src/help/catalog.ts docs/architecture/04-cli.md docs/design/security.md docs/design/figma-brief-terminal.md docs/decisions/394-aperture-grants-use-one-exact-member-principal.md
```

Expected: no protocol schema, report schema, network behavior, write path, activation state, or secret
output change.

- [ ] **Step 3: Push the implementation commits to draft PR #1391**

```bash
git push origin fix/adr-394-aperture-exact-member-principal
gh pr ready 1391
gh pr merge 1391 --squash --auto --delete-branch
```

Expected: required CI runs; auto-merge waits for green gates and never merges past red.

- [ ] **Step 4: Submit the landed Lane and clear the branch**

After GitHub reports the squash merge, read and pass its actual merge SHA:

```bash
aperture_merge_sha="$(gh pr view 1391 --json mergeCommit --jq '.mergeCommit.oid')"
musterd done 01M2GMVH5212TQ0W5M5PNPN1Z2 --pr 1391 --sha "$aperture_merge_sha" --authorized-by nick
git fetch origin main --prune
git switch --detach origin/main
git branch -D fix/adr-394-aperture-exact-member-principal
```

Expected: the Lane moves to `awaiting_acceptance` with merge attestation; follow the command's returned
acceptor/backstop contract. The local branch is removed only after the merge.
