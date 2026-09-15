# Retrospective cut — 2026-08-12 to 2026-08-20

One-shot retrospective over eight days of team history (ADR 294 increment 1; lane
01M018YGRGAYVWR7YDZS65NTPQ). Produced by dolly on 2026-08-20. This is a **curated sample, not a
census**, and it deliberately computes no per-seat or per-model table — see "What this cut
withholds" and "What this cut cannot know" before quoting anything from it.

## Method

Sources: the message stream (read-only SQLite over `~/.musterd/musterd.db`), lane records, and git
history of `docs/wiki/` and `docs/decisions/`. Candidate events were pattern-matched (retraction /
correction / "I was wrong" / challenge acts / factual-error language), then curated by hand into
entries only where the original claim, the falsifying evidence, and the correction could all be
identified. Window denominators, counted not estimated:

- stream messages in window: **2,194**
- lanes resolved in window: **147**
- pattern-matched candidate messages: **108** (one falsification event typically produces several
  matching messages — the claim, the correction, the concession, acceptances quoting them; by
  inspection these collapse to roughly 25–30 distinct events)
- entries curated: **15**

The 10–15 uncurated events are mostly smaller record corrections and double-echoes; nothing was
excluded for being embarrassing. They remain minable — the window's raw material does not expire.

## The tallies (n=15 — illustrative, not statistics)

By detection channel:

| channel | n | entries |
| --- | --- | --- |
| self | 6 | daemon-bounce-hypothesis, sync-test-timeout-dismissal, autorefresh-never-installs, main-is-red, blob-size-estimate, contaminated-typecheck-count |
| peer | 5 | acceptance-ask-misnamed-lane, goals-test-broken, nothing-is-lying-wake-leases, adr-260-item5-attribution, guardian-daemon-down |
| acceptance | 1 | egress-post-identical-failures |
| challenge | 1 | adr-272-routing-past-the-gate |
| human | 1 | five-dead-nvidia-slugs |
| collision | 1 | vitest-known-noise |

By claim class: defect 4, measurement 4, absence 3, causal 3, record 1.

By detection latency: under an hour 4, same day 9, **days 2** (5 and 7 days).

## What the sample says (and how far to trust it)

1. **Self and peer channels catch most of what gets caught, fast.** 11 of 15 entries were falsified
   within hours by the claimant or a teammate, without any gate involved. The correction culture is
   real and it is the ledger's whole capture mechanism — which is also its bias (see below).
2. **The two claims that lived for days were both `absence`-class, and they were the costliest.**
   The vitest "known noise" claim (7 days; a lane and a working day) and ADR 272's unmet gate
   (5 days; downstream lanes re-scoped) both survived *because of their form*: a reassurance stops
   people looking, and a falsifier that cannot fail reads as confirmation. This is the
   longitudinal-measurement motivation in the data: the dangerous claims are not the wrong numbers
   — those get remeasured — but the claims that say measuring is unnecessary.
3. **One systemic generator produced multiple entries.** The stale gitignored
   `packages/protocol/dist` minted two false defect claims in this window alone (goals-test-broken,
   main-is-red) and running-the-gates.md records four recurrences overall. The effective fix was a
   control (#841's typecheck guard), not vigilance. This is what "measuring impact" buys: recurring
   generators are visible only across entries, never inside one.
4. **Measurement conditions are claims too.** Five slugs "dead" at an 850-word probe, two alive at
   100 words. A point-in-time measurement is a claim about the conditions it ran under; worded as a
   general statement, it was false.
5. **Corrections themselves err.** One entry is `amended` because the retraction over-corrected
   (autorefresh-never-installs, settled by the log two rounds later), and the bounce-hypothesis
   entry records a wrong cause offered *while correctly clearing* a false raise. This is why
   entries carry falsifiers and a challenge path — the ledger's own records must not be exempt from
   the discipline they record.
6. **Near-misses exist and the ledger cannot see them.** On 2026-08-19 ryder built a dating check,
   tested it against the incident that motivated it, found it would have passed (i.e. caught
   nothing), and threw it away. A claim falsified before publication mints no entry — the schema's
   unit is the published claim. Worth remembering when reading rates: the discipline that prevents
   claims is invisible here.

## What this cut withholds

Per ADR 294 decision 6, no per-seat or per-model tables are computed here or in any agent-facing
surface until the checkpoint. The raw entries carry seat and model attestation, so the cut is
reproducible at the checkpoint. Beyond the holdback, two reasons such a table would mislead at
n=15: detection bias (a seat whose work gets remeasured hard generates more entries — scrutiny,
not dishonesty) and task-mix confounding (seats do different work; models sit in non-random seats).

## What this cut cannot know

- **Uncaught false claims.** Everything here was caught. The false claims still standing in the
  record are, by definition, absent. This cut measures the correction pipeline, not truth.
- **The true claim denominator.** 2,194 messages and 147 lanes bound it loosely, but claims per
  message is unmeasured, so no false-claim *rate* is computable — and none is offered.
- **Curation selection.** Pattern-matching finds seats that correct loudly. A seat that never
  corrects generates no entries and would look perfect. Treat absence of entries as absence of
  detection, never as reliability.
- **Anything before 2026-08-12.** Earlier history (a visibly rich correction record from Aug 1–5)
  remains unmined and minable; this window was chosen for evidence quality, not because it is
  special.

Falsifier for this cut as a whole: re-run the method over the same window; if it surfaces
falsification events this cut's tallies misclassify, or well-evidenced events materially changing
observation 2 (the absence-class/longevity link), the cut is wrong and gets invalidate-dated.
