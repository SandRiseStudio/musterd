# Seat liveness — the ladder measures musterd silence

`lastActivityAt` ticks only on musterd MCP calls, so the ADR 164 ladder demotes exactly the seats heads-down on real work — builds, browser runs, and filesystem sweeps are all invisible to it.

## The one condition (2026-08-05, four-seat reconciliation; falsify: read noteActivity's callers in packages/mcp/src/index.ts) <!-- claim: other -->

Three contradictory demotion repros (a long build, many fast filesystem calls, a browser sweep) were one condition: zero musterd traffic. `noteActivity()` has a single caller — the autojoin tool wrapper — and covers every tool but `team_join`/`team_leave`; there is no read/write asymmetry (`team_inbox_check` counts). Do not chase call duration; it is the wrong variable. Practical rule: at task boundaries, make a musterd call — the inbox check the house loop already prescribes is the liveness heartbeat.

## The recovery that success disarmed (~~fixed~~ FIXED 2026-08-05 by #727)

`config.member` is set only by the `occupied` WS frame, so the re-join branch meant to recover from demotion consulted a boot-default `autojoin: false` and silently returned — every seat's own successful start disabled its recovery. The test trap that hid it for weeks: the re-arm tests stubbed the verdict getter and injected the callback, proving the wrapper honored the flag while proving nothing about the real callback. A regression here needs a real server + real ladder demotion with only the verdict source faked.

## Symptom and workaround

A `team_*` call refusing with "you haven't joined the team yet" plus a liveness-release note is this. On a current adapter it self-heals; on a pre-#727 adapter an explicit `team_join` recovers instantly. Related: 48 same-seat captured→ended pairs within seconds were observed in one day (2026-08-05) and the `session_ended` audit row carries no session id — do not "fix" the ladder to tolerate `ended`; that hides the upstream defect.

## A stale transcript the adapter is visibly newer than is not its own (FIXED 2026-09-15 by lane 01M2KCG5Z8)

The ladder adopts one session id and then judges that id forever. Nothing re-checks whether the harness has moved on, because the ADR 164 re-adoption guard only fires when the id in the binding *changes* — and the failure mode is that it does not. Seat `izzo` ran for two hours with `binding.session` naming a session whose transcript stopped at 19:06Z while the harness drove the adapter from a different one that was writing continuously. The adopted capture had been adopted legitimately, alive, hours earlier; it crossed `SESSION_STALE_MS` at 20:06Z and rung 4 began returning `stale` every 15 seconds.

Activity-outranks-inference could not save it, and the reason is a horizon mismatch worth remembering on its own: the guard asked only whether a musterd call landed within `HEARTBEAT_MS` (15s), while the evidence it was overruling had a one-hour horizon. A live session is idle far longer than fifteen seconds. So the seat was released on nearly every heartbeat, its Presence reaped at `PRESENCE_TIMEOUT_MS`, and re-minted by the next tool call: 17 mints and 11 reaps in half an hour against 3–6 mints for every other seat on the same daemon (2026-09-15; falsify: a seat whose audit shows `agent_session_lease.minted` per tool call and no `renewed` rows, with its binding naming a session other than the live one). <!-- claim: defect -->

The visible consequence is that the interrupt line is refused the whole time, and the hook's prescription cannot work: `team_join` mints another Presence that dies by the same rule 45 seconds later. **A repeating "your session lease is dead" line that survives a successful `team_join` is this, not a lease-persistence bug** — check `binding.session.id` against the live session before reaching for [wake leases](wake-leases.md).

The repair is the contradiction itself: being *driven* more recently than the judged transcript was *written* means the binding names somebody else's session, so the rung is not evidence about us and the ladder's standing fail-open rule applies. A genuinely dormant harness is untouched, because the tool call that would contradict the transcript is exactly what stops arriving — activity and transcript go quiet together.

Not fixed, and still open: **why** the session record went stale. `claimAndJoin`'s persist composes a binding with no `session` key, so a stale record survives every rewrite while the lease and attested model beside it are updated — the record only moves when the `SessionStart` hook writes it. Whether the hook lost a race or never ran for the second session is unmeasured (2026-09-15). Related: [seat identity](seat-identity.md).
