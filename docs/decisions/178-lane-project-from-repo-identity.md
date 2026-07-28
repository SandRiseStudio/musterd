# 178 — Lane `project` derives from repo identity, and the derivation is worktree-invariant

- Status: accepted — 2026-07-28. Authored by stanley, implementing install-topology lane L5
  (`docs/design/install-topology.md` §7) and **overriding the rule that section specified**. Number
  **178** — verified free on `origin/main` (highest is 177; 177 was taken by #477 between this branch opening and its gate run, which is the collision trap doing its job) at branch time.
- Date: 2026-07-28
- Builds on: [ADR 083](083-coordination-lanes.md) (lanes, `project`, and the two warn-only checks —
  the field this ADR finally populates), [ADR 065](065-agent-workspace.md) (one worktree per seat —
  the reason the doc's rule is wrong), [ADR 165](165-worktree-family-mcp-entry.md) (a slot shared by
  a worktree family may hold only what is identical across the family — the same invariant, arrived
  at independently), [ADR 173](173-absent-is-not-unknown.md) (`'default'` is "I did not say", not a
  peer project — so it must not be read as a negative).

## Context

Lanes have carried a `project` field since ADR 083, with a stated meaning: _"contention is checked
within a project, never across."_ Nothing ever set it. The store stamped `input.project ?? 'default'`
and no caller passed `project`, so the literal `'default'` was the only value any lane on any team
ever held.

Everything downstream of the field was already built and correct: the store filters on it, the board
route takes `?project=`, both the CLI and the MCP tool accept an explicit override, and the web board
suppresses the pill when the value is `'default'`. The read path worked end to end. Only the
derivation was missing — so the feature was fully present and entirely inert.

## Problem

With every lane in one project, `surface_overlap` is **team-wide, not per-repo**. A lane declaring
`packages/web/**` in this repo warns against a lane declaring `packages/web/**` in any other repo the
team touches. The warning is real, the collision is not, and a warning that fires on a non-collision
teaches seats to discount the whole channel.

## The landmine: the specified rule is wrong here

Design doc §7 originally specified deriving from **"the basename of the git toplevel"** (amended in
the doc on 2026-07-28, before implementation, by the review that found this). That rule is wrong in
exactly the topology musterd creates, and it is recorded here because the wrongness is not obvious
and the next person to touch this will reach for `--show-toplevel` first.

`git rev-parse --show-toplevel` inside a **linked worktree** returns the worktree's own path, not the
repository's. ADR 065 gives every seat its own worktree, provisioned as a sibling named
`<repo>-<seat>`. On the dogfood machine that is ~13 worktrees of one repository. The specified rule
would derive `agents-stanley`, `agents-miley`, `agents-izzo`… — **13 distinct "projects" for one
repo**, and since overlap is checked only within a project, it would switch surface contention
**off** for the entire team.

That is the failure this lane exists to fix, inverted. And it would land silently: the checks are
warn-only, so the symptom is not an error but an _absence_ of warnings — the one failure mode a
warn-only system cannot report about itself.

## Invariant

**A lane's project is a property of the repository, never of the checkout.** Anything derived from a
per-seat path cannot name a thing N seats share. (ADR 165 states the same invariant for the MCP
config slot; it was reached there independently, from a different symptom.)

## Decision

1. **Derive from `git rev-parse --git-common-dir`**, not `--show-toplevel`. The common dir resolves
   to the same `…/<repo>/.git` from every worktree of a repository, which is precisely the invariant
   above. The project name is that directory's parent basename (a bare repo's `<repo>.git` loses the
   suffix). A test asserts two sibling worktrees of one repo agree — the assertion the doc's rule
   fails.

2. **Precedence:** explicit `--project` / `project:` argument › `MUSTERD_PROJECT` › derived repo
   identity › `'default'`. A folder outside a work tree stays on the `'default'` floor; git being
   absent or slow degrades to the same floor, never an error.

3. **Derivation runs client-side, in the CLI and the MCP adapter.** It cannot run in the store: the
   daemon's cwd is the daemon's, and `openLane` has no caller workspace. The shared helper lives in
   `@musterd/protocol/project` behind its own subpath entry — the barrel is imported by the browser
   and this shells out (the ADR 135 `build-stamp` rule). It absorbs the two private `rev-parse`
   copies that the CLI provisioner and the MCP workspace label had each grown.

4. **`'default'` is a wildcard in the overlap check, not a peer project.** An unscoped lane contends
   with every project and every project contends with it. Without this, the day derivation lands,
   every pre-existing lane and every new one go **mutually blind** — `project` is stamped at open, so
   this is not a gradual resolve, it is an instant one. An unscoped lane means "I did not say" (ADR
   173), and a warning system should fail toward the false positive. The noise then decays on its
   own as legacy lanes close.

5. **`project` becomes patchable** (`UpdateLane.project`, `musterd lane update --project`,
   `lane_update`). It was `NOT NULL` and had no update path at all, so a lane opened from the wrong
   checkout — or before this existed — was mis-stamped permanently. An immutable field with no
   escape hatch is what would have made point 4 a one-way door.

## What deliberately does not change

- **`unmet_dependency`** stays team-wide. A lane in one repo legitimately depends on a lane in
  another; that is a real fact about sequencing, not a surface collision.
- **`stale_plan` / `stale_dependency`** stay team-wide. A Goal epoch is a team fact.
- **`laneCoveringPath`** (the ADR 150 Gate A edit-guard read) stays team-wide and unscoped. It takes
  a repo-relative path with no project, so scoping it would require the hook to send one. Behavior is
  unchanged by this ADR either way; scoping it is a follow-up, not a regression here.
- **The board does not default-filter to your project.** Seeing a teammate's lane in another repo is
  orientation; hiding it would be a second, unrelated semantic change.

## Observability & Evaluation

**Traces.** No new instrument — the fact is already recorded. Every lane row carries its `project`,
so `musterd lanes --json` is the read: the count of `project == 'default'` on a live board _is_ the
legacy-era backlog, and it should trend to zero as those lanes close or get re-projected. The
`surface_overlap` warning count is the second series, and the honest expectation is that it **drops**
the day this lands — cross-repo pairs stop warning. That drop is the ADR 083 meaning finally taking
effect, not a regression, but it is named here because anyone reading the metric cold would read it
as one.

**Eval.** The failure mode is _silence_ — contention going dark reports nothing at runtime — so the
check has to be a test, not a monitor. Dataset: a real git repo with two sibling worktrees, built in
`packages/protocol/src/project.test.ts`, plus the store's lane scenarios. Baseline: the specified
`--show-toplevel` rule, which yields one distinct project **per seat** (13 on the dogfood machine)
and zero overlap warnings across the team. The assertion is that all three cwds — main tree,
worktree A, worktree B — derive one identical name, and that scenario 4b's unscoped lane still warns
in both directions. If either is ever weakened, contention goes inert with no other signal.

**Experiment.** None, and deliberately: this is a correctness fix to a field whose semantics ADR 083
already fixed, not a behavioral hypothesis to A/B. The one judgment call worth revisiting with data
is decision 4 — `'default'` as a wildcard trades false-positive warnings for the mutual-blindness it
prevents. If the legacy-lane count above stays flat instead of decaying, the wildcard is generating
standing noise and the re-project hatch is not being used, which is the signal to revisit it.

## Consequences

- Per-repo contention becomes real for the first time since ADR 083.
- Teams spanning repos see a warn-count drop; teams on one repo see no behavioral change at all
  (every lane derives the same name).
- One more thing is derived from the environment rather than declared — the cost is a lane opened
  from an unexpected checkout carrying an unexpected project, which point 5 makes repairable.
- `docs/design/install-topology.md` §7 points here and records the wildcard, which is this ADR's one
  addition to the amended design: it turns the "back-compat cliff" the doc names into a slope.

## Related

- [ADR 083](083-coordination-lanes.md) — lanes, `project`, the two warn-only checks.
- [ADR 065](065-agent-workspace.md) — one worktree per seat.
- [ADR 165](165-worktree-family-mcp-entry.md) — the worktree-family invariant.
- [ADR 173](173-absent-is-not-unknown.md) — absent is not a negative.
- [ADR 135](135-build-provenance.md) — the node-only-behind-a-subpath-entry rule.
