# Interactive Slack ask replies Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task in the owning seat. Do not dispatch subagents: this repository requires attributable lane-owned writes.

**Goal:** Let an explicitly linked human Member answer an existing `ask` from Slack with the same `accept`, `decline`, or `wait` Act that `/live` emits.

**Architecture:** The existing Slack incoming webhook continues to deliver the ask, augmented with Block Kit controls when Socket Mode is configured. A daemon-owned Socket Mode supervisor acknowledges inbound Slack envelopes, validates their workspace, linked human Member, open ask, and recipient, then invokes `routeEnvelope` with an internally composed ordinary reply. SQLite holds the human link and an interaction idempotency key; Slack owns no musterd decision state.

**Tech Stack:** TypeScript, Zod in `@musterd/protocol`, SQLite/better-sqlite3, existing `ws` dependency, Node 22 `fetch`, Slack Socket Mode and Block Kit, Vitest.

**Spec:** `docs/superpowers/specs/2026-08-19-slack-interactive-ask-replies-design.md`

## Global Constraints

- ADR 289 is authoritative: Slack is an opt-in ask-reply Surface, never a Slack-created Member or free-form inbox.
- Parse every Slack payload, HTTP body, and CLI argument through `@musterd/protocol` schemas at its boundary.
- Do not add a runtime dependency; use the existing `ws` package and Node 22 `fetch`.
- Never log or audit Slack app tokens, webhook URLs, raw Slack payloads, or ask bodies.
- A Slack action is an internally composed ordinary `accept`, `decline`, or `wait` envelope and follows `routeEnvelope`; it does not write a second decision store.
- Existing Teams remain outbound-webhook-only until an admin configures Socket Mode and explicitly links a human Member.
- Update `SPEC.md`, architecture docs, CLI help, and the roadmap source in the same change as code.
- Before every commit, use the seat trailer `Co-authored-by: gptbot <gptbot@revive.musterd>`.

---

## File structure

- `packages/protocol/src/slack.ts` — Slack configuration, link, external action, and Block Kit value schemas shared at all boundaries.
- `packages/protocol/src/credentials.ts` — sparse Team policy fields for Slack workspace and app token.
- `packages/server/src/db/migrations.ts` — schema v42: `members.slack_user_id`, uniqueness index, and replay ledger.
- `packages/server/src/store/slack.ts` — durable Member-link and interaction-claim operations.
- `packages/server/src/notify/slack.ts` — existing webhook formatter upgraded to plain-text fallback plus Block Kit payloads and best-effort response updates.
- `packages/server/src/notify/slackSocket.ts` — reconnecting Socket Mode transport and explicit external-envelope acknowledgement.
- `packages/server/src/protocol/slack.ts` — server-only Slack action authorization and composition into `routeEnvelope`.
- `packages/server/src/index.ts` — starts, refreshes, and stops the Socket Mode supervisor with the daemon lifecycle.
- `packages/server/src/transport/http.ts` — admin-only Member link routes and policy-triggered Socket Mode refresh.
- `packages/cli/src/commands/team.ts` and `packages/cli/src/help/catalog.ts` — policy flags and `team slack link|unlink` administration.
- `packages/server/src/notify/*.test.ts`, `packages/server/src/store/slack.test.ts`, and `packages/server/src/transport/integration.test.ts` — unit, store, and end-to-end coverage.

### Task 1: Define the contract and durable Slack state

**Files:**
- Create: `packages/protocol/src/slack.ts`
- Modify: `packages/protocol/src/index.ts`
- Modify: `packages/protocol/src/credentials.ts`
- Modify: `packages/protocol/src/credentials.test.ts`
- Modify: `packages/server/src/db/migrations.ts`
- Modify: `packages/server/src/store/rows.ts`
- Create: `packages/server/src/store/slack.ts`
- Create: `packages/server/src/store/slack.test.ts`
- Modify: `docs/architecture/01-data-model.md`
- Modify: `SPEC.md`

**Interfaces:**
- Produces `SlackWorkspaceIdSchema`, `SlackUserIdSchema`, `SlackActionSchema`, and `SlackActionKind` for every external Slack boundary.
- Produces sparse `Policy` fields `ask_slack_workspace_id?: string` and `ask_slack_app_token?: string`.
- Produces `setSlackMemberLink(db, teamId, memberName, slackUserId)`, `clearSlackMemberLink(db, teamId, memberName)`, `findLinkedSlackHuman(db, teamId, slackUserId)`, and `claimSlackInteraction(db, teamId, deliveryId)`.

- [ ] **Step 1: Write the failing protocol and store tests**

```ts
it('keeps Slack configuration absent until every Socket Mode field is supplied', () => {
  expect(PolicySchema.parse({}).ask_slack_app_token).toBeUndefined();
  expect(SlackActionSchema.safeParse({ type: 'block_actions' }).success).toBe(false);
});

it('permits one Slack account for one active human Member in a Team', () => {
  setSlackMemberLink(db, team.id, 'nick', 'U01NICK');
  expect(() => setSlackMemberLink(db, team.id, 'ada', 'U01NICK')).toThrow(/linked/);
  expect(findLinkedSlackHuman(db, team.id, 'U01NICK')?.name).toBe('nick');
});

it('claims an external delivery exactly once', () => {
  expect(claimSlackInteraction(db, team.id, 'envelope-1')).toBe(true);
  expect(claimSlackInteraction(db, team.id, 'envelope-1')).toBe(false);
});
```

- [ ] **Step 2: Run the focused tests and verify they fail**

Run: `pnpm --filter @musterd/protocol test -- credentials.test.ts && pnpm --filter @musterd/server test -- store/slack.test.ts`

Expected: FAIL because the Slack schemas, store module, and migration do not exist.

- [ ] **Step 3: Add boundary schemas and policy fields**

Create `slack.ts` with strict, bounded string schemas and an action discriminator:

```ts
export const SlackWorkspaceIdSchema = z.string().min(1).max(128);
export const SlackUserIdSchema = z.string().min(1).max(128);
export const SlackActionKindSchema = z.enum(['accept', 'decline', 'defer_1h']);
export const SlackActionSchema = z.object({
  delivery_id: z.string().min(1).max(256),
  workspace_id: SlackWorkspaceIdSchema,
  user_id: SlackUserIdSchema,
  action: SlackActionKindSchema,
  team: z.string().min(1).max(32),
  ask_id: z.string().min(1).max(128),
  response_url: z.string().url().optional(),
});
```

Export the schemas from `index.ts`. Add optional `ask_slack_workspace_id` and `ask_slack_app_token` to `PolicySchema`; preserve the sparse-write behavior of `PolicyOverrideSchema`.

- [ ] **Step 4: Add migration v42 and isolated store functions**

Migration v42 must add nullable `members.slack_user_id`, create a partial unique index for non-null `(team_id, slack_user_id)`, and create:

```sql
CREATE TABLE slack_interactions (
  team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  delivery_id TEXT NOT NULL,
  received_at INTEGER NOT NULL,
  PRIMARY KEY (team_id, delivery_id)
);
```

`setSlackMemberLink` must require `kind === 'human'` and `left_at IS NULL`, then let SQLite enforce uniqueness. `claimSlackInteraction` must use `INSERT OR IGNORE` and return whether one row was inserted. Keep raw payloads out of both tables.

- [ ] **Step 5: Run the focused tests and verify they pass**

Run: `pnpm --filter @musterd/protocol test -- credentials.test.ts && pnpm --filter @musterd/server test -- store/slack.test.ts`

Expected: PASS, including migration from schema 41 and duplicate-link/replay cases.

- [ ] **Step 6: Update the normative and data-model documentation**

Document v42, the optional Team policy configuration, the Member-local Slack id, and the idempotency ledger. State that the link is admin-only and not part of ordinary roster reads.

- [ ] **Step 7: Commit the contract and migration**

```bash
git add packages/protocol packages/server/src/db/migrations.ts packages/server/src/store/slack.ts \
  packages/server/src/store/slack.test.ts docs/architecture/01-data-model.md SPEC.md
git commit -m "add Slack reply contracts and state" -m "Refs ADR-289" \
  -m "Co-authored-by: gptbot <gptbot@revive.musterd>"
```

### Task 2: Add admin configuration and explicit human linking

**Files:**
- Modify: `packages/server/src/transport/http.ts`
- Modify: `packages/server/src/transport/policy-http.test.ts`
- Modify: `packages/server/src/transport/integration.test.ts`
- Modify: `packages/cli/src/commands/team.ts`
- Modify: `packages/cli/src/commands/team.test.ts`
- Modify: `packages/cli/src/help/catalog.ts`
- Modify: `packages/cli/src/commands/helpers.ts`

**Interfaces:**
- Consumes `SlackWorkspaceIdSchema`, `SlackUserIdSchema`, and the Task 1 store functions.
- Produces admin-only `PUT /teams/:slug/members/:name/slack-link` and `DELETE /teams/:slug/members/:name/slack-link`.
- Produces `musterd team slack link <member> <slack-user-id>` and `musterd team slack unlink <member>`.

- [ ] **Step 1: Write failing transport and CLI tests**

```ts
it('requires an admin to link a Slack account and never returns it in the roster', async () => {
  await put('/teams/dawn/members/nick/slack-link', bearer(admin), { user_id: 'U01NICK' });
  expect((await get('/teams/dawn/members', bearer(admin))).json.members[0]).not.toHaveProperty('slack_user_id');
  expect((await put('/teams/dawn/members/nick/slack-link', bearer(agent), { user_id: 'U01BAD' })).status).toBe(403);
});

it('clears Socket Mode configuration only as a complete pair', async () => {
  const r = await runCli('team policy --ask-slack-workspace T01 --ask-slack-app-token xapp-1');
  expect(r.stdout).toContain('Slack interactive replies on');
});
```

- [ ] **Step 2: Run the focused tests and verify they fail**

Run: `pnpm --filter @musterd/server test -- transport/policy-http.test.ts && pnpm --filter @musterd/cli test -- commands/team.test.ts`

Expected: FAIL because link routes and CLI subcommands/flags are absent.

- [ ] **Step 3: Implement the admin routes and audits**

Use the same `authAdmin` guard as Team policy routes. Parse `{ user_id }` through `SlackUserIdSchema`; resolve the named Member through the store; use `setSlackMemberLink` or `clearSlackMemberLink`. Add audit actions `slack.linked` and `slack.unlinked` with only Member name and Slack user id classification, never a token or raw payload.

- [ ] **Step 4: Implement policy and CLI administration**

Add `--ask-slack-workspace <id|off>` and `--ask-slack-app-token <xapp token>` to `team policy`. Setting a workspace requires an app token in the same invocation; `off` deletes both sparse keys. Mask the token in all CLI output. Add the `team slack` dispatcher with exactly `link` and `unlink`; parse positional arguments before calling the HTTP client.

- [ ] **Step 5: Run focused tests and verify they pass**

Run: `pnpm --filter @musterd/server test -- transport/policy-http.test.ts transport/integration.test.ts && pnpm --filter @musterd/cli test -- commands/team.test.ts`

Expected: PASS for admin-only authorization, human-only unique links, masked output, and sparse configuration clearing.

- [ ] **Step 6: Commit the administration boundary**

```bash
git add packages/server/src/transport packages/cli/src/commands/team.ts \
  packages/cli/src/commands/team.test.ts packages/cli/src/help/catalog.ts
git commit -m "add Slack reply administration" -m "Refs ADR-289" \
  -m "Co-authored-by: gptbot <gptbot@revive.musterd>"
```

### Task 3: Make outbound ask notifications interactive without regressing fallback delivery

**Files:**
- Modify: `packages/server/src/notify/slack.ts`
- Modify: `packages/server/src/notify/slack.test.ts`
- Modify: `packages/server/src/protocol/route.ts`
- Modify: `packages/server/src/transport/integration.test.ts`

**Interfaces:**
- Consumes `Policy.ask_slack_workspace_id` and `Policy.ask_slack_app_token`.
- Produces `type SlackBlock = Record<string, unknown>`, `formatAskSlackPayload(input): { text: string; blocks?: SlackBlock[] }`, and `postSlackWebhook(url, payload)`.
- Preserves existing plain-text webhook behavior when Socket Mode is not completely configured.

- [ ] **Step 1: Write failing formatter and route tests**

```ts
it('adds three Block Kit actions only for a fully configured Socket Mode Team', () => {
  expect(formatAskSlackPayload({ ...ask, interactive: true }).blocks).toEqual(
    expect.arrayContaining([expect.objectContaining({ type: 'actions' })]),
  );
  expect(formatAskSlackPayload({ ...ask, interactive: false }).blocks).toBeUndefined();
});

it('keeps a webhook send successful when Slack returns no interactive response channel', async () => {
  await sendAskWithSlackConfiguredOnlyAsWebhook();
  expect(audit()).toContainEqual(expect.objectContaining({ action: 'ask.surfaced', result: 'allow' }));
});
```

- [ ] **Step 2: Run the focused tests and verify they fail**

Run: `pnpm --filter @musterd/server test -- notify/slack.test.ts transport/integration.test.ts`

Expected: FAIL because the formatter only emits text and has no interactive mode.

- [ ] **Step 3: Implement deterministic Block Kit payloads**

Keep the existing accessible top-level `text`. When `interactive` is true, add one `actions` block with action ids `musterd.ask.accept`, `musterd.ask.decline`, and `musterd.ask.defer_1h`; each button value is `JSON.stringify({ team, ask_id })`. Use `primary` only for Approve and `danger` only for Deny. Pass `env.id` into the formatter from `dispatchAskToSlack`.

- [ ] **Step 4: Preserve detached delivery semantics**

Change `postSlackWebhook` to POST `{ text, blocks? }`, still using the five-second abort and still resolving `{ ok, status? }` rather than throwing. `dispatchAskToSlack` remains after persistence/delivery and only adds blocks when both new policy fields exist; the existing webhook-only Team sees the prior text unchanged.

- [ ] **Step 5: Run focused tests and verify they pass**

Run: `pnpm --filter @musterd/server test -- notify/slack.test.ts transport/integration.test.ts`

Expected: PASS for button shape, exact value payload, plain fallback, webhook failure isolation, and redacted `ask.surfaced` audit detail.

- [ ] **Step 6: Commit interactive outbound delivery**

```bash
git add packages/server/src/notify/slack.ts packages/server/src/notify/slack.test.ts \
  packages/server/src/protocol/route.ts packages/server/src/transport/integration.test.ts
git commit -m "render Slack ask reply controls" -m "Refs ADR-289" \
  -m "Co-authored-by: gptbot <gptbot@revive.musterd>"
```

### Task 4: Build the Socket Mode supervisor and external-envelope parser

**Files:**
- Create: `packages/server/src/notify/slackSocket.ts`
- Create: `packages/server/src/notify/slackSocket.test.ts`
- Modify: `packages/server/src/index.ts`
- Modify: `docs/architecture/03-server.md`

**Interfaces:**
- Produces `SlackSocketSupervisor` with `start()`, `refresh()`, and `stop()`.
- Consumes a transport adapter `{ openConnection(token): Promise<WebSocket>; post(url, init): Promise<Response> }` so tests do not contact Slack.
- Calls `onAction(SlackAction)` only after acknowledging the Socket Mode external envelope.

- [ ] **Step 1: Write failing supervisor tests with a fake transport**

```ts
it('acknowledges an interactive envelope before invoking the action handler', async () => {
  const order: string[] = [];
  const supervisor = makeSupervisor({ onAck: () => order.push('ack'), onAction: () => order.push('action') });
  await supervisor.receive(interactiveEnvelope('E1'));
  expect(order).toEqual(['ack', 'action']);
});

it('replaces and reconnects a Slack-requested disconnect with bounded backoff', async () => {
  const supervisor = makeSupervisor();
  await supervisor.receive({ envelope_id: 'E2', type: 'disconnect', reason: 'refresh_requested' });
  expect(supervisor.retryDelayMs()).toBeGreaterThan(0);
  expect(supervisor.retryDelayMs()).toBeLessThanOrEqual(30_000);
});
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run: `pnpm --filter @musterd/server test -- notify/slackSocket.test.ts`

Expected: FAIL because the supervisor does not exist.

- [ ] **Step 3: Implement the supervisor with the existing `ws` dependency**

Open `https://slack.com/api/apps.connections.open` with `Authorization: Bearer <xapp token>`, parse the returned dynamic URL, and connect with `ws`. For every received Socket Mode envelope with an `envelope_id`, send `{ envelope_id }` before asynchronous action processing. Parse only `interactive` envelopes containing a `block_actions` payload; ignore and audit malformed/unsupported types without logging raw content. Use exponential delays capped at 30 seconds; reset the delay after a successful open.

- [ ] **Step 4: Wire lifecycle ownership into the daemon**

Create the supervisor during `createServer`, call `start()` after `listen()`, call `refresh()` after a successful policy update, and call `stop()` before WebSocket/http/database shutdown. A Team without both Socket Mode policy fields owns no Slack connection.

- [ ] **Step 5: Run focused tests and verify they pass**

Run: `pnpm --filter @musterd/server test -- notify/slackSocket.test.ts`

Expected: PASS for acknowledgement order, malformed payload isolation, replacement connection, capped retry, configuration refresh, and clean stop.

- [ ] **Step 6: Update the server architecture and commit**

Add `notify/slackSocket.ts` to the architecture file tree and startup/shutdown sequence.

```bash
git add packages/server/src/notify/slackSocket.ts packages/server/src/notify/slackSocket.test.ts \
  packages/server/src/index.ts docs/architecture/03-server.md
git commit -m "supervise Slack Socket Mode" -m "Refs ADR-289" \
  -m "Co-authored-by: gptbot <gptbot@revive.musterd>"
```

### Task 5: Authorize Slack actions and route ordinary reply envelopes

**Files:**
- Create: `packages/server/src/protocol/slack.ts`
- Create: `packages/server/src/protocol/slack.test.ts`
- Modify: `packages/server/src/store/messages.ts`
- Modify: `packages/server/src/store/audit.ts`
- Modify: `packages/server/src/protocol/route.ts`
- Modify: `packages/server/src/notify/slackSocket.ts`
- Modify: `packages/server/src/transport/integration.test.ts`

**Interfaces:**
- Produces `handleSlackAction(ctx, action): Promise<'accepted' | 'rejected' | 'duplicate'>`.
- Consumes Task 1's `claimSlackInteraction` and `findLinkedSlackHuman` plus the Socket Mode `SlackAction`.
- Produces only ordinary `accept`, `decline`, or `wait` envelopes via `routeEnvelope`.

- [ ] **Step 1: Write failing authorization and parity tests**

```ts
it('routes an eligible linked human Slack approval exactly as /live does', async () => {
  await handleSlackAction(ctx, slackAction({ user_id: 'U01NICK', action: 'accept', ask_id: ask.id }));
  expect(lastMessage(db)).toMatchObject({
    act: 'accept', from: 'nick', thread_id: ask.id, meta: { in_reply_to: ask.id },
  });
});

it.each(['wrong_workspace', 'unlinked_user', 'agent_member', 'closed_ask', 'wrong_recipient'])
('rejects %s without appending an Act', async (caseName) => {
  await expect(runRejectedSlackCase(caseName)).resolves.toBe('rejected');
  expect(replyCount(db)).toBe(0);
});

it('does not append a second Act when Slack redelivers an acknowledged envelope', async () => {
  await handleSlackAction(ctx, slackAction({ delivery_id: 'E1' }));
  await handleSlackAction(ctx, slackAction({ delivery_id: 'E1' }));
  expect(replyCount(db)).toBe(1);
});
```

- [ ] **Step 2: Run the focused tests and verify they fail**

Run: `pnpm --filter @musterd/server test -- protocol/slack.test.ts transport/integration.test.ts`

Expected: FAIL because Slack actions have no server-side authorization or envelope composition.

- [ ] **Step 3: Implement server-side eligibility and composition**

In one SQLite transaction, claim the delivery id; find the Team by slug and require its configured workspace id to equal `action.workspace_id`; resolve an active linked human Member; load the referenced message; require `act === 'ask'`; reject an ask already answered, deferred, held, risk-accepted, stranded, or resolved; and require either `ask.to.kind !== 'member'` or `ask.to.name === member.name`.

Compose exactly:

```ts
const reply = makeEnvelope({
  id: ulid(), team: team.slug, from: member.name,
  to: { kind: 'member', name: ask.from },
  act: action.action === 'defer_1h' ? 'wait' : action.action,
  body: action.action === 'defer_1h' ? 'deciding — check back in 1h' : '',
  thread: ask.thread ?? ask.id,
  meta: action.action === 'defer_1h'
    ? { ask_ref: ask.id, until: '1h' }
    : { in_reply_to: ask.id },
});
routeEnvelope(ctx, team, member, reply, undefined, true);
```

Add bounded audit actions `slack.action_accepted`, `slack.action_rejected`, and `slack.action_duplicate`; their detail may name result category and action kind but never include tokens, URLs, raw payloads, or bodies.

- [ ] **Step 4: Add best-effort settled-message feedback**

When `action.response_url` is present, POST a concise Slack response after routing: “Approved by <Member>”, “Denied by <Member>”, or “Deciding — check back in 1h.” Treat this as detached cosmetic output. Record an outcome audit if it fails, but never throw after a routed reply.

- [ ] **Step 5: Run focused tests and verify they pass**

Run: `pnpm --filter @musterd/server test -- protocol/slack.test.ts transport/integration.test.ts`

Expected: PASS for `/live` parity, all rejection categories, transactional dedupe, and failed response-url isolation.

- [ ] **Step 6: Commit inbound action routing**

```bash
git add packages/server/src/protocol/slack.ts packages/server/src/protocol/slack.test.ts \
  packages/server/src/store/messages.ts packages/server/src/store/audit.ts \
  packages/server/src/notify/slackSocket.ts packages/server/src/transport/integration.test.ts
git commit -m "route Slack ask replies as member Acts" -m "Refs ADR-289" \
  -m "Co-authored-by: gptbot <gptbot@revive.musterd>"
```

### Task 6: Finish documentation, regression coverage, and owner-run verification

**Files:**
- Modify: `docs/architecture/02-protocol.md`
- Modify: `docs/architecture/03-server.md`
- Modify: `docs/architecture/04-cli.md`
- Modify: `content/roadmap.data.ts`
- Regenerate: `ROADMAP.md` via `pnpm roadmap:gen`
- Modify: `docs/decisions/289-slack-interactive-ask-replies.md`

**Interfaces:**
- Documents the Socket Mode policy pair, Member linking commands, interaction guard, retry behavior, and no-public-ingress boundary.
- Changes the roadmap from a generic Slack stub to a shipped interactive ask-reply increment while retaining a broader Slack Surface as reserved work.

- [ ] **Step 1: Write failing end-to-end regression assertions**

```ts
it('keeps webhook-only Teams compatible while a Socket Mode Team completes a Slack reply', async () => {
  await raiseAsk(webhookOnlyTeam);
  expect(lastWebhookPayload()).toEqual(expect.objectContaining({ text: expect.any(String) }));
  expect(lastWebhookPayload().blocks).toBeUndefined();

  await raiseAsk(socketModeTeam);
  await clickSlackButton(linkedHuman, 'musterd.ask.accept');
  expect(await inboxFor(askingMember)).toContainEqual(expect.objectContaining({ act: 'accept' }));
});
```

- [ ] **Step 2: Run the full server package test suite**

Run: `pnpm --filter @musterd/server test`

Expected: PASS, including every existing webhook and ask-stream regression test plus the new interactive cases.

- [ ] **Step 3: Update docs and regenerate the roadmap**

Document exact CLI commands, required Slack app configuration (`connections:write`, Socket Mode, Block Kit interactivity), secret handling, failure behavior, and the owner-run dogfood procedure. Update only `content/roadmap.data.ts`, then run `pnpm roadmap:gen`; do not hand-edit generated roadmap content.

- [ ] **Step 4: Run repository fast gates**

Run: `pnpm -r build && pnpm typecheck && pnpm format:check`

Expected: PASS. Resolve every source-tree, docs-tree, protocol-schema, vocabulary, and ADR check before pushing.

- [ ] **Step 5: Perform the owner-run Slack dogfood check**

1. Configure a development Slack app with Socket Mode and its app-level token.
2. Set the webhook, workspace id, and app token through the admin policy command.
3. Link one human Member through `musterd team slack link <member> <slack-user-id>`.
4. Raise one `ask` at that Member; click each action in separate asks.
5. Confirm `/live`, `musterd inbox`, and audit each show the exact ordinary reply Act.
6. Redeliver one captured external envelope through the test harness and confirm one persisted reply.
7. Clear the Socket Mode policy pair and unlink the Member; confirm the Team returns to plain webhook-only behavior.

- [ ] **Step 6: Commit docs and verification evidence**

```bash
git add docs/architecture/02-protocol.md docs/architecture/03-server.md docs/architecture/04-cli.md \
  content/roadmap.data.ts ROADMAP.md docs/decisions/289-slack-interactive-ask-replies.md
git commit -m "document interactive Slack ask replies" -m "Refs ADR-289" \
  -m "Co-authored-by: gptbot <gptbot@revive.musterd>"
```

## Plan self-review

- **Spec coverage:** Tasks 1–2 implement opt-in configuration and explicit human Member links; Task 3 preserves outbound delivery while adding controls; Task 4 owns local-first Socket Mode lifecycle; Task 5 provides identity, audience, open-state, and replay guards plus `/live` envelope parity; Task 6 covers compatibility, documentation, generated roadmap, and owner-run evaluation.
- **Placeholder scan:** No deferred implementation wording, unnamed validators, or unspecified tests remain; every Task names files, interfaces, commands, and expected results.
- **Type consistency:** `SlackAction` is defined in Task 1, consumed by Task 4 and Task 5; `claimSlackInteraction` is defined in Task 1 and used only by Task 5; all reply kinds map to protocol acts already defined by the existing ask stream.
