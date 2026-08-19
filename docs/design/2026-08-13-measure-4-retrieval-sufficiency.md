# Measure 4: is there a retrieval problem yet?

ADR 259 gates its retrieval increment on measure 4 — _"instances of a seat re-deriving a fact that
had a wiki page. Materially non-zero ⇒ evaluate a retrieval index; ~0 ⇒ grep suffices, build
nothing"_ — and increment 4 is listed in Consequences as **"explicitly may never be built."** This
design does not build it. It builds the thing that decides whether it ever should, because on
2026-08-13 measure 4 was the only measure in the ADR with no instrument at all.

## The measurement problem, which is the interesting part

Measures 1–3 read themselves off existing traces: blob sizes are queryable server-side, `wiki:check`
catches are CI events, stale-claim incidents are broadcasts. Measure 4 has no trace, and the obvious
way to get one does not work.

**You cannot ask a seat whether it re-derived a fact that had a page.** A seat re-derives a fact
precisely because it did not know the page existed; at wrap-up it has nothing to recall and reports
zero. The measure would then read ~0 — "grep suffices, build nothing" — from an instrument that is
structurally incapable of returning anything else. That is ADR 259's own finding 4, the defect class
the whole memory arc is about (instruments correct when built, wrong when later consulted),
reproduced inside the measurement of it. A self-report here is not a weak instrument; it is a
guaranteed false negative.

So the seat is asked only for what it demonstrably knows — **the facts it learned this session** —
and the machine does the remembering. That inverts the ignorance: the seat supplies the half it
cannot be wrong about, and a mechanical search over `docs/wiki/` supplies the half it cannot know.

## Operational definition

**A measure-4 event is: a fact a seat reports learning this session, which an existing wiki page
already carried at the time the seat started.** Three clauses, each doing work:

- _reports learning_ — the seat's own account of what it took away, not an inference over its
  transcript. Cheap, and it is the only signal that distinguishes a fact the seat re-derived from
  one it merely read.
- _already carried_ — matched against the wiki, not against ADRs or code. Re-deriving something that
  is only in the source is not a retrieval failure of the knowledge layer; it is ordinary work.
- _at the time the seat started_ — a page a teammate committed mid-session was not available to be
  found. Compare against the corpus at session start (`git ls-tree` at that commit), not the tree on
  disk. See _shipping-a-pr.md_ on why a checked-out tree lies after a merge.

## The detector: `pnpm wiki:probe`

`scripts/wiki-probe.ts`. Facts in (argv or one per line on stdin), a verdict per fact out:

    pnpm wiki:probe "a conflicted PR gets zero check-runs so auto-merge waits forever"
    HIT     shipping-a-pr.md 100%  a conflicted PR gets zero check-runs so auto-merge waits forever

Bound it to the corpus the session started with — `--at <sha>`, or `--since <when>` for a seat that
knows the clock but not the SHA:

    pnpm wiki:probe --at 79c73320 "..."      # the commit this session started at
    pnpm wiki:probe --since 09:00 "..."      # resolved to the last origin/main commit before then

Scoring is **idf-weighted term coverage**, not tf-idf cosine. The question is asymmetric — "does
this page contain what the fact is about" — so a 6 KB page covering a one-line fact must score high,
which a length-normalised cosine buries. idf is what keeps `worktree` (3 pages) worth more than
`the` (all of them).

Three bands, and the middle one is deliberate: **HIT ≥ 0.60** (a measure-4 event), **REVIEW ≥ 0.35**
(a human decides), **MISS** below. Folding REVIEW into either side would make the measure round its
own ambiguity toward an answer — upward, and it argues for building an index nobody needs; downward,
and it hides the failure it exists to find. The count is reported as three numbers, always.

It always exits 0. This measures; it does not gate. A seat that learned nothing new is not failing.

### Calibration, measured 2026-08-13 against the live 26-page corpus

| Test                                              | n   | Result                                                      |
| ------------------------------------------------- | --- | ----------------------------------------------------------- |
| Each page's own summary line → its own page       | 26  | 26/26 HIT, correct page (sensitivity floor; asserted in CI) |
| Hand-written paraphrases of facts known on pages  | 5   | 5/5 HIT, correct page, 61–100%                              |
| Facts with no page (one off-domain, one on-topic) | 3   | 2 MISS, 1 REVIEW at 40%                                     |

The single REVIEW is the known limit, and it is worth naming: _"the espresso machine on the third
floor takes 40 seconds to warm up"_ scores 40% against `office-scene.md` — a page about the office
that says nothing about espresso. **Topical overlap without factual overlap lands mid-band.** It
does not become a false HIT (asserted by test), so it cannot inflate the measure; it costs a human
one glance. Falsify these numbers by re-running `pnpm vitest run scripts/wiki-probe.test.ts` and the
paraphrase set in that table.

Sensitivity against real, unrehearsed seat facts is **not** established — the paraphrases were
written by the same seat that wrote the scorer, which is the weakest possible calibration. The first
ten real wrap-up runs are the honest sample, and this section should be re-measured against them.

**First real run, 2026-08-13 (ryder's own wrap-up, n=3), and it disagrees with the table above.**
Three genuinely-learned facts — none on any page — scored 0 HIT, **2 REVIEW**, 1 MISS: a musterd tool
signature landed at 43% against `office-scene.md`, an eslint rule at 41% against
`running-the-gates.md`. Both spurious. The rehearsed set produced 1 REVIEW in 8; the first
unrehearsed set produced 2 in 3.

The direction matters more than the ratio. The REVIEW band's cost is a human glance, and at 2-in-3
that glance becomes the ritual rather than the exception — seats will start skipping it, which is
how an instrument goes silent. The tempting fix is to raise `REVIEW_AT` until the noise stops; that
is fitting the threshold to make the answer comfortable, on n=3, and it trades the false positives
for exactly the false negatives measure 4 cannot afford. **Do not tune the threshold before the
ten-run sample exists.** If the rate holds, the honest fix is a better scorer (the misses are
short facts whose few terms are all corpus-common), not a moved line.

### 2026-08-19: the session-start boundary, which the first cut did not implement

The operational definition's third clause — _at the time the seat started_ — was prose only until
now. `wiki-probe.ts` read the working tree with `readdirSync` and took no ref, so a page a teammate
committed mid-session could score a HIT for a fact the seat had no way to find. gptbot declined the
lane on 2026-08-14 for exactly this, and was right to: the error is one-directional. It can only push
measure 4 **up**, toward "build a retrieval index", which is the one direction this design is
supposed to be hardest to move in.

`--at` / `--since` load the corpus from git at that commit — blobs, not just the file list, so a
_section_ appended to a page the seat already had is excluded on the same grounds as a whole new
page. Regression fixture is real history, not a mock: `bugbot sometimes fails to register its
check-run` scores 72% HIT on `shipping-a-pr.md` against the tree today, and MISS at `2b968ead`
(#783, the wiki's first commit) because that page arrived a day later in #787.

Two refusals go with it, both of the same family as the defect itself — a number that looks like a
reading but is an artifact:

- A bound that was **asked for and could not be resolved** does not fall back to the working tree.
  Falling back would silently unbound the measure with nothing in the output to show it.
- A ref that resolves but **carries no pages** (anything before #783) says the run measured nothing,
  rather than letting an empty corpus report `0 measure-4 events` as if the wiki had been consulted.

Unbounded runs still work — this is a wrap-up convenience, not a gate — but their count line now
says the HITs are an upper bound. **Every reading before this date was taken unbounded**, so the
ledger's one HIT needed re-checking rather than grandfathering. Re-probed 2026-08-19 against
`--since 2026-08-14T00:00:00` (`272d4ad3`, the corpus as dolly's session opened), dolly's `pnpm
format` / `format:check` glob fact still scores 94% HIT on `shipping-a-pr.md`, which landed
2026-08-12 in #787 — two days before the session that re-derived it. **The event stands as a genuine
measure-4 event.** It was true unbounded and it is true bounded; what changed is that the second
sentence can now be said at all.

### The ledger

The message log, per ADR 259's own layering (git for knowledge, the message log for events). A
measure-4 event is an event: the seat reports its HITs — and its call on each REVIEW — in a
`status_update` at wrap-up. No new store, nothing that can go stale, and it is already the dataset
the ADR's other measures are read from.

## Pre-registered evaluation, for if it fires

Registered now, before any data exists, so that a future session cannot design the comparison after
seeing which way the numbers point.

**Trigger.** ≥ 10 HIT events across ≥ 3 distinct seats within a 30-day window, on a corpus of ≥ 40
pages. Below that, the null result stands and nothing is built. Rationale: fewer than 10 is
indistinguishable from two seats having a bad week; a single seat's hits are a seat problem (it is
not running the probe, or not reading INDEX.md), not a retrieval problem.

**Fixture.** The accumulated HIT events themselves — the team's actual lookup failures, exactly as
ADR 259 specifies. Each is a (fact, page-that-had-it) pair, which is a ready-made retrieval query
with a known correct answer. This is the reason to collect them even in the world where the index is
never built.

**Arms.** (a) grep/ripgrep over `docs/wiki/`; (b) this probe's idf scorer, which by then has a track
record; (c) Cognee-over-wiki, with finding 3's `ok:true, queryable:false` durability wart as a
declared risk; (d) a temporal KG (Graphiti-class). Every arm must be rebuildable from `docs/wiki/`
alone — nothing may live only in a cache (ADR 259).

**Win condition.** An arm must beat **grep** on recall@1 over the fixture by a margin that survives
the fixture's size, AND cost nothing in durability: an index that cannot answer whether a write
landed is disqualified regardless of its recall, because that reintroduces finding 3.

**Pre-registered prediction.** At a corpus under ~100 pages, grep and (b) tie within noise and no
arm justifies its maintenance. If that is what the data shows, the honest output is a dated null
result on this page and no increment 4 — which the ADR already sanctions.

## The null result, as of today

Measure 4 **cannot have fired yet**, and no one should read that as evidence. `docs/wiki/` was
committed 2026-08-13 and is one day old; there has not been a session that could have re-derived a
fact from a corpus that did not exist when it started. The first meaningful read is not before
**2026-09-12**, the ADR 259 measure-1 decision point, by which time the corpus and the probe will
have a month of wrap-ups behind them.

Until then the number is _unmeasured_, not _zero_ — the distinction ADR 173 exists to enforce, and
the one that would otherwise let increment 4 be closed by silence.

## What this deliberately does not do

No index, no vendor, no new store, no musterd surface, no gate. The probe is a wrap-up convenience
that a seat can skip; skipping it costs a data point, not a build. Re-litigating the four-layer
decision or the wiki conventions is out of scope — those are ADR 259, accepted.
