# 201 — The auto-refresher owns the bounce: stop instructing agents to do its job

- Status: accepted
- Date: 2026-07-31
- Authored by dolly, nick-directed (lanes `01KYX89VFBVRA2895TMSZD1N82`, `01KYX7YGNKJAAF4W7TKDDX6XBA`)
- Builds on: [ADR 118](118-service-refresh.md) (`service refresh`, the manual verb),
  [ADR 130](130-daemon-build-provenance.md) (the skew detector this reshapes),
  [ADR 148](148-feature-epoch-roster-skew.md) (the crying-wolf lesson: a chip that alarms on benign
  drift gets ignored), [ADR 085](085-layered-guidance-surface.md) (primer = kernel, skill = depth),
  [ADR 024](024-human-reachability-nudge.md) (the notification rail an unattended tick can reach).

## Context

An auto-refresher LaunchAgent (ADR 118/130 fast-follow) syncs the daemon's checkout to `origin/main`,
rebuilds, and bounces the daemon and the wake actuator on an interval. On a dogfood machine it is
installed and it works.

Agents did not know. Over one afternoon, seats repeatedly closed status updates with "needs a
`musterd service refresh` whenever nick wants it on /live" — handing a human a chore the machine
already owns, on a schedule, and signalling that the seat had not looked. nick: _"musterd agents
including you keep forgetting that we have an autorefresh thing from musterd infra."_

## Problem

**They were not forgetting. They were being told.** `buildSkewNote` emitted, unconditionally:

> ⚠ N commits behind origin/main — run `musterd service refresh`

with no check for whether an auto-refresher was installed. musterd instructed its own team to bypass
its own infra, in its own status output. No memory file, PSA, or documentation beats a live string in
a tool an agent is already reading.

Underneath sat a second, quieter problem. A refresh is sync → build → restart with **no install** —
fast and correct for the ~99% of merges that touch no dependency. The other 1% pins the daemon
_silently_: PR #565 added `@modelcontextprotocol/server`, the build failed on a package that was never
installed, the refresher correctly **refused to bounce**, and the daemon then sat on the old commit
across every later merge while `/health` answered cheerfully. The only evidence was a log nobody reads
unprompted — least of all the PR author, whose own worktree installed the dependency fine.

## Decision

### 1. Skew names who owns closing it

`buildSkewNote` takes an ownership verdict (`off` | `watching` | `stalled`), probed from the
auto-refresher's launchd state and its debounce stamp:

- **watching** — a loaded refresher will pick it up. Calm, **no command, no ⚠**. Skew here is benign
  transient drift, and per ADR 148 a warning that fires on drift the machine already handles gets
  tuned out — after which it cannot warn about anything real.
- **stalled** — the stamp already equals `origin/main` while the daemon is behind, so the tick
  attempted this tip. Loud, because this state is invisible everywhere else.
- **off** — nothing is watching; the manual verb is genuinely the answer, unchanged.

`service refresh` is **not** deprecated or hidden. It stays correct on hosts with no refresher, and as
the escape hatch after a tick you have just watched fail.

### 2. The stalled verdict claims only what it can prove

The tick writes its debounce stamp _before_ building, so `stamp == tip` with the daemon behind covers
both a build in flight and a build that failed. Those are indistinguishable from the status command,
so the message says both rather than asserting the alarming one. It also **names no checkout**: the
`dir` in hand is whatever checkout the CLI was invoked from, which from a seat worktree is not the
daemon's — a confident path there is a confidently wrong repair instruction. (Both faults were in the
first draft of this change and were caught by running it.)

### 3. Install when the lockfile moved

`refreshDaemon` runs `pnpm install --frozen-lockfile` when — and only when — the sync moved
`pnpm-lock.yaml`, decided by `git diff --name-only <before>..<after> -- pnpm-lock.yaml`. That is a fact
the tick already holds. Deciding instead on the build's error prose (`ERR_MODULE_NOT_FOUND` /
`TS2307`) was rejected: it would be one more prose anchor to rot, exactly the class of coupling ADR 175
spent effort deleting.

The install is **advisory**: on failure the refresh continues to the build, which names what is missing
with a far better error. It is never silent — a skipped install is what hid the problem last time.

### 4. An unattended failure leaves the log

A failed `--auto` tick raises an OS notification (ADR 024) naming the pinned commit, the target tip,
and the log. Once per tip, which the existing debounce already guarantees. The tick has no team
credential and this deliberately does not give it one — the notification rail is local and sufficient.

### 5. The standing rule reaches every agent, at the right layer

Per ADR 085: **one line in the primer** (always loaded — `AGENTS.md` and MCP `instructions`, so it
reaches every existing and new seat) and the depth in the **skill**. The primer sat exactly at its
35-line cap, so the line is folded into an existing paragraph with one reclaimed by tightening — net
zero. Every primer line is a per-session token tax and the cap is load-bearing, not incidental.

## Consequences

- Agents on an auto-refreshed machine are no longer instructed to bypass the refresher, and carry the
  rule as standing context rather than as something to remember.
- A dependency-adding merge self-heals instead of pinning the daemon.
- A tick that fails for any _other_ reason is now loud, so the next unknown failure mode surfaces in
  minutes rather than whenever a human happens to read the log.
- `GUIDANCE_CONTENT_VERSION` 11 → 13 (two content changes, each bumped per the ADR 085 ritual).
- The manual verb keeps working, so hosts without a refresher are unaffected.

## Observability & Evaluation

- **Traces.** The tick logs `lockfile moved — installing…` and `installed new dependencies` to
  `~/.musterd/autorefresh/refresh.log`; a failed tick emits the `musterd-autorefresh-failed`
  notification. `musterd service status` prints the ownership verdict on the `build:` line.
- **Eval.** Baseline (pre-this): #565 pinned the daemon for ~25 minutes across two merges, surfaced
  only when a human asked why the board was not live, and the status command told every reader to run
  a manual refresh. Success: a lockfile-changing merge reaches the daemon with no human step, and a
  tick that fails produces a notification within one interval instead of silence.
- **Experiment.** The behavioural claim is that agents stop prescribing the manual verb once the tool
  stops prescribing it. Pre-register on the delivery ledger: count `service refresh` mentions in
  `status_update` / `message` act bodies per week, before and after this lands. The prediction is that
  the rate falls to ~0 without any further reminders — and if it does not, the primer/skill line is not
  the lever and the next move is enforcement (a hook), not more prose. n/a for a control arm: this is a
  single shared machine, so there is no unexposed population to compare against.
- **Watch for.** False `stalled` verdicts during a normal in-flight build — the window is one build
  per tick, and the wording covers both cases, but if operators report noise the fix is to distinguish
  in-flight from failed (a completion marker beside the attempt stamp), not to soften the alarm.
