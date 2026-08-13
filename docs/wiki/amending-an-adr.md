# Amending an ADR

Only an accepted ADR's `## Decision` is frozen — a dated follow-up note in `## Consequences` is the PRESCRIBED amendment mechanism, and a superseding ADR is for reversing a decision, not recording what happened next.

## The rule and its bad summary (2026-08-05, #738; falsify: read rule 3 in scripts/check-change-adr.ts)

AGENTS.md used to summarize this as a blanket "never edit a decision; supersede it", which caused a wrong review before #738 reworded it. Context, Consequences, and Observability stay editable on any ADR.

## The gate was inert for 94 of 223 accepted ADRs (~~inert~~ FIXED 2026-08-06 by #739; falsify: scripts/adr-status.ts against the corpus)

The old `isAccepted` regex demanded a bare `Status: accepted`, but house style annotates the line — so exactly the long-arc "accepted — design frozen" ADRs people amend were unprotected. Gate silence is not compliance: for weeks, edits that should have failed did not. #743 added the restoration escape — a Decision edit whose result equals a form the file previously held passes, because #739 froze the violations it revealed and removing them was itself a Decision edit.
