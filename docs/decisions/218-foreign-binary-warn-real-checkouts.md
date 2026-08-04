# 218 — ADR 213's foreign-binary warn only fires between real checkouts

- Status: accepted
- Date: 2026-08-04
- Builds on: [ADR 213](213-adapter-binary-workspace-guard.md) (warn when adapter binary
  seat-workspace ≠ identity seat-workspace)
- Prompted by: stanley + dolly — `packages/mcp/src/surface-drift.test.ts` fails 2 tests on clean
  `main` in any seat worktree (CI green because Actions uses a fresh clone)

## Context

ADR 213 warns when the running module lives under seat workspace A and the resolved identity lives
under seat workspace B. That closed the measured miley-binary / izzo-cwd leak.

`surface-drift.test.ts` (and any MCP test that mocks `process.cwd()` to a `mkdtemp` fixture and
writes a fixture `.musterd/binding.json` there) trips the same guard on every boot: binary root =
the developer's seat worktree, identity root = the tmpdir. The guard is correct about "two different
binding roots" and wrong about "this is a cross-seat leak worth crying about."

Two stacked failures made it red:

1. **Structural:** every tmpdir-rooted identity under a seat worktree's module path warns, training
   readers to ignore the one warning a seat-identity guard cannot afford to dilute.
2. **Assertion:** the silent cases used `expect(warning()).not.toContain('surface')`, and the
   fixture prefix is `musterd-surface-drift-…`, so the path substring alone failed the test even
   when no surface-drift warning fired.

CI stayed green because a fresh clone's module path and a fixture under `/tmp` are still two roots —
wait: in CI the module is also under the clone root which has `.git` and a binding may or may not
exist at repo root. The measured failure was seat worktrees (`agents-stanley`, …). Either way the
tmpdir fixture is not a peer seat checkout.

## Problem

ADR 213 compared seat-binding roots only. A throwaway fixture directory that happens to contain a
test `binding.json` is not a seat workspace in the ADR 143/213 sense.

## Decision

**Warn only when both roots are seat workspaces that look like real checkouts** — each has a
`.git` entry (directory or worktree gitfile). No `.git` on the identity side → silence (ephemeral
test fixtures, scratch dirs). Packaged installs already silent (no seat binding above the module).

The measured sibling-worktree leak still warns: both `agents-miley` and `agents-izzo` are git
worktrees.

Tighten the surface-drift silent assertions to the contested-surface message shape
(`reports surface`) so a future unrelated stderr line cannot trip on the substring `surface`.

## Consequences

- `surface-drift.test.ts` (and peers that fixture identity under `os.tmpdir()`) stay quiet under
  ADR 213 when run from a seat worktree.
- The real leak shape is unchanged.
- ADR 213's Observability claim stands; this narrows the predicate, it does not soften the warn.

## Observability & Evaluation

- **Traces:** same stderr diagnostic as ADR 213; fires less often (fewer false positives).
- **Eval:** regression in `seat-identity-guard.test.ts` — fixture tmpdir with binding + foreign
  seat module → silence; two git seat worktrees → warn. `surface-drift.test.ts` silent cases green
  from a seat worktree.
- **Experiment:** n/a — unit regression against the reported failure is sufficient.
