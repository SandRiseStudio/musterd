# 237 — Supersession must be visible: to the ledger, and to the session it evicted

- Status: proposed
- Date: 2026-08-05
- Deciders: dolly (probe + draft), filed from ryder's incident lane `01KZ9GQN3E`
- Relates to: ADR 017 (newest-wins), ADR 042 (kind-scoped single-active), ADR 068
  (workspace-scoped displacement), ADR 092 (same-workspace successor grace), ADR 101 (stateless
  POST authenticates a seat, not a session), ADR 108 (autojoin on first tool call), ADR 131
  (residency — the ping-pong lesson), ADR 164 (liveness ladder)

## Context

On 2026-08-05, seat ryder, workspace `/Users/nick/agents-ryder`: a session evicted at 17:24:53Z
kept working for twenty minutes — editing files, committing, opening a PR — and from inside that
session every signal said it still held the seat. `team_status` answered "you are ryder".
`lane_open`, `lane_update` and `lane_submit` all succeeded, stamped `created_by ryder`; one of them
routed an acceptance ask to another seat. Only `team_send` refused, and its refusal said "you
haven't joined the team yet — call team_join first", which is the opposite of what happened. The
lane that filed this defect was itself opened by the evicted session.

The probe (this ADR's origin) established **where the claim is actually checked**, and the answer
is: almost nowhere, and never server-side per request.

1. **The only live-claim gates are client-side, on four tools.** `team_send`, `team_inbox_check`,
   `team_memory_*` and `team_wake_context` guard on the MCP adapter's WS `joined` flag
   (`packages/mcp/src/tools/{send,inboxCheck,memory,wakeContext}.ts`). Everything else — every lane
   tool, `team_status`, `team_next` — goes over stateless HTTP.
2. **HTTP authenticates a seat, not a session — by design.** `authTouch`
   (`packages/server/src/transport/http.ts`) resolves agent key + `x-musterd-seat` header. ADR 101
   records why: a POST is stateless; there is no per-request occupancy to key on. Two sessions in
   one workspace are indistinguishable at this layer. There is nothing to check _against_, so "add
   the check to the lane path" is not an available move without a session identity on the wire.
3. **`authTouch` also refreshes ambient presence** — so an evicted session that keeps calling lane
   tools keeps the seat looking present, actively masking its own eviction.
4. **The eviction push exists, but only one branch of it is honest.** The same-workspace reap
   (`ws.ts scheduleSameWorkspaceEviction`) audits `claim.superseded {same_workspace:true}` and
   sends a frame carrying `same_workspace: true`, which the client answers by exiting cleanly
   (ADR 092). But the **cross-workspace displacement branch — in both transports** (`ws.ts` claim
   step 4, `http.ts` claim step 4) — pushes `superseded` with _no_ flag and writes **no audit row
   at all**. The client goes permanently dormant (`wantPresence = false`, no reconnect — correct,
   that is the ADR 131 anti-ping-pong rule) but does not exit, and the ledger shows only the
   winner's `claim.occupied`.

The incident's ledger confirms the last point: at 17:24:53Z there is a `claim.occupied` for ryder
and **no eviction row of any kind** — yet the evicted session's later refusal quoted the
cross-workspace message ("taken over by a newer one", not "replaced by a newer one in the same
workspace"). Two sessions in the _same folder_ took the cross-workspace branch. How they came to
present different workspace strings is an open question recorded below; what is settled is that the
branch they took is silent to the ledger and non-terminal to the loser.

One caution shapes everything below: the evicted session filing the defect lane _was the right
outcome_. A hard refusal on lane writes would have blocked correct, correctly-attributed work,
requested by a human. More refusal is not the fix; honesty is.

## Decision

**1. Every displacement writes an audit row.** The cross-workspace branches in `ws.ts` and
`http.ts` gain the same `claim.superseded` audit the same-workspace reap already has, with
`detail.same_workspace: false` and `detail.via: 'ws' | 'http'`. An eviction the ledger cannot see
is an eviction nobody can debug; this is the cheapest and least contestable piece, and it is what
would have made the incident diagnosable from the DB instead of from a session transcript.

**2. The evicted session is told in terms of what happened, on every subsequent guarded call.**
The dormant-guard message distinguishes "never joined" from "was evicted": when
`lastJoinErrorMsg` carries a `superseded` refusal, the guard says so — that the seat was taken
over, when, and that `team_join` would displace whoever holds it now. The current text ("you
haven't joined the team yet — call team_join first") is actively misleading for an evicted session
and, worse, its repair advice _causes_ the ADR 131 ping-pong if followed reflexively.

**3. Reads carry the eviction too.** `team_status` from a session whose client knows it was
superseded must not answer "you are ryder" unqualified. The client has the fact locally
(`lastJoinErrorMsg`); rendering it costs nothing and removes the positive false evidence that kept
the incident running for twenty minutes. Server-side read gating is _not_ added — the HTTP layer
cannot distinguish sessions (point 2 of Context), and pretending otherwise would be the shared-
predicate trap again.

**4. Lane writes stay open, attribution stays as it is.** A stateless seat-authenticated mutation
from an evicted session is still the seat's work, under the seat's key — ADR 109/101 attribution
is not corrupted by it, because the seat _is_ the identity being attested; what was wrong was the
session's belief, not the stamp. The fix for the belief is decisions 2 and 3, not a refusal. If a
future session identity ever rides the HTTP wire, this can be revisited; nothing here forecloses
it.

**5. No auto-rejoin, unchanged.** The evicted session must be told and must choose (ADR 131's
displacement war stays won).

**Out of scope:** the working-tree collision one layer down (sibling lane `01KZ9GRJT7`); the
eviction itself (ADR 017/068 are correct); notification _push_ beyond the frame that already
exists — when the loser's WS is already gone, the only reachable moment is its next tool call, and
this ADR says so plainly rather than pretending at real-time.

**Open question (recorded, not decided):** why two sessions in one folder presented different
workspace strings to the claim path and were classified cross-workspace. Candidates: a client that
sent no `workspace` (the fall-back is displace-all), or a path-normalization drift between
launches. Whoever picks this up should start from the two claim frames, not the folder.

## Consequences

- The ledger becomes complete over displacements: every `claim.occupied` that displaced someone
  has a sibling `claim.superseded`, joinable by timestamp and target.
- An evicted session's first refusal — and every one after it — names the eviction. The
  twenty-minute window of false belief closes at the loser's next guarded call, and shrinks at its
  next _read_ once decision 3 lands.
- Ambient presence from an evicted session's HTTP calls (Context point 3) remains — it is the
  seat's key touching the seat's presence, and the layer has no session identity to filter on.
  Accepted, noted, and bounded by decisions 2/3 making the session stop believing in itself.

## Observability & Evaluation

**Traces.** Every displacement now lands in the audit ledger: `claim.superseded` with
`detail.same_workspace` and `detail.via`, adjacent to the winner's `claim.occupied`. The evicted
session's side is traceable from its refusal text, which names the eviction and its timestamp.

**Eval.** Dataset: the 2026-08-05 incident window (17:11–17:45Z, `~/.musterd/musterd.db`), where
the completeness query below returns one known gap. Baseline: pre-ADR, displacing `claim.occupied`
rows with no adjacent `claim.superseded` exist (the incident); post-ADR the query must return
zero, and the replay integration test holds it there.

**Experiment.** None planned — this is a mechanical visibility repair, not a behavior whose effect
size needs an arm. If the open question (same-folder classified cross-workspace) turns out to be a
recurring classifier bug, its fix earns its own measurement.

- **Completeness invariant:** for any agent-seat `claim.occupied` whose claim displaced a live
  connection, a `claim.superseded` row exists within the same second (`same_workspace` true or
  false). Checkable retroactively: `SELECT` occupieds with no adjacent superseded row — before this
  ADR the incident window shows exactly that gap; after, the query returning rows is the
  falsifier.
- **Message honesty:** a unit test per guarded tool asserting the superseded-flavored guard text
  when `lastJoinErrorMsg` matches `superseded`, and the never-joined text otherwise. Verified by
  mutation (swap the branch, watch the test fail), per the lane's standing instruction.
- **Incident replay:** the eviction sequence (claim, displace via cross-workspace branch, evicted
  client calls a lane tool then team_send) exists as a through-DB integration test; its assertions
  are the audit row (decision 1) and the refusal text (decision 2).
- **What would falsify decision 4:** a displaced session's lane mutation that mis-attributes work
  to the _new_ session's model or occupancy (ADR 101/158). None observed; the stateless stamp
  falls back to the newest attested presence, which after an eviction is the winner's — if that
  fallback ever stamps the _loser's_ mutation with the _winner's_ model, the attribution claim
  above is wrong and lane writes need the session identity after all.
