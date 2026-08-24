# Shared Seeds before Lanes Implementation Plan

> **For agentic workers:** Execute inline in the assigned seat. This workspace forbids subagent implementation.

**Goal:** Replace immediate relay Seed-to-Lane conversion with a persistent, Team-visible Seed lifecycle and promote a Seed atomically only after exploration.

**Architecture:** `@musterd/protocol` owns the typed Seed contract. The server persists Seeds and their narrow public threads, projects relay capture into Seeds, and enforces transitions transactionally; CLI, MCP, and web consume HTTP only.

**Tech Stack:** TypeScript, Zod, SQLite/better-sqlite3, Vitest.

**Spec:** `docs/superpowers/specs/2026-08-19-shared-seeds-before-lanes-design.md`

## Global Constraints

- ADR 291 governs this work; the relay stays raw and capture-only.
- Parse every external boundary with a protocol Zod schema.
- Source bodies, questions, answers, briefs, and conclusions never appear in logs, telemetry, or audit details.
- A Seed is not a Lane; only promotion creates an ordinary Lane.
- Add no runtime dependency and update docs with behavior.

---

### Task 1: Specify the Seed contract and normative API

**Files:**
- Create: `packages/protocol/src/seeds.ts`, `packages/protocol/src/seeds.test.ts`
- Modify: `packages/protocol/src/index.ts`, `SPEC.md`, `docs/architecture/01-data-model.md`, `docs/architecture/02-protocol.md`

**Interfaces:** Produce `SeedSchema`, `SeedStateSchema`, `SeedThreadEntrySchema`, and Zod request/result schemas for list, read, claim, question, answer, conclude, and promote.

- [ ] **Step 1: Write failing tests**

```ts
expect(SeedSchema.safeParse({ id: '01J', team: 'revive', state: 'open' }).success).toBe(false);
expect(ConcludeSeedSchema.safeParse({ conclusion: '' }).success).toBe(false);
```

- [ ] **Step 2: Verify RED**

Run: `pnpm --filter @musterd/protocol test -- seeds.test.ts`

Expected: schemas do not exist.

- [ ] **Step 3: Implement the minimal contract**

```ts
export const SeedStateSchema = z.enum(['open', 'exploring', 'needs_clarification', 'clarified', 'completed', 'promoted']);
export const SeedSchema = z.object({ id: z.string(), team: TeamSlugSchema, state: SeedStateSchema, relay_id: z.string(), body: z.string(), captured_at: z.number().int() });
```

Document every endpoint and its permission rule in SPEC and architecture.

- [ ] **Step 4: Verify GREEN**

Run: `pnpm --filter @musterd/protocol test -- seeds.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/protocol/src SPEC.md docs/architecture/01-data-model.md docs/architecture/02-protocol.md
git commit -m "protocol: add shared Seed contract" -m "Refs ADR-291" -m "Co-authored-by: gptbot <gptbot@revive.musterd>"
```

### Task 2: Persist Seeds and replace immediate-Lane ingest

**Files:**
- Create: `packages/server/src/store/seeds.ts`, `packages/server/src/store/seeds.test.ts`
- Modify: `packages/server/src/db/migrations.ts`, `packages/server/src/seeds/ingest.ts`, `packages/server/src/seeds/ingest.test.ts`, `docs/architecture/03-server.md`

**Interfaces:** Produce `createSeedFromRelay`, `listSeeds`, `getSeed`, `claimSeed`, `askClarification`, `answerClarification`, `concludeSeed`, and `promoteSeed`.

- [ ] **Step 1: Write failing tests**

```ts
expect(await ingestTeamSeeds(ctx, team)).toBe(1);
expect(listLanes(db, team.id, team.slug)).toHaveLength(0);
expect(listSeeds(db, team.id)).toMatchObject([{ state: 'open', relay_id: '00001-a' }]);
```

- [ ] **Step 2: Verify RED**

Run: `pnpm --filter @musterd/server test -- seeds/ingest.test.ts store/seeds.test.ts`

Expected: ingest creates a Lane and the Seed store does not exist.

- [ ] **Step 3: Implement migration and atomic transitions**

```ts
const tx = db.transaction(() => {
  const seed = insertSeedFromRelay(db, teamId, relay);
  advanceSeedCursor(db, teamId, relay.id, now);
  return seed;
});
```

Use unique `(team_id, relay_id)` storage. Promotion must create the Lane, link it, and set `promoted` in one transaction. Audit only identifiers, actor, source, and state.

- [ ] **Step 4: Verify GREEN**

Run: `pnpm --filter @musterd/server test -- seeds/ingest.test.ts store/seeds.test.ts`

Expected: PASS for replay, cursor safety, no immediate Lane, and idempotent promotion.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/store/seeds.ts packages/server/src/store/seeds.test.ts packages/server/src/db/migrations.ts packages/server/src/seeds docs/architecture/03-server.md
git commit -m "server: persist shared Seeds from relay ingest" -m "Refs ADR-291" -m "Co-authored-by: gptbot <gptbot@revive.musterd>"
```

### Task 3: Enforce authorization over HTTP

**Files:**
- Create: `packages/server/src/transport/seeds-http.test.ts`
- Modify: `packages/server/src/transport/http.ts`, `packages/server/src/store/seeds.ts`, `docs/architecture/03-server.md`

**Interfaces:** Consume Task 1 request schemas and Task 2 store operations; expose authenticated list/read/mutation HTTP endpoints.

- [ ] **Step 1: Write failing transport tests**

```ts
await requestAs(explorer, 'POST', `/teams/bravo/seeds/${seed.id}/clarification`, { body: 'Which Surface?' }).expect(200);
await requestAs(otherMember, 'POST', `/teams/bravo/seeds/${seed.id}/answer`, { body: 'CLI' }).expect(403);
await requestAs(submitter, 'POST', `/teams/bravo/seeds/${seed.id}/answer`, { body: 'CLI' }).expect(200);
```

- [ ] **Step 2: Verify RED**

Run: `pnpm --filter @musterd/server test -- transport/seeds-http.test.ts`

Expected: no Seed routes are registered.

- [ ] **Step 3: Register parsed routes and domain refusals**

```ts
const body = parseOrBadRequest(AnswerSeedClarificationSchema, await readJson(req));
return json(SeedResultSchema.parse(answerClarification(ctx.db, team.id, member.id, seedId, body, Date.now())));
```

Only agents claim/explore, only the active explorer asks/finalizes, and only the submitting Member answers. Return existing `forbidden`, `not_found`, or `conflict` without leaking unavailable Seeds.

- [ ] **Step 4: Verify GREEN**

Run: `pnpm --filter @musterd/server test -- transport/seeds-http.test.ts`

Expected: PASS for allowed/refused transitions, visibility, and body-free audit/log assertions.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/transport/http.ts packages/server/src/transport/seeds-http.test.ts packages/server/src/store/seeds.ts docs/architecture/03-server.md
git commit -m "server: expose authorized Seed lifecycle routes" -m "Refs ADR-291" -m "Co-authored-by: gptbot <gptbot@revive.musterd>"
```

### Task 4: Add human, agent, and web Surfaces

**Files:**
- Modify: `packages/cli/src/client.ts`, `packages/cli/src/commands/**`, `packages/mcp/src/client.ts`, `packages/mcp/src/tools/**`, `packages/web/src/**`
- Create: `packages/cli/src/commands/seed.test.ts`, `packages/mcp/src/tools/seeds.test.ts`, focused web Seed tests
- Modify: `docs/architecture/04-cli.md`, `docs/architecture/05-mcp.md`, `docs/architecture/06-testing.md`, `docs/architecture/08-web.md`, terminal frames

**Interfaces:** Consume Task 1 schemas and Task 3 endpoints. Produce `musterd seed` commands, equivalent `team_seed_*` MCP tools, the active Seed tray, and Seed history with linked-Lane provenance.

- [ ] **Step 1: Write failing Surface tests**

```ts
expect(await runCli(['seed', 'claim', seed.id])).toContain('exploring');
await expect(toolHandlers.team_seed_answer({ id: seed.id, body: 'CLI' })).resolves.toMatchObject({ state: 'clarified' });
expect(renderSeedTray([openSeed, promotedSeed]).queryByText(promotedSeed.body)).toBeNull();
```

- [ ] **Step 2: Verify RED**

Run: `pnpm --filter @musterd/cli test -- seed.test.ts && pnpm --filter @musterd/mcp test -- seeds.test.ts && pnpm --filter @musterd/web test -- seed`

Expected: no Seed commands, tools, or tray exist.

- [ ] **Step 3: Implement thin parsed clients and tray**

```ts
const activeSeeds = seeds.filter((seed) => ['open', 'exploring', 'needs_clarification', 'clarified'].includes(seed.state));
```

Keep server authorization authoritative. Provide action-naming empty states. Promoted leaves the tray immediately; completed leaves it after three days but remains in history.

- [ ] **Step 4: Verify GREEN and end-to-end behavior**

Run: `pnpm -r build && pnpm -r lint && pnpm test && pnpm coverage && pnpm format:check`

Expected: all commands pass; a relay capture creates one Seed, viable completion creates exactly one linked Lane, and no body text appears in audit/telemetry evidence.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src packages/mcp/src packages/web/src docs/architecture docs/design/figma-brief-terminal.md tests
git commit -m "web: surface shared Seeds" -m "Refs ADR-291" -m "Co-authored-by: gptbot <gptbot@revive.musterd>"
```

## Plan self-review

- Spec coverage: Task 1 owns contract and source attribution; Tasks 2–3 own durable lifecycle, privacy, transactions, and permissions; Task 4 owns every required Surface, tray/history expiry, observability, and end-to-end verification.
- Placeholder scan: no unresolved implementation placeholder is present.
- Type consistency: every surface consumes Task 1 schemas and Task 3 endpoints; every durable transition is implemented in Task 2.

