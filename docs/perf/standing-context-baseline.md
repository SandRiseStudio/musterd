# Standing-context baseline

The measured cost of everything musterd injects into a seat's context (spec
`docs/superpowers/specs/2026-08-03-standing-context-budget-design.md`). Static numbers are gated by
`pnpm context:check` against `docs/perf/context-budgets.json`; dynamic numbers come from the
report-only `node scripts/context/report.mjs`. est tokens = bytes / 4 (the `SurfaceRender`
formula, ADR 144 inc 1 — comparable across increments, not a billing figure).

## 2026-08-03 — initial baseline (pre-trim)

Method, one line per surface: in-memory `tools/list` connect (`measureToolSurface`, per role) ·
rendered primer (`renderPrimer`, seated generalist, no charter) · exported hook text constants
(`HOOK_NUDGE_TEXTS`) · executed-hook report against a fixture folder.

### Static (gated)

| item                    | bytes  | est tokens |
| ----------------------- | ------ | ---------- |
| tools/list (default)    | 13,464 | 3,366      |
| tools/list (muted)      | 4,470  | 1,118      |
| primer block            | 2,482  | 621        |
| SessionStart nudges (Σ) | 645    | 161        |
| UserPromptSubmit nudge  | 177    | 44         |
| **per-turn total**      | 13,641 | 3,410      |
| **per-session total**   | 16,768 | 4,192      |

The per-turn total (tools/list + UserPromptSubmit nudge) is the headline: it multiplies on every
turn of every seat session. Continuity with prior art: ADR 144 inc-1 attested ≈3,195 est tok/seat
for tools/list on 2026-07-16; inc 2 then trimmed descriptions −14%, inc 5 cut a muted seat −77%
(12,898 → ~3,022 B at the time). Today's default surface (13,464 B) includes tools added since.

### Dynamic (report-only, machine-state dependent)

| hook             | printed on this machine | static share | dynamic share                  |
| ---------------- | ----------------------- | ------------ | ------------------------------ |
| SessionStart     | 487 B (~122 tok)        | 237 B        | 250 B (label nudge, due-gated) |
| UserPromptSubmit | 427 B (~107 tok)        | 177 B        | 250 B (label nudge, due-gated) |

Finding worth carrying into the trim: the due-gated **label nudge (250 B) more than doubles the
per-turn hook output** when it fires — the repeated-until-swept design (ADR 168 rationale) is
deliberate, but its text is a per-turn cost candidate like any other.

The SessionStart "static share" is one branch (the branches are exclusive — joined / wire-fix /
init-fix); the gated `sessionStartNudgesBytes` budget sums all three because each is
independently shippable text.

## 2026-08-03 — the trim (ADR 212 increment 2)

Guidance texts trimmed to triggers, with the facts they taught moved into the primer (the
committed, always-present copy). Safety net: `packages/mcp/src/ritualProbe.test.ts` pins the
join/inbox/status loop as **behaviour** through a real daemon, so any rewording that keeps the loop
working keeps the suite green.

| item                    | before | after  | Δ        |
| ----------------------- | ------ | ------ | -------- |
| SessionStart nudges (Σ) | 645    | 528    | −117     |
| UserPromptSubmit ritual | 177    | 92     | −85      |
| label nudge (per-turn)  | 250    | 98     | −152     |
| primer block            | 2,482  | 2,538  | +56      |
| tools/list (default)    | 13,464 | 13,464 | 0        |
| **per-turn total**      | 13,891 | 13,654 | **−237** |
| **per-session total**   | 17,018 | 16,720 | **−298** |

(Per-turn now counts the label nudge — see below — so the "before" row restates the old baseline on
the new definition rather than the 13,641 printed above.)

Three things changed structurally, and one deliberately did not:

- **The label nudge is now gated.** At 250 B it was the largest per-turn item and was measured only
  by the report-only script — unbudgeted text riding a per-turn hook. It is now
  `LABEL_NUDGE_TEXT`, a budgeted line item, and the per-turn headline counts it, so the headline is
  the worst case (a sweep due) rather than the flattering one.
- **The primer grew on purpose.** The autojoin rule and the `team_join` caveat moved out of the
  SessionStart nudge into the primer's loop, which also resolved a contradiction: the primer told a
  seat to call `team_join` while the nudge told it not to. +56 B committed once, −117 B per session.
- **`FEATURE_EPOCH` 4 → 5.** The ADR 168 downgrade guard only refuses a _newer_ epoch, so without
  the bump an older checkout's `init` would rewrite the trimmed hooks back to the fat text.
- **Tool descriptions were left alone.** The plan's third trim candidate was "tool description
  sentences restating primer guidance". Read against the breakdown, that premise does not hold: the
  heavy descriptions (`team_send` 950 B, `lane_submit` 451 B) are act and parameter semantics needed
  at call time, not duplicated guidance. ADR 144 inc 2 already cut descriptions −14% and inc 4
  re-justified the surface from bounce data. Trimming further here would relitigate a measured
  decision without new data.

**The finding worth carrying.** After this trim, guidance text is 1.4% of the per-turn surface
(190 B of 13,654) and 4.4% of the session (734 B of 16,720). **Tool schemas are 98.6% of per-turn
cost.** Any future work that wants a materially smaller standing context has to act on the tool
surface — role scoping (ADR 144 inc 5, already −77% for a muted seat) is the lever that moves the
number; rewording nudges is not.
