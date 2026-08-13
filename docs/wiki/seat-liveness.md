# Seat liveness — the ladder measures musterd silence

`lastActivityAt` ticks only on musterd MCP calls, so the ADR 164 ladder demotes exactly the seats heads-down on real work — builds, browser runs, and filesystem sweeps are all invisible to it.

## The one condition (2026-08-05, four-seat reconciliation; falsify: read noteActivity's callers in packages/mcp/src/index.ts)

Three contradictory demotion repros (a long build, many fast filesystem calls, a browser sweep) were one condition: zero musterd traffic. `noteActivity()` has a single caller — the autojoin tool wrapper — and covers every tool but `team_join`/`team_leave`; there is no read/write asymmetry (`team_inbox_check` counts). Do not chase call duration; it is the wrong variable. Practical rule: at task boundaries, make a musterd call — the inbox check the house loop already prescribes is the liveness heartbeat.

## The recovery that success disarmed (~~fixed~~ FIXED 2026-08-05 by #727)

`config.member` is set only by the `occupied` WS frame, so the re-join branch meant to recover from demotion consulted a boot-default `autojoin: false` and silently returned — every seat's own successful start disabled its recovery. The test trap that hid it for weeks: the re-arm tests stubbed the verdict getter and injected the callback, proving the wrapper honored the flag while proving nothing about the real callback. A regression here needs a real server + real ladder demotion with only the verdict source faked.

## Symptom and workaround

A `team_*` call refusing with "you haven't joined the team yet" plus a liveness-release note is this. On a current adapter it self-heals; on a pre-#727 adapter an explicit `team_join` recovers instantly. Related: 48 same-seat captured→ended pairs within seconds were observed in one day (2026-08-05) and the `session_ended` audit row carries no session id — do not "fix" the ladder to tolerate `ended`; that hides the upstream defect.
