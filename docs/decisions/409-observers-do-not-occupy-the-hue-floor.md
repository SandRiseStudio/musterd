# 409 — Observers do not occupy the hue uniqueness floor

- Status: accepted
- Date: 2026-09-16
- Relates to: [ADR 374](374-a-members-colour-is-a-hue-the-seat-file-owns.md) (uniqueness among
  live teammates, 12° OKLCH, assignment never refuses), [ADR 063](063-observer-seats.md)
  (observers are hidden sessions, not roster members)
- Lane: `01M2NR7N9VBABK5QDJ5V3E2GT4`

## Context

ADR 374 stores a member's colour as one HSL hue and refuses an explicit value within
`HUE_MIN_SEPARATION` (12° OKLCH) of a live teammate's. Assignment is a walk, never a refusal:
past a full wheel `assignHue` still returns a hue. The 409 is only `assertHueClear` on an
*explicit* hue.

On a file-backed team that explicit hue is the normal path. `writeSeatFile` assigns from sibling
seat files and `musterd team add` POSTs the number. The daemon then checks `takenHues`: every live
row with a hue, `left_at IS NULL`.

Measured 2026-09-16 on revive: 32 live hues, 9 of them `web-*` observers (`observer = 1`,
lifecycle forever). The greedy walk seats a median 24 members at 12°. The 23 roster hues still
fit; the 9 watchers take the set past full. A file-assigned hue that is clear of every seat still
409s against a watcher. `team add` is locked with no escape hatch, which is the opposite of
Decision 4.

The brief said those `web-*` seats never release. That was false. The nine names at 14:02 PDT
(`web-j5dghb`, `web-dyyx9s`, `web-raxb0c`, `web-ucru1t`, `web-vsajeq`, `web-6kljx0`,
`web-yg99wy`, `web-35abqk`, `web-blqv5y`) were gone but one by 15:05 — ten live watchers, only
`web-35abqk` still in the table. Reap-by-deletion works; the set refills. The lock is who
counts, not that a watcher holds a hue forever.

## Problem

The uniqueness floor treated an observer as a teammate. An observer is a session (ADR 063): hidden
from the roster, unable to send, reaped by idle TTL / cap, and it has no seat file. It is not a
colour the team chose and not a colour `team add` should have to walk around. Leaving the 12°
floor and the "never refuse creation" walk untouched, the living set those rules apply to is
wrong.

Lowering 12° would recolour the roster to make room for watchers. Refusing to assign observer
hues would still leave existing `web-*` rows occupying the floor until they reap. The defect is
who counts, not how far apart.

## Decision

1. **Hue uniqueness is among live roster members** (`left_at IS NULL AND observer = 0`). An
   observer does not occupy the floor. `takenHues` and the neighbour named by `assertHueClear`
   both exclude `observer = 1`.
2. **An explicit hue that collides with an observer is kept.** One that collides with a live
   roster member is still refused, naming them, at creation and at set. Departed seats still hold
   no hue against anyone (ADR 374).
3. **Observers may still carry a paint hue.** Assignment for a watcher walks the roster set; it
   does not reserve a slot. A later `team add` may land on the same number. That is a glance
   collision with a hidden session, not with a teammate.
4. **The 12° floor and the never-refuse walk are unchanged.** This ADR does not reopen ADR 374
   Decision 1–2, 4–6. "Live teammate" in Decision 3 is the roster member, not `left_at IS NULL`.

## Consequences

- File-backed `team add` POSTs the seat-file hue and no longer 409s because a `/live` tab is
  sitting on a nearby colour. The CLI's local `assignHue` already walked only sibling seat files;
  the daemon now uses the same set.
- Existing `web-*` rows keep their hues; they simply stop blocking. No hue-NULL migration. They
  already reap (ADR 064/196) — the 14:02 names were gone an hour later — so the floor does not
  need a second reap path.
- Two observers may share a hue with each other and with a later seat. The floor is for the
  people you see.
- ADR 374's Decision section is frozen; the dated note in its Consequences records the narrowing.
- 2026-09-16 — file-backed `team add` still 409s an explicit hue on a *saturated roster*
  (`assertHueClear` has no hatch; revive is one seat from the median 24), and ADR 374 still does
  not say what happens past that. Who counts is this ADR; degrade-or-override past 30 is a
  separate lane.
  Follows-up: 01M2P43WQ7MSBPJF2ZDZVVA732 — landed 2026-09-16 (ADR 374 Consequences, same date):
  the file's word is never refused, a caller's 409 names a clear hue, and past a full wheel the
  colour is kept and shared out loud.

## Observability & Evaluation

**Traces** — none added. A colliding explicit hue is already a 409 naming the neighbour; after
this change that neighbour cannot be an observer. No new audit kind.

**Eval** — baseline 2026-09-16: revive held 32 live hues of which 9 were observers, and
`assertHueClear` named `web-*` on an explicit collision. After: `members.hue.test.ts` keeps an
explicit 212 against `web-abc123` and still 409s the same number against a live agent; a fresh
seat seeds from its name even when an observer sits on that hue. Failure is a 409 that names an
`observer = 1` row, or `takenHues` walking a new seat off an observer's colour.

**Experiment** — n/a. The lock is a uniqueness predicate, not a traffic metric; the tests are the
falsifier.
