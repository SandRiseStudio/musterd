# 343 — Defer multi-admin delegation

- Status: accepted — 2026-09-04 (ryder, lane `01M1MMKHX8WXASZT6CGWPNJ4ES`). The load-bearing code
  claim below was re-verified against `origin/main` at `1a5ec5ee`, three days after it was written,
  and still holds — see **Re-verification** below.
- Date: 2026-09-01

## Context

ADR 342 inferred a duplicate-grant race from the request decision route reading
before it settles its request. That inference is false for the current daemon:
after `readJson()` resolves, the route performs synchronous SQLite and hub work
without another `await`. Node runs that section to completion before it begins
another request handler, so a second local request observes the settled row and
receives the existing conflict response.

The Team has not yet dogfooded two human admins. ADR 145 explicitly defers
multi-admin routing, delegation, and accountability design until that evidence
exists.

## Problem

Do not turn an unsupported concurrency theory into a transactional refactor or
new governance behavior, while retaining an honest path to multi-admin work.

## Decision

1. ADR 342's proposed transaction requirement and its duplicate-side-effect
   claim are withdrawn. The current conditional request settlement remains.
2. Multi-admin delegation and policy are deferred until a two-human Team
   produces an attributable decision-routing need. The existing human-only
   `is_admin` capability and admin-only governance endpoints remain unchanged.
3. Any future async persistence, multi-process daemon, or federated
   request-decision path must re-evaluate settlement atomicity before it
   introduces an await or remote boundary between reading and settling.

## Consequences

- No server, protocol, CLI, MCP, schema, or policy change follows from ADR 342.
- ADR 342 remains historical context for the concern but does not authorize the
  unimplemented transactional behavior.
- The security program proceeds with scoped bootstrap credentials and abuse
  controls, while multi-admin delegation remains evidence-gated.

## Observability & Evaluation

- Traces: no new trace is introduced; current `request.decide` audit rows
  continue to record the deciding human and outcome.
- Eval: the request-route integration suite is the dataset. Baseline and
  expected result: a first decision settles the request and a later decision
  receives `409`, with one terminal request row.
- Experiment: a two-human dogfood Team records concurrent approval behavior
  before a follow-on ADR selects routing or delegation semantics.

## Re-verification — 2026-09-04

This ADR withdraws another one on the strength of a claim about the code, so the claim was checked
rather than taken. It holds, and it is narrower than it sounds.

**The decide route contains exactly one `await`, and it is before the read.** In
`packages/server/src/transport/http.ts`, the whole handler spans roughly lines 2046–2360 and the
only `await` in it is `await readJson(req)` at **2046**. The request row is read at **2047**
(`getRequest`), the pending check is at **2049**, and every settle — `decideRequest` at **2119**,
**2271** and **2337** — is downstream of that with no yield in between. Node therefore runs
read-to-settle as one synchronous block, a second concurrent admin decision observes the settled
row, and `decideRequest`'s `WHERE status = 'pending'` compare-and-set returns `null` for it. Decision
1 stands: no transactional refactor is warranted.

**Why decision 3 is the load-bearing half, and why it is currently unenforced.** `issueGrant` is at
**2094** — *before* both approve settles (2119, 2271). So the ordering ADR 342 worried about is real:
the grant is minted before the request is settled. What prevents a duplicate grant is not the
ordering, it is the absence of a yield. Introduce one `await` anywhere between 2047 and the settle —
async persistence, a remote hub call, a metrics flush — and two admins can both pass the 2049 pending
check and both mint a grant, which is precisely ADR 342's duplicate-side-effect claim, reachable.

Decision 3 already says a future async boundary must re-evaluate settlement atomicity. Nothing
enforces it: no test, lint rule or gate fails when an `await` is added between the read and the
settle, so the safety this ADR rests on can be removed silently by a change that has nothing to do
with governance. That gap is its own work, not a reason to reopen ADR 342 —
lane `01M1QA28RDN2SEMAC17X99Y01X`.

**The dogfood gate is still closed.** Decision 2 defers delegation until a two-human Team exists. The
`members` table holds one human admin (`nick`); the other human rows are `driver`, `driver2` and
`web-*` observers — bootstrap and web-visitor rows, not a second administrator (2026-09-04; falsify:
`sqlite3 ~/.musterd/musterd.db "select name, role from members where kind='human'"`). No second human
has ever administered a team here, so the evidence decision 2 waits on has not arrived.

## Enforcement — 2026-09-04

Decision 3 no longer rests on prose (lane `01M1QA28RDN2SEMAC17X99Y01X`, split from the
re-verification above). The decide route now **settles before it mints**: `decideRequest`'s
`WHERE status = 'pending'` compare-and-set runs after the target and account checks and before
`issueGrant`, on both the approve and deny branches, and a decision whose settle returns no row
throws `conflict` (HTTP 409) and mints nothing. The ordering ADR 342 worried about — grant minted,
request still pending — is gone from the code rather than made harmless by accident.

What this changes about decision 3: an `await` or remote boundary introduced between the read and
the settle is no longer a silent duplicate-grant hazard. Both admins may pass the pending check; one
settle wins; the loser mints no grant and gets the same 409 it gets today. The rule that a future
async or federated path must re-evaluate settlement atomicity stands for the *rest* of the handler
(presence attach, delivery, audit) — those still run after the settle without a transaction — but
the credential-minting half is now guarded by order, not by the absence of a yield.

Pinned by `packages/server/src/transport/decide-settle-order.test.ts`: two concurrent approvals of one
request produce one grant, one settled row and one `request.decide` audit row; a late approval after
a deny gets 409 and no grant; and, structurally, every `decideRequest(` in the handler's source
precedes `issueGrant(`. The lane's honest finding on option 1 stands: a yield-injected interleaving
is not reachable on a handler that is synchronous after `readJson` without adding a test seam, so the
order is pinned at the source instead.
