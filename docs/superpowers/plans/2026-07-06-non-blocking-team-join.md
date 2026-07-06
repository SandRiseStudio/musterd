# Non-blocking `team_join` Implementation Plan (ADR 095)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the `team_join` claim block a **caller/policy choice** instead of a hardcoded 120s. Add a `wait` control (default = today's blocking spin-then-seat) whose `wait:0` returns a pending handle immediately while keeping the socket parked for background occupy; on approval, drop an interrupt-class act at the seat so a released autonomous agent is told at its next tool boundary instead of polling.

**Architecture:** Protocol-first. The load-bearing subtlety (ADR 095 Context): the existing non-blocking client path (`waitOnPending=false`, launch autojoin) **closes the socket and gives up** — unusable here. The new mode returns to the caller immediately **while keeping the socket open and parked** (the 120s timeout path already keeps it open; we reuse that keep-open, minus the wait). The treadmill ADR 087 feared cannot recur because the server already collapses one request per seat (`collapseByTarget:'seat'`). Spec: `docs/decisions/095-non-blocking-team-join.md` — read it first; it is the contract.

**Tech Stack:** TypeScript, zod, vitest. No new runtime dependency.

**Conventions that bind every task:** parse external input through `@musterd/protocol` zod schemas at the boundary; CLI/MCP talk to the server over the wire, never import `@musterd/server`; each new source file gets a described line in the relevant `docs/architecture/0N-*.md` file tree (the `arch-trees:check` gate fails otherwise); `pnpm -r build && pnpm -r lint && pnpm test` green before any task is "done". The default path (`wait` omitted) must be **byte-for-byte** today's behavior — every existing join test stays green untouched.

---

### Task 1: Protocol — a `claim_wait` binding default + shared wait resolver

**Files:**
- Modify: `packages/protocol/src/binding.ts` (`WorkspaceSpecSchema`, ~line 35)
- Add: `packages/protocol/src/claim-wait.ts` (the resolver + its test)
- Modify: `packages/protocol/src/index.ts` (export)

- [ ] **Step 1: Write the failing test** — `packages/protocol/src/claim-wait.test.ts`:

```ts
import { resolveJoinWaitMs, DEFAULT_JOIN_WAIT_MS } from './claim-wait.js';

it('arg wins over binding default wins over the built-in default', () => {
  expect(resolveJoinWaitMs({ arg: 0 })).toBe(0);                       // explicit non-blocking
  expect(resolveJoinWaitMs({ arg: 30 })).toBe(30_000);                 // seconds → ms
  expect(resolveJoinWaitMs({ bindingDefault: 0 })).toBe(0);            // policy default, no arg
  expect(resolveJoinWaitMs({})).toBe(DEFAULT_JOIN_WAIT_MS);            // nothing set → today's 120s
  expect(resolveJoinWaitMs({ arg: true })).toBe(DEFAULT_JOIN_WAIT_MS); // wait:true = block, default budget
  expect(resolveJoinWaitMs({ arg: false })).toBe(0);                   // wait:false = non-blocking
});
```

- [ ] **Step 2: Verify failure** — `pnpm --filter @musterd/protocol test` → FAIL (module missing).

- [ ] **Step 3: Implement** — `claim-wait.ts`: `DEFAULT_JOIN_WAIT_MS = 120_000`; `resolveJoinWaitMs({arg?, bindingDefault?})` maps `number` (seconds→ms, `0`→`0`), `true`→default, `false`→`0`, precedence arg → bindingDefault → default. In `binding.ts` add to `WorkspaceSpecSchema` (non-secret, rides `workspace.json`):

```ts
/** Default claim-wait for this folder in seconds (ADR 095). 0 = non-blocking (return the pending
 *  handle immediately, occupy in the background). Absent ⇒ block the built-in default. Kept OUT of the
 *  compact MUSTERD_CLAIM grammar — an explicit `wait` on the call always overrides it. */
claim_wait: z.number().int().nonnegative().optional(),
```

Export both from `index.ts`. Confirm `WorkspaceSpecSchema` round-trips with and without the field (existing binding tests stay green).

---

### Task 2: MCP client — a "return-on-pending, keep parking" join mode

**Files:**
- Modify: `packages/mcp/src/client.ts` (`join()` ~205-258, the `pending` frame handler ~342-357)
- Modify: `packages/mcp/src/client.test.ts` (or the nearest join test)

The current `join(timeoutMs)`: `timeoutMs>0` ⇒ block, park on `pending`, keep socket open on timeout; `timeoutMs` falsy ⇒ `waitOnPending=false` ⇒ reject **and close** on `pending`. We need a third shape: **return immediately with a pending outcome, keep the socket open and parked** so the pushed `occupied` still lands.

- [ ] **Step 1: Write the failing test** — drive a fake WS that answers `hello` with a `pending` frame. Assert: with the new non-blocking flag, `join()` **resolves** (does not reject) with `{ pending: true, requestId }`, the socket stays **open**, and a subsequently-pushed `occupied` frame flips `client.joined` true + persists the resume token. Assert a second `join()` call while parked does **not** open a second socket/request.

- [ ] **Step 2: Verify failure** — `pnpm --filter @musterd/mcp test` → FAIL.

- [ ] **Step 3: Implement** — change `join()` to take `{ timeoutMs?, returnOnPending? }` (keep the numeric overload working for existing callers, or thread an options object). When `returnOnPending`: keep `waitOnPending=true` socket/park semantics (do **not** close), but on the `pending` frame **resolve** `pendingJoin` with a pending outcome instead of continuing to wait. Return type becomes `Promise<{ pending: false } | { pending: true; requestId: string }>` (or resolve-void + a `client.pendingRequestId` read — pick the smaller diff; the tool in Task 3 needs to know which happened). Leave the blocking and launch-autojoin paths byte-for-byte unchanged.

---

### Task 3: MCP tool — the `wait` argument on `team_join`

**Files:**
- Modify: `packages/mcp/src/tools/join.ts`
- Modify: `packages/mcp/src/claim.ts` (`claimAndJoin` threads the wait/mode)
- Modify: `packages/mcp/src/config.ts` (surface `binding.claim_wait` as a config default)
- Modify: the join tool test

- [ ] **Step 1: Write the failing test** — `team_join {wait:0}` on an approval-gated seat returns the **pending** message (request id + "you are not seated yet, keep working, you'll get an interrupt line") and does **not** block. `team_join {}` (omitted) still blocks then seats (existing behavior). `wait:0` twice ⇒ still one server request (assert via a request-count spy).

- [ ] **Step 2: Verify failure** — `pnpm --filter @musterd/mcp test` → FAIL.

- [ ] **Step 3: Implement** — add `wait: z.union([z.number(), z.boolean()]).optional()` to the input schema (describe: "seconds to block for approval; 0/false = return immediately, occupy in the background"). Compute `waitMs = resolveJoinWaitMs({ arg: args.wait, bindingDefault: config.claimWait })` (Task 1). Pass through `claimAndJoin`. Branch the result: seated ⇒ today's success text; pending ⇒ the non-blocking pending text (distinct from the *timed-out* text — this one is intentional, not a fallback). Keep `JOIN_WAIT_MS` as the `DEFAULT_JOIN_WAIT_MS` re-export so nothing else drifts. Update `DESCRIPTION` to mention `{wait:0}` for background agents.

---

### Task 4: Server — emit an interrupt-class act at the seat on approve

**Files:**
- Modify: `packages/server/src/transport/http.ts` (the `decide` approve branch, ~696-710)
- Modify: `packages/server/src/transport/integration.test.ts`

`interrupt-check` (`GET /inbox/interrupt-check`, already shipped) raises on a waiting **urgent directed act** (`meta.urgent:true` + `meta.urgent_reason`, `envelope.ts:57-67`). Approval today only pushes an `occupied` WS frame — invisible to `interrupt-check`. Add: on approve, the daemon sends a directed act to the newly-granted seat so a non-blocking claimant is told at its next tool boundary.

- [ ] **Step 1: Write the failing test** — extend the ADR 088 integration test: a session claims non-blocking (returns pending), an admin approves, then that seat's `GET /inbox/interrupt-check` **raises one line** ("seat granted"), and `/inbox` shows the grant act. A **blocking** claimant (the WS-push path) does **not** get a duplicate interrupt act (guard against double-notify — the blocking caller already knows).

- [ ] **Step 2: Verify failure** — `pnpm --filter @musterd/server test` → FAIL.

- [ ] **Step 3: Implement** — in the approve branch, after `deliverClaimDecision`, if the request was opened in non-blocking mode (persist a `nonblocking` flag on the claim request when it is created — Task 3/ws.ts pass-through), send a system-originated directed act to `presence.id` with `meta.urgent:true`, `urgent_reason:'seat granted'`, a short body ("you are live as <seat> on <team>"). Reuse the existing message-send store path; do **not** invent a new frame. Audit as usual. Skip the act when the caller blocked (avoid double-notify).

---

### Task 5: CLI — `--wait 0` on `musterd claim`

**Files:**
- Modify: `packages/cli/src/commands/claim.ts` (~129-137, the `--timeout` parse)
- Modify: `packages/cli/src/commands/claim.test.ts` (or `claim-client.test.ts`)

`musterd claim` already has `--timeout <s>` (`0` = unbounded). Add `--wait 0` = **don't block, print the request id and exit** (the CLI mirror of `team_join {wait:0}`), so the two surfaces are symmetric. `--timeout` keeps its existing meaning; `--wait 0` is the new non-blocking switch.

- [ ] **Step 1: Write the failing test** — `musterd claim izzo --wait 0` on a gated seat prints "request <id> opened — approve with `musterd requests decide …`; re-run `musterd claim` to confirm" and exits 0 without hanging. Plain `musterd claim izzo` behavior unchanged.

- [ ] **Step 2: Verify failure** — `pnpm --filter @musterd/cli test` → FAIL.

- [ ] **Step 3: Implement** — parse `--wait`; when `0`/`false`, call the claim client in return-on-pending mode (Task 2's mode over the CLI's HTTP claim path — confirm the CLI claim client shares the same pending-resolve semantics; if it uses a different transport than the MCP WS client, mirror the "return the request id, leave it open" behavior there). Keep `--timeout` orthogonal.

---

### Task 6: Provisioning + docs + green build

**Files:**
- Modify: `packages/cli/src/commands/init.ts` and the `musterd agent` path (write `claim_wait` when a `--wait`/`--background` flag or an autonomous role is chosen)
- Modify: the relevant `docs/architecture/0N-*.md` tree(s) for any new source file (`claim-wait.ts`)
- Modify: `.claude/skills/musterd/SKILL.md` (one line: `team_join {wait:0}` for background agents) — only if the guidance:check stamp requires it

- [ ] **Step 1** — `init`/`agent`: accept an opt-in (e.g. `--wait <s>`), persist `claim_wait` into `workspace.json`/`binding.json` via `WorkspaceSpecSchema`. Default absent ⇒ blocking, unchanged.
- [ ] **Step 2** — add the `claim-wait.ts` file-tree line so `pnpm arch-trees:check` passes; add the SKILL/AGENTS one-liner if `pnpm guidance:check` demands it.
- [ ] **Step 3** — full gate: `pnpm -r build && pnpm -r lint && pnpm test && pnpm arch-trees:check && pnpm guidance:check` all green.
- [ ] **Step 4: Live verify (the ADR's experiment)** — a headless dogfood seat: `team_join {wait:0}` on a fresh gated seat returns pending immediately; do a throwaway tool call; an admin runs `musterd requests decide <id> --approve`; the next tool boundary surfaces `⚡ seat granted`; `team_join {}` confirms already-joined. Compare against `wait:120` (dead turn). Record steps-to-seated + turn-time-lost against the ADR 095 eval targets.

---

## Build-order rationale

Protocol (1) before the client (2) before the tool (3) so each layer's schema/return-type is fixed before its caller compiles. Server (4) is independent of 2–3 except for the `nonblocking` flag it reads off the claim request, so it can proceed in parallel once Task 1 lands the shared types. CLI (5) mirrors 2–3 on the HTTP path. Provisioning + gates (6) last, once the surfaces exist. Every task keeps the `wait`-omitted path identical to today — the default never moves, only the knob is added.
