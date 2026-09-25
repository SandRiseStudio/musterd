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

The daemon (still on `main`'s build, which has no such route) logged the client's audit-row post: `POST /teams/revive/workspace/repair → 404`, swallowed by the client as designed — a dead or older daemon is silence, never a failed session start. The `workspace.repaired` row itself could not land until the daemon ran the ADR 408 route, so that half of the arm was owed after merge. **It was paid on 2026-09-16 — see the next section.**

## What the live arm caught that the unit tests could not

The FIRST run (19:57:11Z) repaired correctly and printed **eleven lines**: `runRefreshGuidance`'s own `✓ guidance refreshed to v23 — 9 file(s)` plus its nine-path file list, then the probe's one line. Every one of those would have landed in model context at every session start — the exact noise ADR 171's contract forbids. `runRefreshHooks` had a `quiet` option from the plan; `runRefreshGuidance` did not. Fixed and re-measured at 19:58:06Z: one line. The unit tests are pure over injected deps, so they can never see a real driver's stdout — the live arm is the only instrument for that class.

## A second finding the arm surfaced — decided the same evening

~~The route authenticates like `/inbox/interrupt-check`: seat credential **and** a live session lease. But the SessionStart hook runs *before* the session has joined — the same window in which the interrupt probe is known to be refused (ADR 164, the deaf-until-`team_join` finding). So on a real session start the post will likely answer `401`, not `200`, even once the route exists. That is not what ADR 408's decision 4 intends ("only a live occupancy repairs a workspace" — the repair is local and provably the seat's, lease or no lease). Candidate correction: authenticate the route with the seat credential alone. Measured only as a prediction so far (2026-09-16; falsify: after the route is live, start a fresh session on a seat with one stale stamp and read the daemon log — a `200` on `POST /workspace/repair` disproves this).~~ **DECIDED 2026-09-16** (nick, same PR): the route now takes the seat credential alone — `authMember(…, { leaseless: true })`, the single leaseless agent route, ADR 408 decision 4 amended. **CONFIRMED AGAINST A LIVE DAEMON the same day — see below.** <!-- claim: defect -->

## The audit row lands, and the leaseless route is confirmed (2026-09-16, izzo, daemon on `6fe9544`)

The row this design turns on had never been *observed*. Every earlier measurement ran against a daemon predating the route, so `POST /workspace/repair` answered 404 and the prediction of a `401` — the thing decision 4 was amended to avoid — stayed a prediction. The daemon bounced onto a build carrying the route during the increment-4/5 session, which made the check runnable, and it was run before the lane closed rather than after:

```
$ sqlite3 ~/.musterd/musterd.db "select actor, detail from audit where action='workspace.repaired'"
izzo|{"build":"37d11cfa…-dirty","repaired":{"guidance":1,"hooks":0},"skipped":[],"remaining":{"guidance":0,"hooks":0,"permissions":0}}
izzo|{"build":"8702f698…-dirty","repaired":{"guidance":1,"hooks":0},"skipped":[],"remaining":{"guidance":0,"hooks":0,"permissions":0}}
izzo|{"build":"8702f698…-dirty","repaired":{"guidance":0,"hooks":0},"skipped":[{"class":"permissions","reason":"policy"}],"remaining":{"guidance":0,"hooks":0,"permissions":1}}

daemon.log, POST /teams/revive/workspace/repair:  3 × 200,  2 × 404,  ZERO 401
```

Three separate findings, one query. **The 404s are the degrade path working** — those are the two posts made before the bounce, swallowed by the client exactly as decision 4 requires, so a dead or older daemon costs a session start nothing. **Zero 401s confirms the leaseless route**, which is the load-bearing one: SessionStart posts before the session has joined, inside the ADR 164 window where every lease-gated route refuses, and this is the single agent route excepted from ADR 337 for that reason. The prediction above said `401`; the correction shipped the same evening; this is the first time the corrected path has been seen answering a real hook. **The third row is decision 2's security line visible as evidence rather than as a test** — the seat saw the permission floor was behind, recorded `skipped: [{permissions, policy}]` and `remaining.permissions: 1`, repaired nothing, and did not touch the file.

The audit row lands on a real session start and the leaseless path answers 200, never 401 (2026-09-16). Falsify: hand-edit one guidance stamp back a version on any seat, start a session, and read both the `audit` table and `daemon.log` — no new row means the post is not landing, and a `401` means the leaseless exception has regressed. <!-- claim: defect -->

## Increment 4's live arm — the cache must be written AFTER the repair (2026-09-16, izzo, `izzo/workspace-self-heal-inc4`)

Increment 4 caches the drift measurement in `.musterd/drift.json` so the MCP adapter can report it on every inbox check without re-inspecting. The first build wrote that cache in the same block that fetches the daemon build for the skew line — which runs BEFORE the self-heal step.

Measured on `agents-izzo`, one guidance stamp hand-edited v23 → v22:

```
$ node packages/cli/dist/bin.js init --check-build
musterd: repaired 1 guidance file.
$ cat .musterd/drift.json
{ "inspected_at": 1789592922125, "build": "d953fda…", "guidance": 1, "hooks": 0, "permissions": 0, "declined": false }
$ musterd init --check
✓ provisioning is coherent — primer and server agree
```

The workspace is coherent and the cache says `guidance: 1`. Every inbox check for the next ten minutes would have warned about drift that no longer existed and prescribed a repair already done — the same failure class as #1479 (a correct fix reported as failing), arriving through the surface built to stop it. The repair running first is the whole point; the report has to follow it. Fixed by moving the write after the self-heal block, where `remaining` is the honest number; re-measured, the same run now writes `guidance: 0`. Pinned by a unit test that injects both steps and asserts the ORDER, because no assertion over either step alone can see this.

The cache holds what REMAINS after the repair, never what was found before it (2026-09-16). Falsify: hand-edit one guidance stamp back a version, run the probe, and read `.musterd/drift.json` — a non-zero count on a workspace `init --check` calls coherent means the write has drifted back ahead of the repair again. <!-- claim: defect -->

Order alone was not enough (2026-09-25, dolly). The write after the repair went through `refreshDriftCache`, which returns a cache still inside its TTL without looking again, so a seat whose cache was a few minutes old kept the pre-repair count anyway. The manual repairs never wrote the cache at all: `musterd init --refresh-hooks` repaired 6 hooks on dolly, and the inbox went on warning "behind on 6 hooks — run `musterd init --refresh-hooks`" until the TTL ran out. Every caller that has just changed the folder now passes `force` — the session-start heal and `init --refresh-{hooks,guidance,permissions}`. Falsify: run `musterd init --refresh-hooks` in a drifted seat and read `.musterd/drift.json` straight after — a non-zero `hooks` count, or an `inspected_at` from before the run, means a repair's result is being hidden by the TTL again. <!-- claim: defect -->

## The drift the session start cannot fix is the one increment 4 exists for (same arm)

The permission floor never self-heals (decision 2), so it is exactly what has to survive into the cache. Measured by removing one `mcp__musterd` entry from this seat's `.claude/settings.local.json` and running the probe:

```
musterd: repaired nothing; the harness permission layer is still behind — run `musterd init --refresh-permissions`.
$ cat .musterd/drift.json      → { …, "permissions": 1, "declined": false }
$ node -e "…provisioningDriftOf(process.cwd())"   # the real mcp dist, not a fixture
{ "kind": "provisioning_drift", "permissions": 1, "repairable_at": "manual",
  "text": "⚠ musterd: this workspace is behind on 1 permission entry — the permission floor is never self-healed; it is the harness's security boundary; run `musterd init --refresh-permissions`." }
```

Both halves hold at once: the floor entry was **not** rewritten, and `repairable_at` is `manual` rather than `session-start` — a reader told the next session start would fix this would correctly do nothing and stay broken. The entry was restored and `init --check` reads coherent.

Drift the session start cannot repair reaches the seat as a `manual` warning, not a `session-start` one (2026-09-16). Falsify: remove one floor entry from a seat's `.claude/settings.local.json`, run the probe, and read the warning — `repairable_at: 'session-start'`, or a rewritten floor entry, breaks this. <!-- claim: other -->

## The record's age is the seat's silence — a stale cache is not a dead hook (2026-09-18, izzo)

The `drift_unreadable` "stale" warning (lane `01M2NYV805`) assumed a running writer never leaves the cache older than its TTL. The writer is the PostToolUse hook, which runs only at a tool boundary — so a seat that makes no tool call writes nothing, however healthy. Read from the session transcript's own hook records:

```
13:25:42  PostToolUse:Bash hook_success            → drift.json written 13:25:44 (the hook)
13:29:34  last tool call (team_send)
          … no tool call of any kind …
16:12:54  team_inbox_check  → "drift record is 167m old … the hook is not running"
16:12:57  drift.json rewritten — by the hook riding THAT call
```

`age_ms` 10,031,148 = 16:12:55 − 13:25:44 to the second. Reproduced 2026-09-19: aged the file by hand to twenty minutes, the harness rewrote it one second after the next Bash call; the hook command run by hand from the harness shell also writes. The adapter reads the file *inside* the tool call and the hook that refreshes it runs *after* the call returns, so the first read after any idle is too early by construction, and no threshold fixes that. ADR 421: the adapter remembers the first stale sighting and reports only when a later sighting finds the record still older than it — a boundary passed with no write (2026-09-19; falsify: idle a wired seat past thirty minutes, `team_inbox_check` twice — a warning on the first call is the rule regressing; one on the second means the hook did not write across a boundary, which on a wired seat is a real dead hook, not this defect). <!-- claim: defect -->

Two things worth not relearning while reading such a transcript: Claude Code records a `hook_success` attachment only when the hook printed something, so a silent hook run leaves no record at all — the cognee hook's `{}` shows every call, the musterd interrupt hook shows only its deaf lines — and the deaf line (`the interrupt line is deaf — this seat's session lease is dead`) is emitted *after* the drift write in `interruptCheck`, so a deaf seat still refreshes the record.

## What it will never touch

The ADR 261 permission floor, and any file outside the seat's worktree (the machine-wide Claude Code settings, Codex's git-common-dir `hooks.json`) — spec 2026-09-16, ADR 408 decision 2. Falsify: leave a seat's `.claude/settings.local.json` one floor entry short, run the probe, and check the entry is STILL absent and the line names `--refresh-permissions`.

## Related

- [The instrument discharges the act](the-instrument-discharges-the-act.md) — the adjacent lesson that a check which is also the delivery cannot measure delivery; the audit row here is the same remedy applied to provisioning.
- ADR 408; `docs/superpowers/specs/2026-09-16-workspace-self-heal-design.md`; `docs/superpowers/plans/2026-09-16-workspace-self-heal.md`.
