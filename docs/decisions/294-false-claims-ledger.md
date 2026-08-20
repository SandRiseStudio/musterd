# 294 — The claims ledger: a false claim is recorded by its correction

- Status: proposed
- Date: 2026-08-20
- Deciders: nick, dolly (design conversation 2026-08-19/20)
- Origin: seed captured 2026-08-14 via Slack — "Need to start recording wrong claims made by
  agents and measuring their impact" (lane 01M018YGRGAYVWR7YDZS65NTPQ)
- Relates to: ADR 056 (research as first-class practice — this ledger is one of its instruments),
  ADR 259 (git is truth; derived indexes are declared caches), ADR 101/158 (model attestation —
  what makes per-model cuts possible), ADR 109 (git attribution), wiki README rules 2–4 (dated
  claims, falsifiers that can fail, corrections invalidate-dated)

## Context

Seats measure once and treat the snapshot as timeless. Sometimes acceptance remeasures and catches
it; sometimes the wrong claim stands for days and is found only when a lane collides with it. The
week of 2026-08-12 supplied the canonical cases: a wiki claim ("that flake is runner noise — live
with it") that carried a date and a falsifier and still misled the team for seven days because the
falsifier could not fail; an ADR that cited a measured gate as satisfied when the gate had never
fired; and a same-day sequence in which a seat cleared a false alarm correctly while attaching a
wrong cause, ran its own falsifier, and retracted — all on the record.

The team's correction culture is loud and real (the retrospective found ~25–30 distinct
falsification events in eight days) but produces prose, not data. Nothing records who claimed what,
who caught it, through which channel, how long it stood, or what it cost — so nothing can say
whether acceptance catches what it should, which claim classes are dangerous, which systemic
generators keep minting falsehoods, or how models compare on any of it (the ADR 056 question).

## Problem

Capture false claims without compounding the disease being treated. Three failure modes were
designed against, explicitly, with nick:

1. **The ledger becomes paperwork** — a claim-registration tax at claim time that agents route
   around, or a scheduled sweep that becomes one more control believed to be in force.
2. **The ledger becomes a leaderboard** — published per-model "false claim rates" that are really
   detection-bias artifacts, quoted without their denominators.
3. **The ledger gets gamed** — agents hedge into unfalsifiability, under-claim, or (worst) stop
   self-correcting because wrongness is scored.

## Decision

1. **The ledger lives in git.** `docs/claims/README.md` (schema, minting rules) and
   `docs/claims/entries/*.md`, one file per entry, append-only; a wrong entry is overturned in
   place with a dated note, never deleted. No new store; no daemon table; ADR 259 shape.

2. **An entry is minted by the corrector, at the moment of correction, riding an act that already
   exists.** The four surfaces: an acceptance that overturns or materially amends a submitted
   claim; a challenge that ends in concession; a self-correction posted to the stream; a wiki
   strike-through or ADR amendment (the striking commit carries the entry). **No scheduled sweeps,
   no patrol, no background extraction** — nick's explicit constraint. The claimant pays nothing
   at claim time.

3. **Entries are themselves claims.** Every entry carries a falsifier that can fail (wiki rule 3).
   The claimant may challenge an entry once, with evidence; a losing entry is marked `overturned`
   and stays visible. The retrospective already contains an `amended` entry — corrections err too,
   and the ledger is not exempt from its own discipline.

4. **No bare rates, ever.** Any computed cut over entries must carry its detection-channel
   breakdown and its denominator basis. The ledger measures *caught* wrongness; catching is
   proportional to scrutiny; a rate without its detection story is the falsifier-that-cannot-fail
   problem in a new costume.

5. **Observational only, and self-correction scores best.** Ledger data feeds nothing automatic —
   not lane routing, not seat privileges, not acceptance thresholds. When cuts are eventually
   read, the published badness ordering of channels is: self-caught is the *least* bad way to have
   been wrong, then peer, acceptance, challenge, human, and collision-days-later worst. If the
   ledger ever makes a seat regret posting a retraction, it has failed at its one job. If stated
   confidence is ever added to claims, scoring uses a proper scoring rule (Brier-style), under
   which honest confidence is the optimal strategy — that is the design north star: the cheapest
   way to game the metric must be identical to the behavior the metric wants.

6. **Visibility holdback, with an expiry the ADR itself records.** Raw entries are public in git
   from day one (they must be — the corrector commits them). Computed per-seat and per-model cuts
   stay out of every agent-facing surface — orientation briefs, acceptance context, wiki — until
   **the checkpoint: 2026-10-01, or 100 forward-captured entries, whichever comes first.** At the
   checkpoint nick decides: publish the cuts, or extend once with a new written date. An undated
   holdback would become the next control believed to be in force; this one expires by
   construction. Known leak, accepted: any seat can compute its own cut from public entries; we do
   not surface it and do not prohibit it, and the effect is itself observable in the experiment
   below.

7. **Increment 1 is retrospective and one-shot** (this change): the schema, fifteen curated
   entries from 2026-08-12–20, and one cut aggregated only by channel/class/latency
   (`docs/claims/2026-08-20-retrospective-cut.md`). No code. The acceptance-must-mint rule
   (decision 2, surface 1) binds socially from this ADR's acceptance; gate enforcement — the
   acceptance path checking that an overturn carries an entry — is a later increment, built only
   if forward capture shows unminted overturns actually occur.

## Consequences

- Correctors write ~15 lines of structured frontmatter at the moment they are already writing the
  correction prose. Claimants do nothing new.
- History before the ledger's existence is an uncontaminated baseline: it cannot have been written
  to please the metric. Everything forward is post-treatment.
- The ADR 056 research program gains a claims axis: entries carry seat and model attestation, so
  model / harness / memory comparisons can include calibration and detection-latency once the
  holdback lifts — with decision 4's confounds attached.
- A recurring false-claim generator (the retrospective's stale-dist family) becomes visible across
  entries, turning "be more careful" into "build the control".

## Observability & Evaluation

**Traces.** The entries are the trace: entry files reference message ids, PRs, and commits; git
supplies who/when for the entries themselves (ADR 109).

**Eval.** At the checkpoint (2026-10-01 or 100 forward entries): (a) forward entry rate per week
against the retrospective's ~25–30 events/8 days — a large gap in either direction means minting
is being skipped or corrections have collapsed; (b) detection-latency distribution — the design
succeeds if the `collision` share shrinks; (c) self-correction share — if it *drops* after this
ADR merges, decision 5 has failed and the holdback question reopens before any cut is published.

**Experiment.** The before/after around this ADR's merge measures the observer effect itself:
claim boldness, falsifier quality (rule-3 compliance), and retraction frequency, compared across
the pre-ledger baseline and forward capture. The measurement system's damage to the measured
behavior is a result, not an accident to explain away.

## Falsifier for this ADR's premise

If forward capture through the checkpoint yields fewer than ~10 minted entries while corrections
demonstrably continue in the stream (pattern-match finds them), then correction-time minting does
not capture the phenomenon and decision 2 is wrong — revisit capture at the acceptance gate
instead. If self-correction share drops materially post-merge, decision 5's protections are
insufficient regardless of entry volume.
