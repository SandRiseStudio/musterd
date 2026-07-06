# 095 — Return-immediately `team_join`: a `wait` control for the claim block

- Status: proposed
- Date: 2026-07-06
- Builds on: ADR 077 (claim handshake + request lane), ADR 087 (seat resume ≠ claim — the blocking call), ADR 088 (the interrupt line)
- Refines: ADR 087 Fix D

## Context

ADR 087 Fix D made MCP `team_join` **one blocking, idempotent call**: it occupies via resume token if
present, else opens-or-reuses the single request for `(workspace, seat)`, **waits** for the admin
decision (up to `JOIN_WAIT_MS = 120s`, [join.ts:19](../../packages/mcp/src/tools/join.ts)), occupies,
persists the refreshed token, and returns seated. That was the right call for the case it targeted — an
**interactive** agent with a human present to approve, where a single call that spins-then-seats is the
best DX and mirrors the CLI `claim` `⧖` spinner.

But the fixed 120s block is a compromise baked into the tool, not a choice the caller makes. For an
**autonomous / headless** agent (a cron seat, a background workflow, an agent whose human is not the
team admin), a first-ever claim on a seat that needs approval hard-parks the agent's turn for up to two
minutes on a decision it cannot make itself. It cannot check its inbox, prep work, or do anything else
while parked — and if the admin is away it wastes the full 120s and returns pending anyway.

### Why this is not a revert of ADR 087

The loose version of this idea — "make `team_join` return immediately again" — reads as reverting Fix D.
It is not, because ADR 087 **conflated two things the codebase has since severed**:

1. _"returns immediately as pending"_ — the synchronous-wait duration.
2. _"each call opens another request"_ — the duplicate-request treadmill (the actual 2026-07-03 bug).

Fix C (stable presence code) plus the server's `createRequest(..., collapseByTarget: 'seat')` fixed **(2)
independently of (1)**: a second claim for the same folder+seat now **reuses** the open request, it does
not mint a new one. So returning immediately no longer implies a treadmill — the two are orthogonal now.
ADR 087 tied them together because in that transcript both were broken at once.

Most of the pieces a non-blocking return needs already exist:

- **Background occupy.** When the 120s wait elapses `team_join` already returns a pending handle and
  **leaves the socket open** ([client.ts:244-253](../../packages/mcp/src/client.ts)); a later approval
  occupies in the background via `hub.deliverClaimDecision` and persists the resume token
  ([join.ts:80-88](../../packages/mcp/src/tools/join.ts)). A non-blocking return is this same
  keep-parking behavior with the caller released at zero wait instead of 120s.
- **One request, not N.** The server opens the claim request with `collapseByTarget: 'seat'`
  ([http.ts:1045](../../packages/server/src/transport/http.ts)), so an immediate-return caller's open
  request is **reused** on any follow-up — an eager retry loop cannot spam the admin.
- **The interrupt line is built.** ADR 088's `GET /inbox/interrupt-check` primitive already ships
  server-side ([http.ts:1192](../../packages/server/src/transport/http.ts), with an integration test),
  provisioned as a PostToolUse hook by `init`. The delivery channel exists.

Two pieces are **not** free, and the plan treats them as the real work:

1. **A keep-parking non-blocking mode.** `client.join()`'s existing non-blocking path (`waitOnPending =
   false`, used for best-effort launch autojoin) **closes the socket and gives up** on the `pending`
   frame — so it is *not* directly reusable; a background occupy would never arrive. The new mode must
   return to the caller immediately **while keeping the socket open and parked**, i.e. resolve `join()`
   with a `pending` outcome instead of rejecting-and-closing. This is a small variant of the blocking
   path (which already keeps the socket open on timeout), not the launch-autojoin path.
2. **The grant must land in the seat's inbox.** `interrupt-check` surfaces a waiting *directed act*.
   Approval today only pushes an `occupied` WS frame — nothing an interrupt-check would see. So on
   approve the daemon must also write an **interrupt-class directed act** to the seat, so the released
   agent is told at its next tool boundary rather than having to re-poll `team_join`.

## Problem

Let an autonomous agent claim a fresh, approval-gated seat **without surrendering its turn** to a human
decision — get a durable pending handle immediately, keep doing useful work, and be told the moment the
grant lands — while preserving the blocking single-call DX as the default for interactive agents, and
without reopening the duplicate-request treadmill ADR 087 closed.

## Decision

Make the wait a **control**, not a constant. Three additive changes; no wire/SPEC bump.

### 1. A `wait` argument on `team_join` (and `--wait` symmetry on `musterd claim`)

`team_join` gains an optional `wait` control resolving to a block budget in seconds:

- **omitted / `wait: true`** → today's behavior: block up to the default budget (120s MCP / 300s CLI),
  spin-then-seat. Unchanged default; interactive DX is untouched.
- **`wait: 0` / `wait: false`** → **non-blocking**: open-or-reuse the one request, return the pending
  handle **immediately** while the socket stays open and parked, so the seat still occupies in the
  background on approval (a new "return-on-pending, keep parking" `join()` mode — see Context, not the
  socket-closing launch-autojoin path).
- **`wait: <seconds>`** → block up to that bound, then fall back to the pending handle. Generalizes the
  hardcoded 120s.

If a resume token is present the call still occupies instantly and `wait` never engages — the control
only governs the **no-grant claim** path. `musterd claim` already parameterizes the block
(`--timeout`, `0 = unbounded`); this adds the missing **`--wait 0` = don't block, return the request**
mode so the two surfaces are symmetric.

The non-blocking result is explicit about its own resolution path, e.g.:

> Claim opened on **revive/izzo** — request `01K…` (awaiting admin approval). You are **not seated yet**.
> Keep working; you'll get an interrupt line the moment an admin approves, and your next `team_join`
> confirms you're live. Ask an admin to run `musterd requests decide 01K… --approve`.

### 2. The folder may default the wait (a binding field)

`init` / `musterd agent` write the folder's `binding.json`. Add an optional `claim_wait` field there so
a seat provisioned for an autonomous role defaults to non-blocking without the model passing the
argument, while an interactive seat keeps the blocking default. Kept out of the compact `MUSTERD_CLAIM`
policy grammar (which stays untouched); an explicit `wait` argument on the call always wins over the
binding default.

### 3. Approval delivery rides the interrupt line (ADR 088)

On approve, the daemon writes an **interrupt-class directed act** to the newly-granted seat — surfaced
at the agent's next tool-call boundary by the already-shipped ADR 088 `interrupt-check` hook
(`⚡ musterd: seat granted on revive — you are live as izzo`). The background occupy has already flipped
the session to seated; the interrupt line is what tells the *model* so it stops assuming it is unseated.
This is the piece that turns "returned immediately" into "productive while waiting" rather than "must
poll." The `interrupt-check` primitive exists; the only new server work is emitting that act on approve
(Decision context, piece 2). If the act is absent, `wait: 0` still degrades gracefully to
poll-on-next-`team_join` — strictly better than a 120s hard park for an autonomous seat.

## Consequences

- Autonomous/headless agents stop losing up to 120s per fresh claim; interactive agents keep the
  one-call-and-seated spinner (default unchanged). The knob, not the default, moves.
- The change is small and mostly plumbing on existing machinery: a return-on-pending `join()` mode, a
  `wait` arg on `team_join`/`claim`, a wait default carried in the binding, and an interrupt-class act
  emitted on approve. Background occupy, stable code, request-collapse, and the `interrupt-check` hook
  already exist.
- No treadmill risk: `collapseByTarget: 'seat'` means an eager non-blocking retry reuses the one open
  request. Worth an explicit test — non-blocking retry loop asserts **one** request per seat.
- The wait default lives as a **binding field** (`claim_wait`), not inside the compact `MUSTERD_CLAIM`
  policy grammar — so the env grammar and `ClaimPolicySchema` stay untouched.
- Surface additions: one optional tool arg, one optional CLI flag, one binding field, one interrupt-class
  act on approve. All additive; resume/role/teammate paths untouched.

## Observability & Evaluation

**Traces** — extend the `musterd.seat.occupy` counter (ADR 087) `path` dimension with `pending_async`
(returned non-blocking, occupied later) so the blocking-vs-immediate split is first-party. Add
`musterd.seat.claim_wait_ms` (histogram) to see how long callers actually block — if interactive claims
resolve in seconds, the 120s default is mostly a floor for the absent-admin case, which is the case
non-blocking removes.

**Eval** — the eval this ADR moves: **turn-time lost to a fresh claim** for an autonomous seat (target:
→0 with `wait: 0`; baseline is up to 120s) and **duplicate requests per seat under a non-blocking retry
loop** (target: 1 — must not regress ADR 087's →0). Secondary: for approvals that land after a
non-blocking return, **time-to-model-awareness** (grant approved → agent's next tool boundary surfaces
it), which is the ADR 088 delivery latency.

**Experiment** — A/B a headless dogfood seat claiming a fresh approval-gated seat with `wait: 120`
(control) vs `wait: 0` (treatment), admin approving after a 60s delay. Treatment should show the agent
doing useful work in the gap and picking up the grant at its next tool boundary; control shows a dead
turn. If treatment doesn't reduce lost turn-time without inflating request count, the knob isn't the
lever.
