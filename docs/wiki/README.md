# Wiki — how the team's knowledge is kept

Team knowledge as governed markdown: one page per topic, written by seats, reviewed like code. A choice the team made → ADR; a fact the team learned → wiki page.

## The rules

1. **Line 1 is an H1 title. The first body line is a one-sentence summary.** `INDEX.md` is generated from these — never edit it by hand (`pnpm wiki:index` regenerates; `pnpm wiki:check` fails CI on drift).
2. **Defect claims carry a date and a falsifier.** Any claim that something is broken, missing, or never happens must name when it was observed and what would disprove it: `autorefresh never installs (2026-07-31; falsify: read needsInstall in service.ts)`. The date is CI-enforced; the falsifier is on you and your reviewer.
3. **Corrections invalidate, dated — never overwrite.** Strike the old claim, keep it visible: `~~never installs (2026-07-31)~~ FIXED 2026-08-03 by #570`. Git supplies the history; the page keeps it legible.
4. **Writes go through the front door.** A wiki edit is a normal branch + commit by a seat — attributed (ADR 109), reviewed when non-trivial.

## Template

    # <Topic>

    <One sentence: what this page knows.>

    ## <Section>

    <Dated, falsifiable facts. Link related pages with relative links.>
