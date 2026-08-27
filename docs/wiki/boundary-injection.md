# The boundary-injection trap

A test that injects a signal at the seam between its producer and its renderer proves the renderer works and says nothing about whether the producer can ever emit it — so a suite can stay fully green while the feature is unreachable in production.

## The shape

A feature has two halves: something that **produces** a signal (a fetcher reading a server field, a call site passing an argument through) and something that **renders** it (a chip, a banner, an orientation block). The convenient place to test is the seam between them — build the input object by hand, hand it to the renderer, assert the output. That test is real and worth having. What it is *not* is a test of the claim its name usually makes: that the feature works. If the producer is wired to the wrong field, or a call site drops the argument, every seam-injection test stays green, including the one named for exactly the behaviour that is broken (2026-08-26, observed on #1076; falsify: instance 1 below — the named emit-layer test is in `git show 4381c4d5`, the server condition it could never trigger at `packages/server/src/transport/http.ts:3878`).

First found on #1076 (statusline chip), 2026-08-26, twice in one PR; recurred on #1088 the next day. Seed: ledger message `01M0ZDVCGA`.

## Instance 1 — the marker that could never fire (2026-08-26, #1076; falsify: the server line `truncated = limit === undefined && full` at `packages/server/src/transport/http.ts:3878`, landed in #914 — if `waitingTruncated` was reachable with `limit=100`, that line did not say what this claims; the emit-layer test that stayed green is in `git show 4381c4d5`)

The chip's `+` truncation marker read `inboxRes.truncated`, but the server computes `truncated = limit === undefined && full` — it is exclusively the no-limit caller's signal, and the chip names `limit=100`. The marker was unreachable in production. The emit-layer suite was green the whole time, **including a test named for exactly that behaviour**: it injected `waitingTruncated: true` into the renderer and asserted the `+` appeared. The renderer could indeed render a `+`. Nothing could ever ask it to.

## Instance 2 — the recurrence, measured (2026-08-27, #1088; falsify: check out `9538e073~1`, revert the orientation call site, run the cli suite — the PR body records all 2051 tests green under that revert)

`openActionNeeded` gained a `discharged` parameter (ADR 254: an act a co-eligible seat already answered stops counting as owed). Every existing orientation test injected a `SessionOrientationInput` at the fetcher boundary — pinning the composer — so with the orientation wiring reverted, **all 2051 CLI tests stayed green**. The fix's test half added `sessionOrientationFetch.test.ts`, which talks to a stub daemon over a real socket; under the same revert exactly one test goes red, and it is the one named for the claim.

## Two sites are still in the trap (2026-08-27; falsify: drop the 4th argument `dischargedIds(res)` from `pendingActionSummary` in `packages/cli/src/commands/helpers.ts` and from `openRequests` in `packages/cli/src/commands/send.ts`, then run `pnpm --filter @musterd/cli test` — a red test falsifies this; measured 2055/2055 green with both dropped)

The #1088 fix wired six call sites but boundary-tested two (orientation, chip) plus the MCP auto-target twin. The comeback banner (`pendingActionSummary`) and the CLI `send` auto-target (`openRequests`) are protected only by the shared unit test, which a call-site revert does not touch — the same duplicate-verdict stakes the PR's own comments name. Flagged non-blocking in the #1088 review; measured again on main today. Whoever adds the boundary tests should strike this claim, dated.

## Why it is worse than no test

A missing test leaves an open question. A green test **named for the claim** closes it — the next reader and the next reviewer both stop looking (2026-08-26; falsify: the #1076 record — the marker's emit-layer test existed, was named for the truncation behaviour, and the wrong wiring shipped past review anyway). This is [correct by coincidence](correct-by-coincidence.md) inverted: there the *code* is right for the wrong reason and the fixtures hide the disagreement; here the *test* passes for the wrong reason — it manufactured the very evidence it claims to check. The neighbouring failure modes, for contrast: in [instrument silence](instrument-silence.md) the instrument says nothing and silence gets read as health; in [double-gated tests](double-gated-tests.md) the test never runs and skipped gets read as green. Here the test runs and passes, every time, and is telling the truth about the renderer — the lie is in the test's name.

The same blindness reaches falsifiers, not just suites: ADR 332's falsifier 1b first read "absent from the settings file", a mechanism-shaped check that a half-removed surface walked through twice. A test or falsifier that names the mechanism inherits the mechanism's blind spots; name the outcome.

## The rule, and the diagnostic

**If a test asserts a value the code must produce, at least one test has to cross the boundary where it is produced** — a real socket, a stub server, whatever the seam actually is. Injecting the value one layer up makes a renderer test; keep it, and name it as one.

The diagnostic is the revert asymmetry: revert the producer to the broken source and confirm that exactly the test named for the claim — and only that test — goes red. On #1076, reverting to `inboxRes.truncated` turned 1 of 19 red while all 7 emit-layer tests stayed green; the seven that stayed green were never testing the claim. A whole suite staying green under a producer revert is this page's trap caught in the act — which is precisely how the two sites in the section above were measured.
