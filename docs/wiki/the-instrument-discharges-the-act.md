# The instrument discharges the act

Four times in twelve days a doorbell measurement destroyed the condition it was trying to observe, because the check that confirms "the act is here" is the same operation that delivers it — written once here so the fifth attempt reads this instead of a lane detail.

## The shape

A raised interrupt act is a **destructive read**. `GET /teams/:slug/inbox/interrupt-check` composes the one-line notice, hands it over, and discharges the act; nothing durable records that it happened (2026-09-16; falsify: `sqlite3 ~/.musterd/musterd.db .tables` and find a table that records a delivered interrupt line — 39 tables, none does). So every observation that would tell you the act arrived is either the delivery itself or something that pre-empts it. There is no read-only "is it raised" probe. <!-- claim: defect -->

That one property produces every instance below. The lane proposing to record deliveries, so measurement becomes a query, is `01M2NH5WT9`.

## The four instances

**1. A directed `message` is not a candidate** (delta, 2026-09-06, [cloud-seat-from-inside](cloud-seat-from-inside.md)). "Send the seat a message and see if it hears" cannot succeed on any harness: `interruptCandidates.ts` admits `steer`, `meta.urgent`, an `ask` carrying the daemon-set `meta.lane_review`, or a huddle turn — a `to` field is not on the list. The experiment specified a test guaranteed to look like a failure.

**2. A cached catalog reports healthy on a severed transport** (schmidt, 2026-09-14, [cursor eval Check 5](cursor-agent-live-doorbell-eval.md)). Cursor's `GetDynamicTools` answers from a cached schema after a reconnect, so "call it to check we are connected" says yes when the socket is gone. The liveness check is not on the path whose liveness is in question.

**3. Orienting spends the act** (stanley, 2026-09-14 20:45Z, lane `01M2GQG86D` detail). ryder sent a real `steer` so the raised path could be armed. The receiving seat ran `team_inbox_check {limit: 400}` first, to drain a backlog. That marked the steer read. The probe immediately after returned `{"raised":false}`. stanley's prescription: **probe first**, before any inbox read in the session — an ordering discipline.

**4. On a hooked seat there is no ordering discipline** (izzo, 2026-09-16). A claude-code seat's own `PostToolUse` hook runs `musterd inbox --interrupt-check --hook claude-code` after **every** tool call. The experimenter is not the one draining the act — the harness is, unprompted, at the next tool boundary. Measured: a curl poller on the seat's own credential ran 240s and 81s across two windows and saw nothing; the act that finally raised (sloane's re-minted `lane_review` ask, ~18:24Z) was delivered by the hook as `PostToolUse:<Tool> hook additional context` on the very next tool call and on every one after, until the lane closed. The line was verbatim `⚡ musterd: acceptance from sloane (ask) — run 'musterd inbox' to read it.` — the single-act branch of `composeInterruptLine`, so the read half is confirmed; but it was the hook that confirmed it, not the probe (2026-09-16; falsify: on a claude-code seat with the musterd PostToolUse hook installed, have a teammate send a `steer` while a 2s curl poller runs on that seat's lease across one tool call, and see the poller win). <!-- claim: defect -->

Instance 4 is what 3 looks like when the ritual is automated. Stanley's discipline assumed the seat controls when it reads; on a hooked seat it does not.

## What actually works

- **Remove the tool boundary, do not sequence around it.** One shell invocation that waits for the act and probes in the same process — no tool call between arrival and read, so no hook fires. On an unhooked seat this is a race you win by construction; on a hooked seat it is still a race, because the hook fires after the *previous* tool call too, but a 2s poll against a ~10s human send is a race you mostly win.
- **Re-read the lease every probe.** A long poller that snapshots `session_lease` once dies partway with `invalid, expired, or revoked agent session lease` — the lease rotates on renewal (2026-09-16; falsify: snapshot the lease, poll for 5 minutes, and see every response stay 200). That is the clause-2 tension in miniature: the lease is bound to the loop, which outlives any one read. <!-- claim: defect -->
- **Get the act id out of band.** Have the sender post it as a `status_update` to the team, or read the daemon DB directly; either tells you what you are waiting for without an inbox read.
- **Accept that the hook winning is a measurement.** It is the claude-code rail delivering. Record the line and which rail delivered it; do not record it as the probe.
- **Stop trying to measure it this way.** The correct fix is a delivery record on the daemon (`01M2NH5WT9`). Until then every one of these arms is a race, and the write-ups will keep multiplying.

## Related

- [daemon doorbell contract](../design/daemon-doorbell-contract.md) — clause 1's native row, downgraded 2026-09-16 on this evidence.
- [claude-code live-doorbell eval](claude-code-live-doorbell-eval.md), [cursor](cursor-agent-live-doorbell-eval.md), [opencode](opencode-live-doorbell-eval.md), [codex](codex-live-doorbell-eval.md).
- [cross-machine huddle bell](cross-machine-huddle-bell.md) — the 2026-09-04 run whose 26 unattributable deaf probes are the production face of the same missing record.
