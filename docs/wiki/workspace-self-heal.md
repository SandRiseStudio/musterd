# Workspace self-heal

A seat whose guidance or in-worktree hooks are behind the installed build repairs them at session start and reports one line — measured live on `agents-ghost`, 2026-09-16, before the code merged.

## The measurement (2026-09-16, izzo, branch `izzo/workspace-self-heal-inc3` at `bc836e50`)

Setup: `agents-ghost` (an offline seat, `musterd init --check` coherent), one guidance stamp edited by hand from `musterd:content v23` to `v22` in `.musterd/skill/orient.md`. Confirmed: `init --check` → `✗ 1 musterd guidance file is v22, current is v23`.

The probe, run exactly as the SessionStart hook runs it but from this branch's dist rather than the shared checkout's:

```
$ node /Users/nick/agents-izzo/packages/cli/dist/bin.js init --check-build   # 19:58:06Z
musterd: repaired 1 guidance file.
$ echo $?
0
$ musterd init --check
✓ provisioning is coherent — primer and server agree
```

The daemon (still on `main`'s build, which has no such route) logged the client's audit-row post: `POST /teams/revive/workspace/repair → 404`, swallowed by the client as designed — a dead or older daemon is silence, never a failed session start. The `workspace.repaired` row itself cannot land until the daemon runs the ADR 408 route; that half of the arm is owed after merge (falsify then: `sqlite3 ~/.musterd/musterd.db "select actor, detail from audit where action='workspace.repaired'"` after a fresh session on a seat with one stale stamp — an empty result means the row is not landing).

## What the live arm caught that the unit tests could not

The FIRST run (19:57:11Z) repaired correctly and printed **eleven lines**: `runRefreshGuidance`'s own `✓ guidance refreshed to v23 — 9 file(s)` plus its nine-path file list, then the probe's one line. Every one of those would have landed in model context at every session start — the exact noise ADR 171's contract forbids. `runRefreshHooks` had a `quiet` option from the plan; `runRefreshGuidance` did not. Fixed and re-measured at 19:58:06Z: one line. The unit tests are pure over injected deps, so they can never see a real driver's stdout — the live arm is the only instrument for that class.

## A second finding the arm surfaced, not yet decided

The route authenticates like `/inbox/interrupt-check`: seat credential **and** a live session lease. But the SessionStart hook runs *before* the session has joined — the same window in which the interrupt probe is known to be refused (ADR 164, the deaf-until-`team_join` finding). So on a real session start the post will likely answer `401`, not `200`, even once the route exists. That is not what ADR 408's decision 4 intends ("only a live occupancy repairs a workspace" — the repair is local and provably the seat's, lease or no lease). Candidate correction: authenticate the route with the seat credential alone. Measured only as a prediction so far (2026-09-16; falsify: after the route is live, start a fresh session on a seat with one stale stamp and read the daemon log — a `200` on `POST /workspace/repair` disproves this). <!-- claim: defect -->

## What it will never touch

The ADR 261 permission floor, and any file outside the seat's worktree (the machine-wide Claude Code settings, Codex's git-common-dir `hooks.json`) — spec 2026-09-16, ADR 408 decision 2. Falsify: leave a seat's `.claude/settings.local.json` one floor entry short, run the probe, and check the entry is STILL absent and the line names `--refresh-permissions`.

## Related

- [The instrument discharges the act](the-instrument-discharges-the-act.md) — the adjacent lesson that a check which is also the delivery cannot measure delivery; the audit row here is the same remedy applied to provisioning.
- ADR 408; `docs/superpowers/specs/2026-09-16-workspace-self-heal-design.md`; `docs/superpowers/plans/2026-09-16-workspace-self-heal.md`.
