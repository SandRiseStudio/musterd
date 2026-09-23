# The doorbell (lane 4 of reach & boundaries) — implementation plan

> **For agentic workers:** implement this plan task-by-task in your own seat
> (`superpowers:executing-plans`). Do **not** dispatch writing subagents — AGENTS.md hard rule 8.
> Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Something addressed to a human rings them through surfaces musterd owns — `/live`, an OS
banner, Slack, or a generic webhook — chosen by team defaults and the human's own overrides, and
never through a harness session.

**Architecture:** One pure decision and one small adapter per surface:
1. `routeEnvelope` asks a pure protocol function *"does this act ring a human, and whom?"*.
2. The daemon composes one **doorbell record** from structured fields only (no body).
3. A per-human **route** is resolved: team allow-list ∩ team defaults, overridden by the human's
   own prefs, then filtered by availability.
4. Each sink gets the record, one attempt, detached from the send path, and audits
   `doorbell.surfaced {surface, ok, status?}`.
   - `slack`, `webhook` — the daemon POSTs (ADR 149's dispatch, moved behind the sink interface).
   - `os` — the daemon queues the ring; the **host** LaunchAgent on the human's machine polls and
     raises the banner (`notify/os.ts`, already shipped).
   - `live` — always on; `/live` already receives the envelope over the firehose. The tab adds a
     browser `Notification`.

**Tech stack:** TypeScript, zod (`@musterd/protocol`), better-sqlite3 (`@musterd/server`), the host
poll loop (`@musterd/cli`), React (`@musterd/web`), vitest.

**Spec:** `docs/superpowers/specs/2026-09-23-reach-and-boundaries-design.md` — §1 (all of it), §7.
The doorbell is spec lane 4: independent of the wall and running beside it.

## Ownership

izzo owns lane `01M37QFX4M6MFXJB3Z1KYEQMZE` and every task in it. dolly reviews this plan before any
code, and reviews each PR against the spec before it merges. Acceptor: **big-body**, named at
`lane_submit`.

The lane ships as three PRs. Each one merges to `main` on its own and leaves every existing surface
working.

| PR | Tasks | What a human sees after it merges |
| --- | --- | --- |
| A — record, routing, server sinks | 0, 1, 2, 3, 4 | Slack exactly as today (now via the sink). Webhook sink available. `doorbell.surfaced` audit rows. |
| B — the `os` sink | 5 | An OS banner on the human's own machine, with no `musterd notify` running. |
| C — `/live` notification, CLI, docs | 6, 7, 8 | A browser notification from an open `/live` tab. `musterd doorbell` to set your own sinks. |

**Overlap with the wall (lane 1)** — four shared files, all in different regions:

| File | Wall sub-lane | Wall edits | This lane edits |
| --- | --- | --- | --- |
| `packages/protocol/src/feature-epoch.ts` | 1a (dolly) | the wall's epoch | the doorbell's epoch |
| `packages/server/src/transport/http.ts` | 1b (stanley) | the hint block (~3935), `composeInterruptLine` (~785) | availability POST (~941), new `/members/*/doorbell` and `/doorbell/rings` routes |
| `packages/cli/src/commands/team.ts` | 1d (dolly) | `team create --as` → `--member` (~687) | `team policy` doorbell flags (~337–483) |
| `packages/cli/src/help/catalog.ts` | 1d (dolly) | `--as` help lines | `doorbell` and `team policy` entries |

Rule: whichever PR lands second rebases, and never rewrites the other's hunk. The epoch file is the
only real contention (two appends to one list). The wall takes its epoch first. This lane takes the
next number at rebase time, not at plan time.

## Global constraints

- `pnpm` is `/Users/nick/Library/pnpm/pnpm` on this laptop (not on the harness PATH).
- **Protocol changes are ADR-gated** (AGENTS.md rule 1). ADR 443 covers every change here. Commit
  footer on each commit: `Refs ADR-443`.
- Docs and code never disagree at the end of a commit (rule 3). New source files get a described
  line in their package's `docs/architecture` file tree (`arch-trees:check`).
- **Never log secrets** (rule 5). A sink URL — team or personal — is never logged, audited, echoed
  in an error, or returned to anyone but its owner. Audit detail is `{surface, ok, status?}` only.
- **The record carries no body** (ADR 088 §4). The one exception is the `slack` sink, which keeps
  ADR 149's deliberate body-to-human rule. The body is read at dispatch from the envelope; it is
  never stored in the record, the ring queue, or any audit row.
- **The send path never waits on a sink.** Every sink runs after persist + deliver, detached, one
  attempt, and never throws into `routeEnvelope`.
- **Nothing addressed to a human is delivered through a harness session** (spec §1). No sink may
  resolve, list, or message a harness session. The `os` sink raises a banner, not a session line.
- §7 honesty: ADR 443 states that the doorbell protects against model mistakes, not against a
  hostile same-user process.
- Fast gates before every push: `pnpm typecheck && pnpm lint && pnpm format:check`.

## Review focus

1. **A team-addressed `ask`.** ADR 147 routes a team-addressed ask to admin humans. Expect: it rings
   every admin human. Spec §1's "team-addressed acts do not ring" is read as covering `request_help`,
   `handoff` and review acts, never `ask`. *dolly: confirm this reading.* Pinned in Task 1.
2. **A present human.** ADR 155 Increment 2 keeps Slack quiet at raise when an admin human composes
   as present, and fires on the agent's re-notify. Expect: that modulation carries over to every
   *off-machine* sink (`slack`, `webhook`), while `live` and `os` ring at once. *dolly: confirm, or
   say it should be dropped.* Pinned in Task 2.
3. **`dnd` + `blocking`.** Expect: the ring pierces. `dnd` + `standard`: held, then rung when the
   human goes `available` if the act is still open. `away` and `off_hours` hold the same way (the
   `reachability.ts` away set). Pinned in Task 2.
4. **An admin reading a teammate's prefs.** Expect: `{sink: 'webhook', on: true, personal: true}`,
   never the URL. Pinned in Task 3.
5. **An old policy blob with `ask_slack_webhook`.** Expect: it becomes the team's default `slack`
   sink with no admin action, and Slack keeps firing byte-for-byte as before. Pinned in Task 3.
6. **The `os` sink on a machine the human is not on.** Expect: nothing. A ring carries a host
   label, and only the host enrolled under that label raises it. Pinned in Task 5.
7. **Dead sink endpoint.** Expect: the send returns at normal latency, one `doorbell.surfaced
   {ok:false}` row, no retry. Pinned in Task 4.

---

### Task 0: ADR 443 (already reserved — draft PR #1666)

**Files:**
- Modify: `docs/decisions/443-the-doorbell.md` (the reservation stub)
- Modify: `docs/decisions/149-ask-surfaces.md`, `docs/decisions/222-answerable-asks-on-live.md`
  (dated "extended by ADR 443" notes)

- [ ] **Step 1:** Write the ADR: Context (the incident, spec §1), Problem, Decision, Consequences.
  The Decision records:
  - What rings: every `ask`; `request_help`, `handoff`, and `lane_review` asks when **directed** to
    a human member. Team-addressed `request_help`/`handoff` do not ring.
  - The record's fields (Task 1), and that it carries no body. The `slack` exception, per ADR 149.
  - The four sinks and their interface. `live` is always on and cannot be switched off.
  - Routing: team allow-list and defaults, per-human overrides, availability holds, `blocking`
    pierces `dnd` (ADR 044).
  - Privacy of personal URLs (review focus 4).
  - `ask_slack_webhook` is read as the team's default `slack` sink. `ask.surfaced` generalizes to
    `doorbell.surfaced`, and the old action name stays readable in audit queries.
  - The `os` sink runs on the host, not the daemon, and why: the daemon may be a synced peer on
    another machine, and the host is the one process already running on the human's own machine.
  - Considered and rejected: a desk session (spec §1); an `os` sink in the daemon; retrying or
    queueing off-machine sinks.
  - The §7 sentence, verbatim.
- [ ] **Step 2:** Commit `docs: ADR 443 — the doorbell` with the seat trailer and `Refs ADR-443`.

### Task 1: Protocol — the record, the ring rule, and the prefs schema

**Files:**
- Create: `packages/protocol/src/doorbell.ts` (+ export from `index.ts`, arch-tree line)
- Modify: `packages/protocol/src/credentials.ts` — `PolicySchema.doorbell`
- Modify: `packages/protocol/src/feature-epoch.ts` (new epoch)
- Test: `packages/protocol/src/doorbell.test.ts`

**Interfaces — produces:**
- `DOORBELL_SINKS = ['live', 'os', 'slack', 'webhook'] as const`
- `DoorbellRecordSchema` — `{team, from, act, species?, tier?, act_id, deadline_ms?, answer_path}`
- `ringTargets(input): string[]` — the human member names this act rings
- `DoorbellPolicySchema` (team) and `DoorbellPrefsSchema` (per human)
- `resolveRoute(policy, prefs, tier): DoorbellSink[]`

- [ ] **Step 1: Write the failing tests**

```ts
import { ringTargets, resolveRoute, DoorbellRecordSchema, DoorbellPolicySchema } from './doorbell.js';

const humans = new Set(['nick', 'ana']);
const admins = new Set(['nick']);
const ring = (act: string, to: string | null, meta = {}) =>
  ringTargets({ act, to, meta, humans, admins });

describe('what rings the doorbell (ADR 443)', () => {
  it('a directed ask rings its human', () => expect(ring('ask', 'ana')).toEqual(['ana']));
  it('a team-addressed ask rings every admin human', () => expect(ring('ask', null)).toEqual(['nick']));
  it.each(['request_help', 'handoff'])('a directed %s to a human rings', (act) =>
    expect(ring(act, 'ana')).toEqual(['ana']));
  it('a directed lane_review ask to a human rings', () =>
    expect(ring('ask', 'ana', { lane_review: { lane: 'L1' } })).toEqual(['ana']));
  it.each(['request_help', 'handoff'])('a team-addressed %s does not ring', (act) =>
    expect(ring(act, null)).toEqual([]));
  it('a directed act to an agent does not ring', () => expect(ring('handoff', 'dolly')).toEqual([]));
  it.each(['message', 'status_update', 'steer', 'insight'])('%s never rings', (act) =>
    expect(ring(act, 'ana')).toEqual([]));
});

describe('the record', () => {
  it('has no body field, and rejects one', () => {
    const rec = { team: 'revive', from: 'dolly', act: 'ask', act_id: '01X', answer_path: '/live?act=01X' };
    expect(DoorbellRecordSchema.parse(rec)).not.toHaveProperty('body');
    expect(() => DoorbellRecordSchema.strict().parse({ ...rec, body: 'secret' })).toThrow();
  });
});

describe('routing', () => {
  const policy = DoorbellPolicySchema.parse({ allow: ['live', 'os', 'slack'], defaults: ['live', 'slack'] });
  it('defaults apply when the human set nothing', () =>
    expect(resolveRoute(policy, undefined, 'standard')).toEqual(['live', 'slack']));
  it('a human override stays inside the allow-list', () =>
    expect(resolveRoute(policy, { sinks: { os: { on: true }, webhook: { on: true, url: 'https://x' } } }, 'standard'))
      .toEqual(['live', 'os']));
  it('live cannot be switched off', () =>
    expect(resolveRoute(policy, { sinks: { live: { on: false } } }, 'standard')).toContain('live'));
  it('a per-tier rule narrows a sink', () =>
    expect(resolveRoute(policy, { sinks: { slack: { on: true, tiers: ['blocking'] } } }, 'standard'))
      .not.toContain('slack'));
});
```

- [ ] **Step 2:** `pnpm --filter @musterd/protocol test -- doorbell` → FAIL (module missing).
- [ ] **Step 3: Implement.**
  - `ringTargets` reads `humans`/`admins` as name sets, so the function stays pure and the server
    passes roster facts in.
  - `DoorbellPolicySchema = z.object({ allow: z.array(SinkSchema).default(['live','os','slack','webhook']), defaults: z.array(SinkSchema).default(['live','os']), slack_url: z.string().url().optional(), webhook_url: z.string().url().optional() })`.
    The team URLs live here; `parse({})` yields no outbound sink configured.
  - `DoorbellPrefsSchema = z.object({ sinks: z.record(SinkSchema, z.object({ on: z.boolean(), tiers: z.array(AskTierSchema).optional(), url: z.string().url().optional(), host: z.string().optional() })).default({}) })`.
    `url` is a personal Slack/webhook URL. `host` is the `os` sink's machine label (Task 5).
  - `resolveRoute` returns sinks in `DOORBELL_SINKS` order: always `live`, then each sink that is
    in `allow` and either on by the human's override or in `defaults`, filtered by `tiers`. It is
    pure and returns names only. URL resolution is the server's job.
  - Add `doorbell: DoorbellPolicySchema.default({})` to `PolicySchema`. Keep `ask_slack_webhook`,
    and mark it in its doc comment as read-through to `doorbell.slack_url` (Task 3).
  - Add an epoch to `feature-epoch.ts`: `Epoch <k> — ADR 443: the doorbell`.
- [ ] **Step 4:** Tests pass. Run `pnpm --filter @musterd/protocol test` in full (≥95% lines).
- [ ] **Step 5:** Commit `protocol: the doorbell record, ring rule and routing`, `Refs ADR-443`.

### Task 2: Server — ring on route, availability holds, and the held queue

**Files:**
- Create: `packages/server/src/notify/doorbell.ts` — `ringDoorbell(ctx, team, sender, env, message)`
- Modify: `packages/server/src/protocol/route.ts:470-476` — replace `dispatchAskToSlack` with
  `ringDoorbell`. Delete `dispatchAskToSlack` (`:1124-1164`); its ADR 155 presence rule moves into
  `ringDoorbell`.
- Modify: `packages/server/src/db/migrations.ts` — next version: table `doorbell_rings`
  (`id, team_id, member_id, act_id, record TEXT, sinks TEXT, state TEXT CHECK(state IN ('held','queued','done')), host TEXT, created_at`)
  and `members.doorbell_prefs TEXT`
- Modify: `packages/server/src/db/schema.ts` (mirror the migration)
- Modify: the availability POST handler in `transport/http.ts` (~line 941) — on a change to
  `available`, call `flushHeldRings(ctx, member)`
- Test: `packages/server/src/notify/doorbell.test.ts`, `transport/integration.test.ts`

**Interfaces — consumes** Task 1. **Produces** `ringDoorbell`, `flushHeldRings`, the
`doorbell_rings` table.

- [ ] **Step 1: Write the failing tests**

```ts
describe('ringDoorbell (ADR 443)', () => {
  it('rings a directed ask to a human; never an agent', async () => {
    await send(alice, { to: 'nick', act: 'ask', meta: { species: 'consult', tier: 'standard' } });
    await send(alice, { to: 'bob', act: 'handoff' });
    expect(rings(db).map((r) => r.member)).toEqual(['nick']);
  });
  it('holds a standard ask while the human is dnd, rings it on available', async () => {
    await setAvailability(nick, 'dnd');
    await send(alice, { to: 'nick', act: 'ask', meta: { species: 'consult', tier: 'standard' } });
    expect(rings(db)[0].state).toBe('held');
    expect(surfaced(db)).toHaveLength(0);
    await setAvailability(nick, 'available');
    await eventually(() => expect(rings(db)[0].state).not.toBe('held'));
  });
  it('a blocking ask pierces dnd', async () => {
    await setAvailability(nick, 'dnd');
    await send(alice, { to: 'nick', act: 'ask', meta: { species: 'approve', tier: 'blocking' } });
    expect(rings(db)[0].state).not.toBe('held');
  });
  it('a held ring whose act was answered meanwhile is dropped, not rung', async () => {
    await setAvailability(nick, 'away');
    const { id } = await send(alice, { to: 'nick', act: 'ask', meta: { species: 'consult', tier: 'standard' } });
    await send(nick, { to: 'alice', act: 'accept', reply_to: id });
    await setAvailability(nick, 'available');
    expect(surfaced(db)).toHaveLength(0);
  });
  it('the record stored in doorbell_rings carries no body', async () => {
    await send(alice, { to: 'nick', act: 'ask', body: 'the secret plan', meta: { species: 'consult', tier: 'standard' } });
    expect(rings(db)[0].record).not.toMatch(/secret plan/);
  });
  it('a present admin keeps off-machine sinks quiet at raise (ADR 155), and a re-notify rings them', async () => {
    await withSlack(async (slack) => {
      await presence(nick, 'working');
      const { id } = await send(alice, { to: 'nick', act: 'ask', meta: { species: 'consult', tier: 'standard' } });
      expect(slack.posts).toHaveLength(0);
      await send(alice, { to: 'nick', act: 'ask', thread: id, meta: { species: 'consult', tier: 'standard' } });
      await eventually(() => expect(slack.posts).toHaveLength(1));
    });
  });
});
```

- [ ] **Step 2:** `pnpm --filter @musterd/server test -- doorbell integration` → FAIL.
- [ ] **Step 3: Implement.**
  - `ringDoorbell` builds `humans`/`admins` from `listMembers`, calls `ringTargets`, and for each
    target: composes the record (Task 1 fields; `deadline_ms` from `askContract(tier)` when the act
    is an ask; `answer_path = /live?act=<id>`), resolves the route, then either
    - inserts a `held` ring (away/dnd/off_hours and not `blocking`-through-`dnd`), or
    - inserts a `queued` ring and hands it to Task 4's dispatcher.
  - The availability test reuses `isSelfSetAway` from `reachability.ts` — export it rather than
    copy it.
  - `flushHeldRings` re-reads each held ring's act. If an `accept`/`decline`/`resolve` has answered
    it, the ring goes to `done` with no surface. Otherwise it is dispatched.
  - The ADR 155 presence rule applies to `slack` and `webhook` only (review focus 2).
- [ ] **Step 4:** `pnpm --filter @musterd/server test` in full, keeping the ≥85% bar. The ADR 149
  Slack tests must pass unchanged. If one fails, the carry-over is wrong — fix the code, not the
  test.
- [ ] **Step 5:** Commit `server: ring the doorbell on route; hold for away/dnd, blocking pierces`.

### Task 3: Server — prefs, policy read-through, and URL privacy

**Files:**
- Modify: `packages/server/src/transport/http.ts` — `GET/PUT /members/me/doorbell` (self only);
  `GET /members/:name/doorbell` (admin, masked); the `POST /policy` merge accepts `doorbell`
- Modify: `packages/server/src/store/teams.ts` — `getPolicy` maps a legacy `ask_slack_webhook` to
  `doorbell.slack_url` (plus `slack` in `defaults`) when `doorbell.slack_url` is unset
- Modify: `packages/server/src/store/reachability.ts:38` — `adminHumanReachable` counts "any admin
  human has an off-machine sink configured" rather than `ask_slack_webhook` alone
- Test: `packages/server/src/transport/doorbell-http.test.ts`, `store/reachability.test.ts`

- [ ] **Step 1: Write the failing tests** — (a) nick `PUT`s a personal webhook URL, and `GET
  /members/me/doorbell` returns it; (b) an admin `GET /members/nick/doorbell` returns
  `{webhook: {on: true, personal: true}}` with no `url` key anywhere in the JSON; (c) a non-admin
  reading another member gets 403; (d) a policy blob holding only `ask_slack_webhook` resolves
  `doorbell.slack_url` to it, and the stored blob is not rewritten; (e) a team whose only sink is a
  human's personal webhook counts as reachable.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement. The mask is one function, `maskPrefs(prefs)`, used by every non-self
  read path. The `PUT` validates with `DoorbellPrefsSchema` and rejects a sink outside the team's
  allow-list with 422 naming the sink, never echoing a URL.
- [ ] **Step 4:** Server tests pass.
- [ ] **Step 5:** Commit `server: doorbell prefs; personal URLs private; ask_slack_webhook reads through`.

### Task 4: Server sinks — `slack`, `webhook`, and `doorbell.surfaced`

**Files:**
- Create: `packages/server/src/notify/sinks.ts` — `interface DoorbellSink { name; fire(record, ctx): Promise<{ok, status?}> }`
  and the dispatcher
- Modify: `packages/server/src/notify/slack.ts` — `formatAskSlackText` takes the record (plus the
  body, per ADR 149) and phrases non-ask acts ("dolly handed you a lane", "…needs your help",
  "…asks you to accept a lane")
- Create: `packages/server/src/notify/webhook.ts` — POST the record JSON as-is, 5 s abort, never throws
- Modify: `packages/server/src/store/audit.ts:339,569` — add `doorbell.surfaced`; keep
  `ask.surfaced` in the action union for old rows
- Test: `notify/sinks.test.ts`, `notify/webhook.test.ts`, `notify/slack.test.ts`

- [ ] **Step 1: Write the failing tests** — (a) the webhook POST body deep-equals the record, with no
  `body` key; (b) a sink pointed at a closed port resolves `{ok:false}` and the send's ack returns
  before it does; (c) each attempt writes exactly one `doorbell.surfaced` row, with detail
  `{surface, ok, status?}` and no URL anywhere in the row; (d) a personal URL wins over the team URL
  for that human; (e) Slack text for a handoff names the lane title and never the body. (A handoff's
  body is not an ask's, so ADR 149's exception does not cover it.)
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement. The dispatcher marks the ring `done` after every sink has settled. The
  `os` sink's `fire` is a no-op on the server: it leaves the ring `queued` with `host` set for Task
  5 to pick up.
- [ ] **Step 4:** Server tests pass. Also run `pnpm --filter @musterd/server test -- slack route`.
- [ ] **Step 5:** Commit `server: slack and webhook sinks behind one interface; doorbell.surfaced`.
- [ ] **Step 6:** Open PR A from the Task 0–4 commits. Get dolly's review, then merge.

### Task 5: The `os` sink — the host raises the banner

**Files:**
- Modify: `packages/server/src/transport/http.ts` — `GET /doorbell/rings?host=<label>&after=<cursor>`
  (host-key auth, the same scope as `wakeLeases`) and `POST /doorbell/rings/:id/surfaced {ok}`
- Create: `packages/cli/src/host/doorbell.ts` — `pollDoorbellOnce(deps)`: fetch rings for this host's
  label, `osNotify` each, then report
- Modify: `packages/cli/src/host/loop.ts` — call it once per tick beside `pollHostOnce`
- Modify: `packages/cli/src/notify/os.ts` — nothing, if `buildNotifyCommand` fits as-is
- Test: `packages/cli/src/host/doorbell.test.ts`, `packages/server/src/transport/doorbell-http.test.ts`

**Spike first (Step 0):** confirm which label a human's `os` sink binds to. The proposal is the
host registry's enrolled label, set by `musterd doorbell os on` run from the human's Workspace
(Task 7). Confirm that one host process sees that label, and that a host on a second machine does
not. If a machine can run a human without enrolling any seat, record in ADR 443 how its host gets a
label.

- [ ] **Step 1: Write the failing tests** — (a) a ring with `host: 'mac-a'` is returned to `mac-a`'s
  host key and not to `mac-b`'s; (b) `pollDoorbellOnce` calls `osNotify` once per ring with title
  `musterd [<team>]` and a body built from record fields only; (c) a second poll with the returned
  cursor raises nothing twice; (d) a `POST …/surfaced` writes `doorbell.surfaced {surface:'os', ok}`;
  (e) the banner text passes through `buildNotifyCommand` as argv (the existing injection test,
  re-pointed at a record).
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement. A quiet tick logs nothing (ADR 131 carve-out). A ring older than the
  act's deadline is marked `done` without a banner.
- [ ] **Step 4:** `pnpm --filter @musterd/cli test -- host` and the server suite pass.
- [ ] **Step 5:** Commit `host: the os doorbell sink`. Open PR B. Merge, then announce first and run
  `service refresh` (the host binary changes). Live check: a directed ask to nick raises one banner on
  this Mac.

### Task 6: `/live` — a browser notification from an open tab

**Files:**
- Modify: `packages/web/src/live/AsksStrip.tsx` (~line 146, beside the title-count effect)
- Create: `packages/web/src/live/doorbellNotify.ts` — pure `shouldNotify(prev, next, seat)` plus the
  `Notification` call
- Test: `packages/web/src/live/doorbellNotify.test.ts`

- [ ] **Step 1: Write the failing tests** — a newly **open** ask whose ringees include the connected
  seat fires once; a backfilled ask does not fire on page load; an answered ask does not fire; an
  observer seat (ADR 063) never fires; the notification body is built from the record fields, never
  the body.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement. Ask for permission from a click in the strip ("notify me here"), never on
  load. The notification's click focuses the tab and scrolls to the ask (ADR 222's answer
  affordance).
- [ ] **Step 4:** `pnpm --filter @musterd/web test` passes. Check it in a real tab per
  `browser-tooling-on-this-laptop` (no-browser render test first).
- [ ] **Step 5:** Commit `live: the doorbell rings an open tab`.

### Task 7: CLI — `musterd doorbell`, and the team policy knob

**Files:**
- Create: `packages/cli/src/commands/doorbell.ts` — `doorbell` (show my route),
  `doorbell <sink> on|off [--url <u>] [--tiers blocking,standard]`, `doorbell os on` (records this
  machine's host label)
- Modify: `packages/cli/src/commands/team.ts:337-342,405,483` — `team policy --doorbell-allow`,
  `--doorbell-defaults`, `--doorbell-slack <url|off>` (with `--ask-slack-webhook` kept as an alias)
- Modify: `packages/cli/src/help/catalog.ts`
- Test: `packages/cli/src/commands/doorbell.test.ts`, `team.test.ts`

- [ ] **Step 1: Write the failing tests** — `doorbell` prints each sink with where its state comes
  from (team default / your override / not allowed); a URL prints masked to its host, as
  `maskWebhook` does; `doorbell webhook on` with no `--url` and no team URL exits 2 with the reason;
  run from an agent seat, `doorbell` says the doorbell is for human members and exits 0.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement. No MCP tool: agents do not configure a human's doorbell. This is
  deliberate, and ADR 443 says so.
- [ ] **Step 4:** `pnpm --filter @musterd/cli test` in full.
- [ ] **Step 5:** Commit `cli: musterd doorbell; team doorbell policy`.

### Task 8: Docs, and the spec's own tests

**Files:**
- Modify: `SPEC.md`, `docs/architecture/03-server.md`, `04-cli.md`, `08-web.md` — the doorbell
  section; ADR 149's Slack paragraph points at it
- Modify: `docs/design/daemon-doorbell-contract.md` — rename-collision note: that doc's "doorbell"
  is the agent interrupt rail. Add a dated line saying the human doorbell is ADR 443, so the two are
  not confused.
- Create: a `docs/wiki/` page on how a human is rung (template: `docs/wiki/README.md`), with dated
  claims and falsifiers. Run `pnpm wiki:check`.

- [ ] **Step 1:** Write the docs. Every doc touched carries the §7 sentence.
- [ ] **Step 2:** Full local gate: `pnpm typecheck && pnpm lint && pnpm format:check && pnpm test`.
- [ ] **Step 3:** Open PR C. After dolly's review, `gh pr merge <n> --squash --auto --delete-branch`,
  then `lane_submit` with big-body as acceptor, and do what its reply says.

---

## Self-review notes

- **Spec coverage:**

  | Spec §1 part | Task |
  | --- | --- |
  | No human reach through a harness session | Global constraints; the wall removes the hint |
  | The record, structured fields only | 1, 2 |
  | The `slack` body exception | 4 |
  | What rings, and what does not | 1 |
  | `live` sink | 6 |
  | `os` sink via the host | 5 |
  | `slack` sink (ADR 149 moved behind the interface) | 3, 4 |
  | `webhook` sink | 4 |
  | Team allow-list and defaults, per-human overrides, per-tier rules | 1, 3, 7 |
  | `away`/`dnd` hold, `blocking` pierces `dnd` | 2 |
  | Personal URLs private to their owner | 3 |
  | One attempt, detached, audited `doorbell.surfaced` | 4, 5 |
  | `live` + inbox remain the guaranteed reach | 1 (`live` always on) |
  | §7 | Global constraints, 0, 8 |

- **Scope widening for this lane:** `packages/protocol/src/{doorbell,credentials,feature-epoch}.ts`;
  `packages/server/src/{notify/*,protocol/route.ts,store/{teams,reachability,audit}.ts,db/*,transport/http.ts}`;
  `packages/cli/src/{host/{doorbell,loop}.ts,commands/{doorbell,team}.ts,help/catalog.ts}`;
  `packages/web/src/live/{AsksStrip.tsx,doorbellNotify.ts}`; `docs/decisions/{443,149,222}-*`; `SPEC.md`; `docs/architecture/*`;
  `docs/design/daemon-doorbell-contract.md`; one new `docs/wiki/` page.
- **Open, for dolly:** review focus 1 (team-addressed asks ring admins) and 2 (ADR 155 modulation
  kept for off-machine sinks only).
- **Open, resolved in Task 5's spike:** how a human's `os` sink names its machine.
- **Not built:** retry or queueing for off-machine sinks; answer-from-Slack (ADR 149's reasons
  stand); per-channel routing by species; a doorbell for team-addressed acts.
