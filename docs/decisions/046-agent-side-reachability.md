# 046 — Agent-side reachability: the directed-act nudge on every command

- Status: accepted
- Date: 2026-06-24

## Context

The recipient-side reachability loop is, today, **human-only**. ADR 024 gives a returning/away human the
comeback summary on `status` (`⚑ N requests waiting for you`) and the watch-pane banner+bell; ADR 035
adds `notify` (OS push); ADR 044 adds the availability axis + `urgent` breakthrough. An **agent** that
goes heads-down has none of this. The 2026-06-24 dogfood (recorded in `human-agent-dynamics.md` §6) made
it concrete: a seat-holding agent read its inbox once, never re-checked, and left a directed
`request_help` ("real test" → David) unanswered for the whole session — the exact failure the loop exists
to prevent, committed by the agent *building the loop*.

The relationship musterd models is symmetric (peers; either may steer or supervise). The **reachability
tooling is not** — and that asymmetry, not "agents should poll more," is the bug.

## Problem

Make a directed act waiting for an agent impossible to miss during normal work, **without** (a) a wire
change, (b) requiring the agent to run a resident process (`--watch`/`notify` — an agent shelling out
one-shots won't), (c) nagging, or (d) adding meaningful latency to every command.

## Decision

Append a **one-line reachability banner** to the output of any **authenticated, acting** command, built
from the *same* pure predicate the human comeback summary already uses
(`openActionNeeded`/`pendingActionSummary`, ADR 024/025). It is the agent-side mirror of `status`'s
comeback line, surfaced everywhere an agent already is instead of only when it thinks to look.

```
⚑ 2 acts waiting for David — musterd inbox        (since 14:17)
```

### 1. Where it fires

A shared post-command step (in `bin.ts`, after a successful dispatch) re-resolves the identity with
`resolveRead(flags)` and, **only when the identity is explicit** (an acting env/binding/`--as`
identity — never an ambient global-config read, per ADR 036), does a best-effort
`pendingActionSummary(http, team, me)` and prints the banner to **stderr**.

- **Skip when the command already shows it:** `inbox` (renders the acts) and `status` (already prints the
  comeback summary) are excluded — no double-surfacing.
- **Skip non-identity commands:** `serve`/`service`/`init`/`reset`/`role`/`uninstall`/`help` carry no
  acting identity context; the re-resolve simply yields nothing and prints nothing.
- **stderr, not stdout:** keeps `--json` and piped stdout clean; the nudge is a sidecar signal.
- **Best-effort:** any inbox/roster read failure is swallowed — the nudge must never fail a command.

### 2. Why this isn't nagging

Two existing properties carry over from ADR 024/035: the **durable cursor** (reading the inbox advances
it, so an acted-on item stops counting — the banner self-clears) and **open-vs-done** (`openActionNeeded`
drops `resolve`d threads). The banner shows only when `count > 0`, is a single line, and points at the
fix (`musterd inbox`). An opt-out (`MUSTERD_NO_NUDGE=1` env, or `--quiet`) covers scripts that want
silence.

### 3. Why client-side

No wire change and no SPEC bump — it rides the existing inbox cursor read, exactly as ADR 035's `notify`
does. The server stays a clean core. This is the down-payment posture again: the governed routing of the
full "Notification tiers" item is the superset; this is the cheap, correct floor.

## Implementation plan

- **`packages/cli/src/render/rows.ts`** — add `renderReachabilityNudge(count, sinceTs): string` (or
  reuse `renderPendingSummary` with agent-facing copy "acts waiting for <me>"). Pure.
- **`packages/cli/src/commands/helpers.ts`** — already exports `pendingActionSummary`; add a thin
  `reachabilityNudge(http, team, me): Promise<string>` that formats it, or keep formatting in bin.
- **`packages/cli/src/bin.ts`** — after `await <command>(rest)` returns a code, run the nudge step:
  `resolveRead(rest.flags)`; if `explicit && identity` and command ∉ {inbox, status, serve, service,
  init, reset, role, uninstall} and not `--json`/`--quiet`/`MUSTERD_NO_NUDGE`, print the banner to
  stderr (best-effort, wrapped in try/catch). One added import; ~15 lines.
- **`packages/cli/src/args.ts`** — add `quiet` to `BOOLEAN_FLAGS`.
- **Tests (`bin`/helpers):** (1) pure render; (2) integration against a live in-memory daemon — a
  `request_help → me` makes the banner appear after an unrelated `send`, and disappears after the inbox
  cursor advances; (3) ambient-only identity prints nothing; (4) `--json`/`--quiet` suppress it.
- **Docs:** note the nudge in `04-cli.md` (global behavior section) and tick the roadmap item to shipped
  on landing.

## Open questions

- **Kind scope.** Fire for humans too, or agents only? Humans already have `status` + `notify`; firing on
  every command may annoy. Leaning: fire for any explicit identity but make opt-out trivial — revisit if
  it's noisy for humans driving the CLI directly.
- **Latency.** One extra inbox read per acting command. Acceptable on localhost; consider a short cache
  (skip if the last nudge ran < Ns ago in the same process) — but CLI one-shots are separate processes,
  so a cache only helps long-running ones. Probably not needed.
- **Throttle across processes.** True "don't repeat within N minutes" would need durable per-seat state
  the CLI deliberately avoids (ADR 035 kept de-dupe in-memory). Accept one line per command; the cursor
  is the real silencer.

## Consequences

- Symmetric reachability: an agent can't sit on a directed `request_help` it never looked for.
- No wire/SPEC change, no new dependency, no resident process required.
- Self-clearing and quiet-able; reuses the audited ADR 024/025 predicate so live and nudge paths classify
  identically.
- A small per-command read cost on acting commands; bounded and best-effort.
