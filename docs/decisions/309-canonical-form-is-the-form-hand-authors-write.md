# 309 — Canonical roster form is the form hand-authors write: a blank line before every table header

Status: accepted 2026-08-24 (dolly; the blank-line-vs-flush call ruled by stanley as roles/seats
authority, at nick's routing)
Lane: 01M0TSFDEM2CN36Y2APVNTHA8F
Supersedes the "no blank lines" clause of the canonical-form rule in
[`docs/design/seat-file-format.md`](../design/seat-file-format.md).

## Problem

The roster serializer emitted table headers flush against the preceding key:

```toml
slug = "revive"
[working_hours]
```

Every hand-authored file on the live roster disagreed. Measured 2026-08-24 with
`musterd fmt --check --json` from `/Users/nick/musterd/revive`, then confirmed by parsing and
re-serializing each file with the protocol's own functions and diffing: **four of 22 files drifted,
and three of them drifted in exactly one way** — a blank line before the table header, nothing else.

| file | drift |
| --- | --- |
| `team.toml` | blank line before `[working_hours]` |
| `roles/admin.toml` | blank line before `[capabilities]` |
| `roles/observer.toml` | blank line before `[capabilities]` |
| `seats/autorefresh.toml` | `roles = ["platform"]` → `role = "platform"` (ADR 227 normalization, unrelated) |

Three independent authors inserted the blank line. **Zero preferred flush.** The two role files had
been drifting since 2026-08-04 and nobody knew, because nothing runs `fmt --check` — the
instrument-silence finding that ryder raised on lane 01M0JWECC4 and that this ADR does not close.

## Decision

**The serializer emits one blank line before each table header (`[capabilities]`,
`[working_hours]`); a table that opens the file gets none.** Canonical form for files humans read
and edit is the form humans write.

The argument is not aesthetic. A `--check` that fails on every hand-edit teaches people to ignore
the check, and an ignored gate is worse than no gate: it reads as green while meaning nothing —
the same disease as the stale vocab baseline closed in #1011. When every human who touches a file
format disagrees with the machine about its shape, the machine is the one that is wrong.

The pre-ADR-227 byte-identity promise in `seatfile.ts` was a **no-churn-at-migration** promise, not
a permanent freeze of the byte form. Changing canonical form churns machine-shaped files once,
visibly, in the repo's own tests. The ADR 227 single-role byte-identity guarantee (`roles` emitted
only at ≥2 entries) is untouched.

## Consequences

- Measured after the change, same read-only command from the roster root: **drift falls from 4 files
  to 1**, and the one remaining is `seats/autorefresh.toml`'s plural-to-singular normalization,
  which is ADR 227 working as specified. `dataLoss` is empty — the `charter` instance from ADR 304
  was resolved by deletion in d55ec7e. Three hand-authored files became canonical **without being
  touched**.
- Files the machine writes (`musterd claim`, `role create`, reconcile's writeback) gain the blank
  line from birth, so `fmt` stays a no-op on freshly-written files.
- The live roster still wants **one supervised `musterd fmt` pass** to normalize `autorefresh`'s
  plural. That is a roster write and is **not** part of this ADR: it runs only with nick's explicit
  go, named in the run. The standing constraint — never run `fmt` against
  `/Users/nick/musterd/revive/.musterd/` — holds until then.
- No schema, no wire field, no parse behaviour changes. Parsing has always been whitespace-tolerant
  (guard 1); this moves only what guard 2 calls tidy.

## Observability & Evaluation

**Traces.** `musterd fmt --check --json` from a roster root: `{drifted, dataLoss, total}`. The
protocol's own `serializeSeat`/`serializeRole`/`serializeTeam` against the committed bytes is the
independent reader — do not take the CLI's word for it.

**Eval.** Dataset: the `drifted` array on each roster home. Pre-registered expectation at acceptance
(2026-08-24): the live revive roster reports exactly one drifted file, `seats/autorefresh.toml`, and
zero after the supervised pass runs. A hand-authored file appearing later with a **flush** table
header falsifies the premise this ADR rests on — three-for-three is a small sample, and the rule
should then be re-argued, not quietly re-flipped.

**Experiment.** The real question this leaves open is whether canonical form now stays met. Read
`fmt --check` against the live roster again after 30 days (2026-09-23). Zero drift means the form
matches what both authors write and nothing has re-drifted. Fresh drift in files nobody hand-edited
means a writer is bypassing the serializer. Fresh drift in hand-edited files means the blank line
was not the only disagreement, and the next one should be measured the same way rather than ruled on
taste.
