# 256 — Goals are the board's front door

- Status: accepted
- Date: 2026-08-12
- Deciders: nick (directed), miley (carried)
- Spec: `docs/superpowers/specs/2026-08-12-goals-front-door-design.md` · plan:
  `docs/superpowers/plans/2026-08-12-goals-front-door-plan.md`
- Amends: [ADR 084](084-declared-goals-general-teams.md) — the declared-Goal seam gains a
  `story` field and, for the first time, mechanical consequences on lanes.

## Context

Goals were declared and then ignored. On revive, 14 lanes out of ~400 carried a `goal_id`:
declaration worked (ADR 048/084), but nothing anywhere made attachment matter — no verb
read it, no surface led with it, no nudge asked for it. The web board opened on a kanban of
lane states, which answers "what state is each card in" and never "what is this team trying
to do". A stranger — nick's own test, the founding brief for the board — could not tell.

## Decision

Goals become the board's top level, and a goal-less lane is **warned, never refused**.

1. **`no_goal` lane warning** — advisory, `owner: null`, never a directed wake. Emitted in
   the opener's/claimer's own verb result at open, and by `laneWarnings`/`boardWarnings`
   while the lane is contending, whenever the team has unshipped goals and the lane names
   none. `with` suggests the first unshipped goal by wave.
2. **`Goal.story`** — an optional ≤140-char plain-language line for the outsider, declared
   with the goal (`team_goal_declare {story}`), amendable by re-declaration, carried
   through store → projection → MCP render → web.
3. **`team_next` leads with goals** — the brief opens with the unshipped goals
   (wave-ordered, in-flight first at equal wave), `up_next` serves goal-attached lanes
   first, and a served goal-less lane carries a one-line link-it nudge.
4. **Acceptance nudge** — the close-time ask on a goal-less lane appends "if it advanced
   one, link it (lane_update {goal_id}) before resolving". Appended, never blocking.
5. **The web board defaults to a goals grid** — mission cards ("What's being worked on"),
   one per unshipped goal, each with a runway of its lanes rolling backlog · working ·
   review · shipped 🏁, a dashed "Not on a goal yet" card last, shipped goals on a slim
   shelf, and drill-in to the filtered columns (`?goal=` deep link). The `/live` overlay
   leads with the same grid (resolving the 2026-07-31 columns-only hold). A team with no
   declared goals falls back to columns.
6. **`FEATURE_EPOCH` 9 → 10.** An epoch-9 seat neither emits nor renders any of this.

## Alternatives rejected

- **Hard gate (refuse a goal-less open/claim).** Produces garbage attachment — lanes
  pinned to whatever id silences the gate — and breaks the house warn-first posture
  (ADR 083: a warning never fails a verb).
- **Derived clustering (group lanes by surface/branch similarity).** Machine clusters are
  not intentions; the board would assert missions nobody declared. Declaration stays the
  only source of a goal (ADR 234's actor-over-inference posture).
- **Close-time-only nudge.** Cheapest tooth, but the board stays ungrouped exactly while
  the work is in flight — the stranger's question goes unanswered when it matters.

## Observability & Evaluation

- **Traces.** A lane opened/claimed goal-less while unshipped goals exist carries one
  `no_goal` row in the verb's `warnings` (and on the board while contending), always
  `owner: null` — a directed wake attributed to this kind is a defect. `lane.ready_for_review`
  asks on a goal-less lane carry the link-it sentence in the ask body.
- **Signal:** goal-attachment rate — lanes opened with a `goal_id` over all lanes opened,
  before vs after. The baseline is on the record: 14 of ~400 (~3.5%). If the warning and
  the grid work, new lanes should attach at a majority rate within two weeks; if the rate
  stays flat, the teeth are decoration and the next step is a redesign, not a louder nudge.
- **Signal:** `no_goal` warning volume on the board — should spike at rollout (expected,
  the backlog is unattached) and then decay as owners link or lanes close. A volume that
  never decays means the nudge is being read as wallpaper.
- **Check:** `deliverLaneWarnings` wakes nobody for `no_goal` (`owner: null` is asserted
  in `lanes.test.ts`); any directed wake attributed to this warning kind is a defect.
- **Eval.** Direct assertion in the suites: warning matrix (attached / no goals / shipped-only
  / backlog lane) in `lanes.test.ts`; acceptance-ask presence/absence in the integration
  suite; grid model edge cases in `goalGrid.test.ts`. Plus the stranger test that motivated the board — open `/board` cold and answer
  "what is this team trying to do" from the grid alone. Cheap, manual, repeat after
  rollout with nick.
- **Experiment.** None — a surface + advisory-warning change, not a model-behavior claim.
  The attachment-rate signal above is the observational follow-up.

## Consequences

- Day one is loud by design: nearly every contending lane on revive carries `no_goal`
  until owners link or declare. The board renders one warning detail per card
  (last-wins), and nobody is woken for it.
- Rollout (operational, post-merge): add stories to the existing goals, declare the
  running arcs, retire the scratch goals, then let the warnings prompt lane owners.
- The board's stored view preference migrates: legacy `'goals'` (swimlanes) reads as the
  grid; nothing stored defaults to the grid exactly when unshipped goals exist.
