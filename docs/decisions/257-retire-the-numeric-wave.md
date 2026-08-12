# 257 — Retire the numeric wave

- Status: accepted
- Date: 2026-08-12
- Deciders: nick (directed), miley (carried)
- Amends: [ADR 048](048-plan-goal-work-item-model.md) / [ADR 084](084-lanes-join-the-plan.md) —
  the declared-Goal skeleton loses the numeric `wave`; `'later'` survives as a shelf marker.
- Amends: [ADR 103](103-steer-challenge-defer-acts.md) — `defer` no longer carries a target
  position. It has one meaning: shelve the Goal.
- Follows: [ADR 256](256-goals-are-the-boards-front-door.md) — whose story pass surfaced this.

## Context

`Goal.wave` was a build-order rank: an integer, or `'later'` to sort last. Four consumers read
it — `nextGoal`, the orientation brief, the `no_goal` suggestion, and the web goal grid — each
with its own private copy of the same rank function, all collapsing `null` and `'later'` to
`+Infinity`.

That collapse is the defect. **An unset wave was indistinguishable from a deliberately shelved
one**, so a Goal nobody had ranked sorted behind every Goal anybody ever had. Which would be
tolerable if new Goals got ranked — but they could not be. The numeric half of the union was
unreachable over MCP: `team_goal_declare {wave: 7}` was rejected while `{wave: 'later'}` passed,
because the union publishes as JSON-Schema `anyOf[integer, const]` and the tool boundary could
not type it. Every Goal declared by an MCP seat was therefore waveless, permanently outranked.

The evidence on revive, at the time of writing: the four most recent Goals — `goals-front-door`,
`wake-pricing`, `eligible-sets`, `value-layer` — all carried no wave, while every waved Goal
dated from the CLI era. `team_next` recommended `insight-dashboard` (wave 7, declared by a seat
no longer working on it) over every arc the team was actually building. The field was not idle;
it was actively mis-steering the board, and had been for an era.

The deeper problem is that a hand-maintained global sequence has no back-pressure. Nothing tells
you a rank has gone stale, nobody is accountable for re-ranking, and the cost of being wrong is
paid by whoever reads the board next. `depends_on` does not have this problem, because it states
a fact about the work that stays true.

## Decision

**The numeric wave is retired. `'later'` stays.**

1. **`Goal.wave` is `'later' | null`.** `'later'` means shelved — an explicit, human act.
   `null` means the ordinary unset, and it no longer means "last".
2. **Ordering is one shared comparator**, `compareGoals` in `@musterd/protocol`, used by all
   four consumers so they cannot drift apart again: shelved last, then `in-flight` before
   `planned` before `shipped`, then **most recently declared first**.
3. **Recency replaces the rank.** Declaring or re-declaring a Goal _is_ the statement that the
   team cares about it now, so the ordering maintains itself. There is no rank to keep fresh
   and therefore no rank to go stale.
4. **`depends_on` is untouched** and still outranks everything: a Goal blocked by an unshipped
   dependency is not a candidate at all. Dependencies are correctness; ordering is preference.
   This split is why removing the rank costs nothing — the hard constraint was never the wave.
5. **`defer` means shelve.** It no longer takes `meta.wave`. A pre-257 `defer` carrying a
   number replays as a plain shelving, which is what the word always meant.
6. **The write paths close**: `DeclareGoalSchema.wave` and the MCP tool accept only `'later'`,
   and `musterd goal declare --wave <n>` fails at the call site with the reason and a pointer
   to `--depends`, rather than shipping a number to the server for a bare schema rejection.

### The read path stays open — deliberately

The journal is append-only and pre-257 declarations carry `wave: 7`. `listGoals` parses each
declaration with `GoalDeclareMetaSchema` inside a `try` and **skips rows that fail**, so a
schema that stopped accepting integers would not produce an error — it would silently delete
`insight-engine`, `insight-dashboard`, `board-loops`, `coordination-density`,
`cookoff-value-experiment` and `harness-residency` from the board, with no message anywhere.

So `LegacyDeclaredWaveSchema` keeps accepting an integer on read, and the fold coerces it to
`null`. History stays readable; the number orders nothing. Three tests in
`goals.test.ts` pin this — a legacy Goal survives the projection, its old rank orders nothing,
and a legacy `defer` replays as a shelving.

## Observability & Evaluation

- **Traces.** Goal declarations and `defer`s are already durable acts in the journal, and
  `next_goal` is derived on every `team_next`. Nothing new to instrument: the question "what did
  the board recommend, and did anyone take it" is answerable from the existing log by joining
  `next_goal` at time T against the `goal_id` of the lanes claimed after T.
- **Eval.** Dataset: the revive journal, ~12 declared Goals and the lanes attached to them.
  Baseline (measured pre-change, 2026-08-12): `nextGoal` returned `insight-dashboard` — a Goal
  with **zero lanes opened against it in the current era** — while every lane actually being
  claimed belonged to `goals-front-door`, `eligible-sets`, `wake-pricing` or `value-layer`. So
  the baseline agreement rate between "what the board recommended" and "what seats did" was 0/4.
  The bar after this change: the recommended Goal should be one seats are actually claiming
  lanes on. Re-measurable by the same join at any point.
- **Experiment.** The honest risk is that recency is _also_ wrong — that it just replaces a
  stale rank with a recency-chasing one, e.g. after a cosmetic amendment moves an idle Goal to
  the front. The check is the same join a few weeks on: if recommended-vs-claimed agreement is
  still poor, the answer is not a third ordering heuristic but to stop recommending a single
  next Goal at all and let `depends_on` plus the grid speak for themselves. That is the
  pre-registered fallback, not a new ADR's worth of design.

## Consequences

- `team_next`, the orientation brief, the `no_goal` suggestion and the web grid all lead with
  the most recently declared unshipped Goal instead of the oldest ranked one. On revive this
  changes the recommendation from `insight-dashboard` to the arcs actually in flight.
- Goals carrying legacy numbers keep them in the log forever but read as `wave: null`. Nobody
  needs to migrate anything, and no re-declaration is required.
- **The curated public roadmap (`content/roadmap.data.ts`) keeps its waves, deliberately.** Its
  `Wave` is a different artifact with a different failure mode: hand-curated editorial groupings
  with prose labels ("Wave 3: Reach + the second-product seed"), published as a document and
  maintained as one. It is not derived from, and does not steer, the coordination board. The
  vocabulary does fork — ADR 098 would otherwise object — and this is the fork being named
  rather than left implicit: _wave_ is a roadmap word now, not a Goal word.
- The open lane "a numeric Goal wave can't be declared over MCP" is closed by deletion rather
  than repair. The `anyOf` tool-boundary limitation is real and will bite any future union-typed
  tool argument; it is recorded here so the next one is diagnosed in minutes rather than
  mistaken for a stale bridge.
- Ordering by recency means a Goal amended for an unrelated reason (a story pass, a title fix)
  moves to the front. That is a genuine wart. It is accepted because the alternative — a rank
  someone must remember to maintain — is what produced the state this ADR is fixing, and because
  an amendment is at least _evidence someone looked at the Goal recently_, which a stale integer
  is not.
