# Amending an ADR

Only an accepted ADR's `## Decision` is frozen — a dated follow-up note in `## Consequences` is the PRESCRIBED amendment mechanism, and a superseding ADR is for reversing a decision, not recording what happened next.

## The rule and its bad summary (2026-08-05, #738; falsify: read rule 3 in scripts/check-change-adr.ts)

AGENTS.md used to summarize this as a blanket "never edit a decision; supersede it", which caused a wrong review before #738 reworded it. Context, Consequences, and Observability stay editable on any ADR.

## The gate was inert for 94 of 223 accepted ADRs (~~inert~~ FIXED 2026-08-06 by #739; falsify: scripts/adr-status.ts against the corpus)

The old `isAccepted` regex demanded a bare `Status: accepted`, but house style annotates the line — so exactly the long-arc "accepted — design frozen" ADRs people amend were unprotected. Gate silence is not compliance: for weeks, edits that should have failed did not. #743 added the restoration escape — a Decision edit whose result equals a form the file previously held passes, because #739 froze the violations it revealed and removing them was itself a Decision edit.

## The convention the gate made unwritable (2026-08-31, #1087; falsify: write the marker onto ADR 326 Decision 2 with #1117 reverted and run `pnpm change-adr:check`)

There are two audiences for an amendment and the prescribed mechanism only serves one. A dated `## Consequences` note is a complete record — and it is invisible to the reader who opens `## Decision`, reads item 2, and stops, which is what a reader looking up "what does orientation do with a review request" actually does. The repo already answered that with an inline dated marker: [ADR 160](../decisions/160-seat-session-labels.md):48 and :90, ADR 250:67, and ADR 056 on the Status line.

Then the gate started firing. Those markers landed while `isAccepted` demanded a bare `Status: accepted` and 94 of 223 ADRs were unprotected (#739 fixed the regex, see above), so the convention had never been tested against a live gate. Once it was, it failed: rule 3 freezes the whole `## Decision`, and `wasEverOnMain` — the one escape — is a restoration check that by construction cannot pass text the file never held. Measured on 2026-08-31: dolly reviewed #1087 and asked for exactly those markers on ADR 326:45 and :49, they were written as asked, and `change-adr:check` rejected them. Convention and gate contradicted each other; the gate won, so the correct fix was unwritable and #1087 shipped the weaker Status-line-and-Consequences form instead.

`isAppendOnlyAmendment` (`scripts/adr-sections.ts`, #1117) closes it: strip the dated marker spans from the new Decision, and the remaining **words** must match the old one. Append-only becomes a property of the diff rather than a promise — a reworded sentence, a deleted clause, an undated marker, and ordinary new prose all still fail. It is deliberately not the "env override / opt-out flag" the gate's own docstring rejects: that one says *trust me* about arbitrary text, this one admits nothing but a pointer.

Two things worth knowing before you use it. The comparison is on words, not lines, because the useful marker position is **mid-sentence** — ADR 326's needed to land inside a line — and inserting one necessarily re-wraps the paragraph; the deliberate cost is that a re-wrap rides along with a marker unnoticed (a re-wrap alone still fails: a marker must have been added). And the marker is a pointer, never the amendment: the substance still belongs in `## Consequences` or a superseding ADR.

One tightening on top, from dolly's review of #1117 and measured before taking it: **inside a fenced code block the comparison is line-exact, not word-level**, because indentation there is the content — 22 of 329 ADR Decisions carry a fenced block, so an indent change riding a marker was a live hole rather than a hypothetical one. Marker syntax is also only recognized outside fences, since a fence may legitimately hold an example of a marker and stripping that would delete code from the comparison.
