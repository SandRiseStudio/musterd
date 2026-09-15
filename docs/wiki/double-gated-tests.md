# Double-gated tests can be wrong for years

A test that needs two independent permissions to run can rot into something that could never pass, while every signal anyone looks at stays green — because "green" for a gated test means *skipped*, and skipped tests are never falsified by the code moving under them.

## The shape

A gate on a test (an env flag, an owner opt-in, a spend authorization, a real-binary requirement) removes it from the loop that keeps other tests honest. One gate is survivable: someone eventually flips the flag. Two gates multiply — the test runs only when *both* are open at once, and if nobody is responsible for opening both, the answer is nobody, indefinitely. Meanwhile the codebase keeps moving, and nothing forces the fixture to move with it: CI reports the file as passing (0 tests run), coverage doesn't count it, and refactors that break its assumptions break nothing visible.

This is [instrument silence](instrument-silence.md) wearing a test runner: the suite's green is a quiet instrument, and a skipped test's green is the claim least likely to be checked. It is also a setup for [correct by coincidence](correct-by-coincidence.md) in reverse — the fixture doesn't drift into accidental agreement, it drifts into guaranteed disagreement, and the skip hides it.

## The measured instance (2026-08-24; falsify: `git show 1790bc6d:tests/codex-cli.acceptance.test.ts` boots against a strict-v2 daemon)

The owner-gated real-Codex acceptance test (`tests/codex-cli.acceptance.test.ts`) landed 2026-08-03 in #621 behind two gates: `MUSTERD_REAL_CODEX=1` *and* `MUSTERD_REAL_CODEX_CONFIRM=1` (a spend authorization — it drives the real Codex CLI). Excluded from CI by design. Between landing and 2026-08-24 it was **never executed once**, and for that whole window it could not have passed:

- The binding fixture predated ADR 281 (#928): no `version: 2`, and a `surface` key the strict v2 schema *rejects* rather than strips. Adapter boot would have died at parse.
- The `.codex/config.toml` fixture predated ADR 286: no `MUSTERD_LAUNCH_SURFACE = "codex"` marker, so the adapter would have refused Presence attachment.
- Its `.member` assertion was **never valid at all** — `member` left `BindingSchema` before #621 landed (ADR 075). The test asserted a field that did not exist on the day it merged.

That last one is the sharp edge: the test was not broken by later drift, it was born wrong, and review didn't catch it because review reads gated tests instead of running them. First real execution 2026-08-24 (Codex CLI 0.149.1, spend authorized by nick, after the #1038 repairs): 3/3 green in 28s. Evidence and the standing falsifier live in [06-testing.md](../architecture/06-testing.md#codex-harness-evidence-adr-216).

## What actually helps

- **A gated test has an owner and a date, or it is decoration.** Record the last real run next to the run instructions (as 06-testing.md now does for this test) — an undated gated test should be read as "never ran", because in this instance that reading would have been correct for three weeks and nobody made it.
- **First execution is part of landing.** A test that has never run once proves nothing about the code and nothing about itself; #621's fixture shipped with an assertion on a schema field that was already gone. If the gate is spend, the landing PR is the moment the spend is cheapest to justify.
- **When an identity/schema epoch turns, grep the gated tests too.** ADR 281 and ADR 286 both migrated live fixtures; the skipped fixture was the one that stayed behind, precisely because no run went red.
