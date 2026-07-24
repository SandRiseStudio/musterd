# Worktree-family MCP entry (ADR 159) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the repo-root-shared Claude Code MCP entry seat-agnostic, so a seat can no longer present a sibling worktree's credential at claim time.

**Architecture:** `buildMcpEnv` stops materializing `MUSTERD_SERVER`, `MUSTERD_TEAM`, `MUSTERD_AGENT_KEY`, `MUSTERD_GRANT` and `MUSTERD_SURFACE`; all five already have a `binding.json` → `workspace.json` fallback in the adapter, so no adapter change is needed. The doctor then treats a baked secret as drift **on presence** rather than on mismatch, and points at `musterd wire` — a headless repair that fixes the whole worktree family in one run.

**Tech Stack:** TypeScript (ESM, Node 22), pnpm workspaces, vitest.

**Spec:** `docs/superpowers/specs/2026-07-24-worktree-family-mcp-entry-design.md`

## Global Constraints

- Run every command from the **repo root** (`/Users/nick/agents-izzo`). Vitest is configured at the root; running it from a package directory silently picks up the wrong config.
- Branch is `feat/worktree-family-mcp-entry`, already created off `main` at `fdb617e`. Do not branch again.
- Never run `pnpm format` (rewrites the whole tree). Format only your own files: `pnpm exec prettier --write <paths>`.
- `pnpm lint` is a **separate gate** from `pnpm format:check` — run both before pushing.
- `ROADMAP.md` is never prettier-formatted and is always edited last.
- Every ADR ≥ 060 requires an `## Observability & Evaluation` section, enforced by a doc gate.
- ADR numbers are gated by `pnpm adr-numbers:check` for both uniqueness and H1-matches-filename. **Re-check `origin/main` for the highest ADR number immediately before Task 6** — 159 was free at `fdb617e` but parallel branches have collided twice.
- The five env names being removed remain **supported manual overrides**. Do not remove any adapter-side read of them. This change stops _materializing_ them, nothing else.

---

## File Structure

| File                                                         | Change                         | Responsibility                                                                                                                      |
| ------------------------------------------------------------ | ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| `packages/cli/src/onboard/mcpEntry.ts`                       | Modify                         | `buildMcpEnv` returns `{}`; its doc-comment becomes the single written record of the shared-slot invariant                          |
| `packages/cli/src/commands/agent.ts`                         | Modify (~line 175)             | Drop `MUSTERD_SURFACE` from the entry                                                                                               |
| `packages/cli/src/onboard/harness.ts`                        | Modify (~line 30)              | Add `registeredAgentKey?: string` to `DetectResult`                                                                                 |
| `packages/cli/src/onboard/harnesses/claudeCode.ts`           | Modify (~lines 456, 499)       | Read back `MUSTERD_AGENT_KEY`; correct the false "this folder only" scope string                                                    |
| `packages/cli/src/onboard/doctor.ts`                         | Modify (~lines 46-56, 200-224) | Presence-based secret check; `wire` remedies; `repair` field on the report                                                          |
| `packages/cli/src/onboard/entryGuard.ts`                     | Modify                         | Delete `assertEntryIdentity`, `EntryIdentityError`, `EntryIdentityOpts`; keep `isInside`, `foreignAdapterNote`, `siblingWorkspaces` |
| `packages/cli/src/commands/init.ts`                          | Modify (~lines 17-27)          | `--fix` routes entry-only drift to `wireCommand`, not `runInit`                                                                     |
| `packages/cli/src/onboard/onboard.test.ts`                   | Modify                         | Assert the empty env                                                                                                                |
| `packages/cli/src/onboard/doctor.test.ts`                    | Modify                         | Invert the matching-grant assertion; cover agent-key and remedy text                                                                |
| `packages/cli/src/onboard/entryGuard.test.ts`                | Modify                         | Delete the `assertEntryIdentity` describe block                                                                                     |
| `packages/cli/src/onboard/sharedEntry.test.ts`               | **Create**                     | The family regression: two sibling worktrees produce byte-identical entries                                                         |
| `packages/mcp/src/config.test.ts`                            | Modify                         | Pin the binding-only resolution the strip depends on                                                                                |
| `docs/decisions/159-*.md`                                    | **Create**                     | ADR                                                                                                                                 |
| `docs/architecture/05-mcp.md`, `docs/architecture/04-cli.md` | Modify                         | Document the invariant + the `wire` repair                                                                                          |
| `packages/web/src/content/roadmap.data.ts`, `ROADMAP.md`     | Modify                         | Roadmap entry                                                                                                                       |

---

### Task 1: Strip per-seat state from the entry

**Files:**

- Modify: `packages/cli/src/onboard/mcpEntry.ts:46-54`
- Modify: `packages/cli/src/commands/agent.ts:171-179`
- Test: `packages/cli/src/onboard/onboard.test.ts:20-53`

**Interfaces:**

- Consumes: nothing from earlier tasks.
- Produces: `buildMcpEnv(b: AgentBinding): Record<string, string>` — unchanged signature, now always returns `{}`. `buildEntry(b: AgentBinding): McpServerEntry` — unchanged signature, `env` is now always `{}`.

- [ ] **Step 1: Rewrite the two failing assertions**

In `packages/cli/src/onboard/onboard.test.ts`, replace the `it('builds the v0.3 claim-binding env …')` block at lines 21-31 with:

```ts
it('emits NO per-seat state — the entry is shared by every worktree of the repo (ADR 159)', () => {
  // Claude Code keys local-scope MCP config by REPO ROOT, so all `agents-*` seat worktrees share
  // ONE entry. Anything per-seat in it is a single global slot the next provisioning run overwrites
  // — and `MUSTERD_GRANT`/`MUSTERD_AGENT_KEY` are *credentials*, which the adapter ranks ABOVE
  // binding.json, so the loser presents a sibling's secret at claim time. The adapter resolves all
  // of these from `.musterd/binding.json` (found by walking up from cwd) or the committed
  // `workspace.json`, both of which are genuinely per-worktree.
  expect(buildMcpEnv(binding)).toEqual({});
});

it('keeps the env names working as manual overrides — it just stops materializing them', () => {
  // Regression guard on intent: this task removed the *writer*, not the reader. If someone later
  // "restores" any of these to the entry, the shared-slot defect returns.
  for (const k of [
    'MUSTERD_SERVER',
    'MUSTERD_TEAM',
    'MUSTERD_AGENT_KEY',
    'MUSTERD_GRANT',
    'MUSTERD_SURFACE',
    'MUSTERD_CLAIM',
    'MUSTERD_MODEL',
  ]) {
    expect(buildMcpEnv(binding)[k]).toBeUndefined();
  }
});
```

Then in the `it('resolves a runnable launch command for the adapter')` block, change line 52 from `expect(entry.env['MUSTERD_CLAIM']).toBeUndefined();` to:

```ts
expect(entry.env).toEqual({});
```

Leave the `NEVER emits MUSTERD_MODEL` test at lines 33-46 exactly as it is — it still passes and it carries the ADR 158 history.

- [ ] **Step 2: Run the tests to verify they fail**

```bash
pnpm vitest run packages/cli/src/onboard/onboard.test.ts
```

Expected: FAIL — the first test reports the received object still containing `MUSTERD_SERVER`, `MUSTERD_TEAM`, `MUSTERD_AGENT_KEY`, `MUSTERD_SURFACE`.

- [ ] **Step 3: Empty `buildMcpEnv`**

In `packages/cli/src/onboard/mcpEntry.ts`, replace the function at lines 46-54 with the following. **Keep the function** — do not inline `{}` at the three call sites. It is the only place the reason is recorded, and it is where the regression test binds.

```ts
export function buildMcpEnv(_b: AgentBinding): Record<string, string> {
  return {};
}
```

Then extend the doc-comment directly above it (which currently ends at line 45 explaining `MUSTERD_CLAIM` and `MUSTERD_MODEL`) by appending this paragraph before the closing `*/`:

```
 *
 * ADR 159 finished the job for the rest. The same argument applies with more force to the remaining
 * fields, because of WHERE this entry lives: Claude Code keys local-scope MCP config by **repo root**,
 * so every `agents-*` seat worktree of one repo shares a SINGLE entry. A shared slot may hold only what
 * is identical across every seat sharing it — and `MUSTERD_AGENT_KEY`/`MUSTERD_GRANT` are per-seat
 * *credentials* that the adapter ranks ABOVE binding.json (`packages/mcp/src/config.ts`), so whichever
 * seat provisioned last left every sibling presenting its secret at claim time. `MUSTERD_SERVER`,
 * `MUSTERD_TEAM` and `MUSTERD_SURFACE` are merely redundant, but they made the entry differ between
 * writers (`init`/`wire` baked them, `agent` never did), which is what turned overwriting the slot into
 * theft rather than a no-op.
 *
 * So the entry now carries NOTHING. Identity and secrets come from `.musterd/binding.json`, which the
 * adapter finds by walking up from **cwd** — a signal that is genuinely per-worktree — falling back to
 * the committed `workspace.json` for the non-secret fields. All five names remain supported *manual*
 * overrides; provisioning simply stops materializing them.
 *
 * This function is deliberately kept rather than inlined as `{}` at its call sites: it is the one place
 * the reason is written down, and the place the regression test binds. `MUSTERD_GRANT` outlived
 * `MUSTERD_CLAIM`'s removal precisely because no single place recorded the rule.
```

- [ ] **Step 4: Drop `MUSTERD_SURFACE` from `musterd agent`**

In `packages/cli/src/commands/agent.ts`, replace the `entry` object at lines 171-179 with:

```ts
const entry = {
  command: launch.command,
  args: launch.args,
  // Seat-agnostic by construction (ADR 143, completed by ADR 159): this entry is keyed by repo root
  // and therefore shared by every seat worktree. `MUSTERD_SURFACE` came out with the rest — it is in
  // binding.json. AUTOJOIN/DRIVER are still here and still repo-root-global; that is a known,
  // recorded gap (ADR 159 increment 2), not an oversight.
  env: {
    MUSTERD_AUTOJOIN: '1',
    ...(driver ? { MUSTERD_DRIVER: driver } : {}),
  },
};
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
pnpm vitest run packages/cli/src/onboard/onboard.test.ts
```

Expected: PASS, all 4 tests.

- [ ] **Step 6: Run the full CLI suite for fallout**

```bash
pnpm vitest run packages/cli
```

Expected: PASS. If `claudeCodeProvision.test.ts` or `claudeCode.test.ts` assert on entry env contents, update those assertions to `{}` — they are asserting the old behaviour, not catching a bug.

- [ ] **Step 7: Commit**

```bash
git add packages/cli/src/onboard/mcpEntry.ts packages/cli/src/commands/agent.ts packages/cli/src/onboard/onboard.test.ts
git commit -m "fix(onboard): the shared MCP entry carries no per-seat state (ADR 159)

Claude Code keys local-scope MCP config by repo root, so all agents-*
worktrees share one entry. init/wire baked MUSTERD_AGENT_KEY + MUSTERD_GRANT
into it — credentials the adapter ranks above binding.json — so the last
writer left every sibling presenting its secret at claim time.

buildMcpEnv now returns {}. Every dropped var already falls back to
binding.json (secrets) or workspace.json (server/team/surface), so the
adapter is unchanged. All five remain manual overrides.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: Pin the adapter fallback the strip depends on

The whole change rests on the claim that an empty env still resolves a full config. Task 1 removed the writer without ever proving the reader copes. This task proves it.

**Files:**

- Test: `packages/mcp/src/config.test.ts`

**Interfaces:**

- Consumes: `loadMcpConfig(env: NodeJS.ProcessEnv): McpConfig` from `packages/mcp/src/config.ts`.
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Read the existing test file to match its setup style**

```bash
sed -n '1,60p' packages/mcp/src/config.test.ts
```

The file already builds temp workspaces for binding resolution. Reuse whatever helper it has for writing a `.musterd/binding.json` and setting cwd. If no helper exists, use the `mkdtempSync` + `process.chdir` pattern from `packages/cli/src/onboard/onboard.test.ts:1-10`, and restore the original cwd in `afterEach`.

- [ ] **Step 2: Write the failing test**

Append to `packages/mcp/src/config.test.ts`:

```ts
describe('empty env — the ADR 159 shared-entry contract', () => {
  it('resolves server, team, surface, agent_key and grant from binding.json alone', () => {
    // Provisioning writes an entry with NO env (ADR 159), because the entry is shared by every seat
    // worktree of the repo. Everything must therefore come off disk. If this breaks, seats stop
    // being able to claim at all — this is the test that makes the strip safe.
    const dir = mkdtempSync(join(tmpdir(), 'musterd-adr159-'));
    mkdirSync(join(dir, '.musterd'), { recursive: true });
    writeFileSync(
      join(dir, '.musterd', 'binding.json'),
      JSON.stringify({
        server: 'http://localhost:4849',
        team: 'revive',
        agent_key: 'mskey_from_disk',
        grant: 'msgr_from_disk',
        surface: 'claude-code',
        claim: { mode: 'seat', name: 'izzo' },
      }),
    );
    const prev = process.cwd();
    try {
      process.chdir(dir);
      const cfg = loadMcpConfig({});
      expect(cfg.server).toBe('http://localhost:4849');
      expect(cfg.team).toBe('revive');
      expect(cfg.agentKey).toBe('mskey_from_disk');
      expect(cfg.grant).toBe('msgr_from_disk');
      expect(cfg.surface).toBe('claude-code');
      expect(cfg.claim).toEqual({ mode: 'seat', name: 'izzo' });
    } finally {
      process.chdir(prev);
    }
  });

  it('still honours an explicit env override — the names are manual, not removed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'musterd-adr159-ovr-'));
    mkdirSync(join(dir, '.musterd'), { recursive: true });
    writeFileSync(
      join(dir, '.musterd', 'binding.json'),
      JSON.stringify({
        server: 'http://localhost:4849',
        team: 'revive',
        surface: 'claude-code',
        claim: { mode: 'seat', name: 'izzo' },
      }),
    );
    const prev = process.cwd();
    try {
      process.chdir(dir);
      expect(loadMcpConfig({ MUSTERD_TEAM: 'other' }).team).toBe('other');
    } finally {
      process.chdir(prev);
    }
  });
});
```

Add any missing imports (`mkdirSync`, `mkdtempSync`, `writeFileSync` from `node:fs`; `tmpdir` from `node:os`; `join` from `node:path`) to the top of the file.

**Note:** the exact property names on `McpConfig` (`agentKey` vs `agent_key`, `claim` shape) must match the interface. Verify with:

```bash
sed -n "$(grep -n 'interface McpConfig' packages/mcp/src/config.ts | cut -d: -f1),+30p" packages/mcp/src/config.ts
```

Correct the assertions to the real names before running.

- [ ] **Step 3: Run the test**

```bash
pnpm vitest run packages/mcp/src/config.test.ts
```

Expected: PASS immediately — this pins existing behaviour rather than driving new code. If it FAILS, stop: the Task 1 strip is unsafe and the spec's safety table is wrong. Report before continuing.

- [ ] **Step 4: Commit**

```bash
git add packages/mcp/src/config.test.ts
git commit -m "test(mcp): pin binding-only resolution — the contract ADR 159's strip depends on

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: The family regression — sibling worktrees produce identical entries

No current test covers two worktrees sharing one entry. This is the test that would have caught the whole class.

**Files:**

- Create: `packages/cli/src/onboard/sharedEntry.test.ts`

**Interfaces:**

- Consumes: `buildEntry(b: AgentBinding): McpServerEntry`, `buildMcpEnv(b: AgentBinding): Record<string, string>` from `./mcpEntry.js`.
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Write the failing test**

Create `packages/cli/src/onboard/sharedEntry.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { buildEntry, buildMcpEnv } from './mcpEntry.js';

/**
 * The ADR 143 / ADR 159 invariant, as an executable rule.
 *
 * Claude Code keys local-scope MCP config by REPO ROOT. Every `agents-*` seat is a git worktree of the
 * same repo, so all of them share ONE `musterd` entry — provisioning any seat overwrites the entry
 * every other seat is using. That is only safe if the entry each seat would write is IDENTICAL.
 *
 * So: build the entry two different seats would produce and require them to be byte-equal. Any future
 * change that reintroduces per-seat state fails here, loudly, with the reason attached.
 */
describe('the repo-root-shared MCP entry is seat-agnostic', () => {
  const izzo = {
    server: 'http://localhost:4849',
    team: 'revive',
    agent_key: 'mskey_izzo',
    grant: 'msgr_izzo',
    surface: 'claude-code' as const,
    claim: { mode: 'seat' as const, name: 'izzo' },
  };
  const miley = {
    server: 'http://localhost:4849',
    team: 'revive',
    agent_key: 'mskey_miley',
    grant: 'msgr_miley',
    surface: 'claude-code' as const,
    claim: { mode: 'seat' as const, name: 'miley' },
  };

  it('two sibling seats produce byte-identical entries', () => {
    expect(JSON.stringify(buildEntry(izzo))).toBe(JSON.stringify(buildEntry(miley)));
  });

  it('leaks neither seat’s credentials into the shared slot', () => {
    const serialized = JSON.stringify(buildEntry(izzo));
    expect(serialized).not.toContain('mskey_izzo');
    expect(serialized).not.toContain('msgr_izzo');
  });

  it('a seat differing ONLY by surface still shares the entry', () => {
    // `surface` looks per-seat and is not: it is in binding.json, and baking it made `init` and
    // `agent` write different entries for the same folder.
    expect(buildMcpEnv({ ...izzo, surface: 'cursor' })).toEqual(buildMcpEnv(izzo));
  });
});
```

- [ ] **Step 2: Run it**

```bash
pnpm vitest run packages/cli/src/onboard/sharedEntry.test.ts
```

Expected: PASS (Task 1 already emptied the env). To confirm the test has teeth, temporarily re-add `MUSTERD_GRANT: b.grant ?? ''` to `buildMcpEnv`, re-run, see all three fail, then revert.

- [ ] **Step 3: Commit**

```bash
git add packages/cli/src/onboard/sharedEntry.test.ts
git commit -m "test(onboard): sibling worktrees must produce byte-identical MCP entries (ADR 159)

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: Doctor flags baked secrets on presence and prescribes `wire`

**Files:**

- Modify: `packages/cli/src/onboard/harness.ts:25-32`
- Modify: `packages/cli/src/onboard/harnesses/claudeCode.ts:453-466, 496-500`
- Modify: `packages/cli/src/onboard/doctor.ts:46-56, 193-224`
- Modify: `packages/cli/src/onboard/doctor.test.ts:49-58, 195-220`

**Interfaces:**

- Consumes: `DetectResult` from `./harness.js`; `inspectProvisioning(cwd: string): Promise<DoctorReport>` from `./doctor.js`.
- Produces: `DetectResult.registeredAgentKey?: string`. `DoctorReport.repair?: 'wire' | 'init'` — `'wire'` when every drift line is entry drift (repairable headlessly), `'init'` when any drift needs full onboarding, absent when there is no drift. Task 5 consumes `repair`.

- [ ] **Step 1: Write the failing tests**

In `packages/cli/src/onboard/doctor.test.ts`, widen the `harnessWithEntry` helper at lines 50-58 to accept the new field:

```ts
function harnessWithEntry(
  label: string,
  extra: {
    registeredModel?: string;
    registeredArgs?: string[];
    registeredGrant?: string;
    registeredAgentKey?: string;
  },
) {
  return {
    label,
    detect: async () => ({ installed: true, configured: true, detail: label, ...extra }),
  };
}
```

Replace the two grant tests at lines 206-220 with:

```ts
// INVERTED by ADR 159. This used to fire only on a MISMATCH, which missed the common case: the
// entry is shared by every worktree of the repo, so a grant that happens to match THIS folder's
// binding is still a per-seat credential sitting in a slot every sibling reads.
it('flags a baked grant even when it matches this folder’s binding', async () => {
  h.primer = 'managed';
  h.binding = { claim: { mode: 'seat', name: 'Miley' }, grant: 'msgr_mine' };
  h.harnesses = [harnessWithEntry('Claude Code', { registeredGrant: 'msgr_mine' })];
  const r = await inspectProvisioning('/x');
  const line = r.drift.find((d) => d.includes('MUSTERD_GRANT'));
  expect(line).toBeDefined();
  expect(line).toContain('musterd wire');
});

it('flags a baked agent key — a sibling seat’s team credential, not just a grant', async () => {
  h.primer = 'managed';
  h.binding = { claim: { mode: 'seat', name: 'Miley' } };
  h.harnesses = [harnessWithEntry('Claude Code', { registeredAgentKey: 'mskey_someone' })];
  const r = await inspectProvisioning('/x');
  expect(r.drift.find((d) => d.includes('MUSTERD_AGENT_KEY'))).toBeDefined();
});

it('marks entry-only drift as headlessly repairable', async () => {
  h.primer = 'managed';
  h.binding = { claim: { mode: 'seat', name: 'Miley' }, grant: 'msgr_mine' };
  h.harnesses = [harnessWithEntry('Claude Code', { registeredGrant: 'msgr_mine' })];
  const r = await inspectProvisioning('/x');
  expect(r.repair).toBe('wire');
});

it('does not claim headless repair when the drift needs full onboarding', async () => {
  // No primer + a configured harness ⇒ the "server wired, no primer" drift, which `wire` cannot fix.
  h.primer = 'none';
  h.binding = { claim: { mode: 'seat', name: 'Miley' } };
  h.harnesses = [harnessWithEntry('Claude Code', {})];
  const r = await inspectProvisioning('/x');
  expect(r.repair).toBe('init');
});
```

Also update the baked-model test at line 203 — its remedy changes from `musterd init` to `musterd wire`:

```ts
expect(line).toContain('musterd wire');
```

- [ ] **Step 2: Run to verify failure**

```bash
pnpm vitest run packages/cli/src/onboard/doctor.test.ts
```

Expected: FAIL — `r.repair` is undefined (property does not exist), the matching-grant case produces no drift, and the model remedy still says `musterd init`.

- [ ] **Step 3: Add `registeredAgentKey` to the detect contract**

In `packages/cli/src/onboard/harness.ts`, replace the `registeredGrant` doc-block and field at lines 25-30 with:

```ts
  /**
   * The `MUSTERD_GRANT` baked into the registered server, if readable. Provisioning no longer emits it
   * (ADR 159): the entry is keyed by repo root and shared by every seat worktree, so a per-seat grant
   * in it is a credential every sibling reads. A present value is therefore drift **on presence**, not
   * on mismatch.
   */
  registeredGrant?: string;
  /**
   * The `MUSTERD_AGENT_KEY` baked into the registered server, if readable. Same story as
   * {@link registeredGrant} and strictly worse: the agent key is the *team* credential, so a stale one
   * in the shared slot means a seat may boot authenticating as a sibling rather than merely carrying
   * its grant. Provisioning no longer emits it (ADR 159).
   */
  registeredAgentKey?: string;
```

- [ ] **Step 4: Read the key back in the Claude Code adapter**

In `packages/cli/src/onboard/harnesses/claudeCode.ts`, add after line 456 (`const grantMatch = …`):

```ts
const agentKeyMatch = got.ok ? /MUSTERD_AGENT_KEY=(\S+)/.exec(got.out) : null;
```

and add to the returned object after the `registeredGrant` spread on line 464:

```ts
      ...(agentKeyMatch ? { registeredAgentKey: agentKeyMatch[1] } : {}),
```

While here, correct the false scope string at line 499. It currently claims per-folder scope, which is the exact belief ADR 143 documents as wrong:

```ts
      scope: `wired for this repo (${process.cwd()}) — Claude Code keys local scope by repo ROOT, so every git worktree of this repo shares this one entry; it carries no per-seat state (ADR 159), so that sharing is harmless. Another project needs its own \`musterd init\`, and a second agent needs its own folder.`,
```

- [ ] **Step 5: Add the `repair` field to the report**

In `packages/cli/src/onboard/doctor.ts`, add to the `DoctorReport` interface (after the `drift` field, ~line 52):

```ts
  /**
   * How this drift can be repaired, when there is any. `'wire'` ⇒ every line is *entry* drift: the
   * harness MCP entry disagrees with `.musterd/binding.json`, which `musterd wire` rewrites headlessly.
   * `'init'` ⇒ at least one line needs full onboarding (a missing primer, missing hooks, stale
   * guidance). Absent ⇒ no drift.
   *
   * This exists so `--fix` can stop prescribing `musterd init` for entry drift. On a repo-root-shared
   * entry (ADR 143) that remedy is actively harmful: it repairs the running seat by taking the slot
   * from whoever holds it, and it mints a member and trips the already-bound guard on the way.
   */
  repair?: 'wire' | 'init';
```

- [ ] **Step 6: Replace the model and grant checks**

In `packages/cli/src/onboard/doctor.ts`, replace lines 200-224 (the `registeredModel` block and the `registeredGrant` block) with:

```ts
// Entry drift: the shared harness entry disagrees with this folder's binding.json. Tracked
// separately from `drift` so `--fix` can route it to `musterd wire` (headless, whole-family)
// instead of `musterd init` (mints a member, trips the bound guard, steals the shared slot).
//
// A legacy baked MUSTERD_MODEL. Provisioning stopped emitting it, but entries written before that
// still carry one at the TOP of the adapter's ladder, where no observation can correct it — the
// exact shape that had a seat attesting `grok-4.5` for weeks while running `claude-opus-4-8`.
if (d.registeredModel !== undefined) {
  entryDrift.push(
    `${h.label}'s musterd server bakes MUSTERD_MODEL=${d.registeredModel} — a wire-time snapshot ` +
      `that outranks what the harness is actually running, and that no later observation can ` +
      `correct. Run \`musterd wire\` here to rewrite the entry without it.`,
  );
}
// Per-seat SECRETS in a slot shared by every seat worktree of this repo (ADR 143/159). Flagged on
// PRESENCE, not on mismatch: the entry is keyed by repo root, so a grant that matches *this*
// folder is still the credential every sibling worktree reads — and it outranks their own
// binding.json in the adapter's ladder. Provisioning no longer writes either one.
for (const [name, value, why] of [
  [
    'MUSTERD_GRANT',
    d.registeredGrant,
    'so a sibling seat presents this grant at claim time and gets denied or sent to approval',
  ],
  [
    'MUSTERD_AGENT_KEY',
    d.registeredAgentKey,
    'so a sibling seat may authenticate with this team key rather than its own',
  ],
] as const) {
  if (value === undefined) continue;
  entryDrift.push(
    `${h.label}'s musterd server bakes ${name} — a per-seat secret in an entry Claude Code keys ` +
      `by repo ROOT, which every git worktree of this repo shares, ${why}. ` +
      `Run \`musterd wire\` here: it rewrites the entry from .musterd/binding.json without ` +
      `secrets, and because the entry is shared, one run repairs every seat in the family.`,
  );
}
```

Declare `entryDrift` alongside `drift` near line 173:

```ts
const drift: string[] = [];
const entryDrift: string[] = [];
```

Change the baked-`MUSTERD_CLAIM` block at lines 193-198 to push onto `entryDrift` instead of `drift`, and change its remedy sentence from ``Run \`musterd init\` to re-sync`` to ``Run \`musterd wire\` to re-sync``.

Then, just before the `return` of `inspectProvisioning`, merge and classify. Find the existing return statement and insert above it:

```ts
// Entry drift is repairable headlessly; anything else needs full onboarding. Classify BEFORE
// merging so the distinction survives into `--fix`.
const repair: 'wire' | 'init' | undefined =
  drift.length > 0 ? 'init' : entryDrift.length > 0 ? 'wire' : undefined;
drift.push(...entryDrift);
```

and add `...(repair !== undefined ? { repair } : {}),` to the returned object literal.

- [ ] **Step 7: Run the tests**

```bash
pnpm vitest run packages/cli/src/onboard/doctor.test.ts
```

Expected: PASS. If the "quiet about a normal entry" test at line 222 now fails, check it is not passing a `registeredGrant` — it should not be.

- [ ] **Step 8: Commit**

```bash
git add packages/cli/src/onboard/harness.ts packages/cli/src/onboard/harnesses/claudeCode.ts packages/cli/src/onboard/doctor.ts packages/cli/src/onboard/doctor.test.ts
git commit -m "fix(doctor): baked secrets are drift on presence, and the remedy is \`musterd wire\`

The grant check fired only on mismatch, which missed the common case: the
entry is keyed by repo root and shared by every worktree, so a grant matching
THIS folder is still the credential every sibling reads. Now flagged on
presence, and MUSTERD_AGENT_KEY is read back and flagged too — a stale one
means a seat may authenticate as a sibling, not merely carry its grant.

Remedies point at \`musterd wire\`, which rewrites the entry headlessly and,
because the entry is shared, repairs the whole family in one run. Also
corrects the scope string that claimed per-folder reach.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 5: `--fix` routes entry drift to `wire`; delete `assertEntryIdentity`

**Files:**

- Modify: `packages/cli/src/commands/init.ts:12-27`
- Modify: `packages/cli/src/onboard/doctor.ts` (`runInitDoctor` return)
- Modify: `packages/cli/src/onboard/entryGuard.ts:1-101`
- Modify: `packages/cli/src/onboard/entryGuard.test.ts`

**Interfaces:**

- Consumes: `DoctorReport.repair` from Task 4.
- Produces: `runInitDoctor(json: boolean, cwd?: string): Promise<number>` — unchanged signature. New: `inspectProvisioningRepair(cwd: string): Promise<'wire' | 'init' | undefined>` is **not** introduced; `initCommand` re-reads the report instead (see Step 3).

- [ ] **Step 1: Write the failing test**

Create `packages/cli/src/commands/init.test.ts` if it does not exist; otherwise append. Check first:

```bash
ls packages/cli/src/commands/init.test.ts
```

```ts
import { describe, expect, it, vi } from 'vitest';

const calls = vi.hoisted(() => ({
  init: 0,
  wire: 0,
  repair: 'wire' as 'wire' | 'init' | undefined,
}));

vi.mock('../onboard/doctor.js', () => ({
  runInitDoctor: async () => 1,
  inspectProvisioning: async () => ({
    primerManaged: true,
    harnesses: [],
    drift: ['x'],
    notes: [],
    anyConfigured: true,
    ...(calls.repair !== undefined ? { repair: calls.repair } : {}),
  }),
  runCheckBuild: async () => 0,
}));
vi.mock('../onboard/init.js', () => ({
  runInit: async () => {
    calls.init += 1;
    return 0;
  },
}));
vi.mock('./wire.js', () => ({
  wireCommand: async () => {
    calls.wire += 1;
    return 0;
  },
}));

const { initCommand } = await import('./init.js');

describe('musterd init --check --fix', () => {
  it('repairs entry-only drift with `wire`, never full onboarding', async () => {
    // `runInit` mints a member and trips the already-bound guard; on a repo-root-shared entry it also
    // repairs this seat by taking the slot from whoever holds it. `wire` is the headless rewrite.
    calls.init = 0;
    calls.wire = 0;
    calls.repair = 'wire';
    await initCommand({ flags: { check: true, fix: true }, args: [] } as never);
    expect(calls.wire).toBe(1);
    expect(calls.init).toBe(0);
  });

  it('falls back to full onboarding when the drift needs it', async () => {
    calls.init = 0;
    calls.wire = 0;
    calls.repair = 'init';
    await initCommand({ flags: { check: true, fix: true }, args: [] } as never);
    expect(calls.init).toBe(1);
    expect(calls.wire).toBe(0);
  });
});
```

- [ ] **Step 2: Run to verify failure**

```bash
pnpm vitest run packages/cli/src/commands/init.test.ts
```

Expected: FAIL — `wire` is never called; `init` is called in both cases.

- [ ] **Step 3: Route the repair**

In `packages/cli/src/commands/init.ts`, replace the whole `initCommand` body (lines 12-27) with:

```ts
export async function initCommand(parsed: Parsed): Promise<number> {
  // `--check-build` (ADR 135): the hook-cheap freshness probe — one health fetch, one line on
  // mismatch, always exit 0. Kept separate from `--check` (which reads manifests + runs git).
  if (parsed.flags['check-build']) return runCheckBuild();
  if (parsed.flags['check']) {
    const code = await runInitDoctor(Boolean(parsed.flags['json']));
    // --fix folds the "now run X" follow-up the check would otherwise print into one step.
    // JSON mode stays a pure read-only report (no interactive repair to intermix with the payload).
    if (code !== 0 && parsed.flags['fix'] && !parsed.flags['json']) {
      // Which repair depends on what drifted. Entry drift — the harness MCP entry disagreeing with
      // binding.json — is fixed by `musterd wire`: headless, no member minted, no bound-folder guard,
      // and because Claude Code keys that entry by repo ROOT it repairs every seat worktree at once.
      // Sending entry drift to `runInit` was actively harmful: it repaired the running seat by taking
      // the shared slot from whoever held it, who then hit `expired_grant` on wake.
      const { repair } = await inspectProvisioning(process.cwd());
      if (repair === 'wire') {
        process.stdout.write(
          `\n${theme.meta('entry drift — running `musterd wire` to rewrite this folder’s MCP entry from binding.json…')}\n\n`,
        );
        return wireCommand(parsed);
      }
      process.stdout.write(
        `\n${theme.meta('drift found — running `musterd init` to repair…')}\n\n`,
      );
      return runInit();
    }
    return code;
  }
  return runInit();
}
```

Update the imports at the top of the file:

```ts
import type { Parsed } from '../args.js';
import { inspectProvisioning, runCheckBuild, runInitDoctor } from '../onboard/doctor.js';
import { runInit } from '../onboard/init.js';
import { theme } from '../render/theme.js';
import { wireCommand } from './wire.js';
```

Update the doc-comment above `initCommand` — the line reading `repair any drift by re-running init` becomes:

```
 * `musterd init --check --fix` — diagnose, then repair: entry drift goes to `musterd wire` (headless,
 *   repairs the whole repo-root-shared entry family), anything else to a full `musterd init`.
```

- [ ] **Step 4: Run the tests**

```bash
pnpm vitest run packages/cli/src/commands/init.test.ts
```

Expected: PASS, both tests.

- [ ] **Step 5: Delete `assertEntryIdentity`**

In `packages/cli/src/onboard/entryGuard.ts`, delete `EntryIdentityError` (line 25), `EntryIdentityOpts` (line 29) and `assertEntryIdentity` (line 62) together with their doc-comments — everything from the start of the `EntryIdentityError` block through the end of `assertEntryIdentity`. **Keep** `isInside`, `foreignAdapterNote` and `siblingWorkspaces`, which are live at `doctor.ts:227-231`.

Add this note at the top of the file, below the imports:

```ts
// ADR 159 removed `assertEntryIdentity`, which compared the harness entry's baked secrets against
// binding.json. The entry no longer carries secrets, so there is nothing to compare; the doctor now
// flags any baked secret on presence instead. (It was already dead code — ADR 158 §6 said the doctor
// called it, and the doctor re-implemented half of it inline. The agent_key half never ran at all.)
```

- [ ] **Step 6: Delete its tests**

In `packages/cli/src/onboard/entryGuard.test.ts`, delete the `assertEntryIdentity` describe block (~lines 26-119 — the grant-mismatch, agent_key-mismatch, matching-secrets and no-binding cases) and remove `assertEntryIdentity` / `EntryIdentityError` from the import statement. Keep the `foreignAdapterNote` block.

- [ ] **Step 7: Verify nothing else referenced it**

```bash
grep -rn "assertEntryIdentity\|EntryIdentityError\|EntryIdentityOpts" packages/ docs/ --include='*.ts' --include='*.md'
```

Expected: only the ADR 158 mention in `docs/decisions/158-*.md`, which Task 6 corrects. If any `.ts` hit remains, remove it.

- [ ] **Step 8: Full CLI suite + typecheck**

```bash
pnpm build && pnpm typecheck && pnpm vitest run packages/cli
```

Expected: PASS. `pnpm build` must run before `typecheck` — otherwise stale `.d.ts` files produce phantom errors.

- [ ] **Step 9: Commit**

```bash
git add packages/cli/src/commands/init.ts packages/cli/src/commands/init.test.ts packages/cli/src/onboard/entryGuard.ts packages/cli/src/onboard/entryGuard.test.ts
git commit -m "fix(init): --fix repairs entry drift with \`wire\`; drop dead assertEntryIdentity

Entry drift went to full runInit, which mints a member, trips the bound-folder
guard, and on a repo-root-shared entry repairs the running seat by taking the
slot from whoever held it. It now routes to \`musterd wire\`.

assertEntryIdentity compared entry secrets to binding secrets; the entry no
longer has secrets. It was already dead in production despite ADR 158 §6
claiming the doctor called it.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 6: ADR 159 and docs

**Files:**

- Create: `docs/decisions/159-<slug>.md`
- Modify: `docs/decisions/158-model-attestation-truth.md` (correct the §6 claim)
- Modify: `docs/architecture/05-mcp.md`, `docs/architecture/04-cli.md`
- Modify: `packages/web/src/content/roadmap.data.ts`, then `ROADMAP.md` last

**Interfaces:**

- Consumes: the shipped behaviour from Tasks 1-5.
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Re-check the ADR number**

```bash
git fetch origin --quiet && git ls-tree --name-only origin/main docs/decisions/ | sed 's|.*/||; s/-.*//' | sort -n | tail -3
```

If 159 is taken on `origin/main`, use the next free number and use it consistently in the filename, the H1 and every reference below. `pnpm adr-numbers:check` gates both uniqueness and H1-matches-filename.

- [ ] **Step 2: Write the ADR**

Create `docs/decisions/159-worktree-family-mcp-entry.md`. The H1 must be exactly `# 159. Worktree-family MCP entry — a shared slot carries no per-seat state` (filename slug and H1 must agree).

Required sections: `## Status` (accepted, 2026-07-24), `## Context`, `## Decision`, `## Consequences`, and — mandatory for ADRs ≥ 060, gated in CI — `## Observability & Evaluation`.

Source the content from `docs/superpowers/specs/2026-07-24-worktree-family-mcp-entry-design.md`. It must additionally record:

- **Observed impact:** the `agent_key` half means a seat may have been booting with a _sibling's team agent key_, not only a sibling's grant — broader than the lane's original framing.
- **Side benefit:** `init` builds one entry for whichever harness is chosen, and Cursor/Codex write their configs _inside the working tree_ (`.cursor/mcp.json`, `.codex/config.toml`, both flagged via `secretPath`). Emptying the env therefore also stops writing the plaintext team agent key into repo-tracked files for those harnesses. `secretPath` is deliberately left in place — role provisioning still writes other servers there.
- **Deferred increment 2:** `MUSTERD_AUTOJOIN` and `MUSTERD_DRIVER` are still baked by `musterd agent` into the shared slot and are read only from `process.env`. So `musterd agent X --driver nick` currently marks **every** worktree in the family as driven by nick, corrupting ADR 155 driver co-presence, and forces autojoin on family-wide against the default `wire` documents. Fixing needs new `Binding` fields plus adapter fallback — its own lane.
- **Correction to ADR 158 §6:** it stated the doctor calls `assertEntryIdentity`. It never did; the doctor re-implemented the grant half inline and the agent_key half never ran. ADR 159 deletes the function.

- [ ] **Step 3: Correct the ADR 158 claim**

In `docs/decisions/158-model-attestation-truth.md` §6, append to the sentence claiming the doctor calls `assertEntryIdentity`:

```
(Corrected by ADR 159: it never did — the doctor re-implemented the grant comparison inline and the
agent_key half never ran. ADR 159 removed the function and made a baked secret drift on presence.)
```

- [ ] **Step 4: Update architecture docs**

In `docs/architecture/05-mcp.md`, find the section describing the MCP entry env and add:

```markdown
### The entry carries no per-seat state

Claude Code keys local-scope MCP config by **repo root**, so every git worktree of a repo shares one
`musterd` entry. A shared slot may hold only what is identical across everything sharing it, so the
entry holds nothing: no server, team, surface, agent key or grant. The adapter resolves all of them
from `.musterd/binding.json`, found by walking up from **cwd** — the one signal that is genuinely
per-worktree — falling back to the committed `workspace.json` for the non-secret fields.

All of `MUSTERD_SERVER`, `MUSTERD_TEAM`, `MUSTERD_SURFACE`, `MUSTERD_AGENT_KEY`, `MUSTERD_GRANT`,
`MUSTERD_CLAIM` and `MUSTERD_MODEL` remain supported **manual** overrides for headless/CI use.
Provisioning simply never writes them. See ADR 143 and ADR 159.
```

In `docs/architecture/04-cli.md`, find the `musterd init --check` description and add:

```markdown
`--fix` picks its repair from what drifted. **Entry drift** — the harness MCP entry disagreeing with
`.musterd/binding.json` — routes to `musterd wire`: headless, no member minted, no bound-folder guard,
and because the entry is shared by repo root, one run repairs every seat worktree in the family.
Anything else (missing primer, missing hooks, stale guidance) still runs a full `musterd init`.
```

- [ ] **Step 5: Roadmap**

Add an entry to `packages/web/src/content/roadmap.data.ts` following the shape of the neighbouring ADR 158 entry: what shipped, the observed defect, and the deferred increment 2. Then mirror it into `ROADMAP.md`.

**Edit `ROADMAP.md` last and never run prettier on it.**

- [ ] **Step 6: Format and run the gates**

```bash
pnpm exec prettier --write docs/decisions/159-worktree-family-mcp-entry.md docs/decisions/158-model-attestation-truth.md docs/architecture/05-mcp.md docs/architecture/04-cli.md packages/web/src/content/roadmap.data.ts
pnpm adr-numbers:check && pnpm vocab:check && pnpm guidance:check
pnpm build && pnpm typecheck && pnpm test && pnpm lint && pnpm format:check
```

Expected: all PASS. `pnpm lint` is a separate gate from `format:check` — both must run.

- [ ] **Step 7: Commit**

```bash
git add docs/ packages/web/src/content/roadmap.data.ts ROADMAP.md
git commit -m "docs(adr-159): worktree-family MCP entry — a shared slot carries no per-seat state

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 7: Verify against the live machine, then ship

The whole point is a bug observed on this machine across thirteen worktrees. Prove the fix on it before opening the PR.

**Files:** none (verification + PR).

- [ ] **Step 1: Capture the current shared entry**

```bash
claude mcp get musterd 2>&1 | head -20
```

Record which secrets it currently carries and whose they are. This is the "before".

- [ ] **Step 2: Confirm the doctor now reports it**

```bash
pnpm build && node packages/cli/dist/bin.js init --check --json | python3 -m json.tool
```

Expected: `drift` contains a `MUSTERD_GRANT` and/or `MUSTERD_AGENT_KEY` line naming `musterd wire`, and `repair` is `"wire"`.

**Do not run `--fix` yet.** Other seats are live; see Step 3.

- [ ] **Step 3: Ask before repairing the shared slot**

Rewriting the entry affects **every** live seat on the machine. Even though the new entry is seat-agnostic and therefore safe, a live session holds its config in memory and will need `/mcp` reload.

Post to the team and wait for acknowledgement before writing:

```bash
node packages/cli/dist/bin.js send --act status_update 'About to rewrite the shared repo-root MCP entry (ADR 159) — it becomes seat-agnostic, no secrets. Live sessions should /mcp reload afterwards. Speak up in the next few minutes if you are mid-claim.'
```

Then run the repair:

```bash
node packages/cli/dist/bin.js wire
claude mcp get musterd 2>&1 | head -20
```

Expected: the entry now shows no `MUSTERD_GRANT`, no `MUSTERD_AGENT_KEY`, no `MUSTERD_SERVER`, no `MUSTERD_TEAM`, no `MUSTERD_SURFACE`.

- [ ] **Step 4: Confirm the family is clean**

```bash
for d in /Users/nick/agents-*; do
  [ -f "$d/.musterd/binding.json" ] || continue
  printf '%s: ' "$(basename "$d")"
  (cd "$d" && node /Users/nick/agents-izzo/packages/cli/dist/bin.js init --check --json 2>/dev/null \
    | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("repair","clean"), len(d["drift"]))' 2>/dev/null || echo "skipped")
done
```

Expected: no worktree reports `wire`. Before this change, every seat but the slot-holder reported grant drift by construction. Report the actual output — if any worktree still reports entry drift, investigate rather than proceeding.

- [ ] **Step 5: Push and open the PR**

```bash
git push -u origin feat/worktree-family-mcp-entry
gh pr create --title "fix(onboard): the repo-root-shared MCP entry carries no per-seat state (ADR 159)" --body "$(cat <<'EOF'
## Summary

Claude Code keys local-scope MCP config by **repo root**, so all thirteen `agents-*` seat worktrees share one `musterd` entry. `init`/`wire` baked `MUSTERD_AGENT_KEY` and `MUSTERD_GRANT` into it — credentials the adapter ranks *above* `binding.json` — while `agent` has written a deliberately seat-agnostic entry since ADR 143. Two writers, opposite policies, one slot: the last one won, and every other seat presented a sibling's credential at claim time.

This finishes ADR 143's move rather than managing the conflict: the shared entry now carries nothing. Identity and secrets come from `.musterd/binding.json` via cwd, which already worked — every dropped variable had a fallback, so the adapter is unchanged.

## Also fixed

- The doctor flagged a baked grant only on **mismatch**, so a matching one passed even though it is still the credential every sibling reads. Now flagged on presence, and `MUSTERD_AGENT_KEY` is read back and flagged too.
- Remedies pointed at `musterd init`, which on a shared slot repairs the running seat by taking it from whoever holds it. They now point at `musterd wire`, and `--fix` routes entry drift there — one run repairs the whole family.
- `assertEntryIdentity` deleted: it compared entry secrets to binding secrets, and there are none. It was already dead despite ADR 158 §6 claiming the doctor called it.
- Emptying the env also stops writing the plaintext team agent key into `.cursor/mcp.json` and `.codex/config.toml`, which live inside the working tree.

## Known gap, recorded not fixed

`MUSTERD_AUTOJOIN` and `MUSTERD_DRIVER` are still baked into the shared slot by `musterd agent` and are read only from `process.env`. So `musterd agent X --driver nick` marks **every** worktree as driven by nick, and forces autojoin family-wide. Fixing needs new `Binding` fields plus adapter fallback — deferred to increment 2 as its own lane. Treat driver co-presence for `agents-*` seats as unreliable until then.

## Verification

Ran on the live machine: before, the shared entry carried a grant and the doctor reported drift in every worktree but the slot-holder's. After `musterd wire`, the entry carries no env and no worktree reports entry drift.

Test coverage includes the regression that would have caught this class: two sibling seats must produce byte-identical entries.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
gh pr merge --squash --auto --delete-branch
```

- [ ] **Step 6: Resolve the lane**

After the PR merges, sync main, delete the local branch, and close the lane:

```bash
git checkout main && git pull --ff-only origin main && git branch -d feat/worktree-family-mcp-entry
```

Then `lane_resolve` `01KYAWFCGG7YZ80H1RWEF4CXQ1` with the PR number and merge SHA, open the increment-2 lane for `AUTOJOIN`/`DRIVER`, and save seat memory.

---

## Self-Review

**Spec coverage.** Increment 1 strip → Task 1. Safety table → Task 2. Doctor presence-check, `wire` remedies, `assertEntryIdentity` deletion → Tasks 4-5. Repair path → Tasks 5 and 7. Byte-identical regression → Task 3. Observability & Evaluation → Task 6 Step 2, exercised live in Task 7 Step 4. Deferred increment 2 → recorded in Tasks 1, 6 and 7, opened as a lane in Task 7 Step 6. No gaps.

**Placeholders.** None. Every code step carries real code. Task 6 Step 2 describes ADR prose rather than quoting it, which is correct — the content is sourced from the committed spec and listed point by point.

**Type consistency.** `registeredAgentKey` is introduced in Task 4 Step 3 and consumed in Task 4 Steps 1/4 only. `DoctorReport.repair: 'wire' | 'init' | undefined` is introduced in Task 4 Step 5 and consumed in Task 5 Step 3 under the same name and union. `buildMcpEnv`/`buildEntry` signatures are unchanged throughout. Task 2 Step 2 flags that `McpConfig` property names must be verified against the interface before asserting, rather than assuming them.

**Known risk.** Task 2 pins behaviour rather than driving it, so it passes on first run. That is intentional and stated: if it fails, Task 1 is unsafe and the implementer must stop.
