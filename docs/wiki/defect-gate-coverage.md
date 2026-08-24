# DEFECT_RE coverage

The wiki defect-claim gate would catch roughly a fifth of the wiki's own defect claims if their dates were dropped — and the larger hole is structural, not vocabulary: two in five defect claims live in headings, which the gate never lints at all.

## The definition — what "coverage" means here (2026-08-24; falsify: read the header comment of `scripts/wiki-coverage.ts` against this paragraph)

Before this meter, recall had one anecdote ("~10%") with no denominator. The definition now enforced in `scripts/wiki-coverage.ts`:

- **Corpus**: every non-fenced line in `docs/wiki` (INDEX.md aside) carrying **both** a date and a `falsify:` marker — the self-labeled population of authors who followed README rule 2.
- **Labels**: each corpus line is hand-labeled in `scripts/wiki-claim-labels.json` as `defect` (asserts an absence or malfunction — the broken/absent/unconsumed population `DEFECT_RE` exists to police) or `other` (rules, principles, measured facts, positive-behavior traps, statuses, titles, fragments — territory the gate deliberately does not lint).
- **Coverage**: the share of `defect` lines the gate would still catch if the author forgot the date. The dated parenthetical is stripped before matching, so no credit comes from defect vocabulary inside the falsifier text itself; a heading line counts as missed regardless of vocabulary, because `checkWiki` returns from heading lines before its `DEFECT_RE` branch.

`pnpm wiki:check` prints the number on every run and fails on an unlabeled corpus line or a stale label — the denominator stays complete on touch. The number itself never gates: a target number would be answered by relabeling, not by widening.

## Measured 2026-08-24: 10 of 50 defect claims covered (falsify: `pnpm wiki:check` — its second output line is this number, recomputed)

At the meter's first run (103 corpus lines, 49 labeled `defect`; 50 once this page's own heading-miss claim below joined the corpus): coverage **10/50**, with **19 shape misses** and **21 heading misses**. The 2026-08-24 widening that added the "reaches-nobody" family bought real ground — 6 of the 10 covered claims match on shapes added that day — and the honest recall is still one in five.

## Headings are never linted, and that is the bigger hole (2026-08-24; falsify: `checkWiki` in `scripts/check-wiki.ts` — the `HEADING_RE` branch returns before the `DEFECT_RE` test; or relabel nothing and count the meter's heading misses against its shape misses)

This wiki's house style puts the claim **in** the heading — `## <claim> (<date>; <falsifier>)` — so the gate's structural skip of heading lines excludes 21 of 50 defect claims from linting entirely (2026-08-24), including specimens in already-enforced shapes (`` `gh pr edit` is broken on this repo ``, "`modelDrift` is computed and read by nothing"). Widening `DEFECT_RE` cannot reach any of them. If heading linting is ever added, do it deliberately: headings carry their dates inline by convention, so the false-positive surface is different from body prose — measure before and after with this meter.

## Limits of the number (2026-08-24; falsify: each limit names its own check)

- **Survivorship**: the corpus is rule-2-compliant lines — claims by authors who already dated them. The gate's true target, the undated claim someone will write next, is unobservable by construction; using the compliant population as its stand-in assumes future defect claims are phrased like past ones (falsify: when the next undated claim slips through in review, check whether the meter's corpus contained its shape).
- **Line-based extraction**: hard-wrapped prose splits claims across lines, so a few corpus entries are fragments (`adr-296-terminology-eval.md` contributes five; falsify: the `extractClaims` entries for that file against the page's rendered prose).
- **Labels are one seat's judgment** (ryder, 2026-08-24), applied under the discriminator in the definition above. The borderline cases are real — incident narrations, fixed-and-struck claims (labeled `defect`: rule 4 keeps them visible and an undated rewrite should still be caught), positive-behavior traps (labeled `other`) — and a relabeling pass by another seat is the check (falsify: relabel independently and diff; disagreement above a handful of lines means the discriminator, not the labeler, needs sharpening).
