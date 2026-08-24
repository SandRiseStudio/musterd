# ADR 296 terminology eval

The recorded eval for ADR 296's pre-registered claim — the burn-down numbers, the suppression census, the confusion test, and the one trip — measured 2026-08-24 at f125a735, so the burn-down has something to burn down from and the claim has something to be judged against.

## The claim being evaluated

ADR 296 §Observability pre-registered two halves:

- **Quantitative:** after the table lands, zero banned-term introductions merge to main, and the
  tier-1 burn-down reaches zero by its registry bound (`adr-296-terminology-gate`,
  staleAfterDays 45 from 2026-08-21 → ~2026-10-05).
- **Qualitative:** the confusion test — two questions answerable from the regenerated glossary
  (brand.md §5, sourced from `docs/glossary/terms.ts`) alone.

And it named its own indictment: a steady stream of `vocab:ok` suppressions or Not-column edits
is usage voting against a chosen word — revise the term, not the gate.

## Burn-down (measured 2026-08-24 at f125a735; falsify: run `pnpm vocab:check` and read the summary line)

| Date | Commit | Gated green | USER_FACING baseline | DESIGN baseline |
| --- | --- | --- | --- | --- |
| 2026-08-21 (baseline) | 213e85b9 | 277 | 49 (47 live + 2 dead) | 28 |
| 2026-08-21 (burn-down B, #1000) | 2df29e6c | 312 | 13 | 28 |
| 2026-08-24 (burn-down A, #1019) | f125a735 | 325 | 5 | 28 |

Trajectory of the user-facing half: 49 → 13 → 5, with **0 pending** — burn-down C (the five root
docs) is complete on branch `stanley/vocab-burndown-c`, handed to sloane with lane 01M0K5XTX9
(2026-08-24; falsify: `git log origin/stanley/vocab-burndown-c`). The design half (28
`DESIGN_BASELINE` docs, burn-down D, lane 01M0K5Y0F4) is open and unstarted. The registry bound
is ~2026-10-05; as of this measurement the bound has not passed, so "reaches zero by its bound"
is **on track, not yet discharged** — this page is the baseline record, not the closing report.

The measure-first method mattered more than migration: B found 36 of its files exempt for
nothing (one hit, a false positive); A found 4 of 8; C found 3 of 5. Roughly **half of every
exemption list protected nothing** (2026-08-24; falsify: the three lane reports, #1000/#1019 and
lane 01M0K5XTX9).

## Zero introductions — with the one exception, on landing day

The claim "zero banned-term introductions merge to main" has exactly one exception, and it
happened before the gate had been on main an hour: ADR 299 (#972) landed minutes before the gate
(#973) with an unquoted "worktree" in its frozen Decision, turning main red. Resolution: #978
bumped `TERMINOLOGY_GATE_FROM` 299 → 300 — the boundary moved rather than the frozen ADR being
edited (2026-08-21; falsify: `git log --oneline 63d53ab6..51ad3f3a` and the comment above
`TERMINOLOGY_GATE_FROM` in scripts/check-vocab.ts). Since #978: zero introductions have merged
(2026-08-24; falsify: `pnpm vocab:check` red on any main commit since 51ad3f3a).

That incident is also the gate's one real trip — it caught an actual banned word in an actual
ADR, in anger, on its first day. The registry entry now records `everTripped: true,
lastTripped: 2026-08-21`.

Related hardening since: #1011 added `baselineRot` after the 2026-08-21 baseline was found
carrying 2 entries for deleted files — a dead exemption now fails the gate by name.

## The indictment metric: the ADR is not indicted

Counted 2026-08-24 at f125a735 (falsify: `grep -rn 'vocab:ok' --include='*.ts' --include='*.tsx'
--include='*.md' . | grep -v node_modules`, then read each line):

- **Not-column edits since the table landed: zero.** `docs/glossary/terms.ts` has exactly one
  commit — the one that created it (#973).
- **ADR 296 suppressions in shipped surfaces: 4**, none of them prose using a banned word for
  its concept:
  - 3 in `packages/cli/src/help/catalog.ts` (#1019) — literal-interface mentions that must not
    drift from the commands they document: the live `--profile` flag (rename is tier 3), role
    create's `--from <template>` usage string, and the legacy `.musterd/profiles/` path.
  - 1 in `packages/web/src/routes/character-sheet.tsx` (#1000) — a false positive: `kit` as a
    person's name in a demo roster.
- The remaining markers are ADR 098 suppressions (epic/sprint) or meta-mentions in the docs that
  define the marker itself.

No steady stream, no vote against any chosen word. The suppressions that exist are the gate
meeting reality (live flags, legacy paths, a name), not writers resisting the vocabulary.

## The confusion test: one pass, one half-pass

**Q1 — "Aren't those profiles just roles?"** PASS from §5 alone. **Role**: "a responsibility the
team grants a member: charter + ceiling … not workspace setup; never granted by a local file."
**Toolkit**: "what a workspace is equipped with … no authority — installing one grants nothing.
Not 'profile'." The two Not columns answer the admin's question directly, in two rows.

**Q2 — "Why does session labeling work on my laptop and not my server?"** ~~PARTIAL. **Driver**
("how a harness session runs: desktop, terminal, IDE, headless") gives the reader the right
question — the laptop runs a desktop/terminal driver, the server headless — but the per-harness
specifics live in the driver support matrix, and that is still the open reserved lane
01M0K5ZC33 (2026-08-24; falsify: the lane board — a claimed/done state, or a support-matrix page
in this wiki, disproves this).~~ COMPLETED 2026-08-24: the matrix exists —
[driver support matrix](driver-support-matrix.md) — and its labeling row answers Q2 concretely
(desktop = cross_rename via the app's MCP tools, terminal = OSC 0 tab title only, headless = none).
Q2 PASSES from the glossary plus that page.

## Control exercised 2026-08-24

All three registry exercise cases run live at f125a735, each failing by name, gate green after
restore (falsify: re-run them — the recipe is the registry entry's `exercise` field):
unbackticked "profile" in a new `help/` file → caught; **Toolkit** dropped from brand.md §5 →
glossary drift caught; dead path in `USER_FACING_BASELINE` → rot caught. Plus
`scripts/check-vocab.test.ts` (15 tests) green.

Related: [running the gates](running-the-gates.md), [ledger seats](ledger-seats.md) (the
deliver-it-or-delete-it rule this vocabulary work keeps meeting).
