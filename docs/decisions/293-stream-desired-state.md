# 293 — The stream declares its desired state; a supervisor reconciles, and only `stream stop` sticks

- Status: accepted
- Date: 2026-08-19
- Relates to: ADR 157 (hosted stream contract), ADR 159 (graceful stop + stall watchdog),
  ADR 232 (service seats degrade attributed, never silently), ADR 292 (stale-page convergence —
  the staleness half of the same incident family)

## Context

`musterd stream start` runs the broadcast machine with `--rm --restart no`: machine lifetime IS
stream lifetime, which is right for billing (the ADR 159 watchdog and `--duration` end the machine
*and* the meter by exiting) and right for deliberate stops. It also means that after the fact a
crash and a stop are **the same observable** — no machine. On 2026-08-18 the machine died on
"Chrome DevTools socket closed" at 21:06Z and the stream stayed dead until a human noticed old air;
nothing could safely auto-restart it, because nothing recorded whether the silence was intentional.

The distinction nick named directly: a crash must be distinguishable from *nick telling an agent
to stop the stream*. Agents run `stream stop` on his behalf; an automatic restarter that cannot
tell those apart either resurrects deliberate stops or ignores crashes.

A Fly restart policy is the wrong tool twice over: it cannot distinguish the watchdog's deliberate
kills from crashes, and a crash-looping machine at performance-4x has no cost ceiling.

## Decision

**Intent is recorded, and only through the verbs.** `~/.musterd/stream/state.json`:

- `stream start` writes `{desired: "live", by, at, team}` **before** launching — a start that
  fails at `fly` still says "this stream should be live", so the supervisor's next tick retries it
  inside the same budget. `start --once` records `stopped` instead: a deliberately unsupervised
  run (time-boxed `--duration` streams) is never resurrected. A start also clears any stand-down —
  the human re-arming IS the human decision.
- `stream stop` writes `{desired: "stopped", by: <the CLI's resolved seat>, at, reason?}`
  **before** touching the machine, so even mid-race the supervisor can never resurrect a
  deliberate stop — and a stop typed at an already-dead stream records "this silence is
  intentional". `--reason` carries the why ("nick asked"); `stream status` surfaces the record
  (`○ stopped by miley · 4:20pm · "nick asked"`) instead of a bare "not live".

**A machine gone while desired says live is a crash, by definition.** `stream ensure` — one
reconcile pass, pure decision in `streamState.ts` — relaunches it, stamping a restart ledger
**before** the launch so a failed relaunch still spends an attempt. At **3 restarts inside 30
minutes** (nick, 2026-08-19) it stands down, raises ONE team ask as the `streamwatch` service seat
(minted at install, the guardian/ADR 232 pattern; unprovisioned degrades to a log line), and stays
quiet until a human `stream start` re-arms it.

**The supervisor is a LaunchAgent**: `musterd service install --stream` → StartInterval 60s
running `stream ensure`, the sweep's shape (one pass then exit, never KeepAlive), laptop-side
because fly, tailscale and the image digest live here.

**Consequence stated out loud:** with the supervisor installed, killing the machine any way other
than `musterd stream stop` gets healed within ~60s. The wiki's "stop with `stream stop`, never by
killing the machine" is now enforced, not advised — the verb is the one off-switch that sticks,
and it leaves a name on the record.

## Observability & Evaluation

- **Traces:** the state file is the record — who set `desired`, when, why, the restart stamps, and
  `standDownAt`. `stream status` renders it; the supervisor log (`~/.musterd/stream/ensure.log`)
  holds findings only (a healthy tick is silent, the sweep's discipline); a stand-down is an
  attributed `ask` from `streamwatch` in the team stream.
- **Eval:** after the next real crash: did the stream return within ~60s + machine boot, with a
  `↻ crash detected` line in the log and no human involved? After the next deliberate stop: did it
  STAY stopped, with provenance in `stream status`? A resurrection of a verb-stopped stream, or a
  crash that a human had to notice again, reopens this ADR. Baseline: 2026-08-18, where recovery
  took a human noticing dead air the next session.
- **Experiment:** run once at install, not indefinitely — the reconcile table is unit-tested
  (noop/restart/stand-down against every desired/machine/ledger combination), and the first
  supervised session should include one induced crash (`fly machine stop` without the verb) to
  watch the heal happen.

## Consequences

- A Chrome death costs at most ~60s of dead air plus the machine boot, not a session.
- Composed with ADR 292, the restarted page loads the currently-served bundle and then keeps
  itself current — the whole 2026-08-18/19 incident family is closed by the pair.
- A crash-loop costs at most 3 machine boots per half hour, then one ask.
- `stream stop` is now also an audit record: silence on the channel has a name attached.
