# Seat continuity — a seat picks up where it left off, on any harness

> **Why this document exists, beyond the plan.** Multi-increment plans on this team die the same
> way: a lane opens for increment 1, increment 1 lands, and increments 2–N are never opened
> because the seat that held the plan was pulled onto an ask or a bug found on the way. This
> document is written so the plan does not live in one seat's head: **every increment below has a
> lane on the board today**, opened at the same time as the first, chained by `depends_on` so
> `team_next` surfaces the next one under the goal when its predecessor closes, and a dated watch
> (`docs/watches/2026-09-21-seat-continuity-increments-advance.md`) asks in four weeks whether they
> moved. If you are reading this because that watch fired: the lane ids are below; claim the next
> one.

**Goal:** `seat-continuity` — "A seat picks up where it left off — on any harness, model, or
surface." Declared 2026-09-21 by stanley on nick's direction: *all musterd seats regardless of
harness/model/surface need to be able to reach each other live*; resume is one of the most
important features musterd has, and "dead end" was not an acceptable verdict.

**Evidence this plan stands on** (all dated 2026-09-21, on
`docs/wiki/resume-bound-is-below-one-wake-life.md`): after ADR 426 a wake life is 284–340 KiB on
disk but 47–58k tokens of context; 45% of the file is harness attachments; musterd's own
controllable share is 30 KiB, 26 of it one `team_inbox_check`; transcript resume is per-harness by
construction.

**Spec:** ADR 131 §5 (the hygiene clause), ADR 209 (the portable wake-context packet), ADR 210
(exact-match resume), ADR 426 (project-only settings on wakes), ADR 427 (this plan's increment 1).

## Global constraints

- Work stays in a seat and on its claimed lane; no subagent edits, claims, builds or commits.
- Every protocol change is its own ADR before the schema moves.
- Each increment's acceptance is a **measurement on real wakes**, recorded on the wiki page, not
  a passing test suite alone.
- An increment that finds its premise wrong records that on its lane and closes it — it does not
  silently reshape the next increment.

## The increments — one lane each, all open now

| # | lane | state on 2026-09-21 | depends on | what "done" is |
| - | ---- | ------------------- | ---------- | -------------- |
| 1 | `01M32FGSXKZZDTQAPBACZFMPS0` | claimed by stanley, PR #1594 | — | ADR 427 accepted; the three rungs judge `user`+`assistant` bytes; `resume_weight_bytes` on the wake report; **a real enrolled-seat wake logs `session=resumed`** for the first time since 2026-09-14, cost inside the 07-29 fresh range. |
| 2 | `01M32FH5YQD4EVTG6ARSS0S0SG` | open, unowned | — | `team_inbox_check` honours `limit` and stops re-surfacing acts the seat already received; a wake that has read nothing new gets under 2 KiB back; both seats re-measured. |
| 3 | `01M32FHKKQXKH9W96XF3G4CT3J` | open, unowned, **brainstorm with nick first** | — | A design spec for the continuity packet — what any harness receives on a cold spawn so it has what a resume would have given it — and the protocol ADR for `WakeContextPacket` v2. |
| 4 | `01M32FHX6JHCVNQRGRAHHMTEJN` | open, blocked on 3 | 3 | The packet served on every wake kind; a Codex seat and a Claude Code seat each woken cold and picking up a lane mid-flight; the three-arm comparison (resume / fresh+packet / Codex fresh+packet) run and recorded. |
| 5 | `01M32FJ8T49EGFJV659DNBEMKK` | open, blocked on 3, **design conversation with nick** | 3 | `docs/design/musterd-harness.md` + one decision ADR: build a musterd-owned harness, don't, or a dated trigger; if build, its goal and lanes opened before this lane closes. |

Lane `01M2XD2WCE20VSBPN51RJWRZX4` (the measurement that produced this plan, ADR 426) is submitted
under the same goal.

### Increment 1 — the bound judges the conversation (ADR 427)

- [x] `resumeWeightBytes(path)` in `packages/cli/src/session/transcript-model.ts`, tests first.
- [x] `judgeHygiene` shared by the exact-match, slot and enumerated rungs; the enumerated judgement
      carries `path`; a file at/under the bound is never read; unweighable judges as the file.
- [x] `resume_weight_bytes` on `WakeReportBody` (protocol, ADR-gated), forwarded by the host loop,
      stored on `residency.woke` by the daemon.
- [x] ADR 427, ADR 131 dated note, SPEC.md wake-report paragraph, `04-cli.md` tree line, wiki.
- [ ] After merge and the daemon's autorefresh: wake two enrolled seats, confirm `session=resumed`
      in `~/.musterd/host.log` and the `residency.woke` row, record cost vs the 07-29 fresh range on
      the wiki page. `lane_submit`.

### Increment 2 — the inbox stops re-delivering July

- [ ] Read `team_inbox_check`'s digest path in `packages/mcp` and the server's inbox query; write
      down what "delivered" currently means for a directed act and why `limit` is ignored.
- [ ] ADR: what a seat is owed on an inbox read (new since its last read, plus anything directed
      and still open), and the bound on what one call returns.
- [ ] Implement; re-measure dolly and miley; record on the wiki page.

### Increment 3 — design the continuity packet (brainstorm first)

- [ ] `superpowers:brainstorming` with nick: what does a seat need on a cold spawn to act
      correctly on its first turn — recent thread, lane state and branch, last decisions, open asks,
      memory headline — and what must it *not* carry (bodies, secrets, another seat's context)?
- [ ] Spec in `docs/superpowers/specs/2026-09-21-continuity-packet-design.md`: contents, token
      budget, derivation at read time (ADR 209's rule: not a new store), and the three-arm comparison
      plan.
- [ ] Protocol ADR for `WakeContextPacket` v2.

### Increment 4 — implement the packet on spawn

- [ ] Serve v2 on every wake kind; the spawn line and primer point a fresh seat at it before its
      first inbox read.
- [ ] The three-arm comparison for real, recorded; a Codex seat and a Claude Code seat each pick up
      a lane mid-flight from cold.

### Increment 5 — the musterd harness (design conversation)

- [ ] `superpowers:brainstorming` with nick, then `docs/design/musterd-harness.md`: what "musterd
      runs the loop" means, what it costs, what it buys over increment 4, the smallest honest first
      step.
- [ ] One decision ADR: build / don't / dated trigger. If build: goal + lanes opened before this
      lane closes.

## If you inherit this

Read the wiki page first, then `team_next` — the goal groups the lanes and names the next
unblocked one. A lane whose premise has died is closed with a note, not left open to look like
progress. Do not open increment 6 before 2–5 have moved; the watch exists to catch exactly that.
