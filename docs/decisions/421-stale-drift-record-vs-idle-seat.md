# 421 — A stale drift record is not a dead hook until a tool boundary has passed

- Status: proposed
- Date: 2026-09-19
- Relates to: [ADR 408](408-a-workspace-repair-is-an-audit-row.md) (the drift cache and its
  adapter reader, increment 4), [ADR 419](419-startup-probe-runs-at-every-sessionstart.md) (every
  SessionStart writes the record), [ADR 088](088-interrupt-line-tool-boundary-inbox-check.md) (the PostToolUse interrupt
  probe the writer rides)
- Lane: `01M2X9RY4X67H5QERYE37237VH`

## Context

ADR 408 increment 4 caches the workspace's provisioning drift in `.musterd/drift.json` so the MCP
adapter can report it on every inbox check without inspecting the workspace. The writer is the
interrupt-check probe — the PostToolUse hook — on a ten-minute TTL. Lane `01M2NYV805` then added
the "unknown is not clean" warning: an absent, unparseable or **stale** record is reported as
`drift_unreadable`, with a 30-minute stale threshold chosen on the reasoning that _"a running
writer never leaves a cache older than the TTL, so three missed cycles is far enough above it that
an ordinary quiet stretch never trips it"_, and a sentence naming the likeliest cause: _"the hook
is not running."_

Measured on `agents-izzo`, 2026-09-18, from the session transcript's hook records:

- `drift.json` written 13:25:44 — by the PostToolUse hook after a Bash call (Claude Code's
  `hook_success` record at 13:25:42).
- **No tool call of any kind from 13:29:34 to 16:12:54.** The seat was waiting on a review.
- 16:12:54 `team_inbox_check`: the adapter read the record — 10,031,148 ms old, exactly
  16:12:55 − 13:25:44 — and returned _"its drift record is 167m old … the likeliest cause is that
  the hook is not running."_
- The PostToolUse hook riding that same call rewrote the record two seconds later.

The hook was never broken. Reproduced 2026-09-19: the record aged by hand to twenty minutes, the
harness rewrote it one second after the next tool call. The writer runs only at tool boundaries,
and a quiet seat has none — so the premise "a running writer never leaves a cache older than the
TTL" is false for the ordinary case of a seat that is idle, and the threshold cannot fix it: any
idle stretch longer than the threshold produces the warning on the first inbox check after it,
which is the one check where the reader most needs the line to be true. The first read after an
idle is also structurally too early — the adapter reads the file inside the tool call, and the
hook that would refresh it runs after the tool call returns.

## Problem

The adapter reports "the hook is not running" from an observation — age — that cannot distinguish
a dead hook from a quiet seat. On a team where seats routinely wait hours for acceptance, the
warning fires on healthy seats, prescribes a diagnosis that is wrong, and costs a seat's first
turn back (izzo spent a session's opening on it). A warning that fires on healthy workspaces is
one people learn to ignore, which mutes it for the population it exists for.

## Decision

1. **Staleness is reported only after a tool boundary has passed with no write.** The adapter
   remembers, per workspace and per adapter process, when it first read the record as stale. A
   first sighting is silent — the inbox check that made it is itself a tool boundary, so a living
   hook rewrites the record before the next one. A later sighting that finds the record **still
   older than the first sighting** is the observation age alone could not make: a boundary passed
   and nothing wrote. That, and only that, is reported as `stale`. A later sighting that finds the
   record newer than the first sighting is a hook that wrote and a seat that idled past the
   threshold again — a new first sighting. A fresh record clears the memory.
2. **The sentence says what was seen.** The `stale` text names the age _and_ the passed boundary
   ("… and a tool boundary has passed since this seat first read it stale, with no rewrite") so
   "the hook is not running" is stated from evidence, not likelihood. `absent` and `unparseable`
   keep their immediate report and their "likeliest cause" phrasing: ADR 419 guarantees a
   SessionStart write before any tool call, so absence on a seat workspace is not an idle artefact,
   and a file that does not parse is wrong the moment it is read.
3. **The 30-minute threshold stays**, as the age at which a sighting starts counting. It is no
   longer claimed to separate a quiet seat from a stopped writer — nothing about age does.

## Consequences

- A dead hook is named on the second inbox check after the record goes stale rather than the
  first: one call later, on the same surface. The `01M2NYV805` measurement — a zeroed file left
  behind by a hook that broke after one clean write — is still caught; it now costs one extra
  call.
- The memory is process-local to the adapter, which is per session. A fresh session starts with
  no sightings, which is right: its SessionStart just wrote the record, and its first inbox check
  reads it fresh.
- A harness with no interrupt-check hook wired (Cursor, Codex — `acceptance-routing.md`) still
  reaches the warning, on its second inbox check: there really is no writer at a tool boundary
  there, and the state really is unknown.
- The stated premise in `format.ts` is corrected in the same commit; the wiki pages that carried
  it (`structured-results-have-two-audiences.md`, `workspace-self-heal.md`) are amended, dated.

## Observability & Evaluation

- **Traces.** Nothing new is written: `.musterd/drift.json` stays the local trace, and the
  adapter's sighting memory is in-process only. The warning's `age_ms` is unchanged; the `stale`
  text now states the passed boundary, so a transcript carrying it is evidence of a dead hook
  rather than of a quiet seat. No secrets, ids or paths are added.
- **Eval.** `driftUnreadable.test.ts` pins the five-step sequence below. Dataset and baseline: the
  izzo 2026-09-18 transcript (`hook_success` at 13:25:42, no tool call 13:29:34→16:12:54, the
  warning at 16:12:55 with `age_ms` 10,031,148) is the one false positive on record; the baseline
  is one false warning per idle stretch over thirty minutes on every seat, the target is zero, and
  a dead hook still named — one call later than before.
- **Experiment.** None; the change is a pure function's memory and the live falsifier below is
  runnable on any seat.

`packages/mcp/src/tools/driftUnreadable.test.ts` pins the sequence: silent first sighting; `stale`
on a later sighting with no rewrite; silence and re-arm when the record was rewritten between
sightings; memory cleared by a fresh record; memory keyed per workspace. Falsify live: on any seat,
make no tool call for over thirty minutes, then run `team_inbox_check` once — a `drift_unreadable`
warning on that first call means this rule has regressed; run it a second time — silence on a seat
whose hook is wired means the hook wrote across the boundary, as designed.
