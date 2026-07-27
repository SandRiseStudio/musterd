# 164 — Session-attested presence: a heartbeat must be attested by a session, not by a process

- Status: **draft** — 2026-07-27. Authored by stanley (lane `01KYJ923TD5F4A54XN9W0MKWCW`).
  Number **164 pinned** — verified free on `origin/main` (highest is 163), 2026-07-27.
- Date: 2026-07-27
- Builds on: [ADR 057](057-ambient-agent-presence.md) (presence derives from real actions and never
  displaces — the invariant this ADR restores), [ADR 010](010-single-active-grace.md) (the two clocks;
  agents never revert while live — deliberately **untouched** here), [ADR 131](131-harness-residency-wake-ledger-host.md)
  §5 increment 4 (`binding.session` capture and the `localSessionLiveness` judgement this reuses),
  [ADR 155](155-human-presence-ladder.md) (the presence ladder and the human-only idle decay this
  ADR does **not** extend to agents), [ADR 108](108-probe-safe-autojoin.md) (autojoin on first tool
  call — the recovery path that makes going dormant safe), [ADR 153](153-ask-reachability-gated-hold.md)
  (`unblocker_reachable`, a consumer of the liveness this ADR corrects).

## Context

Presence in musterd is meant to be _ambient_: it is derived from real actions, never asserted
(ADR 057). In practice an agent seat's liveness comes from one signal — the MCP adapter's 15-second
`heartbeat` frame on its WebSocket. While those frames arrive, the seat is `live`; 45 seconds after
they stop (`PRESENCE_TIMEOUT_MS`), it goes offline.

That signal attests **a process**, not **a session**. When the two come apart, the roster lies.

### The observation

Measured 2026-07-27, reproduced end-to-end with timestamps, not hypothesised:

- Seat `izzo`'s Claude Code session (`77895254-…`, worktree `agents-izzo`) started 2026-07-26
  21:24:24 local. Its transcript's last entry is 2026-07-27T04:34:47Z. The CCD session manager
  reports `isRunning: false`.
- At 2026-07-27T17:10Z — **12h 36m** of total silence later — `team_status` still listed `izzo`
  under WORKING, and her presence row read `status='online'` with a `last_seen_at` minutes old.
- Cause: the seat's MCP adapter (PID 41038, `packages/mcp/dist/index.js`, cwd `/Users/nick/agents-izzo`)
  was still alive, started 21:24:28 — matching the session start to the second. It outlived the
  session that spawned it and kept heartbeating.

This is the known "reload orphans MCP procs" trap (claim-flow dogfood findings) surfacing not as a
stray-process annoyance but as a **presence-truth bug**.

### Why it matters beyond tidiness

A seat that reads `working` while its session is dead breaks the roster's core promise, and it broke
a real decision in the same hour it was found: a `lane_handoff` went to `izzo` on the belief she was
live. She was not. The work sat owned-but-unattended, and nobody would have noticed, because every
surface said she was working.

**A falsely-present seat is worse than an absent one.** An absent seat prompts a human to check; a
falsely-present one suppresses the check. It also silently corrupts everything keyed on liveness:
the ADR 155 ladder, the ask clock's reachability gate (ADR 153 `unblocker_reachable` — an ask can
hold for a "reachable" seat that cannot answer), and every wake-vs-already-awake decision.

### Why the existing teardown did not fire

`packages/mcp/src/index.ts` already installs a thorough shutdown: stdin `end`/`close`, `SIGINT`/
`SIGTERM`/`SIGHUP`, and transport `onclose`, all idempotent. The primary signal is the host closing
our stdin. PID 41038 nonetheless survived 12h36m, so **the host did not close the pipe** (or an
inherited fd held it open). The precise reason it was missed is unknown and, for this decision,
does not matter: the mechanism exists, is correct, and demonstrably cannot be relied on. Any fix
that depends on the host announcing the end inherits the same failure.

### What the binding already knows (measured)

`binding.session` (ADR 131 §5 inc 4) is written by the `SessionStart`/`SessionEnd` hooks, and
`localSessionLiveness()` (`packages/cli/src/session/liveness.ts`) already turns it into a
crash-surviving judgement for the wake path. Probing the four live worktrees at 2026-07-27T17:2xZ:

| seat      | `ended_at` | transcript age              | truth                               |
| --------- | ---------- | --------------------------- | ----------------------------------- |
| `izzo`    | absent     | 804 min                     | dead; **only staleness catches it** |
| `ryder`   | present    | 1341 min                    | dead; `ended_at` catches it         |
| `miley`   | present    | **transcript file missing** | ended; `ended_at` catches it        |
| `stanley` | absent     | 0.0 min                     | live                                |

Two things follow. `ended_at` is precise but incomplete — it was absent for exactly the seat that
lied. And the transcript is not always stattable, so a design that reads "cannot stat ⇒ dead" would
take a seat offline on a harness that keeps no transcript.

So the truth already exists on disk, machine-local, next to the process that is lying. It is simply
not consulted by the thing that heartbeats.

## Problem

The heartbeat asserts liveness on behalf of a session it never checks. Nothing in the loop —
adapter, daemon, or roster — ever asks whether the session that justified the presence is still
there, so a surviving process holds a seat `working` indefinitely.

## Decision

**A heartbeat must be attested by the session it claims to represent.** The MCP adapter checks its
own session's liveness on each existing 15-second tick, and stops asserting presence when that
session is gone.

The check runs adapter-side, not daemon-side, for one structural reason: session truth is
machine-local (a binding file and a transcript on the same filesystem), and the daemon is not
guaranteed to be on that machine (ADR 039/040). The adapter is the only party that can both see the
session and is already lying about it.

This costs the server nothing and changes no server semantics. In particular it changes `live`, not
`activity` — so **ADR 010 stands untouched**: an agent still never reverts `working → idle` while
live, and ADR 155's idle decay stays human-only. The candidate of extending staleness decay to
agents is explicitly **rejected**: it would contradict a standing decision in order to paper over a
liveness bug, and it would still report a dead seat as `idle` rather than `offline` — present, and
still wrong.

### The ladder

Four rungs, evaluated on the tick that already re-reads the binding off disk for model
re-attestation (ADR 158 §7) — so the added cost is one `stat` per 15 seconds per seat.

| #   | Signal                                                            | Action            |
| --- | ----------------------------------------------------------------- | ----------------- |
| 1   | stdin EOF / transport close                                       | exit (**exists**) |
| 2   | `process.ppid === 1` — re-parented, nothing spawned us any more   | exit              |
| 3   | `binding.session.ended_at` set **for our own session id**         | **go dormant**    |
| 4   | transcript mtime older than `SESSION_STALE_MS`, `ended_at` absent | **go dormant**    |

**Only rung 2 exits.** That is a correction, not the original design, and the reason is worth
stating plainly: this ADR's first two attempts both classified a signal as "definitive" and both
were wrong about a session that was in fact alive. Exiting is unrecoverable — a live session is left
with no musterd tools until the harness restarts — while dormancy costs nothing, because ADR 108
autojoin re-occupies on the very next tool call. When the asymmetry is that lopsided, confidence
should not be spent. Rung 2 keeps its exit only because a re-parented process has nothing left to
recover _for_.

Rung 4 is the crash/orphan backstop — the only rung that would have caught `izzo` — and it _can_ be
wrong about a session that is merely idle for a long time, because a transcript is appended per
message and a seat waiting on a human writes nothing.

That false positive is bounded on purpose. Rung 4 **must not exit the process**; it calls the
existing `leave()` (back to dormant: presence released, tools stay registered), and ADR 108 autojoin
re-occupies on the next tool call. So a genuinely-idle session that trips rung 4 reads honestly
offline until its next action, then comes back — which is precisely the ADR 057 model, where an
action and not a socket is what makes a seat present. Exiting on rung 4, by contrast, would strand a
live session with no musterd tools until the harness restarts; that is why the rungs are split.

### Thresholds

- `SESSION_STALE_MS` = **60 minutes**. Deliberately far more generous than the
  existing `LOCAL_SESSION_LIVE_MS` (10 min), which guards a wake decision where a false "live"
  merely fails to upgrade. Here a false positive costs a real seat its presence, so the horizon is
  sized to a long human deliberation, not a short one. Every observed lie exceeded it by an order of
  magnitude (804 min, 1341 min).
- **Fail open.** An unreadable binding, an absent `session`, a missing `transcript_path`, or an
  unstattable transcript all mean _no judgement_ — keep heartbeating. `miley`'s missing transcript
  is the live case; harnesses that keep no transcript at all must never be demoted by rung 4. Only
  rungs 1–3 apply there.

### Which session is ours — and the boot race

Rungs 3 and 4 are judgements about **our own** session, and the adapter does not have a session id:
`binding.session` is written by the hooks, and ADR 131 deliberately kept the adapter out of it to
avoid a hook-vs-adapter boot race. This ADR brings the adapter in, so it must handle that race
rather than inherit it.

At boot the adapter routinely sees the _previous_ session's capture, because `SessionStart` has not
written yet. An adapter that pinned that id would then watch it be replaced and conclude — exactly
backwards — that itself was the orphan.

**The first attempt at a fence was wrong, and a live probe caught it.** It adopted only a capture
whose `started_at` was no earlier than the adapter's own process start. The probe drove a real
adapter against an isolated daemon, killed the session the way a crash does, and the seat stayed
online: the adapter had never adopted anything, so no rung could fire. The fence assumed the harness
writes the hook _after_ spawning the MCP server; when that order is reversed, the capture always
looks too old and the ladder is **silently inert**. An inert safety mechanism that reports nothing is
worse than none, because it looks like it works.

Adoption is therefore two rules, neither depending on `started_at`:

- **Settle first.** Adopt nothing for the first 60 seconds of _process_ life, by which point the
  hook has written in either order. (The process's start, not the ladder object's — the ladder is
  constructed lazily on the first heartbeat, minutes in.)
- **Never adopt a corpse.** After settling, adopt the capture on disk only if it still looks alive:
  no `ended_at`, transcript not already stale. A dead capture belongs to somebody else, or to a
  workspace whose hooks never ran; either way it is not evidence about us, so keep failing open and
  look again next tick. Without this, an adapter in a hookless workspace would adopt a corpse and
  promptly execute itself.

### A different session id is not a takeover

An earlier draft read a changed `session.id` as a **successor** — a new session had claimed the
workspace, so this adapter must be a reload orphan, and it exited. Checking the real fleet before
trusting that killed it:

- `agents-miley`'s binding recorded session `c2c6c365`, lifetime **2 seconds**, `ended_at` set, and
  a `transcript_path` naming a file that was never written.
- Meanwhile that workspace's actual session — `40930804`, whose first transcript entry lands in the
  same second its adapter started, the previous evening — was alive and had been appended to
  fifteen minutes earlier.

A foreign, short-lived capture can therefore sit in the binding while the real session works. Under
the successor rule, that adapter would have exited and taken a live session's tools with it. So a
changed id now means **re-adopt** (and a changed id that is already dead is ignored outright — we
keep the session we had). The genuine reload-orphan case is not lost: ADR 092's `same_workspace`
takeover already catches it server-side, where the daemon knows things this file cannot.

The lesson generalises past this rung, and is why only rung 2 still exits: the binding is a hint
about sessions, not a registry of them.

Before adoption, only rungs 1 and 2 apply — an un-adopted adapter never demotes itself on evidence
about somebody else's session.

### Increments

1. **The ladder** — `SessionAttestation` (a pure judgement over an injected binding read, `stat`, and
   `ppid`) wired into the existing heartbeat tick, with `orphan → exit` and `stale → dormant`.
   Adapter-only; no server change, no wire change.
2. **The audit row** — `presence.session_ended`, which needs a client→server path that does not
   exist today. Deferred deliberately: increment 1 removes the lie, and until it has run in the
   field there is nothing to count. Until then the release is visible on stderr and, indirectly, as
   the seat going offline.

### What this does not do

It does not reap orphaned processes as a class, does not change how the daemon computes presence,
and does not give the daemon a filesystem dependency. It removes the _lie_; a rung-4 dormant adapter
may still linger as a process, harmless and holding nothing.

## Observability & Evaluation

**Traces.** A new audit row `presence.session_ended` on the seat, with `detail: { rung, age_ms,
session_id }` — written when the adapter releases or exits under rungs 2–4 (rung 1 is the existing
clean path). The rung is the point: it tells us which signal is actually load-bearing in the field.
Until increment 2 lands that row, the only trace is the adapter's stderr line and the seat going
offline — enough to confirm the ladder fires, not enough to count rungs.

**Eval — dataset and baseline.** The dataset is every `presence.session_ended` row over a dogfood
week, joined to the presence rows for the same seats. The **baseline** is the pre-fix measurement,
n=1 and stark: one seat, 12h36m falsely `working`, one misrouted `lane_handoff`. Three questions,
each answerable from that dataset:

1. _Does the ladder fire at all, and on which rung?_ Count rows by `rung` over a dogfood week. If
   rung 4 dominates, `ended_at` is unreliable in practice and rung 3 is decoration. If rung 2
   dominates, re-parenting is the real orphan signature and the horizon barely matters.
2. _False-positive rate on rung 4._ A rung-4 release followed by a re-occupy from the **same
   session id** is by definition a false positive — the session was alive. Target: **< 1 per seat
   per week**. Above that, raise `SESSION_STALE_MS`.
3. _Residual lie._ The direct measure: for each seat reading `live`, the age of its transcript.
   Any seat live with an age > `SESSION_STALE_MS` is a surviving lie. Target: **zero**.

**Guardrail.** No seat may lose presence while its transcript is being written. Regression test:
a seat whose transcript is touched every tick never leaves through rungs 2–4.

**Verified live, 2026-07-27.** Not simulated in tests — a real MCP adapter (`packages/mcp/dist`)
driven over stdio against an isolated daemon on a copy of the real database, with **stdin held open
throughout** so the pre-existing teardown could not be what fired:

| staged death             | required outcome                      | observed                                         |
| ------------------------ | ------------------------------------- | ------------------------------------------------ |
| transcript goes quiet    | release presence, **keep running**    | released, adapter still running                  |
| `SessionEnd` for our own | release presence, **keep running**    | released, adapter still running                  |
| foreign capture appears  | **stay online** — re-adopt, not fatal | stayed online through the full watch, re-adopted |

Each run first held presence through 75 seconds of live heartbeats, so a release is attributable to
the staged death and not to drift, and the foreign-capture run had to survive an equally long watch
afterwards. `ppid` is covered by unit test only — staging a re-parent means orphaning the process
the probe still needs to observe.

Three probe rounds, three different answers, two of them failures that changed the design: the first
found the ladder inert, the second found a "definitive" rung that would have killed a live session.
The table above is the third.

**Experiment.** None is warranted, and that is a deliberate call rather than an omission: there is
no arm to compare against. The control condition — presence attested by a process — is the measured
defect, and running it deliberately means knowingly telling teammates a dead seat is working. The
one tunable worth an experiment is `SESSION_STALE_MS`, and it is better fitted from the
false-positive rate in question 2 than from a split-arm trial. Revisit only if question 1 shows
rung 4 carrying the load, which would make the horizon a live parameter rather than a backstop.

## Consequences

- The roster can say a seat is offline that a human believes is open on their screen — if that
  session has written nothing for an hour. This is the intended trade: honest absence over false
  presence. The seat returns on its next action.
- `unblocker_reachable` (ADR 153) and the wake path get a liveness signal that means what they
  assume it means. Some asks that would have held for a phantom will now correctly strand or wake.
- Wake costs may rise slightly: a seat that reads offline is a wake candidate where a phantom-live
  seat was not. That is the correct bill for a decision that was previously made on false data.
- The adapter gains a filesystem read on a path it already reads, and a `stat`. No wire change, no
  schema change, no server change beyond the audit row.
- Orphaned MCP processes remain possible; they simply stop being able to misrepresent a seat.

## Related

- [ADR 057](057-ambient-agent-presence.md) — ambient presence from real actions. An open socket is not an
  action; treating it as one is the original defect this ADR names.
- [ADR 010](010-single-active-grace.md) — the two clocks. Untouched: this fixes the liveness clock's input.
- [ADR 131](131-harness-residency-wake-ledger-host.md) §5 — `binding.session`, and `localSessionLiveness`, reused.
- [ADR 155](155-human-presence-ladder.md) — the human-only idle decay, deliberately not extended.
- [ADR 108](108-probe-safe-autojoin.md) — autojoin on first tool call: what makes dormancy cheap.
- [ADR 153](153-ask-reachability-gated-hold.md) — a consumer that was being fed a phantom.
