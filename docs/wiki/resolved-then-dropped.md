# Resolved then dropped

A value computed correctly at one end of a call chain and lost before the wire — the client had the right answer the whole time and never sent it.

This is the mirror of [correct by coincidence](correct-by-coincidence.md): there a surface reports a proxy that happens to equal the truth; here the truth is derived, held in a variable, and then quietly not passed on. Both are silent, but this one is worse to find, because every place you look — the resolver, the schema, the server — is correct. The defect lives in the handoff between them, which is the one thing no single file shows.

Four instances landed in two days (2026-09-04/05) across three packages, which is why it is a page. A fifth arrived on 2026-09-17, after the page existed and after its advice was followed — see [instance 5](#instance-5-sharpens-the-test-advice-the-wire-assertion-is-per-path-2026-09-17).

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
| 5 | `model_source` | `attestedModel()` kept `.model` from `resolveAttestation({model, source})` and discarded `.source` on the next line — then five call sites down-chain had nothing to pass | [#1552](https://github.com/SandRiseStudio/musterd/pull/1552) |

Instance 2 is the same wound from the other side and belongs here: a server that fills in an absent fact destroys the same distinction a client that drops one does. After it, a row could not separate *"the client said `session`"* from *"the client said nothing"*. Measured: 1174 of nick's `presence.attached` rows in 24h recorded `session`, a word his client never sent, and 0 recorded anything else (2026-09-05; falsify: `sqlite3 ~/.musterd/musterd.db "select json_extract(detail,'$.provenance'), count(*) from audit where actor='nick' and action='presence.attached' group by 1"` against a daemon at or after `637222f9` — a `session` count that keeps climbing means the fix did not hold). <!-- claim: defect -->

## What the drop actually cost (2026-09-05; falsify: `sqlite3 ~/.musterd/musterd.db "select datetime(created_at/1000,'unixepoch','localtime'), detail from audit where action='claim.superseded' and actor='dolly'"` — the six rows at 09:40:19 carry `same_workspace: false` in one work tree; if they read `true`, the key was reaching the server and this account is wrong) <!-- claim: defect -->

Instances 3 and 4 disarmed ADR 365. The server compares work-tree identity **only when both sides sent a key** (`ws.ts` `sameWorkspace`); with one side silent it falls back to comparing the branch-qualified label, which is the pre-ADR-365 behaviour the key exists to replace. Since the label is renamed by a branch switch under the very session it identifies, seat `dolly` evicted its own live MCP session with its own `musterd status` — six `claim.superseded` rows, one work tree, a branch switch between them.

ADR 365 shipped the comparison on 2026-09-02 in [#1229](https://github.com/SandRiseStudio/musterd/pull/1229) and nothing fed it until 2026-09-05. **A guard is not armed by existing.** See [the three claim paths](the-three-claim-paths.md) for why fixing one client did not fix the others.

## Instance 5 sharpens the test advice: the wire assertion is per-path (2026-09-17)

Instance 5 is the tier behind an attested model (ADR 301). It is the same shape — `resolveAttestation`
returns `{model, source}` because deciding which rung answers *is* the resolution, and `attestedModel`
kept the id and dropped the rung — but it cost a **ranking**, not just a field: ADR 158 says an
observation outranks a declaration, the roster ranks on `Presence.model_source`, and a null tier reads
as `unknown`. So a CLI-claimed seat whose harness probe genuinely fired ranked *below* a seat that
merely declared the same model. A rule that ranks two kinds of claim cannot rank a claim that never
says which kind it is.

Two things this instance taught that the sections above did not already say.

**Tests on either side of a seam cannot see the seam.** `attestedAttestation` and `identityClientOpts` both had direct unit tests, both green — and neutralising the one line in `gather()` that joins them, which is the literal defect, left all 15 of those tests passing (2026-09-17; falsify: change `modelSource: attestation.source` in `gather()` (`commands/helpers.ts`) to `undefined` and run `npx vitest run packages/cli/src/commands/helpers.attestation.test.ts packages/cli/src/commands/helpers.clientOpts.test.ts` — if any test goes red the join is covered and this is wrong). <!-- claim: defect -->

The test that does catch it starts where the fact starts — a binding on disk — and ends where it has to arrive, the header on the wire, crossing every boundary in between (`helpers.attestationSeam.test.ts`).

**A wire assertion only proves the path the test drove.** This page's advice — capture the socket write, capture the POST body — was followed on four call sites and still missed a fifth; what found it was reading the live daemon's `presence` table after running the freshly built CLI against it, which still read `surface=cli, model=claude-opus-5, model_source=NULL` while the header was provably correct on the same request (2026-09-17; falsify: run any authenticated command from a build carrying only the header fix, then `sqlite3 -readonly ~/.musterd/musterd.db "select surface, model, model_source from presence p join members m on m.id=p.member_id where m.name='ryder' order by last_seen_at desc limit 2"` — a non-null tier on the `cli` row means the claim path was already covered and this account is wrong). <!-- claim: defect -->

The cause is that **the paths write different rows.** `claimSeatPerRequest` claims the seat over WS
before the request, so the row an ordinary CLI act attaches to is born in `claimSessionLease` and is
*held*; the ambient header touch updates the newest row with `conn_id IS NULL AND held_until IS NULL`,
which is a different row entirely. Four fixed call sites and one missed one produced a green suite and
an unchanged database.

The missed one is the **per-request claim** — the third path in [the three claim paths](the-three-claim-paths.md),
which already calls it "the surprising one" and already warns that a field added to one builder reaches
at most two paths. That warning was correct, was written down, and did not stop the same omission:
`claimSessionLease` forwards `this.opts.model` into `watchClaim` field by field, so sharing
`buildClaimFrame` with the live claim bought nothing. **Reading the page is not the same as running its
check** — the grep it prescribes takes ten seconds and would have caught this before the daemon did.

The cheap check is the one from *Finding the next one*, run **after** the fix rather than before it:
group the live rows by the field and confirm the value actually moved.

## Repair: remove the seam, do not fill the field in

Correcting the spelling leaves the trap armed for the next field. Both repairs that held were structural:

- **#1339** — one name from caller to builder (`workspaceKey`), with snake_case appearing only at the wire boundary. That restored TypeScript's excess-property check at the call sites, so the old spelling now fails to compile: `TS2561: ... Did you mean to write 'workspaceKey'?`. Why it could not fail before: [the conditional-spread blind spot](conditional-spread-blind-spot.md).
- **#1341** — one `identityClientOpts` builder for both `resolve()` and `resolveRead()`. The opts literal had been written twice by hand, which is *how* a single omission could hide; a test now pins that the two paths differ in `claimSeatPerRequest` and in nothing else.

## Finding the next one

Ask, of any optional attach field: **is there a test that reads it off the wire?** If the only tests construct the frame by hand, the field's presence is unverified no matter how green the suite is — the same blind spot [double-gated tests](double-gated-tests.md) describes, reached by a different road.

A cheap sweep, since these leave rows: group the live `presence.attached` audit detail by each optional field and look for a column that is uniformly null (or uniformly one value) across thousands of rows. That is what surfaced instances 1 and 2 — 3582 cli attaches with a null provenance, then 1174 human attaches with an invented one. Both were visible as rows for weeks before anyone grouped them.
