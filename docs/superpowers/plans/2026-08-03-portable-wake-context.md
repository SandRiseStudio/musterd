# Portable Wake Context Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this
> plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Per this repository's
> `AGENTS.md`, the lane owner implements inline; do not dispatch subagents.

**Goal:** Every reply, handoff, review, and work-order wake starts with bounded, recipient-scoped
context; fresh delivery is the default, and transcript resume is a narrow, measured exception.

**Architecture:** A daemon-derived `WakeContextPacket` is fetched after the woken Member occupies,
never embedded in the spawn prompt. `WakeOrder` names the typed continuity requirement and intended
delivery. The host enforces that decision locally, reports the actual delivery and non-content
measurements, and preserves the existing same-lease fresh fallback after a failed resume.

**Tech Stack:** TypeScript, zod, better-sqlite3, Vitest, OpenTelemetry. Design:
`docs/superpowers/specs/2026-08-03-portable-wake-context-design.md`.

## Global Constraints

- Write ADR 207 and update `SPEC.md` before changing any `@musterd/protocol` schema.
- The spawn line contains canonical IDs only: never an Act body, lane title, memory body, or
  agent-authored summary (ADR 088/128).
- Packet data is derived, bounded, and recipient-scoped; it creates no new durable context store.
- `portable` means fresh by default. Only an active reply edge may initially declare
  `transcript_required`; review, handoff, and work-order wakes remain portable.
- A compact packet limits inherited context, not work capacity: normal turn and watchdog policy stay
  independent. A failed resume must retain the current fresh fallback in the same lease.
- Record metadata and measurements only — never message/memory/source bodies or secrets.
- No new runtime dependency. Update architecture file trees and all behavior docs in the same PR.
- Run `pnpm build` before typechecking. Before push, run `pnpm typecheck && pnpm format:check`;
  CI remains the authority for the full suite and coverage gates.

---

### Task 1: Make the context-delivery contract normative (ADR 207 + SPEC)

**Files:**
- Create: `docs/decisions/207-portable-wake-context.md`
- Modify: `SPEC.md` (wake-order and wake-report contract sections)

**Interfaces:**
- Produces the normative vocabulary used by later tasks:
  `ContinuityRequirement = 'portable' | 'transcript_required'`,
  `WakeDelivery = 'fresh' | 'resume'`, and
  `WakeDeliveryOutcome = 'fresh' | 'resumed' | 'fresh_fallback'`.
- Produces the exact authorization rule: a recipient may request a packet only for a directed Act
  delivered to that Member, or for a Lane on which the Member is the owner/reviewer under the live
  wake derivation; all other requests return `forbidden` without revealing existence.

- [ ] **Step 1: Write ADR 207 before code**

  Use the repository ADR template. Its Decision section must fix all of the following:

  ```md
  1. The spawn prompt carries team/seat plus `act_id` or `lane_id` only. The packet is fetched
     after authenticated occupy.
  2. `portable` is the launch default and selects a fresh spawn. `transcript_required` is allowed
     only on a recent reply edge and selects resume only while the host's local capture is within
     `transcript_max_bytes`; every other condition selects fresh.
  3. The daemon classifies; the host enforces using local transcript facts and reports the actual
     outcome. A resume failure reports `fresh_fallback` if the fallback occupies.
  4. Packet fields are server-derived, bounded metadata. Full thread and memory bodies are explicit
     recipient-scoped reads, never packet fields.
  5. Telemetry/audit records delivery metadata, byte/age measurements, duration, and cost only.
  ```

- [ ] **Step 2: Update the normative and implementation-facing docs**

  In `SPEC.md`, add the additive wire shapes and compatibility rule:

  ```ts
  type WakeContextRequest = { act_id?: string; lane_id?: string };
  // Exactly one canonical target is required.

  type WakeContextPacket = {
    version: 1;
    wake: { kind: 'reply' | 'handoff' | 'review' | 'work_order'; act_id?: string; lane_id?: string };
    objective: { action: 'reply' | 'review' | 'continue_lane' | 'begin_lane' };
    state: { lane?: WakeContextLane; thread?: WakeContextThread; memory?: MemoryEnvelope };
    fetch: Array<'inbox_thread' | 'lane_detail' | 'seat_memory' | 'git_artifact'>;
    delivery: { requirement: ContinuityRequirement; intended: WakeDelivery };
  };
  ```

  Define `WakeContextLane` as `{ id, state, owner_seat, branch? }` and
  `WakeContextThread` as `{ id, participant_count, unread_count, latest_act? }`; no free-text
  fields are permitted. State that older clients retain the current ID-only wake + `team_next`
  path.

- [ ] **Step 3: Document evaluation before implementing it**

  Add ADR 207 Observability & Evaluation with: packet byte size; requirement/intended/actual
  delivery; transcript bytes/age examined by the host; fetch category/count; duration and
  allowance-equivalent cost. Set the comparison: fresh reply cohort versus present resume ladder,
  with no material regression in failed/duplicate wakes or lane completion latency.

- [ ] **Step 4: Run document checks**

  Run: `pnpm vocab:check && pnpm format:check`

  Expected: PASS. Confirm `change-adr:check` sees ADR 207 as a new decision and no accepted ADR's
  Decision section changed.

- [ ] **Step 5: Commit**

  ```bash
  git add SPEC.md docs/decisions/207-portable-wake-context.md
  git commit -m "docs: specify portable wake context (ADR 207)"
  ```

### Task 2: Add additive protocol schemas and delivery telemetry fields

**Files:**
- Modify: `packages/protocol/src/residency.ts`
- Modify: `packages/protocol/src/residency.test.ts`
- Modify: `packages/protocol/src/index.ts`
- Modify: `docs/architecture/02-protocol.md` (file-tree description if a new protocol file is used)

**Interfaces:**
- Consumes: ADR 207's exact vocabulary from Task 1.
- Produces:

  ```ts
  export const ContinuityRequirementSchema: z.ZodEnum<['portable', 'transcript_required']>;
  export const WakeDeliverySchema: z.ZodEnum<['fresh', 'resume']>;
  export const WakeDeliveryOutcomeSchema: z.ZodEnum<['fresh', 'resumed', 'fresh_fallback']>;
  export const WakeContextRequestSchema: z.ZodType<WakeContextRequest>;
  export const WakeContextPacketSchema: z.ZodType<WakeContextPacket>;
  ```

  `WakeOrderSchema` gains optional `continuity_requirement` and `intended_delivery` fields for
  rolling compatibility. `WakeReportBodySchema` gains optional `delivery_outcome`,
  `transcript_bytes`, and `transcript_age_ms` fields; all are non-content metadata.

- [ ] **Step 1: Write failing protocol tests**

  Add cases that assert:

  ```ts
  expect(WakeContextRequestSchema.safeParse({ act_id: 'A1' }).success).toBe(true);
  expect(WakeContextRequestSchema.safeParse({ lane_id: 'L1' }).success).toBe(true);
  expect(WakeContextRequestSchema.safeParse({}).success).toBe(false);
  expect(WakeContextRequestSchema.safeParse({ act_id: 'A1', lane_id: 'L1' }).success).toBe(false);

  expect(WakeContextPacketSchema.parse(packet).state.memory).toEqual({
    headline: 'resume checkout review', saved_at: 1, size_bytes: 42,
  });
  expect(() => WakeContextPacketSchema.parse({ ...packet, state: { thread: { body: 'leak' } } }))
    .toThrow();
  expect(WakeReportBodySchema.parse({
    lease_id: 'L1', occupied: true, delivery_outcome: 'fresh_fallback',
    transcript_bytes: 262144, transcript_age_ms: 3_000,
  }).delivery_outcome).toBe('fresh_fallback');
  ```

- [ ] **Step 2: Run the focused test and confirm it fails**

  Run: `pnpm exec vitest run packages/protocol/src/residency.test.ts`

  Expected: FAIL because the packet/request schemas and report fields are absent.

- [ ] **Step 3: Implement the schemas in `residency.ts`**

  Place all wake-context schemas beside `WakeOrderSchema`. Use strict object schemas for
  `WakeContextLane` and `WakeContextThread`; include only the fields fixed in Task 1. Use a
  `superRefine` on `WakeContextRequestSchema` to require exactly one of `act_id` and `lane_id`.
  Export types through `packages/protocol/src/index.ts`. Keep new order/report fields optional so
  a daemon and host may roll independently.

- [ ] **Step 4: Run protocol verification**

  Run: `pnpm --filter @musterd/protocol test && pnpm --filter @musterd/protocol build`

  Expected: PASS; existing `WakeOrderSchema` round trips remain valid without the additive fields.

- [ ] **Step 5: Commit**

  ```bash
  git add packages/protocol/src/residency.ts packages/protocol/src/residency.test.ts \
    packages/protocol/src/index.ts docs/architecture/02-protocol.md
  git commit -m "protocol: add portable wake-context contracts (ADR 207)"
  ```

### Task 3: Derive and authorize packet reads on the daemon

**Files:**
- Modify: `packages/server/src/store/residency.ts`
- Modify: `packages/server/src/store/residency.test.ts`
- Modify: `packages/server/src/transport/http.ts`
- Modify: `packages/server/src/transport/integration.test.ts`
- Modify: `packages/server/src/store/audit.ts`
- Modify: `docs/architecture/03-server.md`

**Interfaces:**
- Consumes: `WakeContextRequestSchema`, `WakeContextPacketSchema`, and delivery types from Task 2;
  existing recipient-delivery records, Lane store, and `MemoryEnvelope` projection.
- Produces: `POST /teams/:slug/wake-context` authenticated as the calling Member and returning
  `{ context: WakeContextPacket }`.
- Produces: `buildWakeContext(db, team, recipient, request): WakeContextPacket`, which either
  returns the bounded packet or throws `MusterdError('forbidden', ...)` before exposing target data.

- [ ] **Step 1: Write store tests for all four wake kinds and scoping**

  In `residency.test.ts`, seed a directed reply, handoff, review Act, and board work-order Lane.
  Assert these exact properties:

  ```ts
  expect(buildWakeContext(db, team, ada, { act_id: reply.id })).toMatchObject({
    wake: { kind: 'reply', act_id: reply.id },
    objective: { action: 'reply' },
    delivery: { requirement: 'portable', intended: 'fresh' },
    fetch: ['inbox_thread', 'seat_memory'],
  });
  expect(buildWakeContext(db, team, reviewer, { act_id: review.id }).objective.action).toBe('review');
  expect(buildWakeContext(db, team, owner, { lane_id: lane.id }).objective.action)
    .toBe('continue_lane');
  expect(() => buildWakeContext(db, team, unrelated, { act_id: reply.id })).toThrow(/forbidden/i);
  ```

  Also assert that JSON serialization contains neither the Act body nor the saved memory body.

- [ ] **Step 2: Add HTTP integration tests before routing**

  Exercise `POST /teams/dawn/wake-context` with the recipient token and `{act_id}`/`{lane_id}`.
  Assert 200 + protocol-valid `context` for an authorized target; 403 for an unrelated Member; 422
  for zero/both identifiers. Assert the server parses both request and response through protocol
  schemas at their boundaries.

- [ ] **Step 3: Implement canonical derivation and route**

  In `store/residency.ts`, derive kind/action only from canonical Act metadata and Lane state:

  | Source | `wake.kind` | `objective.action` | required fetch |
  | --- | --- | --- | --- |
  | directed reply/message | `reply` | `reply` | `inbox_thread` |
  | typed handoff | `handoff` | `continue_lane` | `inbox_thread`, `lane_detail`, `git_artifact` |
  | `meta.lane_review` Act | `review` | `review` | `inbox_thread`, `lane_detail`, `git_artifact` |
  | board continuation/work-order Lane | `work_order` | `begin_lane` or `continue_lane` from Lane state | `lane_detail`, `git_artifact` |

  Include the recipient's ADR 093 memory envelope when present, never its body. Define
  `transcript_required` nowhere in this increment: all returned packets are portable/fresh. Add
  `residency.context_read` to the audit union with only kind, packet byte size, and delivery fields.

- [ ] **Step 4: Add lease-decision telemetry without behavior change**

  When `claimWakeLeases` creates an order, include
  `continuity_requirement: 'portable'` and `intended_delivery: 'fresh'` only for work-order
  derivations in this increment; leave inbox wakes unset to preserve their current ladder. Audit the
  order's non-content decision fields in `residency.wake_leased`.

- [ ] **Step 5: Verify server behavior**

  Run: `pnpm --filter @musterd/server test`

  Expected: PASS, including recipient-scoping, no-content serialization, legacy inbox wake orders,
  and work-order packet derivation.

- [ ] **Step 6: Commit**

  ```bash
  git add packages/server/src/store/residency.ts packages/server/src/store/residency.test.ts \
    packages/server/src/transport/http.ts packages/server/src/transport/integration.test.ts \
    packages/server/src/store/audit.ts docs/architecture/03-server.md
  git commit -m "server: derive recipient-scoped wake context (ADR 207)"
  ```

### Task 4: Expose explicit context retrieval on CLI and MCP surfaces

**Files:**
- Modify: `packages/cli/src/client.ts`
- Create: `packages/cli/src/commands/wake-context.ts`
- Modify: `packages/cli/src/bin.ts`
- Modify: `packages/cli/src/help/catalog.ts`
- Create: `packages/cli/src/commands/wake-context.test.ts`
- Modify: `packages/mcp/src/client.ts`
- Create: `packages/mcp/src/tools/wakeContext.ts`
- Modify: `packages/mcp/src/index.ts`
- Modify: `packages/mcp/src/toolNames.ts`
- Modify: `packages/mcp/src/tools/tools.test.ts`
- Modify: `packages/mcp/src/tools/resultAudit.test.ts`
- Modify: `docs/architecture/04-cli.md`
- Modify: `docs/architecture/05-mcp.md`

**Interfaces:**
- Consumes: `POST /teams/:slug/wake-context` and `WakeContextPacket` from Task 3.
- Produces: `musterd wake-context --act <id>` and `musterd wake-context --lane <id>`.
- Produces: `team_wake_context({act_id? , lane_id?})`, with exactly-one validation matching the
  protocol request shape.

- [ ] **Step 1: Write surface tests first**

  CLI test cases must prove:

  ```ts
  await wakeContextCommand(parseArgs(['wake-context', '--act', 'A1', '--json']));
  expect(stdout()).toContain('"kind":"reply"');
  await expect(wakeContextCommand(parseArgs(['wake-context']))).rejects.toThrow(/--act or --lane/);
  ```

  MCP handler tests must prove it refuses before join, sends `{act_id:'A1'}` to the client after
  join, and renders a compact packet with a next-action line plus named explicit fetches — never a
  message or memory body. Add `team_wake_context` to the expected tool-name and structured-result
  audit sets.

- [ ] **Step 2: Run focused tests and confirm failure**

  Run:

  ```bash
  pnpm exec vitest run packages/cli/src/commands/wake-context.test.ts \
    packages/mcp/src/tools/tools.test.ts packages/mcp/src/tools/resultAudit.test.ts
  ```

  Expected: FAIL because neither command/tool nor client method exists.

- [ ] **Step 3: Implement typed client methods**

  Add `wakeContext(slug, request)` on the CLI HTTP client and `wakeContext(request)` on
  `MusterdClient`. Both POST to `/teams/:slug/wake-context`, parse the response with the protocol
  response schema, and reject a malformed daemon response with the existing surface error type.

- [ ] **Step 4: Implement CLI command and MCP tool**

  The CLI prints JSON unchanged under `--json`; human output renders only canonical IDs, state,
  intended delivery, and the explicit next fetch/tool names. The MCP tool returns the same bounded
  information as `structuredContent` and directs the Member to `team_memory_read`,
  `team_inbox_check`, `team_next`, or the declared artifact fetch as applicable. Do not automatically
  read any full body.

- [ ] **Step 5: Verify client surfaces**

  Run:

  ```bash
  pnpm --filter @musterd/cli test
  pnpm --filter @musterd/mcp test
  ```

  Expected: PASS with the new tool/command included in role-scoped and result-audit coverage.

- [ ] **Step 6: Commit**

  ```bash
  git add packages/cli/src packages/mcp/src docs/architecture/04-cli.md docs/architecture/05-mcp.md
  git commit -m "cli: expose bounded wake context (ADR 207)"
  ```

### Task 5: Make portable wake types fresh by default and report actual delivery

**Files:**
- Modify: `packages/cli/src/host/backends/claudeCode.ts`
- Modify: `packages/cli/src/host/backends/claudeCode.test.ts`
- Modify: `packages/cli/src/host/backend.ts`
- Modify: `packages/cli/src/host/loop.ts`
- Modify: `packages/cli/src/host/loop.test.ts`
- Modify: `packages/server/src/store/residency.ts`
- Modify: `packages/server/src/store/residency.test.ts`
- Modify: `packages/server/src/transport/http.ts`
- Modify: `packages/server/src/transport/integration.test.ts`
- Modify: `docs/architecture/03-server.md`
- Modify: `docs/architecture/04-cli.md`

**Interfaces:**
- Consumes: `WakeOrder.intended_delivery`; host-local liveness/transcript facts remain local.
- Produces: `WakeOutcome.delivery_outcome` plus optional `transcript_bytes` and
  `transcript_age_ms`; an intended `fresh` order skips `resumeLadder` entirely.

- [ ] **Step 1: Write host/backend tests**

  Add test cases around the existing `order()`/`spec()` helpers:

  ```ts
  it('portable fresh orders never invoke --resume even with a valid local capture', async () => {
    const outcome = await backend.wake(spec({ order: order({ intended_delivery: 'fresh' }) }), ctx());
    expect(spawnedArgs()).not.toContain('--resume');
    expect(outcome.outcome).toMatchObject({ session: 'fresh', delivery_outcome: 'fresh' });
  });

  it('resume failure reports fresh_fallback after the fallback occupies', async () => {
    const outcome = await backend.wake(spec({ order: order({ intended_delivery: 'resume' }) }), ctx());
    expect(outcome.outcome).toMatchObject({ session: 'fresh', delivery_outcome: 'fresh_fallback' });
  });
  ```

  In `loop.test.ts`, assert supplementary reports retain the same `delivery_outcome` and local
  measurements rather than overwriting the primary wake outcome.

- [ ] **Step 2: Run focused tests and confirm failure**

  Run: `pnpm exec vitest run packages/cli/src/host/backends/claudeCode.test.ts packages/cli/src/host/loop.test.ts`

  Expected: FAIL because the backend always enters the resume ladder when a capture exists and the
  report has no delivery metadata.

- [ ] **Step 3: Implement host delivery selection**

  In `ClaudeCodeBackend.wake`, branch before `resumeLadder`:

  ```ts
  const wantsResume = spec.order.intended_delivery === 'resume';
  if (!wantsResume) return freshAttemptWith({ delivery_outcome: 'fresh' });
  // Existing ladder remains the resume implementation; attach local byte/age facts when inspected.
  // If resume fails and fresh occupies, report delivery_outcome: 'fresh_fallback'.
  ```

  Preserve the current behavior when `intended_delivery` is absent so mixed-version daemon/host
  deployments retain the legacy ladder. Extend `WakeCompletion` only with metadata already known to
  the host; never pass session IDs or paths to the daemon.

- [ ] **Step 4: Select fresh for the portable kinds on the daemon**

  Extend `claimWakeLeases` so every work-order, handoff, and review candidate carries
  `{ continuity_requirement: 'portable', intended_delivery: 'fresh' }`. Add a feature-gated team
  policy flag for portable inbox replies; leave it `false` by default in this task. Its enabled
  state marks ordinary reply wake orders portable/fresh. Existing orders without the new field keep
  legacy behavior.

- [ ] **Step 5: Persist non-content report/audit evidence**

  Validate new report fields at the HTTP boundary and include them in `residency.woke`,
  `residency.wake_failed`, and `residency.wake_cost` detail only when present. Add integration tests
  that a host report stores byte/age/delivery metadata and no order/prompt/body content.

- [ ] **Step 6: Verify the increment**

  Run:

  ```bash
  pnpm --filter @musterd/cli test
  pnpm --filter @musterd/server test
  ```

  Expected: PASS. A valid capture must still resume for a legacy order, while a portable order is
  fresh even with that capture available.

- [ ] **Step 7: Commit**

  ```bash
  git add packages/cli/src/host packages/server/src/store/residency.ts \
    packages/server/src/store/residency.test.ts packages/server/src/transport/http.ts \
    packages/server/src/transport/integration.test.ts docs/architecture/03-server.md \
    docs/architecture/04-cli.md
  git commit -m "server: select fresh delivery for portable wakes (ADR 207)"
  ```

### Task 6: Add the narrow active-reply resume exception and evaluate it

**Files:**
- Modify: `packages/protocol/src/residency.ts`
- Modify: `packages/protocol/src/residency.test.ts`
- Modify: `packages/server/src/store/residency.ts`
- Modify: `packages/server/src/store/residency.test.ts`
- Modify: `packages/cli/src/host/backends/claudeCode.ts`
- Modify: `packages/cli/src/host/backends/claudeCode.test.ts`
- Modify: `packages/cli/src/commands/residency.ts`
- Modify: `packages/cli/src/commands/residency.test.ts`
- Modify: `docs/decisions/207-portable-wake-context.md` (Consequences and evaluation results only)
- Modify: `docs/architecture/03-server.md`
- Modify: `docs/architecture/04-cli.md`

**Interfaces:**
- Consumes: portable-fresh path and report metadata from Task 5.
- Produces: effective policy fields `resume_freshness_ms` and `resume_rate_cap`; both are evaluated
  only for the reply-only `transcript_required` classification.

- [ ] **Step 1: Write failing classification and policy tests**

  Add cases that assert:

  ```ts
  expect(classifyReplyContinuity({
    isDirectedReply: true, age_ms: 30_000, policy: { resume_freshness_ms: 60_000 },
  })).toEqual({ requirement: 'transcript_required', intended_delivery: 'resume' });

  expect(classifyReplyContinuity({
    isDirectedReply: false, age_ms: 1, policy,
  })).toEqual({ requirement: 'portable', intended_delivery: 'fresh' });

  expect(classifyReplyContinuity({
    isDirectedReply: true, age_ms: 60_001, policy: { resume_freshness_ms: 60_000 },
  })).toEqual({ requirement: 'portable', intended_delivery: 'fresh' });
  ```

  Add CLI residency-policy parsing/render tests for both new knobs. Add backend tests proving an
  over-byte-bound `transcript_required` order reports fresh (not `fresh_fallback`) because no resume
  was attempted, and that the existing fallback reserve remains intact on a failed resume.

- [ ] **Step 2: Run focused tests and confirm failure**

  Run:

  ```bash
  pnpm exec vitest run packages/protocol/src/residency.test.ts \
    packages/server/src/store/residency.test.ts packages/cli/src/host/backends/claudeCode.test.ts \
    packages/cli/src/commands/residency.test.ts
  ```

  Expected: FAIL because reply classification and the two effective-policy knobs do not exist.

- [ ] **Step 3: Implement the conservative exception**

  Add `resume_freshness_ms` (minimum 60 seconds, maximum 15 minutes, default 5 minutes) and
  `resume_rate_cap` (1–10 per hour, default 1) to `ResidencyPolicySchema` and its sparse override.
  In the server, classify only an unanswered directed reply Act from the same active thread as
  `transcript_required` when it is no older than `resume_freshness_ms` and the cap has not been
  consumed; all other reply Acts remain portable/fresh. Rate counting derives from the existing
  audit ledger's `delivery_outcome: 'resumed'`, not a new mutable counter.

  In the host, a transcript-required order still skips resume when capture age/bytes fail local
  checks; report `delivery_outcome: 'fresh'` and the measured reason. Never let sender text set the
  classification.

- [ ] **Step 4: Update ADR 207's Consequences with the rollout result**

  Add only a dated result note outside its immutable Decision section: cohort, observation count,
  p50/p95 cost comparison, byte distribution, fetch pattern, and whether the exception remains
  limited to active replies. Do not tune numeric bounds without repeated observations.

- [ ] **Step 5: Run full local verification and open the PR**

  Run:

  ```bash
  pnpm build
  pnpm typecheck
  pnpm format:check
  pnpm test
  ```

  Expected: PASS, including scenario B (MCP + CLI act/reply flow) and coverage. Then follow the
  repository workflow: create the PR, enable squash auto-merge, and submit the Lane for outcome
  acceptance after it lands.

- [ ] **Step 6: Commit**

  ```bash
  git add packages/protocol/src/residency.ts packages/protocol/src/residency.test.ts \
    packages/server/src/store/residency.ts packages/server/src/store/residency.test.ts \
    packages/cli/src/host/backends/claudeCode.ts packages/cli/src/host/backends/claudeCode.test.ts \
    packages/cli/src/commands/residency.ts packages/cli/src/commands/residency.test.ts \
    docs/decisions/207-portable-wake-context.md docs/architecture/03-server.md \
    docs/architecture/04-cli.md
  git commit -m "server: gate reply resume on active context (ADR 207)"
  ```

## Plan self-review

- **Spec coverage:** Tasks 1–2 make the design's packet, delivery, and protocol boundary
  normative and executable. Task 3 derives and scopes packets. Task 4 gives every supported client
  an explicit fetch surface. Task 5 makes portable wakes fresh and measures the outcome. Task 6
  adds the sole allowed transcript exception and its evaluation gate.
- **No placeholders:** All six tasks name files, interfaces, validation, test commands, expected
  behavior, and commits. Numeric defaults for the exception are fixed in Task 6 rather than left
  to the implementer.
- **Type consistency:** `portable`/`transcript_required`, `fresh`/`resume`, and
  `fresh`/`resumed`/`fresh_fallback` are distinct types throughout: requirement, intended delivery,
  and observed outcome respectively.
