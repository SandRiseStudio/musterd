# 310 — Reconcile reads guard 2: canonical drift is reported by the process that already opens every roster file

Status: accepted 2026-08-24 (dolly)
Lane: 01M0TV9YXPHGTSND052Z2JXGX1
Builds on [ADR 058](058-durable-on-git-live-on-daemon.md) (guard 2), [ADR 304](304-roster-files-report-their-unknown-keys.md)
(the warning rail), [ADR 309](309-canonical-form-is-the-form-hand-authors-write.md) (what canonical means).

## Problem

`musterd fmt --check` is guard 2 of ADR 058, it has been correct since it was written, and **nothing
runs it.**

Measured 2026-08-24: `roles/admin.toml` and `roles/observer.toml` on the live roster were
non-canonical from **2026-08-04 to 2026-08-24** — twenty days — and the only reason anyone found out
is that a seat ran the check by hand while working on something else. The roster reached zero drift
that night the same way: by hand. Nothing will notice when it leaves zero.

This is the shape the wiki calls instrument silence, and it is worse than the drift it failed to
report: the guard's existence is what stopped anyone looking.

## Constraint

**CI cannot cover it.** The live roster is not in this repository — it lives in the roster home
(`/Users/nick/musterd/revive/.musterd` on this machine). A `format:check`-style gate in the agents
repo would be an instrument pointed away from its subject, and would report green forever while the
real files drifted. That is a worse failure than no instrument, because it reads as coverage.

A guardian incident class was the other candidate. It is a protocol change (`GuardianClass` is on the
wire), it needs its own collector, and it escalates a blank line to the same channel as `daemon_down`
— a raise nobody can act on trains seats to clear raises on sight, which ADR 294's evidence already
shows happening.

## Decision

**The daemon's reconcile reports canonical drift, on its own channel, and still projects.**

1. `loadTeamSpec` compares `serialize(parse(text))` to the file's bytes at each of the three call
   sites where it already holds the raw text, and returns `TeamSpec.drift: string[]`. One string
   compare per file; the parse it needs has already happened.
2. `ReconcileResult.drift` carries it out, and `reconcileAll` logs one `reconcile_file_drifted` line
   per file, tagged with `root` and `team`.
3. **Separate from ADR 304's `warnings`, deliberately.** A dropped key loses data; drift is only
   untidy; the fixes differ. ADR 304's own lesson is that a reader must be able to tell its findings
   apart, and folding these together would undo it. An unknown key makes a file both non-canonical
   *and* lossy — such a file now says so twice, distinctly.
4. **Warn, never fail.** Fail-closed here would refuse a seat over a blank line.

No schema, no wire field, no protocol change: `TeamSpec` and `ReconcileResult` are server-internal.

## Consequences

- The instrument runs continuously against the **real** roster, on every reconcile pass, rather than
  against a copy of the format in CI.
- It reports; it does not fix. Nothing here writes to a roster — `musterd fmt` is still a supervised
  human action (ADR 309), and it must stay one.
- A roster that is never reconciled is never checked. That is a real hole and it is the honest one:
  this instrument's coverage is exactly the daemon's reach, and it says so rather than implying more.
- `fmt --check` remains the hand tool and the authority. This is a second reader of the same
  property, not a replacement — if the two ever disagree, the serializer is the tiebreak and one of
  the two readers is wrong.

## Observability & Evaluation

**Traces.** `reconcile_file_drifted` in the daemon log (`~/.musterd/daemon.log`), one line per
non-canonical file per pass, carrying `root`, `team`, and the file's roster-relative path.

**Eval.** Dataset: `reconcile_file_drifted` lines in the daemon log. Pre-registered at acceptance
(2026-08-24), measured through the built loader rather than asserted: the live roster returns
`drift: []` across 15 seats and 6 roles, and a scratch copy with one blank line removed from
`roles/admin.toml` returns `drift: ["roles/admin.toml"]`. Mutation-checked — replacing the compare
with `false` turns 4 tests red, so the tests pin the instrument and not its shape.

**Experiment.** Read the log at 30 days (2026-09-23), the same date ADR 309's manual re-read falls
due, and compare the two readers. If `fmt --check` finds drift the log never mentioned, the daemon's
reach is smaller than assumed and the coverage claim above is wrong. If the log carried a drift line
for days and the file is still drifted, then reporting is under-powered for this finding exactly as
ADR 304's 30-day question asks about dropped keys — and the two should be answered together, since
by then they will be two instances of one result about warnings nobody acts on.
