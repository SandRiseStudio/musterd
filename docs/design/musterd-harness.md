# The musterd harness — does musterd run the loop? (design, 2026-09-21)

> **Status: DECIDED in [ADR 436](../decisions/436-wake-edge-is-a-contract-not-a-loop.md) —
> the wake edge is a contract the host enforces around every backend; musterd does not take over
> the loop; a dated trigger names when that is revisited.** This document is the durable _why_:
> what was measured, what the options were, and why the smallest honest step is a contract, not a
> harness. It freezes with the ADR. Increment 5 of the `seat-continuity` goal, lane `01M32FJ8T4`,
> a design conversation between nick and stanley.

Companions: [ADR 251](../decisions/251-native-backend-musterd-as-its-own-harness.md) (the native row
that already exists), [ADR 131 §7](../decisions/131-harness-residency-wake-ledger-host.md) (the
actuator seam), [ADR 209](../decisions/209-portable-wake-context.md) / [ADR 430](../decisions/430-wake-context-packet-v2.md)
(the packet), [ADR 364](../decisions/364-tokens-are-the-attested-unit-when-the-harness-prints-no-price.md) (unpriced is a fact, not
zero), the measurement page [resume-bound-is-below-one-wake-life](../wiki/resume-bound-is-below-one-wake-life.md),
and `docs/superpowers/plans/2026-09-21-seat-continuity.md` (the increment ladder this closes).

## 1. The question as it was asked, and as it stands

The lane was opened on 2026-09-21 morning with this brief: after ADR 426, 129 of dolly's 284 KiB
wake life were three harness attachments present before the seat acted; ~190 KiB / ~22k tokens
is the price of arriving with zero tool calls, 45% of a life, and musterd cannot cut it because
musterd does not own the loop. Nick's framing: every seat, on any harness, model or surface, must
reach every other seat live — is this where a musterd meta-harness starts?

By the afternoon increment 4 had reframed it. The v2 packet ([ADR 430](../decisions/430-wake-context-packet-v2.md))
gave a fresh spawn the same correct first act as a transcript resume on Claude Code, at half the
cost, and the same on Codex. Continuity — the original argument for musterd owning the loop —
holds on the packet alone. What was left on the harness side was four separate things:

1. the per-life floor of harness-injected context;
2. Codex wakes unpriced and, once, a resumed Codex session that read the packet and never acted;
3. the wake edge itself, where the day's defects lived (re-leasing discharged acts, replaying a
   dormant seat's backlog);
4. guidance drift — a seat's primer and skills go stale per Workspace, per harness.

Before deciding, nick asked that the claim be tested on the harnesses it had not been tested on.

## 2. What the four-harness run showed

Arms D (grokbot, Grok CLI) and E (ghost, OpenCode) ran the same three-act thread as arms A–C the
same afternoon (details and falsifiers on the wiki page above). The first act was correct on all
four harnesses that have a wake backend. Everything around the act varied:

| harness     | reads before first act               | first act        | musterd's cost view                        | edge defect hit                                                |
| ----------- | ------------------------------------ | ---------------- | ------------------------------------------ | -------------------------------------------------------------- |
| Claude Code | 0                                    | correct, thread  | priced (`cost_usd`)                        | re-lease of an answered steer (lane 01M32V416B)                |
| Codex       | 1                                    | correct, thread  | tokens only, no price                      | resumed + packet → no act; dormant backlog replayed             |
| Grok CLI    | 2 (its own tool list, the seat skill) | correct, thread  | **nothing** — no settle, no cost row       | dead session read live for 10 min; `usage.json` never read      |
| OpenCode    | 3 + 1 malformed send                 | correct, no thread | `harness_cost_usd 0` on a free model, unverified | capture row says `claude-code`; 3 wakes on one act it never discharged |

Two facts from this table drove the decision.

**The floor is harness-specific and musterd sees it on one harness.** Grok's own usage file shows
284,583 input tokens over four model calls for a one-line reply — an 11.5 KiB system prompt, a 60 KiB
tool-definitions file, 26 KiB of ingested `Claude.md`, a plugin-skill announcement — against 38k
tokens for the whole Claude Code life. The 45% number in the brief was a Claude Code number.

**Every defect the run hit lived in a harness-specific wake path, and none lived in the packet.**
Settle, price, capture, liveness, discharge — each backend does some of these and not others, and
the host does not check. Codex had the settle/price gap until lane 01M1G310Y7 closed it; Grok has
it today. The seam ([ADR 131 §7](../decisions/131-harness-residency-wake-ledger-host.md)) is
honest about what it asks (`outcome`, `settled`), and `settled` resolving to `undefined` is a
legal answer that makes a wake vanish from the ledger.

## 3. Three readings of "musterd owns the wake edge"

The conversation settled the problem first (control of the wake edge, not cost, not "measure
first") and then the shape:

- **(i) Own the loop, one engine.** Route every wake through the ADR 251 native backend. Every
  wake becomes Claude; CLI backends become dev-only. Cleanest edge; kills the model diversity that
  [ADR 056](../decisions/056-research-as-first-class-practice.md) / [ADR 101](../decisions/101-model-as-a-variable.md)
  exist for; phase 1 is coordination-only and cannot do a handoff's work.
- **(ii) Own the loop, one engine per provider.** The native backend grows Anthropic, OpenAI, xAI
  and OpenCode-provider engines. Diversity survives; musterd maintains four SDK integrations and
  their price tables. Big, and it re-derives what each CLI already does well.
- **(iii) Own the edge, not the loop.** Keep spawning the CLIs. The host enforces one wake contract
  around any child: settle always, cost row always, capture with the harness the host spawned,
  liveness that knows a wake ended, discharge defined and told to the seat. The native backend stays
  the reference row and grows on its own schedule.

Decided: **(iii)**, with (ii) as the dated trigger. The bugs were contract holes, not loop holes.

## 4. The wake contract (five clauses)

Each clause is something the run found missing on at least one backend. Each becomes a
host-side guarantee — enforced in the loop that drives `ActuatorBackend`, not left to the
backend's courtesy.

1. **Settle.** Every wake yields a `run … settled` line and a `residency.wake_cost` row. A backend
   whose `settled` resolves with nothing gets a duration-only row stamped by the host with an
   `unpriced_reason`. Falsifier: a Grok wake with no cost row on a daemon carrying the clause.
2. **Price.** Each backend has a cost reader over the artifact its harness actually writes —
   Claude Code's result line, Codex's usage event, Grok's `usage.json` (`inputTokens`,
   `cachedReadTokens`, `outputTokens`, `modelCalls`, `costUsdTicks`), OpenCode's per-step
   `tokens`/`cost`. A reader is a pure function per harness with a fixture test cut from a real
   file. Unpriced stays honest and named ([ADR 364](../decisions/364-tokens-are-the-attested-unit-when-the-harness-prints-no-price.md));
   a free model's `0` is `harness_price_unverified`, never a price.
3. **Capture.** `residency.session_captured` carries the harness the backend spawned, stamped by
   the host at spawn, not inferred from whichever workspace hook fired. Falsifier: an OpenCode
   wake captured as `claude-code`.
4. **Liveness.** A wake that settled is over: the host marks the captured session ended when the
   child exits, so the local-session guard ([ADR 166](../decisions/166-session-liveness-by-enumeration.md))
   cannot read a dead session's file as live until `LOCAL_SESSION_LIVE_MS` lapses.
5. **Discharge.** What discharges a wake act is `accept`, `decline`, or `resolve` on its thread.
   The composed wake line says so in words, on every harness. A `message` reply is recorded as an
   answer that did not discharge; the act is not re-leased at the next window — it waits for the
   lane owner or a human rather than waking the seat again. (Ghost was woken three times on one
   act it answered each time; grokbot's handoff was re-leased two minutes after a correct reply.)

Out of scope here, deliberately: any change to the packet (ADR 430 stands); any attempt to shrink
what a harness injects (that is problem 1 above, not decided); cursor-agent, which has no wake
backend and is excluded explicitly rather than silently.

## 5. The measurement rail and the trigger

One per-harness table derived from the wake ledger — floor tokens before first act, reads before
first act, priced or not, first act in thread or not. The four arms are its first rows. The
revisit reads from it, not from a fresh argument.

**Revisit (ii)** — own the loop with an engine per provider — when, after thirty days of the
contract being enforced (from the day clause 1 lands on the daemon), either holds: a backend
still cannot be priced from its own artifact, or the median floor on any harness exceeds three
times Claude Code's. Otherwise the contract is enough and ADR 251 phase 2 proceeds on its own
charter, unhurried by this goal.

## 6. What ships from increment 5

This document, ADR 436, and the goal-linked lanes, opened before the lane closes: settle + price
`01M32ZKP4Z` (the defect lane filed from the run, claimed by stanley), capture `01M3309Y1V`,
liveness `01M3309Z28`, discharge `01M330A04F` (depends on `01M32V416B`), rail `01M330A14T`. The
last four are unowned. Nothing else builds inside increment 5.
