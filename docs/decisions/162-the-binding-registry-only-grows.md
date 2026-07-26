# 162 — The binding registry only grows, and the test suite was filling it

- Status: accepted
- Date: 2026-07-25

## Context

ADR 161 closed a near-miss in `musterd init` and left one thread hanging: the dogfood machine's
global config held credentials for five finished experiment teams and none for the team its seats
actually run on. Pulling that thread found something larger.

`~/.musterd/config.json` on the dogfood machine held **780 binding-registry entries**. Of those:

- **759 named folders that no longer exist** — every one a `/var/folders/.../T/musterd-*` temp
  directory, on the fixture team `dawn`.
- 21 were real: 5 seat worktrees and 16 cookoff cells.

The 759 are test residue. `saveBinding` records where each member is bound in the global registry
(ADR 020), the write is deliberately best-effort and silent (the binding file is the source of
truth, so a registry failure must never fail the save), and `vitest.config.ts` set `MUSTERD_SILENT`
and `NO_COLOR` but never `MUSTERD_CONFIG`. So every test that saved a binding wrote into the
developer's real config, and nothing ever said so. The file had grown to 58 KB.

This was not merely untidy. `nameBoundElsewhere` — init's cross-folder name-reuse guard — scans the
registry and returns the first seat-name match **without checking that the folder still exists**.
With 664 stale entries for the fixture seat `scout` alone, naming a member `scout` warned that it
was "already bound" in a temp directory deleted weeks earlier. Verified on the live config: the
warning fired, and the folder it named was gone.

Three defects, one cause and two consequences:

1. The test suite wrote the developer's real global config.
2. Nothing ever prunes a registry entry whose folder is deleted — `removeBinding` only fires on a
   deliberate `unbind` in a folder that still exists, so the registry can only grow.
3. The name-reuse guard treats a stale entry as a live collision.

## Decision

**Tests get their own config.** `vitest.config.ts` sets `MUSTERD_CONFIG` to a per-run temp path.
Tests that exercise config behavior already set their own and still override it. One line, and the
leak is structurally closed rather than remembered.

**A vanished folder is not a collision.** `nameBoundElsewhere` skips entries whose folder no longer
exists. This is the correctness half: even with a perfectly pruned registry, a human who deletes a
project should never be warned about it. One `existsSync`, and only for entries that already matched
the name.

**`musterd init --prune-bindings`** reports registry entries whose folder is gone, grouped by team;
`--apply` removes them. It joins `--refresh-guidance` (ADR 161) as local-file maintenance: no daemon
call, no prompts, no identity. The doctor notes the condition once it passes five stale entries.

**Credentials are never pruned.** `identities` and `agentKeys` hold the only copy of a minted key,
and a team being unreachable _right now_ — daemon down, wrong `--server`, laptop offline — is not
evidence that it is dead. Deleting a credential on that inference is unrecoverable. This prunes only
what can be re-derived from the filesystem.

## Consequences

- A developer's global config stops accruing one entry per test run. On this machine that is the
  difference between 21 entries and 780.
- The name-reuse warning becomes trustworthy: it only fires for a folder you can actually go look at.
- The five dead cookoff identities stay. They are inert — nothing reads a credential for a team that
  is not on the daemon — and ADR 161 already made init refuse rather than act when the folder's team
  is unreachable. Pruning credentials safely needs a liveness signal we do not have offline.
- `--prune-bindings` reports by default and mutates only under `--apply`, matching `fmt --check` and
  `init --check`: a maintenance command shows you the diff before it takes it.
- Not addressed: the 16 cookoff-cell bindings whose folders still exist. They are real records of
  real folders; removing them is `musterd unbind` in those folders, not a prune.

## Observability & Evaluation

- **Traces.** No spans. All three changes are local-file behavior on a developer's machine, outside
  the act stream. The observable surface is `musterd init --check`, which now carries a warn-only
  note naming the stale count and the command that fixes it, and `--prune-bindings` itself, whose
  dry-run output is the report (count, total, and a per-team breakdown of what would go).
- **Eval.** Dataset: the live pre-fix config from the dogfood machine — 780 entries, 759 stale, seat
  names `scout` ×664 / `Ada` ×34 / `other` ×61 — the distribution that made the false warning
  reproducible. Baseline: on that input, `nameBoundElsewhere('scout', …)` returned a collision
  naming a deleted temp folder, and a full `vitest run` added entries to the real config. After:
  the same query returns null, a full run adds none, and `--prune-bindings --apply` takes the file
  from 780 entries to 21. Unit tests cover the dry-run/apply split, credential preservation, the
  already-clean path, and both sides of the guard (vanished folder ignored, live folder still
  reported).
- **Experiment.** None pre-registered. The leak is a defect with a determinate fix, not a behavioral
  question; the success criterion is that a full test run leaves the developer's config byte-identical,
  which is directly checkable and was checked.
