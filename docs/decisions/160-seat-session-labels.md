# 160 — Seat session labels: which window is which seat

- Status: accepted
- Date: 2026-07-25

## Context

A human driving a musterd team runs many agent sessions at once — several seats, several harnesses,
one screen. The roster and `/live` answer _who is doing what_; nothing answers _which window is which
seat_. Sidebar rows and terminal tabs carry harness-generated titles ("Check messages", "MCP list")
that say nothing about the seat behind them.

A personal Claude Code skill proved the fix and its constraints. It swept the Claude Code Desktop
sidebar at session start and renamed seat sessions to `🔶 Miley (Fri 3p) - <existing title>`. Running
it live established four facts that shape this decision:

1. **A session can never rename itself.** The desktop app's rename tool refuses the current session,
   and its auto-title does not exist until after the first prompt. So sessions label _each other_:
   every sweep labels all seat sessions except the one it runs in, which the next session's sweep
   picks up. The one unlabeled row is always the one being driven.
2. **The rename tools are agent-side only.** They exist as MCP tools _inside_ a Claude Code Desktop
   session; the musterd CLI has no path to them. Sidebar labeling is agent behavior, not CLI code.
3. **Other harnesses have no writable sidebar at all.** Codex records sessions as append-only JSONL
   with no title field; Cursor's panel titles live inside a live SQLite store that the app owns in
   memory (writing under it is the same clobber we measured with the desktop app's own title files).
4. **Cursor and Codex also have no startup hook** — musterd wires hooks only for Claude Code — so a
   per-harness "labeling driver" would have exactly one implementation, indefinitely.

The obvious design — extend the `Harness` interface with a label driver per harness — dies on facts
2–4. What survives is per-_surface_, not per-harness.

## Decision

Two label surfaces, riding rails musterd already ships. No `Harness` interface extension.

### The label grammar (`@musterd/protocol`, `label.ts`)

One shared module owns the format so every surface agrees:

- `SEAT_CHIP` = 🔶 — the ADR 154 mark reduced to what a plain-text title can carry: titles render no
  images anywhere we write them, and a warm diamond is the closest Unicode gets to the mustard chip.
- Sidebar labels: `🔶 Miley (Fri 3p) - <subject>` — written once per session; the timestamp is the
  session's start, fixed at creation, so a labeled row is never re-dated. Within six days the
  timestamp is weekday-style (`Fri 3p`), beyond that date-style (`Jul 18 3p`).
- Terminal titles: `🔶 stanley · <workspace folder>` — no timestamp; a tab is live, not history.
- `parseSeatLabel` — the three-state idempotency predicate every sweep uses: fully labeled (skip),
  seat-prefixed but chipless (prepend the chip, _keep the original timestamp_), untouched (label).
  _(Amended 2026-07-27 to four states: the chipless case splits on whether a stamp is already there
  — see the amendment below.)_

### Surface 1 — terminal tab titles (CLI postamble, harness-neutral)

After every acting command, the CLI retitles its hosting terminal via OSC 0 written to `/dev/tty`
(`packages/cli/src/render/title.ts`, called from the `bin.ts` postamble beside the ADR 046 nudge).
This is what makes labeling genuinely cross-harness: it rides the CLI itself, so any terminal-hosted
harness whose agent shells out to `musterd` — Codex CLI, cursor-agent, a plain `claude`, a future
musterd harness — labels its own tab as a side effect, with no cooperation from the harness.

- **`/dev/tty`, never stdout/stderr.** The hook one-liners redirect both streams to `/dev/null`
  (hook stdout injects into model context), and piped/`--json` output must stay byte-clean without
  every command knowing titles exist. Where there is no controlling terminal (the desktop app,
  launchd, CI, MCP stdio) the open throws, and that throw is the guard: swallow, stay silent.
- **Pure decision, dirty write.** `terminalTitleFor` is a pure function over (command, flags, env,
  platform, cwd) — the whole decision table is unit-tested. The unverifiable two-line writer is not.
- Skips: daemon/hook/no-identity commands (`serve`, `service`, `gate`, `session`, `host`, …),
  `--no-title`, `MUSTERD_NO_TITLE=1`, win32, and any folder that is not a seat workspace — a plain
  repo or a role/chat folder never gets a seat label, because a wrong label is worse than none.
- Subject is the workspace folder name, not the lane title: lanes live server-side and a network
  round-trip per CLI command is disqualifying. Lane-aware titles from commands that already hold
  lane context are a flagged follow-up.

### Surface 2 — sidebar sweep (agent behavior, shipped as guidance)

The proven sweep becomes product in two pieces:

- **`musterd session resolve-labels --stdin`** — the CLI owns the decision logic: session-list JSON
  in, `{apply, skipped}` out. The CLI is guaranteed present on a provisioned seat; python3 (which the
  personal skill leaned on) is not part of musterd's contract.
- **A second guidance unit on the ADR 085 rail** — a `label-sessions` skill rendered only for
  harnesses whose sessions can call a rename API (Claude Code today, via
  `HarnessGuidance.sessionsSkillPath`). It instructs the agent: list sessions, pipe through
  `resolve-labels`, apply the renames, report one line. Deliberately _not_ merged into the one
  canonical musterd skill — that body is harness-neutral by contract, and this unit is not.

Sweep invariants, unchanged from the proven version: a title whose `titleSource` is `user` is never
touched (a human's own words outrank the sweep, always); sessions younger than two minutes are
skipped (their auto-title is still a first guess); the sweep is idempotent via `parseSeatLabel`;
non-seat folders are out of scope by construction.

> **Amended 2026-07-27.** The first invariant was too broad and cost the feature its reach: it is now
> scoped to titles in the human's _own terms_. A hand-typed title already in seat form is completed
> rather than skipped. See the amendment below.

### Amendment 2026-07-27 — the sweep needed a trigger, and the guard was in the wrong order

Measured two days after shipping: only 3 of ~21 seat sessions in the sidebar carried the chip, all
from 2026-07-24/25. The engine was never broken — `resolve-labels` on live session data still
returned correct labels on demand. Two defects in how the decision met the world:

1. **No trigger.** Surface 2 is agent behavior, and nothing invoked it. The skill says "run at
   session start", but the only thing that speaks at session start is the SessionStart hook, whose
   text named only `team_inbox_check`. So labeling depended on an agent spontaneously deciding to
   sweep — which happened while the feature was new and stopped when attention moved on. The skill's
   own text already assumed a trigger that was never built ("if `apply` is empty and this ran
   automatically, say nothing at all"). **Fix:** the SessionStart hook now names the sweep. Hooks are
   matched by marker, not content, so existing seats keep the old text until a `musterd init`
   rewrite — the same staleness ADR 165 records for the MCP entry.

2. **"`titleSource: user` is inviolable" was too broad, and its guard ran too early.** The guard sat
   _before_ the seat parse, which made the pre-chip upgrade branch unreachable in practice: a
   chipless seat-prefixed title is almost always one a human typed. The human-visible effect was
   perverse — hand-renaming a session, the natural workaround for an unlabeled sidebar, silently
   opted that session out of ever being labeled again, so the workaround consumed the feature.

   **The invariant is narrowed, not dropped.** A title in the human's own terms is still never
   overwritten. But a title the human already wrote in _seat form_ (`Miley - fix(x)`) states what
   the sweep states; completing it — chip and timestamp added, their words carried through verbatim
   — finishes their sentence rather than overruling it. Concretely: `parseSeatLabel` gains `dated`
   (a seated title that already carries a stamp keeps it, never re-dated) and `subject` (so a
   re-render does not restate the seat), and `seated` now requires a word boundary after the seat
   name. That last point is load-bearing rather than cosmetic: `seated` is now what licenses
   touching a human-typed title at all, so a loose prefix match (seat `miley` claiming "Mileystone
   planning") would license overwriting words the sweep has no business touching.

   **Correction, same day — the narrowing is inert on this harness, and the reason matters.** The
   first live sweep after the fix applied 5 of 18 renames. The 13 refusals correlate _exactly_ with
   `titleSource: user`: the desktop app enforces "a title the human typed wins" **inside its own
   rename tool**, and reports success anyway ("Renamed … (If the user had renamed it themselves,
   their title is kept)") — a soft no-op an agent cannot detect from the reply. So defect 2 was
   never solely musterd's to fix: our guard was redundant with the app's, and removing ours changes
   nothing a human can see. Hand-renamed rows are permanently the human's, by the app's rule.

   What the narrowing still buys is real but small: seat-prefixed titles that are _not_ user-typed
   (an earlier sweep's output, an auto-title that happens to lead with the seat) now gain the chip
   and stamp instead of being skipped, and the `dated`/`subject`/boundary work fixes genuine
   defects — a re-render no longer produces `🔶 Miley (Sun 9p) - Miley - x`, and seat `miley` no
   longer claims "Mileystone planning". The user-facing consequence is a **workflow** one, not a
   code one: **do not hand-rename a seat session you want labeled** — the app will honour your title
   forever after. Let the sweep name it; rename only what you want to own.

   The measurable lesson for this ADR's own method: the sweep's `apply` list is a _proposal_, and
   nothing in the pipeline reads back whether the harness accepted it. The engine's output contract
   (§Observability) therefore cannot see this class of failure at all. A future increment that wants
   the sidebar to be trustworthy has to diff the list after applying, not count what it asked for.

### What is deliberately not built

- **No musterd-side session registry.** The roster already answers seat→work; only window→seat is
  open, and that is a property of the surface being looked at, not of team state.
- **No Cursor/Codex sidebar writes.** Their stores are closed (facts 3–4); `musterd init --check`
  says so plainly instead of pretending: terminal titles only for those harnesses.
- **No Windows terminal titling in v1** (no `/dev/tty`; conhost/WT is a different mechanism).
- **No labeling for sessions in the harness's own scratch worktrees** (`<repo>/.claude/worktrees/…`,
  three of them live on 2026-07-27). `seatForCwd` resolves a seat from an `agents-<seat>` folder or
  a committed `workspace.json`; neither identifies the seat that spawned an ephemeral worktree, and
  the repo-root spec would attribute all of them to one seat. A wrong label is worse than none, so
  they stay `not-a-seat` until something actually records which seat opened them.

## Consequences

- One glance at a terminal tab or the desktop sidebar answers "which seat is this" — including for
  harnesses musterd cannot configure at all, provided their agents run the CLI.
- The terminal title is best-effort and unverifiable: an emulator may ignore OSC, a PROMPT_COMMAND
  shell or the harness itself may overwrite it, tmux needs `set-titles`. Accepted — the title is
  re-asserted on every command, and the failure mode is the status quo (an unlabeled tab).
- The sidebar sweep reads the desktop app's session records for `createdAt`/`titleSource`
  enrichment. That path is undocumented and version-fragile, so it is best-effort with an env
  override (`MUSTERD_CCD_SESSIONS_DIR`) and graceful degrade; the worst failure is a mis-dated
  label or a missed skip, never corruption — the original title always survives as the suffix.
- Renames land with `titleSource: "auto"`, so the desktop app may re-title a very young session and
  drop the prefix; the next sweep re-applies it. Live sessions are labeled too — the label marks
  seat ownership, not staleness; the timestamp carries the age signal.
- `GUIDANCE_CONTENT_VERSION` bumps with the new unit, so every existing seat shows guidance drift
  until its next `musterd init` — expected, and the doctor's drift line is the remedy pointer.

## Observability & Evaluation

- **Traces.** No spans are added. Terminal titles are intentionally unobservable — there is no
  read-back for an OSC title, the write is bounded (one small `/dev/tty` write per command, silenced
  by flag/env/skip-set), and its absence is exactly the pre-ADR world; we do not add telemetry for
  an effect we cannot measure. The sweep's observability is its output contract instead:
  `resolve-labels` reports `skipped` reasons with counts (`hand-named`, `already-labeled`,
  `too-fresh`, `not-a-seat`, …) on every run, and the applying agent reports the one-line summary
  in-band. A sweep that suddenly applies zero with rising `hand-named` or `not-a-seat` counts is the
  drift signal that the desktop app's record format moved.

  **Measured 2026-07-27 (the amendment's own evidence).** That signal fired and nobody was reading
  it: `apply: []` with `hand-named: 2, not-a-seat: 2, already-labeled: 1` on a live sample, and 3 of
  ~21 seat sessions chipped. The counts were exactly right and diagnosed the wrong-order guard on
  sight — the gap was that the sweep's output is only produced when a sweep RUNS, and none had run
  in two days. An output contract cannot observe its own trigger. The standing check is therefore
  the sidebar itself: chipped rows should accumulate; if a day's seat sessions are all bare, the
  trigger is gone, not the engine. Post-fix on the same live input: 2 applied, 0 `hand-named`.

  **And the counts still lied, one layer up.** The first real sweep proposed 18 renames and the app
  accepted 5 — the 13 refusals being exactly the `titleSource: user` rows, silently, with a success
  reply (see the correction in the amendment). `resolve-labels` reports what it _proposed_; nothing
  reports what _landed_. So the standing check is the sidebar, never the sweep's own output: list
  sessions again after applying and count chips. A metric that cannot see the acceptor is not an
  observability contract for the effect — it is one for the intent.

- **Eval.** Dataset: the captured `list_sessions` snapshot of this machine's 29 real sessions (seat
  worktrees, hand-named rows, non-seat repos), checked in as the `resolve-labels` test fixture.
  Baseline: the personal `resolve.py` sweep's decisions on that same input — 9 applied / 7
  hand-named skipped / 12 not-a-seat / idempotent second pass — which the CLI port must reproduce
  differentially (modulo the freshness-gate bugfix it deliberately adds). Unit tests cover the label
  grammar, the three-state predicate, the timestamp-preserving chip upgrade, and the full
  `terminalTitleFor` decision table; `--json` output is byte-compared with the feature on and off.
- **Experiment.** None pre-registered — this is a human-legibility affordance, not an agent-behavior
  change; ADR 056 diversity conclusions are untouched. The one open empirical question — does a
  subprocess whose stdout/stderr are redirected to `/dev/null` (the hook's stdio shape) still reach
  the terminal via `/dev/tty`? — was answered by direct probe at build time: yes. Under a pty with
  both streams redirected, the OSC title still lands (`script(1)` capture); where there is no
  controlling terminal at all (the desktop app, launchd), the open throws and the writer stays
  silent, as designed.

## Amendment (2026-07-29): the nudge rail — a sweep that must be asked for, asked until it happens

**Measured.** The trigger died again, exactly as the Observability section predicted it could: after
2026-07-27's sweep, not one ran for three days. Every new seat session received the SessionStart
instruction ("run the musterd-label-sessions skill once") and every one skipped it under a busy
first prompt — the human was hand-typing seat prefixes into the sidebar, which is the affordance
failing at its one job. The engine, the rename tool, and the instruction were all verified working
the day the gap was noticed; the missing piece was purely that a one-shot ask at session start
loses to the opening task.

**Decision.** The ask repeats until it is satisfied, and satisfaction is machine-checkable:

- `musterd session resolve-labels` now **stamps** a machine-wide last-sweep file
  (`~/.musterd/label-sweep.json`, env-overridable) on every run — an empty `apply` is still a sweep.
- New `musterd session label-nudge`: prints one imperative line while the stamp is missing or stale
  (>4h), and nothing otherwise. Hook-shaped: silent-or-one-line, never fails.
- The hand-pasted `UserPromptSubmit` recipe (docs/harness-hooks.md) becomes a **managed machine-wide
  hook** (marker `musterd-promptsubmit-hook`, absorbing the recipe by signature), carrying the
  status_update ritual plus `label-nudge`. Per-turn is the point: the status_update nudge on this
  same rail is demonstrably obeyed, and repetition-until-stamped converts "documented" into
  "happens". The SessionStart orientation drops its always-on label clause for the same due-gated
  call.
- `FEATURE_EPOCH` 3 → 4: both machine-wide hooks changed text, and the ADR 168 downgrade guard only
  protects across a bump (equal epochs overwrite), so without it any older checkout's `init` would
  quietly restore the one-shot world.

Self-quieting is the load-bearing property — one seat's sweep silences every seat's nudge for 4h,
so the steady state is one sweep per working stretch, not one per session. The failure mode of a
lost stamp is one redundant nudge, never a broken sweep.

**Observability.** The standing check stays the sidebar (chips should accumulate), but the trigger
itself is now observable where it wasn't: the stamp file's age *is* the trigger's health, and
`label-nudge`'s output in a transcript shows the ask firing. If chips stop accumulating while the
stamp stays fresh, sweeps are running but renames are not landing (the acceptor layer); if the
stamp goes stale for days, agents are ignoring even the per-turn line — escalate past nudging.

### Amendment 2026-07-30 — forever-loop fix + cross-harness capabilities

Superseded in part by [ADR 186](186-cross-harness-session-labels.md):

1. **Nudge due keys off evidence, not stamp age.** Stamp age re-armed forever while the same
   soft-refused `titleSource: user` rows stayed unlabeled (lane 01KYSY7JNB). `label-nudge` now runs
   `resolveLabels` over CCD rows and fires only when `apply` would be non-empty; stamp age is the
   fallback when CCD is unreadable (ADR 173).
2. **All `titleSource: user` rows are skipped** — including seat-form hand titles. The 2026-07-27
   narrowing remains right in principle and was inert+harmful on Desktop's soft-refuse.
3. **Cursor is `self_rename`, not "no sidebar".** `rename_chat` labels the current chat only;
   Codex stays write-`none` (titles are readable). Terminal OSC remains the universal path.
