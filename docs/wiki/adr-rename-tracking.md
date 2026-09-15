# Rule 3 across a rename

Renaming an ADR used to take the whole of `change-adr:check` rule 3 off it, because a rename reaches a diff as an unrelated delete plus add and the add has no before side to judge.

## The evasion

Rule 3's loop opened with `if (status !== 'M') continue` and then `if (before === null) continue`. A plain `git diff --name-status` never reports a rename — it reports `D old` and `A new` — so a diff that renamed an ADR and rewrote its `## Decision` was never judged at all (2026-09-01; falsify: check out `check-change-adr.ts` at `033af4fc`, rename any accepted ADR while rewriting its Decision, and watch the gate exit 0). That held for the flip window and for already-accepted ADRs alike: one `git mv` and the freeze was gone.

Found by dolly reviewing #1129, and routed rather than fixed inside it — the ADR 338 rule 3 shape, a reviewer-discovered gap noted non-blocking with the finder's name on the lane.

**It was a latent hole, not an exploited one.** Every ADR rename in history was an honest renumber: 12 renames, **0 of which changed the Decision** (2026-09-01, main @ `033af4fc`; falsify: re-run the scan — for each commit touching `docs/decisions`, take its `-M` rename records and compare the Decision section at `sha^:old` against `sha:new`).

## Why not simply refuse added ADRs

A new accepted ADR is the normal authoring flow, and "write a superseding ADR" is the remedy rule 3's own failure message prescribes. Refusing adds would close the escape hatch the rule depends on. So the gate has to tell a rename from a genuinely new file.

## Two keys, because similarity alone is not enough

- **`-M`** makes git pair the delete and the add, and the before side is then read at the *old* path.
- **Slug pairing** covers what `-M` misses. Rename detection is a similarity score, so rewriting enough of the file drops the pair below the 50% default and it splits back into delete-plus-add. Measured 2026-09-01 on the real corpus: renaming `106-unified-git-workflow.md` and replacing its 78-line Decision scored **R040**, under threshold — a similarity-only fix passed the very evasion it was written to stop (falsify: `git diff --name-status -M` on that pair reports `D` + `A`, and `--find-renames=20%` reports `R040`). A renumber changes the number and keeps the slug, so an added ADR is paired with a deleted one whose slug matches — but only when there is exactly one candidate **on each side**. The guard was one-sided at first: two adds sharing a retired slug were both judged against the same before side, so a genuinely new ADR reusing that slug was refused for a Decision it never held (2026-09-01, dolly's review of #1136; falsify: the two-adds case in `scripts/rename-tracking.test.ts`, red before the second-sided guard). Deterministic, and indifferent to how much of the body moved.

Lowering `-M`'s threshold instead was rejected: it buys this case at the price of false pairings across a 300-ADR corpus, and a false pairing here accuses the wrong file of rewriting a Decision it never had.

## What still gets through

Renaming an ADR to a **different slug** while rewriting enough of it to fall under the similarity threshold (2026-09-01; falsify: the two keys are the only pairing the gate does — read the pairing loop in `check-change-adr.ts`). Both keys have to miss at once. Stated rather than discovered: the remaining alternative is refusing every added accepted ADR, which breaks the sanctioned superseding route, and at that point the file is a different document rather than a renamed one.

The restoration escape ([#739's `wasEverOnMain`](adr-flip-window.md)) reads the file's history by path, so it is asked about the **old** path on a rename; otherwise a legitimate restore-and-renumber would be refused, the false positive that escape exists to prevent.

## Related

- [The ADR flip window](adr-flip-window.md) — the other half of rule 3's before-side reading, and the rule this one restores over renames.
- [`scripts/rename-tracking.test.ts`](../../scripts/rename-tracking.test.ts) — both directions against a real fixture repo, red-first, including a guard that the below-threshold fixture really is below threshold.
