# 161 — init defaults to the folder's own team, and a refresh that touches only guidance

- Status: accepted
- Date: 2026-07-25

## Context

On 2026-07-25 a human ran `musterd init` inside `agents-izzo` — a worktree bound to a live seat —
intending only to refresh its guidance files after the ADR 160 version bump. The flow warned twice
that the folder was already bound to `izzo` on `revive`, accepted "yes, set up an agent here anyway",
and then reported:

> Your saved team "cookoff-gb2" isn't on this daemon (its database was reset or you're pointed at a
> different server) — let's set one up.
>
> **Name your team**

Completing that prompt would have created a new team, minted a new member, and repointed a live
seat's binding away from `revive`. The human stopped at the prompt and asked what to do — the flow
gave no way to tell that the next keystroke was destructive.

Two independent defects put them there.

**1. `init` resolved the team from the machine, not the folder.** The team step read
`config.current` — the last team this machine touched — probed it against the daemon, and on a miss
fell straight through to `createTeam()`. `config.current` was `cookoff-gb2`, a finished experiment's
team whose database is long gone. Meanwhile `agents-izzo/.musterd/binding.json` named `revive`, on
the running daemon, two directories away. The folder knew the answer; init never asked it. Worse,
the fallback for "your cached team is dead" was _create a new one_ — the most destructive option
available, reached by default, in a folder that already had an identity.

**2. There was no way to refresh guidance without the full flow.** `writeGuidance` had exactly one
caller: the interactive `init`. So when `GUIDANCE_CONTENT_VERSION` moved 4→5 (ADR 160), every seat's
`init --check` began printing _"run `musterd init` to refresh it"_ — routing a human through member
minting and binding rewrites to fix a cosmetic drift line. The doctor's advice was the trap.

The second defect caused the first to be encountered. A version bump should never hand someone a
loaded gun and a reason to pick it up.

## Decision

**The folder's own team is the default.** `folderTeamHere()` reads the team from this folder's
`.musterd/binding.json`, falling back to the committed `workspace.json` (a fresh clone knows its
team before it has a credential). When that team is live on this daemon it is the first,
pre-selected option; the machine-cached team appears only as a secondary choice when it differs, and
"Create a new team" is a deliberate pick rather than a fallback.

**A bound folder whose team we cannot reach never silently offers team creation.** When the folder
names a team but this machine has no working credential for it, init says exactly that, lists the
paths that do _not_ touch identity, and asks a **default-no** confirm whose wording names the
consequence: _"Create a different team here anyway, repointing this folder away from `revive`?"_
Declining exits with no changes.

**`musterd init --refresh-guidance`** rewrites the stamped skill/command files and nothing else — no
team resolution, no daemon probe, no member mint, no binding write, no MCP entry. It refreshes only
the harnesses whose guidance the folder already carries (adding a harness's files is provisioning,
which remains `init`'s job). Non-interactive, so it is safe in a live seat's workspace and usable
from a script. The doctor's drift line now points here.

## Consequences

- The dangerous path is no longer the default path. Reaching team creation from a bound folder now
  takes an explicit default-no confirm that names the folder's current team.
- Guidance version bumps stop being an identity hazard: the remedy the doctor prints is scoped to
  the files that actually drifted.
- `--refresh-guidance` deliberately will not _add_ guidance for a harness a folder lacks. Eight of
  eleven seat worktrees on the dogfood machine carry no guidance at all; provisioning those is a
  separate, deliberate `init`.
- `config.current` remains meaningful for unbound folders — genuine first-run onboarding is
  unchanged, which is the case init was originally written for.
- Not addressed here: the stale-credential vault itself. This machine holds keys for five dead
  cookoff teams and none for `revive`, which is why the folder's team was unreachable. Pruning dead
  identities is its own decision (ADR 059's vault).

## Observability & Evaluation

- **Traces.** No spans added; init is an interactive local command outside the act stream. The
  observable surfaces are the ones a human reads in the moment: the team-select list now shows
  provenance per option (`this folder's team` / `last used on this machine`), and the refusal path
  prints the folder's team by name. `musterd init --check` remains the machine-readable view, and
  its guidance-drift line is the only place that recommends a repair command.
- **Eval.** Dataset: the reproducing configuration — a bound worktree (`team: revive` in
  `binding.json`) plus a global config whose `current` is a dead team with no credential for the
  folder's team — captured as fixtures in `init.test.ts`. Baseline: the pre-fix behavior, where that
  input reaches `createTeam()` with no confirmation; the fix must instead surface the folder's team
  as default when reachable, and require an explicit default-no confirm when not. Unit tests cover
  `folderTeamHere` precedence (binding over workspace spec over null) and `runRefreshGuidance`
  (writes only present harnesses, leaves bindings and MCP config untouched, refuses in an unbound
  folder).
- **Experiment.** None pre-registered. This is a guardrail on a human-driven command; the evidence
  that justified it is the single live near-miss described above, and the success criterion is that
  it cannot recur by default rather than a measured rate.
