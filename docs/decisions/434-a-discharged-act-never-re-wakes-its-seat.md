# ADR 434: a discharged act never re-wakes its seat

- Status: proposed
- Date: 2026-09-21
- Lane: 01M32V416B72KBFXWJEQZWKB1N (goal `seat-continuity`, stakes high)
- Relates to: [ADR 131](131-harness-residency-wake-ledger-host.md) (the wake ledger),
  [ADR 429](429-inbox-pinning-is-an-obligation-rule-not-a-salience-one.md) (the pinned set is the
  obligation class, discharge folded in SQL), [ADR 254](254-eligible-sets.md) (first answer
  discharges the set), [ADR 025](025-resolve-act-thread-close.md) (`resolve` is thread-terminal),
  the doorbell contract clause 7 (`docs/design/daemon-doorbell-contract.md`)

## Context

The daemon wakes a sleeping seat for an act it is owed and has not answered. "Answered" was
spelled four times, by four readers, and they disagreed:

| reader                                | knew accept/decline | knew resolve | knew recipient `in_reply_to`, any act | knew recipient in-thread turn |
| ------------------------------------- | ------------------- | ------------ | ------------------------------------- | ----------------------------- |
| pinned set, `listInbox` (ADR 429)     | yes                 | yes          | yes                                   | no                            |
| open-loops gauge, `countOpenLoops`    | yes                 | yes          | no                                    | no                            |
| open directed ledger → batched lane   | yes                 | yes          | no                                    | no                            |
| `answerBy` → `recipients[].answered`  | yes                 | —            | no                                    | no                            |
| `pendingInterrupts` → immediate lane  | yes                 | yes          | yes (7(iv))                           | no                            |

Measured on the laptop daemon 2026-09-21, the day seat policy caps were raised to 6/h·5m for the
continuity-packet measurement (lane 01M32R6ATC):

- **ryder, immediate lane.** stanley opened thread 01M32R6T8Y and steered her inside it
  (01M32R78FE, 12:48:53). Leased 13:21:31; she resumed, replied _in the thread_ at 13:21:44 — a plain
  `message`, no `in_reply_to`, because the thread is the reply. Leased for the same steer again at
  13:37:25, the moment her window reopened. She reported it herself: "second sender/act to show this
  (ghost's 01M2TXS55H did it on 09-20) — so it is the wake edge, not one bad act."
- **gptbot, batched lane.** izzo's urgent steer 01M1T4GV18 (2026-09-05). Leased 13:18:36; gptbot
  resumed and replied "standing down" as a `message` carrying `in_reply_to` at 13:19:04. Leased again
  13:37:25 and 13:42:54; replied again at 13:43:14; declared `wake_exhausted` at 13:50:20. Three paid
  wakes to be told the same thing three times, entirely within policy.
- **gptbot, enrollment replay.** Enrolled 12:47:04, fresh, after a 2026-09-05 revoke. Its July–
  September obligations landed on the batched lane oldest-first and the daemon drained them one wake
  per window, ahead of anything current. 412 leases on that seat, lifetime.

## Problem

1. **Discharge has no single home.** Each reader approximates "answered" with the shapes it
   happened to be written knowing. The immediate lane learned the recipient's `in_reply_to` reply
   at clause 7(iv); the batched lane never did. Neither learned the in-thread turn, which is the
   ordinary way a seat answers inside a dialogue and the shape ADR 210's resume-into-thread design
   actively encourages.
2. **The wake edge does not consult its own ledger.** `residency.woke` records that a wake ran for
   an act. Nothing reads it back before leasing the same act again — only the attempt cap does,
   and it counts a _completed_ wake the same as a failed spawn, so a seat that ran and answered in
   a shape the predicate misses is re-woken until the cap declares the act exhausted.
3. **An enrollment inherits the seat's whole past.** Fresh enrollment puts every undischarged act
   the seat was ever owed on the lane. For a seat dormant for months that is a paid replay of
   history, oldest first, and nothing tells the operator it will happen.

Every raised cap turns these into repeated $0.66–1.71 wakes on spent acts. ryder's 1/h cap was
hiding it.

## Decision

1. **One discharge predicate, as SQL, named once.** `packages/server/src/store/discharge.ts`
   defines the four shapes that discharge an act `a` for recipient `r`: any seat's `accept`/`decline`
   with `in_reply_to = a.id`; a `resolve` on `COALESCE(a.thread_id, a.id)`; `r`'s own act, whatever
   it is, with `in_reply_to = a.id`; `r`'s own act, whatever it is, in `a`'s thread and newer than
   `a` in receipt order. The pinned set, `countOpenLoops` / `countOpenLoopsByTeam`, `openDirectedLedger`
   and `answerBy` are built from it — for a `@team` act (`to_member` NULL) the recipient shapes are
   simply never true, so ADR 254's any-one-answers rule is unchanged. `pendingInterrupts` is pure
   over envelopes and cannot take SQL; it gains the fourth shape as a fold (`myLatestOnThread`), and
   `listInterruptCandidates` fetches the seat's own turns on the threads of the steers in the window
   so the fold can see them.

2. **A completed wake spends the act.** In `claimWakeLeases`, an inbox candidate (edge-less) whose
   act already has a `residency.woke` row for this seat is skipped, unless an act from someone other
   than the seat has been added to its thread — or named it by `in_reply_to` — since that wake. A
   `wake_failed` does not spend the act; the attempt cap still governs spawns that never ran. The
   skip is silent, like the still-true skip: a spent act is the resting state of an answered inbox.

3. **A fresh enrollment stamps a wake horizon.** The newest `residency.enrolled` audit row for the
   seat with no `previous_host` — a first enrollment or one after a revoke — is the horizon; an act
   received before it never wakes the seat. A re-enrollment (policy tweak, host swap) carries
   `previous_host` and does not move it. The enroll response gains `predating_backlog`: how many
   directed obligations the seat was still owed at that moment, and `musterd residency on` prints
   one warning line naming it, so the operator re-sends what still matters. **The trade:** "send
   the handoff, then enroll the seat" now needs the handoff re-sent, and the line says so. An
   enrollment means _from now_.

4. **Work orders are untouched.** An edge-bearing candidate (review, dispatch) is a lane fact and is
   bounded by ADR 262/306's own rules; none of the above applies to it.

**Not decided here.** Whether `residency.woke` should be readable as a seat-facing "this already
woke you" in `team_wake_context`; the `inbox.rendered` discharge (7(iv)) is unchanged and stays a
separate shape because it is not a reply.

## Consequences

- The four readers now agree, and there is one place to add a fifth shape. `discharge.test.ts` pins
  each reader on both measured shapes and on the two things that must NOT discharge — a third
  party's turn, and one seat's chatter on a `@team` request.
- On this daemon's ledger the two measured cases become: ryder woken once for 01M32R78FE and not
  again (her 13:21:44 turn is newer than the steer in its thread); gptbot woken once for 01M1T4GV18
  (his 13:19:04 `in_reply_to` message discharges it on the ledger) — and never three times, since
  the 13:18 `woke` row would have spent it regardless.
- A seat that ran a wake and answered in _no_ shape at all (crashed mid-reply, watchdog) is also
  not re-woken for that act — the sender's nudge in the thread is what re-arms it. That is
  deliberate: the alternative is the burn the lane measured.
- **(e), owed after merge:** a real seat woken once on an answered act and not again after its
  window reopens — recorded dated on `docs/wiki/which-acts-wake-a-seat.md`.
- Falsifier: a second `residency.wake_leased` for the same `act` and `target`, with a
  `residency.woke` between them and no act from another seat on that thread in between; or an
  `openDirectedLedger` row whose `to_member` has a newer turn in its thread.

## Observability & Evaluation

- **Traces:** none added. The evidence is already in the ledger: `residency.wake_leased` /
  `residency.woke` / `residency.wake_exhausted` audit rows keyed on `detail.act`, and the enroll
  row's `previous_host` now doubles as the horizon marker. `predating_backlog` rides the enroll
  response and its CLI line.
- **Eval:** the dataset is `~/.musterd/musterd.db`'s `wake_leases` and `audit`. Measure: leases per
  (act, seat) for inbox wakes after the merge SHA reaches the daemon. **Baseline 2026-09-21:**
  01M32R78FE→ryder 2, 01M1T4GV18→gptbot 3 (+1 exhausted), 01M32R9M8M→gptbot 3. **Bar:** ≤ 1 per
  (act, seat) unless a third-party act on the thread sits between two leases.
- **Experiment:** whether a seat _notices_ it was spent — a woken seat that answers, then is not
  woken, and the sender knows to nudge — is the dogfood run 5 question (lane 01M2H2P1XX), not this
  lane's.
