# Workspace-local primer identity implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. The repository's ADR 150 execution contract forbids subagents from editing, building, claiming, or committing in this Lane.

**Goal:** Prevent committed primer content from naming a Workspace-local Member while preserving Member-specific MCP runtime orientation.

**Architecture:** Replace the shared public primer renderer with two delivery-specific functions in `@musterd/protocol`: a repository renderer that accepts only a Team and a runtime renderer that may accept a Member target. Both compose one private working-loop renderer. The CLI writes and prints only repository content; the MCP adapter emits only runtime content; Role, charter, and toolkit data enter neither startup primer.

**Tech Stack:** TypeScript, Vitest, pnpm workspace packages, Markdown architecture documentation.

**Spec:** `docs/decisions/307-primer-identity-neutral.md`

## Global Constraints

- Only `@musterd/protocol` may be imported across package boundaries.
- Do not change a Zod schema or the wire protocol; this is a TypeScript renderer API change only.
- Use the glossary terms **Team, Member, Presence, Surface, Act** exactly as defined in `docs/design/brand.md` §5.
- Do not add a runtime dependency.
- Repository primer input must not accept a Member, Role, charter, toolkit, or claim target.
- Runtime primer input may accept only `team` and optional `member`; authenticated occupancy remains authoritative.
- Role and charter come from the Team role library through authenticated occupancy, never from a toolkit or committed primer.
- Keep the managed-block markers and `upsertPrimer` migration behavior unchanged.
- Update current architecture documentation and this repository's managed `AGENTS.md` block in the same change.
- Implement every behavior through red-green-refactor; watch each new test fail for the intended reason before production edits.

---

### Task 1: Split the protocol primer API by delivery context

**Files:**
- Modify: `packages/protocol/src/primer.test.ts`
- Modify: `packages/protocol/src/guidance.test.ts`
- Modify: `packages/protocol/src/primer.ts`

**Interfaces:**
- Consumes: existing `PRIMER_START`, `PRIMER_START_PREFIX`, `PRIMER_END`, and `PRIMER_END_MARKER` constants.
- Produces: `renderRepositoryPrimer(opts: { team: string }): string` and `renderRuntimePrimer(opts: { team: string; member?: string }): string`, exported through the existing `packages/protocol/src/index.ts` wildcard.

- [ ] **Step 1: Write failing protocol tests for the two public contracts**

Replace `renderPrimer` coverage with literal, behavior-level assertions. The repository cases must prove two independently supplied bindings collapse to identical bytes and that known identity-layer fixtures do not appear:

```ts
import {
  PRIMER_END_MARKER,
  PRIMER_START_PREFIX,
  renderRepositoryPrimer,
  renderRuntimePrimer,
} from './primer.js';

describe('renderRepositoryPrimer', () => {
  it('renders byte-identical repository context for different Workspace Members', () => {
    const adaBinding = { team: 'dawn', member: 'Ada', role: 'backend' };
    const linBinding = { team: 'dawn', member: 'Lin', role: 'reviewer' };
    const ada = renderRepositoryPrimer({ team: adaBinding.team });
    const lin = renderRepositoryPrimer({ team: linBinding.team });

    expect(ada).toBe(lin);
    expect(ada).toContain('**dawn** Team');
    expect(ada).toContain('musterd whoami');
    for (const localFact of ['Ada', 'Lin', 'backend', 'own the data layer', 'supabase']) {
      expect(ada).not.toContain(localFact);
    }
  });

  it('wraps the shared working loop in managed markers', () => {
    const primer = renderRepositoryPrimer({ team: 'dawn' });
    expect(primer).toContain(PRIMER_START_PREFIX);
    expect(primer).toContain(PRIMER_END_MARKER);
    expect(primer).toContain('team_inbox_check');
    expect(primer).toContain('musterd inbox');
  });
});

describe('renderRuntimePrimer', () => {
  it('names a locally resolved Member target without a Role or charter', () => {
    const primer = renderRuntimePrimer({ team: 'dawn', member: 'Ada' });
    expect(primer).toContain('**Ada** on the **dawn** Team');
    expect(primer).not.toContain('## Your charter');
  });

  it('keeps the unresolved claim-first orientation', () => {
    const primer = renderRuntimePrimer({ team: 'alpha' });
    expect(primer).toContain('claim your seat first');
    expect(primer).not.toContain('You are **');
  });
});
```

Change the guidance kernel fixture to `renderRepositoryPrimer({ team: 'dawn' })` so its line-budget and skill-pointer assertions cover committed standing context.

- [ ] **Step 2: Run the focused protocol tests and verify RED**

Run:

```bash
pnpm --filter @musterd/protocol test -- src/primer.test.ts src/guidance.test.ts
```

Expected: FAIL because `renderRepositoryPrimer` and `renderRuntimePrimer` are not exported.

- [ ] **Step 3: Implement the minimal split renderer**

In `packages/protocol/src/primer.ts`, keep the markers unchanged, extract the current channel/loop/skill lines into a private function, and build the two public functions around distinct identity paragraphs:

```ts
type PrimerIdentity = { team: string; member?: string; repository: boolean };

function renderPrimer(identity: PrimerIdentity): string {
  const orientation = identity.repository
    ? `This repository coordinates with the **${identity.team}** Team. Your Member identity is Workspace-local: trust musterd's runtime instructions and authenticated occupancy, or run \`musterd whoami\` when the \`team_*\` tools are unavailable. If no local identity is active, repair the wiring or ask the human; never claim a named seat from repository prose.`
    : identity.member
      ? `You are **${identity.member}** on the **${identity.team}** Team.`
      : `You are a Member of the **${identity.team}** Team — **claim your seat first** (\`team_join\`, or \`musterd claim <name>\` then \`musterd status\`; a seat is claimed with the Team **agent key** — set \`MUSTERD_AGENT_KEY\` or pass \`--key mskey_…\`, and an admin approves if no grant was pre-issued) so teammates can see and reach you.`;

  return [PRIMER_START, '## Your musterd Team', '', orientation, ...renderWorkingLoop(), PRIMER_END].join('\n');
}

export function renderRepositoryPrimer(opts: { team: string }): string {
  return renderPrimer({ team: opts.team, repository: true });
}

export function renderRuntimePrimer(opts: { team: string; member?: string }): string {
  return renderPrimer({ team: opts.team, member: opts.member, repository: false });
}
```

Preserve the existing loop text in `renderWorkingLoop()`; do not add Role, charter, or toolkit parameters to either public API.

- [ ] **Step 4: Run the focused protocol tests and verify GREEN**

Run:

```bash
pnpm --filter @musterd/protocol test -- src/primer.test.ts src/guidance.test.ts
```

Expected: PASS with the repository and runtime contracts both exercised.

- [ ] **Step 5: Commit the protocol API split**

```bash
git add packages/protocol/src/primer.ts packages/protocol/src/primer.test.ts packages/protocol/src/guidance.test.ts
git commit -m "fix(protocol): split repository and runtime primers

Refs ADR-307

Co-authored-by: gptbot <gptbot@revive.musterd>"
```

---

### Task 2: Bind each consumer to its correct renderer

**Files:**
- Modify: `packages/cli/src/onboard/primer.ts`
- Modify: `packages/cli/src/onboard/onboard.test.ts`
- Modify: `packages/cli/src/onboard/init.ts`
- Modify: `packages/cli/src/onboard/init.test.ts`
- Modify: `packages/mcp/src/index.ts`
- Modify: `packages/mcp/src/mcp.test.ts`
- Modify: `scripts/context/check-budgets.ts`

**Interfaces:**
- Consumes: `renderRepositoryPrimer({ team })` and `renderRuntimePrimer({ team, member? })` from Task 1.
- Produces: CLI managed-file/manual output that contains only Team intent; MCP `primerInstructions(config)` that retains the locally resolved Member target.

- [ ] **Step 1: Write failing CLI consumer tests**

Update onboarding file-I/O fixtures to call `renderRepositoryPrimer({ team: 'dawn' })`. Add a migration assertion that begins with a poisoned managed block and verifies `upsertPrimer` replaces only that block with neutral bytes while preserving user prose:

```ts
it('migrates a Member-specific managed block to repository-neutral bytes', () => {
  const agents = join(cwd, 'AGENTS.md');
  writeFileSync(
    agents,
    '# Project rules\n\n<!-- musterd:start -->\nYou are **Stanley** on the **dawn** Team.\n<!-- musterd:end -->\n\n## Keep me\n',
  );

  upsertPrimer(cwd, renderRepositoryPrimer({ team: 'dawn' }));

  const written = readFileSync(agents, 'utf8');
  expect(written).not.toContain('Stanley');
  expect(written).toContain('musterd whoami');
  expect(written).toContain('# Project rules');
  expect(written).toContain('## Keep me');
});
```

Export `printManual` from `init.ts` for its pure output test, pass it a literal Team, and assert the returned setup note contains `renderRepositoryPrimer({ team: 'dawn' })` but none of `Ada`, `backend`, `own the data layer`, or `supabase`.

- [ ] **Step 2: Run focused CLI tests and verify RED**

Run:

```bash
pnpm --filter @musterd/cli test -- src/onboard/onboard.test.ts src/onboard/init.test.ts
```

Expected: FAIL because the CLI re-export/call sites still use `renderPrimer`, and `printManual` neither accepts a Team nor exports a repository-neutral result.

- [ ] **Step 3: Implement the minimal CLI consumer changes**

In `packages/cli/src/onboard/primer.ts`, re-export only the repository renderer:

```ts
export { renderRepositoryPrimer } from '@musterd/protocol';
```

In `init.ts`, remove the now-unneeded `teamRoleCharter` lookup from the primer path and write:

```ts
upsertPrimer(process.cwd(), renderRepositoryPrimer({ team }));
```

Change the two manual-setup calls to `printManual(chosen, entry, team)`, and change the function to:

```ts
export function printManual(
  harness: Harness,
  entry: { command: string; args: string[]; env: Record<string, string> },
  team: string,
): string {
  const primer = renderRepositoryPrimer({ team });
  // retain the existing harness-specific setup text and append primerNote
}
```

Delete `teamRoleCharter` only if `rg -n "teamRoleCharter" packages/cli/src` confirms the primer path was its sole consumer.

- [ ] **Step 4: Run focused CLI tests and verify GREEN**

Run:

```bash
pnpm --filter @musterd/cli test -- src/onboard/onboard.test.ts src/onboard/init.test.ts
```

Expected: PASS; the migration preserves prose and both normal/manual CLI surfaces are Member-neutral.

- [ ] **Step 5: Write the failing MCP consumer test**

Extend the existing `primerInstructions` test with a seat-claim target and forbidden Role/charter/toolkit literals:

```ts
const targeted = primerInstructions({
  server: base,
  team: 'dawn',
  claim: { mode: 'seat', name: 'Lin' },
});
expect(targeted).toContain('**Lin** on the **dawn** Team');
for (const forbidden of ['backend', 'own the data layer', 'supabase']) {
  expect(targeted).not.toContain(forbidden);
}
```

- [ ] **Step 6: Run the focused MCP test and verify RED**

Run:

```bash
pnpm --filter @musterd/mcp test -- src/mcp.test.ts
```

Expected: FAIL at compile/import time because `index.ts` still imports the removed `renderPrimer` API.

- [ ] **Step 7: Wire MCP instructions to the runtime renderer**

In `packages/mcp/src/index.ts`, import `renderRuntimePrimer` and return:

```ts
return renderRuntimePrimer({ team: config.team, ...(seat ? { member: seat } : {}) });
```

Update the nearby comment to state that MCP instructions are process-local and authenticated occupancy supplies the Team Role and charter.

Update `scripts/context/check-budgets.ts` to import both public renderers and set `primerBytes` to the
larger of the repository and named-runtime variants. This keeps the existing single-primer budget
conservative without adding a second budget item for two mutually exclusive delivery variants.

- [ ] **Step 8: Run the focused MCP test and verify GREEN**

Run:

```bash
pnpm --filter @musterd/mcp test -- src/mcp.test.ts
```

Expected: PASS for named, seat-targeted, and unresolved runtime variants.

- [ ] **Step 9: Commit the consumer boundary**

```bash
git add packages/cli/src/onboard/primer.ts packages/cli/src/onboard/onboard.test.ts packages/cli/src/onboard/init.ts packages/cli/src/onboard/init.test.ts packages/mcp/src/index.ts packages/mcp/src/mcp.test.ts scripts/context/check-budgets.ts docs/superpowers/plans/2026-08-24-workspace-local-primer-identity.md
git commit -m "fix: keep Member identity out of repository primers

Refs ADR-307

Co-authored-by: gptbot <gptbot@revive.musterd>"
```

---

### Task 3: Migrate musterd's primer and current documentation

**Files:**
- Modify: `AGENTS.md`
- Modify: `docs/architecture/04-cli.md`
- Modify: `docs/architecture/05-mcp.md`
- Modify: `docs/design/agent-primer.md`
- Modify: `docs/design/provisioning-recipe.md`
- Modify: `docs/decisions/307-primer-identity-neutral.md`

**Interfaces:**
- Consumes: the final repository primer text from `renderRepositoryPrimer({ team: 'revive' })` and the two consumer contracts from Tasks 1–2.
- Produces: neutral committed standing context and documentation that describes the shipped behavior without duplicating ADR rationale.

- [ ] **Step 1: Rewrite the managed block in this repository**

Build the CLI, then invoke the same production functions used by `musterd init` so the checked-in migration is not hand-copied:

```bash
pnpm --filter @musterd/protocol build
pnpm --filter @musterd/cli build
node --input-type=module -e "import { renderRepositoryPrimer } from './packages/protocol/dist/index.js'; import { upsertPrimer } from './packages/cli/dist/onboard/primer.js'; upsertPrimer(process.cwd(), renderRepositoryPrimer({ team: 'revive' }));"
```

Expected: `AGENTS.md` keeps all prose outside the managed markers and no longer contains `You are **stanley**`.

- [ ] **Step 2: Update current documentation and accept the ADR**

Make these precise documentation changes:

- `04-cli.md`: describe `renderRepositoryPrimer`, Team-only committed context, `musterd whoami`, and init's managed-block migration; remove claims that init injects Member/Role/charter.
- `05-mcp.md`: describe `renderRuntimePrimer`, locally targeted Member orientation, and Team Role/charter arrival through authenticated occupancy; remove the claim that MCP and `AGENTS.md` use identical bytes.
- `docs/design/agent-primer.md`: mark its original shared-renderer delivery decision as superseded by ADR 307 and link to the two architecture chapters instead of maintaining a second current specification.
- `docs/design/provisioning-recipe.md`: replace the stale statements that a charter is written to `AGENTS.md` with the Team role-library/occupancy path.
- `docs/decisions/307-primer-identity-neutral.md`: change `Status: proposed` to `Status: accepted` after the user-approved decision is implemented.

- [ ] **Step 3: Run the fast local gates**

Run:

```bash
pnpm typecheck && pnpm format:check
```

Expected: PASS, including architecture tree, vocabulary, ADR-number, guidance, and observability checks.

- [ ] **Step 4: Run milestone tests for touched packages**

Run:

```bash
pnpm --filter @musterd/protocol test
pnpm --filter @musterd/cli test
pnpm --filter @musterd/mcp test
```

Expected: all three suites PASS with no warning or error output attributable to this change.

- [ ] **Step 5: Perform the final mutation and boundary review**

Verify each realistic regression is caught:

- Adding `member`, `role`, or `charter` to `renderRepositoryPrimer` would require an API/test change and cannot be passed by CLI consumers.
- Returning runtime bytes from the CLI makes the repository-neutral and migration tests fail.
- Returning repository bytes from MCP makes the named/targeted MCP tests fail.
- Removing the managed-block replacement makes the poisoned-block migration test fail.
- Removing `musterd whoami` from repository orientation makes protocol and CLI consumer tests fail.

Then run:

```bash
git diff --check
git status --short
```

Expected: no whitespace errors and only the files listed by this plan are modified.

- [ ] **Step 6: Commit the migration and documentation**

```bash
git add AGENTS.md docs/architecture/04-cli.md docs/architecture/05-mcp.md docs/design/agent-primer.md docs/design/provisioning-recipe.md docs/decisions/307-primer-identity-neutral.md
git commit -m "docs: migrate primer identity to Workspace runtime

Refs ADR-307

Co-authored-by: gptbot <gptbot@revive.musterd>"
```

- [ ] **Step 7: Verify, publish, and enable automatic landing**

Use the verification-before-completion skill, then run the required pre-push gates once more against the final commit:

```bash
pnpm typecheck && pnpm format:check
git push
gh pr ready 1001
gh pr merge 1001 --squash --auto --delete-branch
```

Expected: the draft PR becomes ready and auto-merge waits for the required `gates` check; do not poll or manually merge past a red check.
