# Resolved then dropped

A value computed correctly at one end of a call chain and lost before the wire — the client had the right answer the whole time and never sent it.

This is the mirror of [correct by coincidence](correct-by-coincidence.md): there a surface reports a proxy that happens to equal the truth; here the truth is derived, held in a variable, and then quietly not passed on. Both are silent, but this one is worse to find, because every place you look — the resolver, the schema, the server — is correct. The defect lives in the handoff between them, which is the one thing no single file shows.

Four instances landed in two days (2026-09-04/05) across three packages, which is why it is a page.

## The shape

1. A fact is resolved properly (`resolveWorkspaceKey()`, `resolveAttestedProvenance()`).
2. It is carried across a boundary — a constructor, a frame builder, an options object.
3. At that boundary it is renamed, forgotten, or spelled differently.
4. Nothing fails. The field is **optional on the wire**, so the schema accepts the frame; the server applies its documented fallback; the surface renders the fallback without complaint.

The optionality is load-bearing. Every one of these fields was additive by design, so that an older client kept working — and that same tolerance is what let a *current* client silently behave like an old one.

## Why the tests did not catch it

Each instance had tests, and they passed, because they tested the two ends and not the join:

- the resolver's own unit tests — correct, and untouched by the defect;
- the server's tests, which construct the frame **by hand** with the field present, so they exercise the path the client never takes.

The test that finds this class asserts on **the frame the client actually sends**. In this repo that means capturing the socket write (`FakeSocket` in `packages/cli/src/client.test.ts`) or the POST body (`stubFetch` in `client.claim.test.ts`) — not the arguments to an intermediate, which is where the value is still correct.

## The instances

| # | value | lost between | PR |
|---|---|---|---|
| 1 | `provenance` | CLI `watchClaim` and the WS claim frame — the frame carried workspace, model and build, never this | [#1322](https://github.com/SandRiseStudio/musterd/pull/1322) |
| 2 | `provenance` | *inverted*: the server **invented** one (`ctx.provenance ?? 'session'`) where the client sent none | [#1330](https://github.com/SandRiseStudio/musterd/pull/1330) |
| 3 | `workspace_key` | `HttpClient.claim` and `buildClaimFrame` — passed as `workspace_key`, the builder takes `workspaceKey` | [#1339](https://github.com/SandRiseStudio/musterd/pull/1339) |
| 4 | `workspace_key` | `gather()` and both `HttpClient` constructions in `helpers.ts` — resolved every time, passed never | [#1341](https://github.com/SandRiseStudio/musterd/pull/1341) |

Instance 2 is the same wound from the other side and belongs here: a server that fills in an absent fact destroys the same distinction a client that drops one does. After it, a row could not separate *"the client said `session`"* from *"the client said nothing"*. Measured: 1174 of nick's `presence.attached` rows in 24h recorded `session`, a word his client never sent, and 0 recorded anything else (2026-09-05; falsify: `sqlite3 ~/.musterd/musterd.db "select json_extract(detail,'$.provenance'), count(*) from audit where actor='nick' and action='presence.attached' group by 1"` against a daemon at or after `637222f9` — a `session` count that keeps climbing means the fix did not hold).

## What the drop actually cost (2026-09-05; falsify: `sqlite3 ~/.musterd/musterd.db "select datetime(created_at/1000,'unixepoch','localtime'), detail from audit where action='claim.superseded' and actor='dolly'"` — the six rows at 09:40:19 carry `same_workspace: false` in one work tree; if they read `true`, the key was reaching the server and this account is wrong)

Instances 3 and 4 disarmed ADR 365. The server compares work-tree identity **only when both sides sent a key** (`ws.ts` `sameWorkspace`); with one side silent it falls back to comparing the branch-qualified label, which is the pre-ADR-365 behaviour the key exists to replace. Since the label is renamed by a branch switch under the very session it identifies, seat `dolly` evicted its own live MCP session with its own `musterd status` — six `claim.superseded` rows, one work tree, a branch switch between them.

ADR 365 shipped the comparison on 2026-09-02 in [#1229](https://github.com/SandRiseStudio/musterd/pull/1229) and nothing fed it until 2026-09-05. **A guard is not armed by existing.** See [the three claim paths](the-three-claim-paths.md) for why fixing one client did not fix the others.

## Repair: remove the seam, do not fill the field in

Correcting the spelling leaves the trap armed for the next field. Both repairs that held were structural:

- **#1339** — one name from caller to builder (`workspaceKey`), with snake_case appearing only at the wire boundary. That restored TypeScript's excess-property check at the call sites, so the old spelling now fails to compile: `TS2561: ... Did you mean to write 'workspaceKey'?`. Why it could not fail before: [the conditional-spread blind spot](conditional-spread-blind-spot.md).
- **#1341** — one `identityClientOpts` builder for both `resolve()` and `resolveRead()`. The opts literal had been written twice by hand, which is *how* a single omission could hide; a test now pins that the two paths differ in `claimSeatPerRequest` and in nothing else.

## Finding the next one

Ask, of any optional attach field: **is there a test that reads it off the wire?** If the only tests construct the frame by hand, the field's presence is unverified no matter how green the suite is — the same blind spot [double-gated tests](double-gated-tests.md) describes, reached by a different road.

A cheap sweep, since these leave rows: group the live `presence.attached` audit detail by each optional field and look for a column that is uniformly null (or uniformly one value) across thousands of rows. That is what surfaced instances 1 and 2 — 3582 cli attaches with a null provenance, then 1174 human attaches with an invented one. Both were visible as rows for weeks before anyone grouped them.
