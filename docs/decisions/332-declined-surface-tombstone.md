# 332 — A declined surface leaves a tombstone

- Status: accepted
- Date: 2026-08-27
- Builds on: [ADR 060](060-provisioning-drift-check.md) (the drift check),
  [ADR 168](168-hook-drift-is-text-not-presence.md) (drift is text, not presence),
  [ADR 259](259-memory-git-truth-derived-indexes.md) (machine-local facts do not travel),
  [ADR 326](326-session-orientation.md) / the seat chip (the surface that surfaced this)
- Lane: 01M0ZDKXPJBFGMSS775X064BFD

## Context

musterd provisions surfaces into a workspace's harness: hooks in `.claude/settings.local.json`, and
since the seat chip a `statusLine` beside them. ADR 060 checks them for drift and ADR 168 settled
what drift *means* — a slot's value is entirely its text, so presence was never the question.

Both of those describe a surface that is **there**. Neither says anything about one that is not.

## Problem

The provisioning model has two states, and it needs three.

`inspectClaudeStatuslineDrift` reports a missing `statusLine` as drift and prescribes
`musterd init --refresh-hooks`. That is right for a seat that was never provisioned and wrong for a
user who removed the chip on purpose — and **the code cannot tell those apart**, because absence
carries no intent. So a deliberate removal earns the same repair line forever, with no way to say
no. Reporting a choice as drift is corrosive in a specific way: it trains people to skim past drift
output, which costs more than the surface was ever worth. ADR 168's own reasoning applies one step
further out — it observed that presence cannot distinguish *right* from *wrong*; this observes that
absence cannot distinguish *not yet* from *no*.

This is not statusline-specific. The hook table has exactly the same shape: `spec.missing` fires on
absence with no way to record that absence was chosen. The chip merely made it visible, because a
statusline redraws every turn where a drift check runs when asked.

Raised as ryder's first #1076 finding and deliberately kept out of that PR: inventing a vocabulary
inside an amendment is how vocabulary gets invented badly.

## Decision

**A refusal is recorded, and a recorded refusal is not drift.**

1. **The third state.** A surface is *installed*, *absent*, or *declined*. A tombstone is the record
   that absence was chosen. It answers exactly one question — was this refused? — and carries only
   what is needed to say so back to the user later: the surface, when, and by whom.

2. **Where it lives.** `.musterd/declined.json`, versioned, a sibling of `binding.json`.
   - Not in `binding.json` itself: that file is identity, and a re-claim rewrites it. A preference
     must not depend on identity churn.
   - Not in the harness's own settings: the hook table has the same shape as the chip, so the
     vocabulary has to outlive any one harness's schema, and musterd does not put its keys inside
     someone else's file.

3. **Surfaces are named `<harness>:<slot>`** — `claude-code:statusLine`, `claude-code:PostToolUse`.
   The prefix is load-bearing: a slot name alone is unique only inside one harness, and a folder can
   be provisioned for several.

4. **Reads.** The drift inspectors consult the tombstone on the **missing** branch only, and a
   declined surface produces *no line at all* — not a quieter one. A check that still speaks after a
   refusal is the nag this ADR exists to end. The **stale** branch never consults it: a stale surface
   is installed, and refusing a surface was never a licence to leave a wrong one in place.

5. **Writes.** `musterd surface list | decline <name> | accept <name>`. `decline` removes the surface
   *and* records the refusal, so one command means one outcome — a tombstone that claimed a refusal
   while the surface sat installed would be a lie about the folder. `decline` is idempotent and keeps
   the original date: the date shown back to a user must be when they decided, not when they last
   typed the command.

   Two clauses this rule needs to actually hold, both found in review (ryder, #1089) after the first
   implementation offered six hook names and removed only the chip:

   - **Every name `surface list` offers is removable.** A name the command accepts but cannot carry
     out produces the forbidden state above by a different route, so `decline` now refuses a name
     this build does not own rather than tombstoning it. Recording a refusal we cannot perform is
     the same lie one step removed.
   - **The unit is the slot, not the entry.** Two musterd hooks share the Claude Code `PreToolUse`
     event (the ADR 150 lane gate and the ADR 167 session-message observer), and `<harness>:<slot>`
     cannot name them apart. So `claude-code:PreToolUse` is listed once and declining it removes
     both — a slot half-removed would leave the surface firing under a tombstone claiming otherwise.
     A foreign entry on the same event is never touched; matching is by musterd's own markers.

6. **The override.** `musterd init --refresh-hooks` clears every tombstone in the folder — an
   explicit install command *is* the user asking for these surfaces back — and prints one line per
   resurrection naming the surface, the date it was declined, and how to refuse it again. Routine
   drift checks never override. A silent resurrection is how someone finds the chip returned with no
   idea why, which is the same absence-carries-no-intent defect pointing the other way.

7. **It fails open.** An unreadable or malformed `declined.json` yields *no* refusals, never an
   invented one — the discipline `readSettingsSafe` already applies one directory over. The asymmetry
   is deliberate: a surface wrongly coming back is visible and recoverable, while a surface silently
   missing with no record of why is precisely the defect being fixed.

## Consequences

- A user can decline the seat chip, or any project-local hook, and never hear about it again.
- The drift check regains its meaning: every line it prints is now something the user has not
  already answered.
- A refusal is machine-local and does not travel (ADR 259). Declining the chip in one seat workspace
  says nothing about any other, which is correct — a statusline is a property of a terminal, not of
  a team.
- Deliberately **not** built: no reason field, no expiry, no team-wide propagation, no `--force`
  bypass. Each would need a use before it earns a concept.
- A user who removes a surface by hand and never runs `surface decline` still gets the drift line.
  That is correct and worth stating: musterd can read a tombstone, not a mind.

## Observability & Evaluation

- **Traces:** `musterd surface list` is the whole read surface — what can be refused in this folder,
  and what has been, with the date and who. A refusal for a surface this build does not recognise
  still lists, marked as such: hiding it would make `accept` unspellable for a name nothing lists.
  `init --refresh-hooks` emits one line per tombstone it clears, naming the surface, the date it was
  declined, and how to refuse it again. `init --check` emits *nothing* for a declined surface — the
  absence of a line is the signal, which is why the two falsifiers below are both about silence.
- **Eval:** dataset is this repo's own seat workspaces — 13 folders provisioned for Claude Code, each
  carrying between 4 and 5 project-local hooks plus the chip, so 5-6 refusable surfaces apiece.
  Baseline, measured 2026-08-27 before this change: a folder whose chip has been removed reports the
  missing-statusLine drift line on **100%** of `init --check` runs, indefinitely, with no way to
  suppress it. Target: 0% for a declined surface, unchanged for every other drift class.
  Two falsifiers, by sample rather than by date:
  1. Over the next 20 `init --check` runs on a folder holding at least one tombstone, no run reports
     the declined surface, and every other drift class still reports normally. **One false silence —
     a genuinely stale or missing *undeclined* surface going unreported — falsifies the read rule in
     decision (4).**
  1b. **The removal half, one sample per refusable name.** For each name `surface list` offers,
     `surface decline` on a provisioned folder leaves that surface absent from the settings file.
     **One name that survives its own refusal falsifies decision (5)** — which is exactly how the
     first implementation failed: the six hook names all tombstoned and none were removed, and the
     unit test missed it because the statusline is the one surface that *was* removed.
  2. If, after 10 uses of `surface decline`, more than one is followed within a day by
     `surface accept` or a hand-edit of `declined.json`, the vocabulary is being used to mute
     something it should not, and (5)'s remove-and-record coupling is wrong.
- **Experiment:** n/a — there is no A/B here, because the baseline arm is a check that cannot be
  turned off. The failure paths were exercised directly instead: each of the two load-bearing claims
  was reverted in turn and the suite re-run, and exactly the tests naming that claim went red
  (2 of 2066 for the drift rule, 1 of 2066 for the override), with every other test green.

Retire this ADR if a second harness gains refusable surfaces and the `<harness>:<slot>` naming in
(3) cannot express one of them.
