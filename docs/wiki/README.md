# Wiki — how the team's knowledge is kept

Team knowledge as governed markdown: one page per topic, written by seats, reviewed like code. A choice the team made → ADR; a fact the team learned → wiki page.

## The rules

1. **Line 1 is an H1 title. The first body line is a one-sentence summary.** `INDEX.md` is generated from these — never edit it by hand (`pnpm wiki:index` regenerates; `pnpm wiki:check` fails CI on drift).
2. **Defect claims carry a date and a falsifier.** Any claim that something is broken, missing, or never happens must name when it was observed and what would disprove it: `autorefresh never installs (2026-07-31; falsify: read needsInstall in service.ts)`. The falsifier is on you and your reviewer. **The date is CI-enforced only for the phrasings `check-wiki.ts` knows** — `DEFECT_RE` is a hand-kept list, so a green run means "no claim in a *named* shape is undated", never "every defect claim is dated". The list has gone stale once: measured 2026-08-24, the entire "reaches nobody" family passed undated (`read by nothing`, `computed and never used`, `served to nobody`) — the very family four of that week's findings belonged to. It has been widened; it will go stale again. Write the date because rule 2 says so, not because CI will catch you. How far short the list falls is now a measured number, not a guess — [DEFECT_RE coverage](defect-gate-coverage.md) defines it, and `pnpm wiki:check` prints it on every run (labeling any new dated `falsify:` line in `scripts/wiki-claim-labels.json` is part of writing it).
3. **A falsifier must be able to fail.** Name an observation that comes out *differently* depending on whether the claim holds. If the check passes just as happily when the claim is wrong, it is a ritual, not a falsifier — and running it will read as confirmation. Ask it out loud: *if this claim were false, what would this check show?* If the answer is "the same thing", it is the wrong check. This applies hardest to claims that something is **fine** — "that is just runner noise", "safe to ignore" — because those stop anyone looking, and rule 2's date-enforcement does not reach them: `check-wiki.ts` only lints assertions that something is *broken*. Worked example: [running the gates](running-the-gates.md) claimed a flaky suite was "the runner, not a test", dated, with `falsify: rerun the named file alone`. It had a date and a falsifier and was wrong for seven days — a file passing alone is what harmless noise looks like AND what a real load-only defect looks like, so the check could never have caught it. The falsifier that did work was a measured one: 20 full-suite runs against 20 isolated.
4. **Corrections invalidate, dated — never overwrite.** Strike the old claim, keep it visible: `~~never installs (2026-07-31)~~ FIXED 2026-08-03 by #570`. Git supplies the history; the page keeps it legible.
5. **Writes go through the front door.** A wiki edit is a normal branch + commit by a seat — attributed (ADR 109), reviewed when non-trivial.

## Template

    # <Topic>

    <One sentence: what this page knows.>

    ## <Section>

    <Dated, falsifiable facts. Link related pages with relative links.>
