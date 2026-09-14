# Silence is only evidence when someone was listening

A timeout measured across a window in which nothing was running condemns everybody at once — musterd has now made this mistake twice, in two different clocks, and fixed it twice the same way.

## The shape

A loop watches for heartbeats and reaps whatever has not spoken for `timeoutMs`. The loop stops — a
restart, a suspended laptop, a blocked event loop. When it resumes it compares `last_seen_at` against
wall-clock `now - timeoutMs` and finds that *nothing* spoke during the gap. Which is true, and means
nothing: no listener was there to hear it. The sweep then executes at full width on its first tick.

The fix is the same both times: the loop keeps its own continuity clock and refuses to judge until it
has been continuously running for at least the window it is about to judge by.

## Instance 1 — the wake ledger (ADR 236)

An expired wake lease means one of two opposite things: the host tried and failed, or the host was
never there. `startReaper` tracks `continuousSince` and treats a tick gap ≥ `HOST_SUSPEND_GAP_MS`
(90 s) as a break in its own run; a lease outstanding across that break is `wake_deferred`, not
`wake_failed`, so it burns no attempt budget. Threshold chosen from measured overnight gaps
(12–16 min) against a 0.2–0.3 min daytime cluster.

## Instance 2 — presence, and the session leases hanging off it

The same loop, on the same tick, reaped presence by the naked heartbeat cutoff — with no continuity
clock at all. So a daemon bounce deleted every local presence row on the first tick after boot.

The part that made it expensive rather than cosmetic: **a session lease is only valid while its
presence row exists**. `hasValidSessionLease` joins `presence p ON p.id = l.presence_id`, so deleting
the row invalidates the lease with no `revoked_at`, no `claim.superseded`, and no audit row naming
the cause. The seat is told only `invalid, expired, or revoked agent session lease`, so it cannot tell a bounce from a rival's displacement (2026-09-02; falsify: the `sqlite3` query below).
Three seats misdiagnosed exactly that on 2026-09-02, one of them spending a lane on the wrong
candidate before withdrawing it.

Observed 2026-09-02: seats reported their MCP lease dead immediately after a daemon bounce, with no
supersede row anywhere in `audit`. Falsify: bounce the daemon under a live adapter, then
`sqlite3 -readonly ~/.musterd/musterd.db "select action, count(*) from audit where target='<seat>'
and ts > <bounce_ms> group by action"` — before the fix, a `presence.detached` with
`reason:"reaped"` and no `claim.superseded`; after it, neither, because the row survives long enough
for the adapter's reconnect (backoff caps at 30 s) to re-hello.

Fixed 2026-09-02 by lane `01M1HNY302`: `reapStale(db, timeoutMs, watchedSince)` returns `[]` while
`now - watchedSince < timeoutMs`, and the reaper feeds it a presence-scoped continuity clock that
resets on any tick gap ≥ `presenceTimeoutMs`. Presence gets its own clock rather than reusing
`continuousSince` because the two ask different questions at different scales: the wake ledger asks
"was the *host* there?" (90 s, to separate a suspend from jitter), presence asks "were *we* there to
hear a 45 s heartbeat?" — and the reaper shares an event loop with the sockets it judges, so a gap as
long as the timeout already proves nothing could have been heard.

## Instance 3 — the same clock, defeated from inside one tick (2026-09-14)

The guard above measured from the tick's *start*; the cutoff measured from wherever the tick had got
to. `reapStale` read its own `Date.now()`. So a tick that itself blocks longer than the timeout —
which is exactly what a daemon does in the minutes after a 3.6-day host resume, when the guardian
was sampling it `wedged` — passes the guard on the way out and sweeps every row on the way through,
including live sockets whose heartbeats are sitting unread in the buffer until that same tick
returns. Measured 15:57:46Z (lane `01M2GBPX2S`): one tick of ~104 s, `reap_host_suspended` logged
13 s in, `reap_offline` for ghost, wanderer and dolly 51 s in, the next tick's gap 104 s. The three
adapters had open sockets the whole time.

Fixed the same day: the reaper passes its tick's `now` into `reapStale(db, timeoutMs, watchedSince,
now)` so the guard and the cutoff run on one clock — no heartbeat can be heard inside a tick, so no
row can go quiet inside one. And the zombie the reap leaves behind is now told: a heartbeat whose
Presence row is gone logs `ws_heartbeat_reaped` and closes the socket with `4410`, so the adapter's
reconnect re-claims and #1369's `occupied` path writes the fresh lease where the hook reads it. Before
that, ghost's socket stayed open, subscribed and deaf for 19 minutes — 33 `interrupt_probe_refused`
rows — until it happened to drop. Falsify: a `reap_offline` row whose member has a `ws_close` *after*
it with no `ws_heartbeat_reaped` between, on a daemon carrying this fix.

The rule generalises the page's: a loop that refuses to judge until it has listened for a window must
also refuse to judge *while it is not listening* — and a tick is not listening.

## The cost you accept

A genuinely dead session survives up to one extra window (45 s by default) after a restart or a
stall, so the roster can name a seat that is already gone. That is the right trade: an over-eager
reap destroys authority a live session cannot get back without a reconnect, while a late reap only
delays a label. Note it is *not* unbounded — the delay is one window, once, per discontinuity.

## Where to look next

If a third clock in this codebase reaps on a wall-clock cutoff without asking whether its own loop
was running, it has this bug. The test for it: does the sweep behave differently on the first tick
after boot than on the thousandth? If not, it is not asking.

Related: [wake leases](wake-leases.md).
