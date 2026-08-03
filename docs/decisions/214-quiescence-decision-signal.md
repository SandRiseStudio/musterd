# 214 — Quiescence: a decision-grade "busy right now" read, split from display activity

- Status: accepted
- Date: 2026-08-03
- Related: ADR 010 (two-clocks), ADR 140 (idle rename), ADR 155 (human idle decay), ADR 131/189
  (wake pool / wakeability facts), ADR 169 (absent-vs-unknown), PR #612 (settle window)
- Design conversation: docs/superpowers/specs/2026-08-03-quiescence-signal-design.md (approved by
  nick, 2026-08-03)

## Context

`activity` (`offline | idle | working`) answers a **display** question: "has this live seat
self-reported a task?" (ADR 010, renamed by ADR 140 without touching semantics). For agents it is
sticky by design — one `status_update` reads `working` until the seat goes offline; only humans get
the ADR 155 decay. Measured 2026-08-03 on the dogfood machine:

- gating a daemon bounce on live connections would have deferred **95% of refreshes** (184/192) —
  seats stay attached all day, so "connected" cannot mean "busy";
- the audit trail meanwhile showed **44 genuine lulls ≥ 2 min in 6 busy hours** — the team is
  usually quiet even when everyone is attached;
- `activity` is consumed almost entirely for rendering (roster, posture chip, office scene);
  nearly nothing makes a decision from it, and each subsystem that needed a decision-grade signal
  (bounce timing, wake spend, acceptor routing) invented a proxy or went without.

## Decision

Split display from decision. `activity` keeps its ADR 010/140 semantics untouched. The protocol
gains a **derived, never-stored** decision read:

```ts
QuiescenceSchema = {
  state: 'busy' | 'quiet' | 'unknown',
  quiet_for_ms: number | null,
  source: 'audit' | 'harness',
};
```

1. **Derived from the audit trail** — the newest audited action per member (tool calls, sends,
   lane ops), computed at read time. No new writers, no schema migration.
2. **Thresholds live in the consumer.** The wire carries `quiet_for_ms`; the busy/quiet line is a
   caller parameter. A server-side threshold would recreate `activity`'s one-size-fits-nobody.
3. **`unknown` is load-bearing** (the ADR 169/189 absent-vs-unknown discipline): no audited action
   inside the lookback (1h) is unknowable, not "quiet". Every consumer must degrade to its
   without-this-signal behaviour on `unknown` — never treat it as license to act.
4. **`source` is the capture-tier seam.** `audit` is universal (covers hook-less harnesses —
   Codex has no hook path). A future `harness` tier (turn-boundary hooks, ground truth for
   "mid-turn") refines per seat without changing the shape. Pre-registered, not built.
5. **Read surfaces:** `GET /health` gains `quietest_busy_ms` (minimum quiet age across live agent
   seats; **omitted** when unknown — absence, never zero, since zero means "acted just now").
   `MemberSummary.quiescence` (optional) lands with the wake-selection increment, sequenced behind
   ADR 210 (its lane routes to that work's owner for review).
6. **First consumers:** the auto-refresh tick's quiet floor (land a bounce in a lull; the #612
   staleness cap forces through this gate exactly as it forces through the settle window), then
   ADR 189 wakeability as an optional mark-not-filter fact.

Agents only: a human's audited actions are a human at a terminal; the cost this guards (dropping a
seat mid-tool-call) is an agent cost, and humans get the operator notification before a forced
bounce.

## Consequences

- Additive and self-degrading in both directions: an old daemon omits the field (consumers behave
  as before it existed); an old client ignores it. No `FEATURE_EPOCH` bump (the ledger says err
  toward not bumping; nothing here involves a downgrade guard).
- The display surfaces (`activity`, posture, `/live`) are untouched — a seat may render `working`
  from a status_update while quiescence reads `quiet`; that is correct, not a conflict, because
  they answer different questions.
- Codex seats are `audit`-tier until Codex grows hooks — a labelled non-uniformity, not a hidden
  one.

## Observability & Evaluation

**Traces.** `/health.quietest_busy_ms` is itself the instrument — any client can watch the exact
signal the tick decides from. Every quiet-floor hold is logged with the seat-age and cap it weighed
(`a seat is actively working (last action Ns ago; quiet floor Fs) — holding…`), so a hold is never
silent and "waiting for a lull" stays distinguishable from "stuck" in refresh.log. The inputs
(audit-row timestamps, live presences) already exist; no new emission.

**Eval.** Replay the merge trace: bounce count per day and mid-action bounces (a bounce landing
within the quiet floor of an audited action) are both derivable from refresh.log + the audit table.
Success = fewer mid-action bounces at equal freshness (staleness stays capped by #612's
`--settle-cap`); the pre-change baseline is measured in this ADR's Context (19 bounces/day, 95%
with live sessions). Regression watched: total deferral time per catch-up, which the cap bounds.

**Experiment.** The `unknown` rate — live agent seats with no audited action in the lookback — is
auditable from the same tables and is the decision variable for the pre-registered harness tier: a
rising `unknown` rate (or measured mid-turn bounces that the audit proxy missed) triggers building
turn-boundary hook capture, rather than tuning thresholds on a signal that lacks the information.
