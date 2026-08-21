---
question:   Does a demote still occur that the Cursor trust gap does not explain?
claim_ref:  docs/decisions/166-session-liveness-by-enumeration.md
falsifier:  "Any demoted observation EXCEPT one on a Cursor-harness workspace whose `~/.cursor/projects/<slug>/.workspace-trusted` did not yet exist at the demote timestamp (birth time vs sample `at`). Target ZERO. A trust-gap demote is the known-open cause and resolves the wake-guard question separately — the guard now defers on slotState live regardless."
population: the workspaces present in the binding registry on 2026-08-21 — agents, agents-izzo, agents-miley, agents-stanley, agents-ryder, agents-dolly, agents-wanderer, agents-gptbot, agents-kimi. A workspace added or removed inside the window voids this watch rather than silently changing the denominator.
void_if:
  - the set of sampled workspaces changes from the nine named above
  - the sweep's demote semantics change (scripts/research/adr-166-slot-sweep.ts, the `demoted` assignment)
  - the series file is truncated or rotated within the window
series:     ~/.musterd/research/adr-166-slot-sweep.jsonl
cadence:    5m
opened:     2026-08-21
opened_by:  ryder
revisit_by: 2026-09-11
status:     open
resolution:
---

Opened by the resolution of `2026-08-21-adr-166-demoted-successor.md`, whose inspection explained
all 109 demotes (ADR 166 amendment 2026-08-21, "the inspection").

**Why the falsifier excludes the trust gap.** The one cause left open is known and reproducible:
a live Cursor desktop session is unattributable until Cursor writes `.workspace-trusted` (74
minutes measured on agents-kimi, 08-20). A recurrence of that shape is expected and no longer opens
the wake guard — the loop and every backend now defer when the slot says live. Leaving it inside a
target-zero falsifier would guarantee a breach with a known cause, and a watch that is expected to
breach is wallpaper. What this watch exists to catch is a demote with a **novel** cause.

**Why host/** changes no longer void it.** The predecessor named `packages/cli/src/host/**` as the
code under test; after the guard belt, the demote flag is produced entirely by
`packages/cli/src/session/liveness.ts` + the scanners, and the sweep's semantics clause covers
those. Reading this watch requires the per-case check its falsifier states (birth time of
`.workspace-trusted` vs the sample's `at`) — counting alone cannot resolve it.
