# 240 — A lane's title is correctable

- Status: accepted
- Date: 2026-08-05
- Deciders: ryder (nick directed)
- Relates to: ADR 083 (lanes), ADR 098 (canonical work-item vocabulary), ADR 148 (feature epoch),
  ADR 231 (a handoff names its lane)

## Context

stanley opened lane `01KZ9HR001` on 2026-08-05 with a title built on a misreading — it named the
wake failure as `roster provenance CURSOR is not wake`, when the string in the ledger says
`session`. He caught it himself within the hour, corrected it thoroughly, and could only correct it
in one place: a note at the top of the lane's **detail** reading _"the lane TITLE is now wrong and
cannot be edited via `lane_update`. Trust this detail over the title."_

He was right that it could not be done. `UpdateLaneSchema` has no `title`, and `updateLane` never
writes one, so the title is fixed at open across every surface — MCP, CLI and HTTP alike. This is
the wire contract, not an MCP omission.

The argument for changing it is already written in the same file, six lines below, as the reason
`project` became patchable:

> a lane opened from the wrong checkout (or before derivation existed) had no way back — and an
> immutable field with no escape hatch makes a mis-stamp permanent.

Every word of that applies to the title, and the title is worse, because of _where it is read_. A
lane's title is what the board renders, what `team_next` ranks, what a handoff announces, and what a
seat reads when deciding whether a lane is theirs. A correction placed in the detail only reaches
somebody who has already opened the lane — which is to say, it never reaches the person who read the
title on the board and moved on. In this instance the false title asserted an enum corruption; the
real cause was a timing bug three layers away, and anyone acting on the title alone would have gone
hunting an unvalidated write path that does not exist.

## Decision

**`lane_update` takes a `title`.** Protocol (`UpdateLaneSchema`), store (`updateLane`), the MCP tool
and `musterd lane update --title`, in one change because the wire contract is the thing that was
missing.

Three limits, each deliberate:

**Opt-in, like `detail`.** A patch that omits `title` leaves it untouched. The field the whole team
navigates by must not become collateral damage of a state change, so the store reads
`patch.title !== undefined ? … : existing.title` rather than a defaulting coalesce. Both directions
are tested by mutation — dropping the patch, and clobbering on every patch.

**`min(1)`.** An empty title is worse than a wrong one: a wrong title misdirects, an empty one makes
the lane unreferenceable on every surface that names it.

**Forward-only.** Notification bodies already sent (`[lane] opened "…"`, handoffs, work-orders) keep
the title they were sent with. They are history, and rewriting the record of what a teammate was
told — so it agrees with what is true now — is the opposite of what this team has spent the week
building. The board shows the corrected title; the messages show what was said at the time.

**Not audited.** Considered and rejected for now: `lane.claimed` and `lane.released` exist because
ownership is a governance fact, whereas a retitle is an editorial one — and so is `detail`, which
has been freely patchable since ADR 083 with no audit row. Adding a row for the title but not the
detail would draw a line where none exists. If retitling turns out to be used to quietly re-scope
work rather than to correct it, that is the signal to revisit, and the Eval below is how it shows up.

## Consequences

- A lane whose title misstates the work can be put right, and the correction reaches the surface
  where a wrong title actually does its damage: the board.
- A teammate may see a lane's title change under them, having decided what to work on partly by
  reading it. That is the real cost here, it is why the field is opt-in and forward-only, and it is
  why the sent messages are left alone — the record still shows what they were told.
- `FEATURE_EPOCH` moves to 9. An older seat reads titles exactly as before and simply cannot issue a
  correction; the roster's calm `behind` chip (ADR 148) is the cue for why its `lane_update` refuses
  the field.
- The gap this closes is small, but it was found the only way gaps like it are: somebody needed the
  capability at the moment the work was already done, and wrote a note apologising for the tool
  instead.

## Observability & Evaluation

**Traces.** None added, per the Decision — a retitle rides the existing
`PATCH /teams/:slug/lanes/:id` and writes no audit row, matching `detail`'s long-standing treatment.
The lane's `updated_at` moves, which is the same evidence any other edit leaves.

**Eval.** The claim is narrow: a mis-stated title becomes correctable rather than permanent.
Baseline: **one lane (`01KZ9HR001`, 2026-08-05) carrying a self-described wrong title plus a
detail-note apologising for it, and no mechanism to fix either.** Success is that the
note-in-detail workaround stops appearing — a grep of open lane details for phrases like "title is
now wrong" should stay empty. Failure to watch, and the reason the Decision refuses an audit row for
now: titles rewritten to describe _different work_ rather than the same work more accurately, which
would show up as retitles on lanes already `claimed` by somebody other than the retitler. If that
appears, the editorial framing is wrong and the change needs a governance record after all.

**Experiment.** None. This is a one-field escape hatch on an existing patch surface, matching a
sibling field's established semantics; there is no arm worth withholding it from.
