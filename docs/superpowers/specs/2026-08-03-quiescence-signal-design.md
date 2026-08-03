# Quiescence: a decision-grade "is this seat busy right now" signal, split from display activity

- Date: 2026-08-03
- Author: izzo (design conversation with nick)
- Status: approved design, pre-implementation
- Related: ADR 010 (two-clocks), ADR 140 (idle rename), ADR 155 (human idle decay), ADR 131/189
  (wake pool), ADR 169 (`no_candidate` absent-vs-unknown), PR #612 (settle window)

## Problem

`activity` (`offline | idle | working`) is the only "is this seat busy" signal musterd has, and it
answers a *display* question: "has this live seat self-reported a task?" For agents it is sticky —
one `status_update` and the seat reads `working` until it goes offline (the ADR 155 `idleAfterMs`
decay is humans-only, deliberately). Measured 2026-08-03:

- 95% of daemon auto-refreshes happened with live sessions (184/192) — `connections > 0` cannot
  mean "busy", or the daemon never updates during a working day;
- `activity` is consumed almost entirely for rendering (roster, posture chip, office scene); almost
  nothing makes a decision from it — every subsystem needing a decision-grade signal invented its
  own proxy or went without;
- meanwhile the team is *actually* quiet most of the time: 304 audited actions in 6 busy hours with
  44 lulls ≥ 2 min (269 of 360 minutes quiet).

Three consumers now need the decision-grade answer at once: autorefresh bounce timing (when is a
restart least disruptive), wake selection (is this seat mid-something before we spend on waking or
displacing), and acceptor routing (who is free to review).

## Decision

**Split display from decision.** `activity` keeps its ADR 010/140 semantics untouched — no consumer
migrates, no rendering changes. A new **derived, never-stored** read answers the decision question:

```ts
quiescence: {
  state: 'busy' | 'quiet' | 'unknown';
  quiet_for_ms: number | null;      // null iff state === 'unknown'
  source: 'audit' | 'harness';      // which tier answered (only 'audit' is built now)
}
```

Computed at read time from the newest audited action per member (tool calls, sends, lane ops — the
timestamps the daemon already writes). No new writers, no schema change, no migration.

**Thresholds live in the consumer, not the signal.** The daemon reports `quiet_for_ms`; autorefresh
decides what is bounceable, wake decides what is spendable. One server-side threshold would
recreate `activity`'s one-size-fits-nobody problem.

**`unknown` is honest and load-bearing.** A member with no audited action in the lookback window is
not "quiet" — it is unknowable. Same absent-vs-unknown discipline as ADR 169's `no_candidate` and
ADR 189's omit-what-you-don't-know facts. Every consumer must treat `unknown` as "degrade to
today's behaviour", never as license to act.

**Layered capture, audit floor first.** The audit tier is universal (works for every harness,
including hook-less Codex) and ships now. A future harness tier — hooks reporting turn boundaries,
i.e. ground truth for "mid-turn" — refines it where hooks exist; the `source` field is the seam it
slots into without breaking consumers. Pre-registered, not built: Codex stays `audit`-tier until it
grows hooks, a non-uniformity we label rather than hide.

## Read surface

- **`GET /health` gains `quietest_busy_ms`**: the minimum `quiet_for_ms` across live agent seats
  ("the most recently active seat acted N ms ago"; absent when no live agent seat has a known
  quiescence). Autorefresh needs one number and already polls /health — no auth, no new endpoint.
- **`MemberSummary` gains optional `quiescence`** on the authenticated roster read, beside
  `wakeable`. Existing clients ignore it untouched.
- **No events/subscriptions.** Both consumers poll on their own cadence. YAGNI until a consumer
  can't poll.

## Consumers (increment 1 scope: both of these, nothing else)

**Autorefresh.** The settle-window tick (#612) gains a third gate, after "tip held still" passes:
prefer a moment when `quietest_busy_ms ≥ quiet-floor` (default 120 000 ms; flag `--quiet-floor`,
`0` disables). Reuses #612's safety shape verbatim: the staleness cap still forces a bounce
regardless, so quiet-seeking can only *delay toward a lull*, never cancel. `unknown` → bounce.

**Wake selection.** `wakeabilityFromFacts` (ADR 189) gains an optional quiescence fact,
mark-not-filter like every fact there. Explicitly does NOT touch ADR 210 resume logic; the wake
increment lands sequenced behind stanley's exact-match continuity work and as a PR he reviews.

## Increments

1. Protocol type + server derivation + `/health` field. Pure-function tests over synthetic audit
   timelines, including every `unknown` case.
2. Autorefresh quiet-floor gate, extending the #612 test suite.
3. (post-ADR-210) Wakeability fact + roster field, sequenced behind and reviewed by stanley.

Future (pre-registered, unbuilt): harness tier via turn-boundary hooks; acceptor-routing adoption.

## Non-goals

- Changing `activity` semantics, rendering, posture, or anything in `/live` (miley's surface).
- Server-side thresholds; events; storing quiescence; building the harness tier now.
