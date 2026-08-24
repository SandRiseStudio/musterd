# 316 — `idle` becomes `active`, and `working` decays for agents too

- Status: accepted
- Date: 2026-08-24
- Related: ADR 010 (two clocks), ADR 138 (posture — amended), ADR 140 (idle rename — superseded on
  the token), ADR 155 (Inc 3 decay — amended), ADR 148 (`behind` hint), ADR 315 (offline split)
- Spec: docs/superpowers/specs/2026-08-19-presence-honesty-design.md §2.1 + §3 (rollout lane 2)

## Context

`resolveActivity` passed the decay window for humans only, so a live agent had exactly two
observable states: working-while-online and vanished — nick has never seen a member `idle`, and
that is why. And "idle" was always the wrong word: it described the absence of a fresh claim, not
rest.

## Decision

1. **Decay for everyone.** `working` requires fresh evidence: a `status_update` within the window,
   or a live steering link (steering keeps outranking decay). Humans keep `presenceTimeoutMs`
   (45 s); agents get `agentIdleMs`, default **15 min**, env-overridable via
   `MUSTERD_AGENT_IDLE_MS`. Accepted consequence: a heads-down agent reads `active` with a stale
   claim — the claim *is* stale; hooks nudge status at task boundaries.
2. **The claim is kept with its age, never erased.** A decayed read keeps `state` and
   `last_status_at` (previously the decay nulled `state`). Renderers show
   `last: "<status>" · 20m ago` (`activeClaimLine` in the web package; coarse crumb, precision on
   hover) — `no status yet` when there is nothing to age.
3. **Rename `idle` → `active` on the wire** — activity and posture both, not a display alias
   (ADR 138's rule: clients render the wire token). `active` says what it is: connected, between
   claims. Legacy `idle` is accepted on read and normalized to `active` in the zod schemas.
4. **Feature epoch 13.** Same additive-enum shape as ADR 232/315; the web roster's per-row
   tolerant parse plus the `behind` chip cover the skew window.

Deriving stays from `last_status_at` only; `quiescence` (ADR 219) remains decision-grade and out of
posture.

## Observability & Evaluation

- Traces: the roster wire carries `activity`/`posture` per member; a decayed read is
  distinguishable (activity `active` with non-null `state` + `last_status_at`) from a
  never-reported one (both null).
- Eval: the spec's own symptom — "nick has never seen a member idle" — is the baseline; success is
  `active` appearing on real rosters within a day of deploy (dataset: the live team's roster over a
  normal working day).
- Experiment: the 15 min default is a guess held loosely; if seats flap desk↔couch or wear stale
  claims too long, tune `MUSTERD_AGENT_IDLE_MS` before touching code.

## Consequences

- The office floor's leisure furniture is finally reachable for agents (the seating zone keyed on
  the `active` posture); the honest walk desk→couch on decay ships with the existing choreography.
- Every renderer (CLI rows, MCP format, web chips/seating) speaks `active`; local state machines
  that happened to use the word "idle" (connection status, receptionist beats, autorefresh mode)
  are untouched — they were never the wire token.
