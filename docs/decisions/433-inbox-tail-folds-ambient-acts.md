# ADR 433: the inbox tail folds ambient acts to one line each

- Status: proposed
- Date: 2026-09-21
- Lane: 01M32QF2X4AASWTVAG04F8C98V (goal `seat-continuity`)
- Relates to: [ADR 429](429-inbox-pinning-is-an-obligation-rule-not-a-salience-one.md) (the
  pinned set is the obligation class), [ADR 287](287-the-cursor-never-passes-what-you-did-not-see.md)
  (the cursor never passes what was not rendered), lane 01M2GT874Y (a digest line is a rendered row)

## Context

`team_inbox_check` renders a bounded page in two parts: the **pinned** set — acts waiting on the
reader — and the **tail** — the newest `limit` of everything else. ADR 429 gave the pinned set an
obligation rule: only `request_help`, `ask`, and a directed `handoff` / `steer` / `challenge` /
`defer` are pinned, bounded, discharge folded in SQL. It left the tail as it was: "newest N,
whatever they are".

Measured by ryder on her 2026-09-21 12:21 wake — the acceptance measurement for ADR 429's lane,
act 01M32PQC1EFV20DZ8G8X3E5SMA. One unfiltered `team_inbox_check` on the post-429 daemon rendered
42 acts in full and 22 as digest lines. Of the 42: **17 `[lane]` state-machine broadcasts** on lanes
she does not own, **22 `@team status_update`** from teammates, 1 `decline` directed elsewhere, 1
`@team` migration note, and **one act that was hers** — the steer that woke her. 63 of 64 surfaced
acts were ambient. Her `team_inbox_check` result weighed 22.9 → 23.7 → 23.7 KiB across three lives,
before and after ADR 429, because `planInboxCheck` spends `RESULT_BUDGET` (30k chars) to the
ceiling: a byte freed by un-pinning an answered `accept` is a byte re-spent on the next digest line.

Replayed on the daemon's own database the same afternoon (`sqlite3 .backup`, every seat's real unread
tail of 50 through `planInboxCheck`, pre-change render = newest-first, body-capped, to the 21k
`SHOWN_BUDGET`):

| seat     | tail | before          | of which lane / status |
| -------- | ---- | --------------- | ---------------------- |
| ryder    | 50   | 20.4 KiB, 38 full | 24 / 21              |
| dolly    | 50   | 20.4 KiB, 37 full | 20 / 20              |
| big-body | 50   | 20.4 KiB, 31 full | 22 / 19              |
| stanley  | 50   | 20.4 KiB, 36 full | 20 / 17              |

On every busy seat, 37–45 of the newest 50 are a lane transition on somebody else's lane or a
teammate's status line.

## Problem

**The largest category is a state machine narrating itself.** Every lane transition fans out to
every seat as a full `message` with a body _and_ a `meta` JSON that repeats the title — `formatMessage`
renders both. The board already holds the fact; `team_next` already summarises it in a line. A seat
is told, at full weight, 17 times per wake, that lanes it does not own changed state.

**The second is teammates reporting to the room.** A `status_update` to `@team` is the roster's
`working` flip, one line by convention — and rendered in full with its meta.

**Not "stop broadcasting".** A seat that learns nothing about its teammates is the failure mode
musterd exists against; ambient awareness is what makes this a team rather than a queue. The
question is what the tail owes a _reader_: an act about the reader in full, and an act about the
room in a form the reader can scan. And a fold must not lose a transition a seat needed — ADR 287's
rule holds, and losing that is worse than the bytes.

## Decision

1. **The tail has a relationship rule.** An act is **ambient** when it is not directed to the
   reader, is not an obligation (those are pinned, never here), and is either (a) a `status_update`
   to `@team`, or (b) a daemon-composed lane transition — a `message` whose `meta` carries a
   `lane_*` key naming a lane — on a lane the reader neither owns nor depends on. Everything else
   in the tail is rendered in full as before: a plain `@team` `message` (a person wrote it to
   everyone on purpose), an `insight`, a `wait`, any directed act, and a transition on one of the
   reader's own lanes or their dependencies.

2. **Ambient folds; it does not drop.** An ambient act is rendered as one digest line — sender, act,
   addressee, the first ~96 chars of body, id — in a section of its own between the full rows and
   the drain digest, newest-first when the budget cuts so the freshest ambient survives. A folded
   row is a **rendered** row for ADR 287: the cursor walks it exactly as it walks a digest line
   (lane 01M2GT874Y), and `team_inbox_check {ids: [...]}` reads it back whole. A folded row the
   budget cannot carry is not rendered and holds the cursor, like any other row.

3. **The split happens before the newest-N.** Ambient is separated from the rest _before_ `limit`
   selects the newest, so a burst of transitions cannot push the reader's own rows out of the
   window — the same reason the pinned set is unioned above the fill.

4. **Ownership is read from the board, only when needed.** The client fetches `lane_board {mine}`
   once per check, and only when the slice carries a lane broadcast at all; an inbox with none costs
   no extra request. A failed read degrades to "fold every transition" — still rendered, still
   walked.

5. **Client-side, on the MCP surface only.** Nothing changes on the wire, in `listInbox`, in the
   CLI's `musterd inbox`, or in what `GET /inbox` returns; the structured reply gains
   `folded_ambient: [ids]` beside the existing `digested_unread`. The server-side alternatives the
   lane named — lane transitions as board events with their own retrieval rather than envelopes —
   are not taken here: they change what a transition _is_ for every reader, and this ADR only
   changes how one reader renders it.

**Not decided here.** `RESULT_BUDGET` and its 0.7 split are untouched; a seat far behind still fills
the budget with drain lines, which is the drain working. The `PostToolUse` hint that advertises the
`ids` form while orientation needs the unfiltered call — ryder's second finding — is a separate
lane.

## Consequences

- Replayed on the same snapshot after the change (rendered chars of shown + folded, same rows):

  | seat     | before   | after    | full rows kept                                        | folded  |
  | -------- | -------- | -------- | ----------------------------------------------------- | ------- |
  | ryder    | 20.4 KiB | 8.3 KiB  | 5 — 2 DMs, her steer, a `wait`, one `@team` message    | 24 + 21 |
  | dolly    | 20.4 KiB | 11.7 KiB | 10 — 3 `accept`, 2 `wait`, 1 DM, 4 `@team` messages   | 20 + 20 |
  | big-body | 20.4 KiB | 16.7 KiB | 9 — 4 `ask` to him (obligations, body-capped)          | 22 + 19 |
  | stanley  | 20.4 KiB | 12.2 KiB | 13 — 6 DMs, 3 directed status, 1 `accept`, 2 `@team`  | 20 + 17 |
  | izzo     | 1.3 KiB  | 0.9 KiB  | 2                                                     | 1 + 1   |

  What survives in full is what is about the reader. big-body's 16.7 KiB is four unanswered asks
  addressed to him at the 1.2k body cap — the obligation class doing its job, not this fold failing.

- The **real-wake before/after** the lane's acceptance names (a light-inbox seat, one ordinary check,
  dated on `docs/wiki/resume-bound-is-below-one-wake-life.md`) needs a wake on an adapter carrying
  this change, so it is taken after merge; the replay above is the pre-merge evidence and the wiki
  section says which is which.
- A seat that only ever read the tail for lane transitions now reads a line per transition rather
  than a body plus meta. The line carries the title's first ~90 chars and the id; `team_next` and
  `lane_board` carry the rest.
- Falsifier: an unread lane transition on a lane the reader **owns or depends on** rendered as a
  folded line rather than in full; or any ambient row absent from both the full rows and
  `folded_ambient` in a reply that reported `elided_unread: 0`.

## Observability & Evaluation

- **Traces:** none added; the reply's structured content gains `folded_ambient` beside
  `digested_unread`, so a transcript shows which rows were folded.
- **Eval:** the dataset is the daemon's own message log; the measure is rendered chars of one
  bounded check per seat, replayed through `planInboxCheck` against each seat's real unread tail
  (the script is the `.backup` + replay described in Context). **Baseline 2026-09-21:** ryder 20.4
  KiB, dolly 20.4, big-body 20.4, stanley 20.4. **Bar:** on a light-inbox seat, one ordinary check
  renders the reader's own acts in full and the ambient as lines, under half the baseline. Post-
  change on the same dataset: 8.3 / 11.7 / 16.7 / 12.2.
- **Experiment:** whether a folded transition is still _noticed_ — a seat handed a line about a lane
  it depends on, acting on it — is not answered by bytes. The owned-lane promotion in Decision 1
  is the hedge; a measurement of it is a dogfood run, not this lane.
