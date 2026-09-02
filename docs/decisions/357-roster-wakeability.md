# 357 — The roster says whether a seat can be woken, not whether it was enrolled

- Status: proposed — 2026-09-02
- Date: 2026-09-02
- Authored by dolly on lane `01M1J1KC6HQBB9JCC7D834WS4S`; found answering nick's "is
  wakeable/resumable still up to date?" the same afternoon ADR 354 showed what a silent wake path
  costs.
- Builds on: [ADR 131](131-harness-residency-wake-ledger-host.md) (residency and the host
  actuator), [ADR 189](189-wakeability.md) (the five-state `Wakeability` and
  `wakeabilityFromFacts`), [ADR 191](191-wake-an-offline-reviewer.md) (the offline-acceptor pick
  that spends a lease on a "wakeable" seat), [ADR 219](219-quiescence.md) (`enrolled_seat_busy`),
  [ADR 236](236-sleeping-host-defers.md) (absence is not an assertion), [ADR 262](262-work-order-respend-breaker.md)
  (the still-true failure set).

## Context

The roster's `wakeable` has been `residency.has(member)` since ADR 131 — a row exists, so the seat
reads `offline · wakeable`. That is enrolment, labelled as reachability. ADR 189 gave the system a
five-state answer to "can a directed act reach this seat" and a pure function to derive it,
`wakeabilityFromFacts({ enrolled, workspace_readable, host_reachable, seat_quiet })`. Measured on
2026-09-02, that function has only ever been called with two of its four facts: `enrolled` and
(since ADR 219) `seat_quiet`. Nothing supplied `host_reachable` or `workspace_readable`, so
`enrolled_host_stale` and `enrolled_dead_workspace` could appear in exactly one place — on the wake
REPORT the host posts after the wake has already failed — and nowhere a human or the picker reads
before spending a lease.

The host had been telling the daemon it was alive the whole time. `musterd host` polls
`POST /teams/:slug/residency/wake-leases` every 10 s, naming its host label; the daemon claimed
leases against it and wrote nothing down. There was no host liveness signal in the database at all.

Why it matters: ADR 191 routes an acceptance to "a marked-wakeable offline seat" when nobody live is
eligible. With the boolean, a seat whose actuator LaunchAgent is dead or whose workspace was deleted
is picked, the ask waits on a wake that fails, and the failure is visible only in `host.log` — the
same invisibility shape ADR 354 fixed for codex, one layer up. The chip on `/live` could not be
falsified from the roster: every enrolled seat read the same word.

## Decision

1. **The poll is the heartbeat.** `POST /residency/wake-leases` records `(team, host, seen_at)` in a
   new `host_liveness` table (migration v60), newest sighting wins, before the lease claim — a host
   that polls and gets nothing still counts as alive. No new wire, no host change: every actuator
   built since ADR 131 heartbeats from the moment this daemon runs.

2. **The two missing facts are derived server-side, once, for roster and picker alike.**
   `seatWakeabilityFacts` (store/residency.ts) yields per enrolled member:
   - `host_reachable`: `true` if the seat's host was heard from within `HOST_STALE_MS`; `false` if
     it was heard from and then went silent; **`undefined` if this daemon has never heard from it.**
     ~~60 s — six missed 10 s polls~~ CORRECTED 2026-09-02 by the first live falsifier, run 20
     minutes after this landed: the actuator polls every 10 s only while *idle*. `pollHostOnce` is
     serial, so an actuation suspends polling for its whole verify window — the first codex wake
     after #1197 went 94 s between requests (15:50:02 → 15:51:36) while behaving correctly, and at
     60 s every enrolled seat read `enrolled_host_stale` during a healthy wake. Now **five minutes**,
     above the longest silence a serial actuation can produce, and every host-authenticated
     residency request (poll, progress, turn, report) stamps the sighting, not only the poll.
     Unknown never
     demotes (ADR 236): a fresh install, an older host build, or a registry entry nobody has polled
     yet reads exactly as it did before this table existed. The first draft made never-seen read
     stale; it turned five existing wake-pool tests red, which is what those tests were for.
   - `workspace_readable`: `false` only when the newest `residency.wake_failed` for the seat carries
     a still-true wakeability (`enrolled_dead_workspace`, the ADR 262 set) and no `residency.woke`
     has landed since. The daemon cannot stat a path on the host's filesystem; it can read what the
     host last reported and whether anything newer contradicts it.

3. **The roster carries `wakeability` beside `wakeable`.** `MemberSummary.wakeability` is the ADR
   189 enum, optional and additive; `wakeable` keeps meaning "enrolled" for every consumer that
   reads it today. `teamFamilyPosture`'s wake pool — the ADR 191 pick's input — uses the same facts,
   so the roster and the picker cannot disagree.

4. **`/live` renders the reason.** `offline · wakeable` stays; `enrolled · host quiet`,
   `enrolled · workspace gone`, `enrolled · busy` are the new honest reads. An older daemon omits the
   field and the chip reads exactly as before.

Rejected: a dedicated heartbeat endpoint (the poll already is one; a second route is a second thing
to keep alive); a TTL on residency rows (ADR 131's explicit-revocation policy stands — enrolment and
reachability are different facts and this ADR keeps them separate); having the daemon stat
workspaces (it cannot see the host's filesystem, and pretending to is how ADR 189's report rung got
its `enrolled_dead_workspace` in the first place).

## Consequences

- A dead actuator shows on the roster within five minutes as `host quiet` on every seat it serves,
  and ADR 191 stops routing to those seats until it is back. A busy one never reads quiet: its
  progress and report requests are sightings too.
- `host_liveness` is one row per (team, host), rewritten every 10 s per host. Not replicated (ADR
  331): a host's liveness is a fact about THIS daemon's reachability.
- `resumable_at` is untouched by this ADR. For the codex seat it is 19 days stale on the wrong
  harness because codex hooks never fire — lane `01M1J1M141` (ryder), not this one. This ADR must
  not paper over it.
- Named, not done: `enrolled_seat_busy` on the roster reuses the ADR 219 quiescence read the roster
  already computes; it says nothing new, it says it in the same place as the other three.

## Observability & Evaluation

- **Traces.** `host_liveness.seen_at` per host; `GET /teams/:slug/members` rows carry
  `wakeability`; `lane.ready_for_review` routing to an offline seat only when its wakeability is
  `wakeable`.
- **Eval.** Direct assertions (`residency.wakeability.test.ts`): sightings record newest-wins and
  never move backwards; inside `HOST_STALE_MS` ⇒ reachable, past it ⇒ not, never seen ⇒ undefined;
  a still-true failure makes the workspace unreadable until a later `woke`; any other failure does
  not; the wake pool reads `enrolled_host_stale` / `enrolled_dead_workspace` / `wakeable` from the
  same facts, and a never-seen host stays `wakeable`. Integration: a wake-leases poll flips a seat's
  roster `wakeability` from `enrolled_host_stale`-after-silence to `wakeable`.
- **Experiment.** Pre-registered: `launchctl unload` the host LaunchAgent; within `HOST_STALE_MS`
  + one poll every seat in `host-registry.json` reads `enrolled_host_stale` on `/live` and no
  acceptance is routed to them; `launchctl load` it; within one poll they read `wakeable`. Falsify:
  a seat reads `wakeable` past that line after its host's last request, or an acceptance lands on a
  seat reading anything but `wakeable`. **Run once, 2026-09-02 15:51 on `68ddf6ad`** — the reload
  half held (first poll 15:53:18 → `wakeable`/`enrolled_seat_busy` within 10 s), the unload half was
  pre-empted: every seat already read stale at the baseline because a healthy 94 s actuation had
  exceeded the 60 s line. That is the correction above. Re-run owed on the corrected line.
- **What it must also not do.** Read a busy host as quiet. Falsify: `enrolled_host_stale` on any
  seat while `wake_leases` holds an unsettled lease for its host younger than `HOST_STALE_MS`.
- **What it must not move.** `wakeable` (the boolean) for any seat, and the wake pool's membership
  (mark, never filter — ADR 189). Falsify: any existing `review.test.ts` assertion on pool
  membership changes.
