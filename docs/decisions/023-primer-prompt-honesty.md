# 023 — `init` primer prompt: say what writing AGENTS.md will actually do

- Status: accepted
- Date: 2026-06-18

## Context

`musterd init`'s last step offers to write the agent primer into the folder's `AGENTS.md`
(ADR 012). The write is safe by construction: `upsertPrimer` **never overwrites** — it creates the
file if absent, replaces only the marker-delimited block if the primer is already there, and
otherwise **appends** the block below the user's existing prose (`primer.ts`, create /
append-below-prose / update-in-place). ADR 020's folder guard even warns up front, at step 1b, when
an unmarked `AGENTS.md` is present.

The 2026-06-18 dogfood surfaced the gap anyway: the operator ran `init` in an existing project that
already had its own `AGENTS.md`, and at the final prompt — _"**Write** an AGENTS.md primer so Ada
knows how to use musterd?"_ — said yes "without thinking of what would happen to my existing
AGENTS.md." Nothing was lost (the block was appended), but the operator didn't _know_ that at the
moment of deciding.

## Problem

Two things made the decision blind:

1. The honest signal (ADR 020's "this folder already has an AGENTS.md … the block will be appended")
   fires ~8 prompts earlier, at the top of the flow, and is forgotten by the time the primer confirm
   appears at the end.
2. The confirm itself said **"Write an AGENTS.md primer"** regardless of whether a file existed. Next
   to the user's own `AGENTS.md`, "Write" reads like create/overwrite and gives no hint that the real
   behavior is append-and-keep.

The truth was shown once, early, then the decision point was blind to it.

## Decision

Make the confirm prompt reflect what writing will actually do, computed at the decision point.

Add a pure classifier `classifyPrimerTarget(dir): 'none' | 'unmarked' | 'managed'` to `primer.ts`
(it already owns the marker constants via `hasPrimerMarkers`), mapping 1:1 to `upsertPrimer`'s
action (`none`→`created`, `unmarked`→`appended`, `managed`→`updated`). `init.ts` picks the prompt
from it:

- **none** → _"Write an `AGENTS.md` primer so `<name>` knows how to use musterd?"_ (unchanged)
- **unmarked** → _"Append a musterd primer to the `AGENTS.md` already here? (your content is kept —
  the block goes at the end)"_
- **managed** → _"Update the musterd primer in this folder's `AGENTS.md`?"_

No behavior change — append was always the safe behavior, and the _post_-write success line already
distinguished "Wrote / Added the primer to / Updated." This moves that honesty to _before_ the
keystroke, where the decision is made.

## Consequences

- The primer confirm now names the real effect at the point of choice; a user beside their own
  `AGENTS.md` is asked to "append (your content is kept)," never to "write" in a way that reads like
  an overwrite. Closes the 2026-06-18 dogfood paper-cut.
- `classifyPrimerTarget` is pure (a `cwd` → enum) and unit-tested in `onboard.test.ts` across all
  three states, each asserted against the matching `upsertPrimer` action so the prompt and the write
  can't drift apart. The interactive prompt selection stays in `init.ts` (the §4.C wizard-coverage
  boundary, same split as ADR 020).
- **Out of scope:** a diff/preview of the appended block, or a dry-run flag — the wording fix is the
  proportionate response; the write was never destructive.
