# 435 — The publisher's failure signal is read from its last build outcome, not from a log scan

**Date:** 2026-09-21
**Status:** Accepted
**Lane:** 01M32XN1YRAP5MQP6C0A2HBM4M

## Context

Guardian's `publisher_failed` class watches the `/live` build-publisher (ADR 132). Its signal was
computed in `collectSignals` as:

```ts
const buildMtime = await d.statMtime(d.publisherBuildLogPath);
const okMtime = await d.statMtime(d.publisherOkStampPath);
const failLines = buildMtime !== null ? await d.readSince(d.publisherBuildLogPath, bootedAt) : [];
const freshFailure =
  failLines.some((l) => /error|failed/i.test(l)) &&
  buildMtime !== null &&
  (okMtime === null || buildMtime > okMtime);
```

On 2026-09-21 the publisher genuinely failed at 14:09 — `check-prerendered-routes` (#1618) refused
to publish a bundle missing `/audit`, `/character-sheet` and `/live`. Guardian classified it, ran
`refresh --live`, and the publisher recovered at 14:10. It then published cleanly at 14:15, 14:17,
14:19 and 14:29.

Guardian went on reporting `incidents: publisher_failed` on every two-minute tick through all of
them. It was quiet only because `damp.ts` was suppressing it — `suppressed` climbed 1→5 in ten
minutes — and `RAISE_WINDOW_MS` is one hour, so it was due to re-raise at ~15:13 and hourly
thereafter, about a publisher that was working.

## Problem

The predicate had **no recovered edge**, for three independent reasons. Any one of them is
sufficient; together they make the class structurally unclearable.

**1. Nothing writes `publisher.ok`.** The path was constructed in `service.ts` and read in
`signals.ts`. No writer existed anywhere in the repo, and the file was absent on the hub machine.
So `okMtime` was always `null`, which makes the clearing clause `(okMtime === null || buildMtime >
okMtime)` a tautology — it can never be false.

**2. `readSince` does not do what its name and doc say.** Its doc comment reads "Lines of `path`
whose timestamp is at/after `epochMs`". The implementation gates on the *file's* mtime and then
returns `.slice(-400)` — no per-line filtering at all. `build.log` is appended by the publisher
continuously, so the mtime gate always passed, and the window was "the last 400 lines", unbounded
in time. A daemon bounce did not clear it: the next build re-opened the same window onto the same
text. The actual clearing condition was the failure transcript *scrolling out* of a 400-line tail —
and a failed build dumps ~450 lines while a successful one appends two, so recovery needed ~170
successful publishes.

**3. A text scan cannot tell a diagnosis from a symptom.** Of the six lines matching
`/error|failed/i` in the window, three were `[prerender] Encountered error, retrying: …` from
retries that then *succeeded*, and two were `check-prerendered-routes`' own explanatory prose
("the routes that errored", "A page that fails four times is a real bug"). The gate that correctly
refused to publish a hole was itself helping hold guardian's incident open — the same shape as the
`mentions-are-not-uses` section that refused its own `SKILL.md`.

Two consequences followed from the reason string never changing. The raise carried **empty
evidence** — `raiseReason`'s third field was `''`, so the operator was told guardian had given up
but not what was wrong, and a human had to read `build.log` to learn it was three dropped routes.
And `shouldRaise`'s "the reason has CHANGED, so this is information the human has not seen" escape
hatch could never fire; only the hour timer could.

ADR 432's `clearRaise` is correct and was working — `guardian.log` shows it closing `daemon_down`
and `daemon_wedged` at 14:11. It could not reach this class because `act.ts` skips any class still
present in `incidents`, and this class was never absent from `incidents`. 432 built the discharge
half; the signal never produced the edge that half waits for.

**The unit test was green throughout.** It injected a `statMtime` for `/tmp/build.ok`, a fixture
stand-in for the file nothing writes. It asserted that the mtime comparison worked, and it could
not see that one of its operands does not exist in production. That is how this shipped.

## Decision

Read the publisher's state from **its own outcome vocabulary**, bottom-up, and take the last
completed outcome as the answer.

The publisher script prefixes every line *it* writes with `date '+%F %T'`; every line the *build*
writes — vite's asset table, pnpm, `check-prerendered-routes`' diagnosis — is not prefixed.
Anchoring on that prefix is what separates the publisher reporting an outcome from a gate
explaining what a failure looks like:

```
^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} (published |web build failed|worktree re-create FAILED|cannot cd to )
```

- `published` → healthy. `web build failed`, `worktree re-create FAILED`, `cannot cd to` → failed.
- No outcome line in the window → `unknown`, which is **not** healthy (ADR 173: absent is unknown,
  never zero). A guardian that read silence as health would go quiet about a publisher that had
  never run. `unknown` does not raise, and does not clear an existing raise either.
- A build in flight has written `building <sha>` and no outcome yet. It deliberately does not move
  the verdict: mid-build is evidence of nothing, and treating it as failure would raise once per
  retry.

Three supporting changes:

- **`publisherOkStampPath` is deleted**, not given a writer. The publisher already records success
  twice — `.published-sha` and its own log line — and a third marker written solely so a watcher
  could stat it is state that can drift from the thing it describes. Note that pointing the reader
  at `.published-sha` would *not* have worked either: `build.sh` writes that file **before** it
  echoes the `published` line, so `build.log`'s mtime is always the newer of the two and
  `buildMtime > okMtime` would have stayed true through every success.
- **`readTail(path, maxLines)` replaces `readSince` for this read**, and says in its doc that it is
  not mtime-gated. The publisher's state is whatever its log last said, however long ago it said
  it; a quiet publisher is not a recovered one. The bound is 2000 lines — sized against a ~450-line
  failure transcript, with margin for several, so the newest outcome is inside the window even
  after a run of failures. The old 400 could not promise that: one failure transcript was longer
  than the window it had to be found in.
- **`statMtime` is dropped from `SignalDeps`.** It had no remaining consumer there once the
  predicate went. A dep with no reader is the same rot as a reader with no writer, one direction
  reversed.

## Consequences

- `publisher_failed` now has a recovered edge, so ADR 432's `clearRaise` reaches it: the first
  clean publish after a failure drops the memo, sends the `resolve` on the ask's thread, and
  un-damps the class so a genuine recurrence is heard as news rather than withheld as a repeat.
- **Verified against the live log.** At 14:29 on the hub, with guardian stuck, the old predicate
  returned `failed (LATCHED)` and the new one returned `published`, reading
  `2026-09-21 14:29:30 published b09ec5a0 → …`. Same bytes, both predicates, opposite answers.
- The signal is now coupled to the publisher script's wording. That is a real coupling and it is
  the right one — it is a contract between two parts of the same install, generated by the same
  command — but a future edit to `build.sh`'s outcome lines must update the pattern. The tests pin
  the current vocabulary so such an edit fails here rather than going quiet in production.
- The tests no longer fabricate an operand production lacks. They drive the parser with real log
  lines, including the six that fooled the old predicate, so a wiring that stops producing that
  vocabulary fails the suite.
- **Not addressed here:** the raise still carries empty evidence, and the prerender drop is
  load-related and will recur on a busy laptop. The first is a follow-up on the same class; the
  second is the publisher's own retry question, which miley holds. Neither is this lane.

## Observability & Evaluation

**Traces.** 
`~/.musterd/guardian/guardian.log` — `incidents: publisher_failed` should stop appearing within one
tick of the first clean publish after a failure, followed by a `guardian.cleared` row naming the
class, the raise it closes and the suppressed count. If `incidents: publisher_failed` is still
logged after a line matching `published` is the newest outcome in `build.log`, this decision is
wrong.

**Eval.** n/a — mechanical. The decision is a parser over a fixed vocabulary, not a judgement, so
there is nothing to score against a dataset. Its correctness is pinned by unit tests over real log
lines (including the six that fooled the predecessor) and by the A/B below.

**Experiment.** Already run, on the live hub log at 14:29 with the incident open: the old predicate
returned `failed (LATCHED)`, the new one `published`. Same bytes, same window, opposite answers —
the baseline is the shipped predicate and the measurement is the disagreement.
