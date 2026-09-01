# 345 — Retire the desk nameplate

- Status: proposed
- Date: 2026-09-01

## Context

The office scene gave every owned desk a nameplate: a small engraved placard
carrying its owner's name whether they were seated, stepped away, or offline.
It entered as presence-honesty §4's "furniture-with-a-name" (a kept desk must
say whose it is) and was extended by Delight D into a designed object — brass,
then graphite, with a status light-pipe and a disconnected glint.

It was reworked six times in five days, and every rework was triggered by
looking at it on the real `/live` rather than by a test:

| # | Form | Why it moved |
|---|------|--------------|
| #1096 | folded wedge on the desktop | occludes the desk behind it in isometric |
| — | chair-back mount | re-created the floating-chip problem |
| #1126 | hung on the front lip | a seated member sits exactly in front of it |
| #1126 | type clamped at 11px | read proportionally LARGER as the desk shrank |
| #1127 | desk-proportional, engraving drops out below 9px | the bar names nobody |
| #1145 | two-letter initials below the engraving floor | the bar was mute at /live's real width |

At the canvas `/live` actually renders — 617x848 on a 1440x900 window, scale
0.465 — the plate could carry **two letters**. Two letters is not a name on
this roster: `stanley`/`streamwatch` are both ST, and `gptbot`, `ghost`,
`grokbot` and `guardian` are all G-something. A colour tab was added to the
plate specifically to separate initials the room could not tell apart.

A seventh rework was in progress when this ADR was written. Bench seats — 4 of
17 desks — drew no plate at any scale, because a shared counter gives no seat a
side face of its own and `benchStation` never called the plate at all. Seat
assignment is a name hash, so *which* members were anonymous was arbitrary and
shifted with the roster. The fix worked and was green, but it required a
per-desk-species placement fork, and the plate it added was immediately
occluded by the neighbouring seat's monitor.

## Problem

Decide whether a desk-mounted name label earns its place in the scene, given
that the room already names people three other ways and the label's own form
has never survived a live review.

## Decision

**Remove the desk nameplate entirely.** `deskWedge` and the `initials()`
derivation are deleted; no desk carries a name label at any scale or species.

The room's naming is unaffected for anyone present: a member's floating chip is
the walking identity, at full size and in their colour, and the roster rail and
caption pills name them too. The plate was the fourth-best label on a desk that
already had three better ones.

### What this gives up, stated plainly

Presence-honesty §4 claimed the desk of an absent owner says whose it is. That
claim is now carried only by the roster rail, because §4 also specifies that
floating labels are present-only. Two specific losses:

- **An offline owner's desk is anonymous in the room.** It is still *kept* —
  chair in, dark monitor, warm-screen afterglow, no lamp — so the floor still
  shows the seat is owned rather than free. Who owns it is a roster read.
- **The disconnected amber glint (ADR 315) loses its carrier on the floor.**
  The roster row still reads `disconnected`; the desk no longer flags it.

The stepped-away claim is unaffected: it rides the jacket draped over the chair
back, which was always the mark that survived every scale.

### Why not the narrower option

Keeping the plate only on owned-but-EMPTY desks was considered and is the
better *design* — no sitter means the plate returns to the front face, likely
recovering full names at `/live` scale and deleting the whole threshold ladder.
It was rejected on scope: it keeps `deskWedge`, its three states, its floors and
its species fork alive to serve the minority of desks, and the room's absent
owners are exactly the population a viewer is least often asking about.

## Consequences

- `deskWedge` (~300 lines, the scene's most-commented function), the
  engraved/initials/bar ladder, its geometric and typographic floors, the
  status light-pipe and the disconnected glint are removed from `render.ts`.
- `initials()` and its tests go with it — it had no other caller. `initial()`,
  the one-letter glyph used by chips, rail dots, roster rows and avatars, is
  untouched and gains the direct test coverage it never had.
- The bench nameplate lane (`01M1F4933TT2GG5EAACJ9X88Y1`) is closed as
  superseded rather than shipped: it was fixing a hole in a surface that no
  longer exists.
- Presence-honesty §4 is amended in place, not rewritten — the spec records
  what was decided on 2026-08-19 and what changed today.

## Observability & Evaluation

**Traces.** None added. The plate was pure canvas paint on a per-frame draw — it
emitted no acts, no events and no metrics, and its removal changes nothing that
is recorded. The two presence flavors it rendered (`stepped_away`, and
`offline_reason: 'disconnected'`) are unchanged on the wire and still reach the
roster; only one of their *renderings* is gone.

**Eval.** n/a — no agent behavior is involved. The mechanical claim this ADR
makes is covered by the suite instead: `render.test.ts` no longer asserts any
plate, and `format.test.ts` now covers `initial()` directly (it previously had
coverage only as a side effect of the deleted `initials()` block). Both run in
`pnpm coverage`; web is 796/796 green on this change.

**Experiment.** The falsifier below is the experiment, and it is a live-review
one by design: this plate was never once corrected by a test — all six reworks
came from looking at the real `/live`, which is the surface a seventh would have
to be found on too.

## Falsifier

A viewer on `/live` cannot name the owner of an empty desk without opening the
roster. If that read turns out to matter in practice — someone asks "whose desk
is that?" of the floor and the floor cannot answer — the narrower option above
is the fix, and it is cheap: the plate returns on empty desks only, on the
front face, at full size.
