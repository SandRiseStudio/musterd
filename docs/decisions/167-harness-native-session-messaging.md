# 167 — Harness-native session messaging: observe the side channel, then make it a delivery rail

- Status: draft — 2026-07-27. Authored by stanley (lane `01KYJYPH5894Y327A1XSNX41TX`).
  Number pinned against origin/main at 166.
- Date: 2026-07-27
- Builds on: [ADR 163](163-actor-attestation-tool-boundary.md) (the emit-only observer shape this reuses),
  [ADR 150](150-structural-inducement-pretooluse-gates.md) (the PreToolUse plumbing it rides),
  [ADR 088](088-interrupt-line-tool-boundary-inbox-check.md) and
  [ADR 131](131-harness-residency-wake-ledger-host.md) (the reachability ladder this slots into),
  [ADR 160](160-seat-session-labels.md) (the first musterd use of the desktop session surface),
  [ADR 128](128-recipient-scoped-message-reads.md) (the injection constraint every delivered line
  obeys), [ADR 090](090-per-recipient-delivery-status.md) (delivery as derivation),
  [ADR 153](153-ask-reachability-gated-hold.md) (the additive daemon-computed hint precedent).

## Context

Claude Code Desktop now ships an internal MCP server, `ccd_session_mgmt`, whose `send_message` tool
pushes a message from one live desktop session into another on the same machine. Delivery is a user
turn injected into the recipient's conversation within seconds, labelled "From {sender session's
title}". Nick watched it fire organically — a session in `/Users/nick/lab` messaged another session,
unprompted, because the tool was simply there.

Two facts about this capability, verified against the live tool schema and the CLI:

- Input is `{message, session_id}`. The sender picks a target from `list_sessions` and writes
  arbitrary text straight into the recipient's next turn.
- The tools exist **only inside desktop-app sessions**. The `claude` CLI has no send path, and the
  tool is unavailable in unattended sessions (scheduled runs, remote dispatch) and cannot deliver to
  them. Nothing outside a live attended session can push.

For musterd this is the same object seen from two sides.

**Seen from the ledger, it is the anonymous side channel this system exists to replace.** A
`send_message` between two seated sessions carries no seat, no lane, no model attestation, and never
touches the ledger. Two seats coordinating over it are invisible to the ADR 150 gates, absent from
the ADR 090 delivery views, and unattributable in the ADR 056 diversity data. The cell-D experiments
spent weeks measuring route-arounds through git; this is a route-around that ships in the harness
and costs one tool call.

**Seen from the reachability ladder, it is the rung we have been building toward from the far side.**
Today a directed act reaches its recipient at the recipient's _next tool call_ (ADR 088, and only
for interrupt-class acts), or when the ADR 131 host loop spends real money on a wake. Between
"seconds, if the recipient happens to be mid-loop" and "minutes and dollars" there is nothing. A
push that lands in seconds, into a session that is already alive, on hardware we already run, is
exactly that missing rung — delivered by the harness for free.

The temptation is to pick a side: block the channel, or adopt it as transport. Both are wrong.
Blocking fights the platform's own plumbing, punishes Nick's entirely legitimate human use of it,
and only covers sessions where our hooks run — a gate that leaks is worse than a ledger that sees.
Adopting it as transport forfeits everything musterd is: the channel has no identity and cannot
grow one, it is single-harness and machine-local where musterd is deliberately neither, and its
payload is free text where ADR 128 spent an ADR making delivered lines composable-only.

## Problem

A harness-native channel now exists that (a) lets seated agents coordinate invisibly, and (b) offers
push latency the coordination layer needs — and musterd currently neither sees it nor uses it.

## Decision

**Treat it as a rail, not a layer.** Coordination stays in musterd; the channel becomes one
observed, measurable last-mile delivery mechanism among several. Two increments:

### Increment 1 — observe: every seat-issued `send_message` lands in the ledger

A second PreToolUse hook entry (its own marker, `musterd-sessionmsg-hook`; the ADR 150 gate entry's
matcher and meaning are untouched) matches `mcp__ccd_session_mgmt__send_message` and runs the same
`musterd gate check --stdin`. The gate CLI recognises the tool name and emits an ADR 163-style
actor attestation — fire-and-forget, un-awaited, before any enforcement fetch, fail-open. The call
**always proceeds**: observation is exempt from the declared-class boundary for the same reason
ADR 163's is — a reporter that cannot say no cannot expand the gate surface.

What crosses the wire is shapes only, computed client-side:

- `bodyFingerprint` — sha256-16 of the message body. The body itself never leaves the machine;
  this is stricter than the Bash pattern (where the raw command crosses and the server
  fingerprints), because a session message is _another agent's incoming context_ (ADR 128), not
  merely the sender's own command line.
- `sessionRef` — sha256-16 of the target session id. Raw harness session ids never cross the wire;
  that contract (`SessionCaptureSchema`, ADR 131 §5) holds here too. A fingerprint still answers
  "same target as last time?" for analysis.
- `nudgeRef` — a ULID extracted from the body if one is present, which is what lets increment 2
  confirm deliveries without any new state (below).

The daemon records `actor.session_message`, `result: 'allow'`, always. `list_sessions` is not
matched (reads need no provenance — the same line ADR 163 drew), and `set_session_title` is
ADR 160's governed surface already.

Not a gate, and not a warning either. The posture is the lanes posture: make the behaviour visible
and let the data argue. If the ledger later shows seats route-around-ing through this channel, the
gate case writes itself — with evidence, against a policy schema that already knows how to deny.

### Increment 2 — the delivery rail: daemon-composed nudges, sender-relayed, derivation-confirmed

Only a live attended session holds `send_message`, so the daemon cannot push and no resident helper
can either. The one party that reliably has the tool at the right moment is **the sender itself** —
a seat that just called `team_send` is by definition a live session, and if it runs in the desktop
app it holds the rail. So the rail is a relay:

1. **The daemon issues a hint.** When a directed, member-addressed act in
   `{handoff, ask, steer, request_help}` targets a recipient with fresh presence (the same
   freshness test ADR 153's `unblockerReachable` uses), the `POST /messages` ack gains an additive
   field beside `ask_contract`:

   ```
   delivery_hint: {
     recipient_live: true,
     rail: 'ccd_session',
     nudge_text: <daemon-composed line>,
     nudge_fingerprint: sha256-16(nudge_text),
   }
   ```

   Additive in the ADR 153 sense: older clients ignore it, older daemons omit it. No session id
   rides the hint — the daemon does not know one and must not learn one. Routing is resolved
   machine-locally by the sender via `list_sessions`, where ADR 160's seat labels make the
   recipient's session legible by name. The labels were built so humans could find seats in the
   sidebar; here they double as the rail's addressing scheme, and the harness's own
   "From {title}" attribution means a labelled sender arrives as its seat name.

2. **The nudge is composed, never written.** `nudge_text` comes from a sibling of
   `composeInterruptLine()`: structured fields only, sender named, message id included, **act body
   never present**. For an agent recipient: a one-line pointer to `team_inbox_check`. For a
   to-human ask: a line asking the session to surface the ask to the user. The act itself still
   flows through musterd with full attribution; the rail carries a doorbell, not a payload.

3. **The sender relays.** A guidance skill (the ADR 160 pattern: desktop tools named in prose,
   kept out of `SKILL_MCP_TOOLS`) instructs: when `team_send` returns a `delivery_hint` and you
   have the session tools, find the recipient's session by its seat label and `send_message` the
   `nudge_text` **verbatim**. To-human asks target a session the human is driving.

4. **Confirmation is derived, not stored.** `nudge_text` is a deterministic function of the message
   row, so there is no pending-nudge table and no TTL. When an increment 1 attestation arrives
   carrying a `nudgeRef` that resolves to a real message, the daemon recomposes the line, hashes
   it, and compares against `bodyFingerprint`:

   - match → `{nudge: true, verbatim: true}` — delivery attempt confirmed **and** verbatim relay
     verified, in one comparison. The verbatim check is the injection guard: a relay that matched
     the hash carried exactly the composed line and nothing else.
   - resolves but mismatches → `{nudge: true, verbatim: false}` — the model paraphrased. Counted,
     never punished; the guidance skill is the tuning surface.
   - no ULID, or an unknown one → a plain observation row, which is increment 1's whole point:
     that is the organic-use / side-channel population, now distinguishable from sanctioned nudges
     by a field instead of a guess.

   The projection into the ADR 090 ledger follows `interrupt_raises` exactly: a per-recipient
   `ccd_nudges` count derived from audit rows, nothing stored on the message.

5. **Noise is damped by derivation too.** The hint is suppressed when a `nudge: true` row for the
   recipient exists within the last ten minutes — one indexed audit query, no state. Loops are
   structurally impossible rather than damped: a relay is a `send_message`, not a `team_send`, so
   it can never mint a fresh hint. (ADR 131's ping-pong demotion is the prior art for the failure
   class; here the graph has no edge to demote.)

### What the rail is not

It is not guaranteed. The relay is model-dependent and best-effort by construction, and that is
acceptable _because it is measured_: relay rate and verbatim rate are first-class metrics, and the
ADR 088/131 ladder remains underneath, unchanged, for every act the rail misses. It is not
cross-machine, not cross-harness, and unavailable to unattended sessions — including, notably,
seats the host loop itself woke. Per-surface, not per-harness, exactly as ADR 160 concluded for
the same tools: no `Harness` interface extension, no pretence of generality with one
implementation.

## Observability & Evaluation

**Traces.** The new audit kind `actor.session_message` carries
`{tool, body_fingerprint, session_ref?, nudge_ref?, nudge?, verbatim?}` — shapes only (ADR 051);
the body and the raw session id never reach the daemon at all. Hint issuance is visible on the
message ack; `ccd_nudges` (and `ccd_nudges_verbatim`) join `interrupt_raises` in the per-recipient
delivery projection. A `musterd.delivery.ccd_nudge` counter lands beside the ADR 125 metrics.

**Eval — dataset and baseline.**

1. _Headline: does the rail move seen-latency?_ Reuse `musterd.coordination.seen_latency`
   (`crossedBySeen`): nudged directed acts vs un-nudged, over a dogfood fortnight. Baseline is the
   existing seen-latency distribution — measured, not assumed; ADR 125 built the instrument.
2. _Relay rate_: hints issued vs `nudge: true` attestations. This is the honest measure of a
   model-dependent mechanism; if it is poor, the guidance skill gets tuned, and if tuning cannot
   move it, the rail was not worth its surface and this ADR says so.
3. _Verbatim rate_: `verbatim: true / nudge: true`. Target near one; every `verbatim: false` is a
   paraphrase that the fingerprint caught, which is the guard working, not failing.
4. _Side-channel population_: non-nudge `actor.session_message` rows between two seated sessions.
   No target — this is the increment 1 instrument, and it is the evidence a future gate ADR would
   stand on. Today its expected value is near zero; the interesting outcome is discovering it is
   not.

**Guard metric — must not move.** Gate-check critical-path latency and gate outcomes. The observer
is un-awaited and fires before the enforcement fetch, same as ADR 163's attestation; a
`send_message` call must proceed identically with the daemon up, slow, or absent. Regression test:
the observe path returns allow with the HTTP client stubbed out entirely.

**Experiment.** Increment 1 runs alone first, which makes it the natural shadow phase: it measures
organic `send_message` use before any nudge exists, so the side-channel baseline is captured
uncontaminated. Increment 2's comparison then runs within-system (nudged vs un-nudged acts share
the daemon, the seats, and the fortnight). Honesty caveat: n will be small and the rail only exists
app-session → app-session; the seen-latency comparison is a direction check, not a significance
claim, until the fleet has run it for a while.

**Rolling-upgrade caveat, stated so it is not rediscovered:** the verbatim check recomposes with
the current composer. A composition change while a relay is in flight reads as
`verbatim: false`. Both halves live in one daemon today, so this is a labelled imprecision, not a
defect; whoever splits the daemon inherits this sentence.

## Amendment (2026-07-30): the rail could not say why it declined

**"Hint issuance is visible on the message ack"** (above) was true and insufficient, and the gap cost
two days. The ack shows a hint when one is issued. Nothing anywhere showed a hint being _declined_, or
why — and `deliveryHintFor` returned a bare `DeliveryHint | null` in which that `null` stood for six
different facts: team-addressed, act-not-eligible, self-addressed, recipient-row-missing,
recipient-not-live, and damped-by-the-suppression-window. The only counter, `recordCcdNudge('hinted')`,
incremented **solely on success**, and it is OTel, which is off unless an operator wired an endpoint
(ADR 089 / ADR 015 posture). So on the dogfood machine the rail emitted no signal at all, in either
direction.

**What that produced.** "`delivery_hint` emitted zero hints on a 190-act day" was filed as an ADR 179
gate defect and sat as a suspected bug (lane `01KYQ9175S`). The premise was wrong: the denominator was
not 190 but **1**. On 2026-07-28 the traffic was `team|message` 92, `team|status_update` 80,
`member|message` 44, plus one `accept`, one `resolve`, and exactly one hint-eligible act — an `ask`
from izzo to **nick**, an away human with no live local session, on a rail that only reaches live
local sessions. Declining was correct. Zero was the right answer, and there was no way to know it.

That indistinguishability is ADR 173's invariant applied to this ADR's own observability: absence of a
hint was reported as evidence about the rail, when it was evidence about the traffic.

### What changed

- **`deliveryHintFor` returns the reason either way** — `{ hint, reason: 'issued' }` or
  `{ hint: null, reason: <named cause> }`, one name per leg of the predicate (ADR 173 clause 1: name
  the abstention after its cause, not its shape). The wire contract is untouched: `delivery_hint`
  still rides the ack only for `issued`, so every other case is byte-identical to before.
- **A durable row for the decisions that are actually about the rail.** `nudge.decision` is written
  when the rail was a genuine _candidate_ — the act was directed at a real other member and was
  hint-eligible — carrying `detail.reason`. It is deliberately NOT written for
  not-directed / act-not-eligible / self-addressed sends: those cover essentially every message ever
  sent, and mirroring them would turn the audit log into a copy of the messages table. The gated
  population is **~40 rows across the project's entire history**, so the cost is nil and the zero
  becomes queryable:

  ```sql
  SELECT json_extract(detail,'$.reason'), COUNT(*) FROM audit
    WHERE action = 'nudge.decision' GROUP BY 1;
  ```

- **Every decision counted by reason** in telemetry too, so `issued` finally has a denominator — but
  the audit row is the load-bearing half, precisely because a metric nobody is scraping is not
  observability.

### Honest limits

- **No backfill** (ADR 173 clause 3). Historical liveness is not recoverable — presence is now-state,
  not a log — so the reasons for past sends are unknown and stay unknown. The counts begin at this
  change, and a reader comparing across it is comparing to nothing.
- **The relay half is still underdetermined.** `nudge.decision` records what the daemon decided, not
  what the sender did with it; `issued` without a matching `actor.session_message` still cannot
  separate "the sender ignored the hint" from "the sender had no session tools". That is the eval's
  relay-rate question and it wants relay data, not more instrumentation.
- **The more interesting finding is out of scope here.** All-time hint-eligible volume is ~40 acts,
  against 136 free-text `message` acts. The team talks in prose rather than the typed act vocabulary,
  which is what starves this rail — a vocabulary-adoption question (ADR 144's tool surface), not an
  observability one, and it deserves its own lane rather than a fix smuggled in here.

## Consequences

- Seat use of the harness's session messaging becomes ledger-visible with zero behaviour change —
  the warn-never-block posture, applied to a channel instead of a lane.
- Directed acts gain a seconds-latency rail between the tool-boundary check and the paid wake,
  costing one tool call by a sender that was already live.
- To-human asks gain a path to Nick's attention that covers exactly the gap `musterd notify`
  leaves: reachable-but-not-looking. The OS push already suppresses itself when he is reachable;
  the nudge is what reaches him there.
- The nudge protocol leans on ADR 160's labels for addressing; a seat whose session the human
  hand-renamed (which the desktop app makes permanent — ADR 160's measured no-op) is harder to
  address by name. The rail degrades to no-hint-relay there; nothing breaks.
- Two new prose-named desktop tools in guidance deepen the per-surface dependency on Claude Code
  Desktop. Accepted knowingly, bounded to one skill and one hook entry, both removable by marker.
- The channel stays open for everything else. This ADR observes it and harnesses it; it
  deliberately does not govern it. If governance is ever warranted, the increment 1 ledger is
  where that argument gets its numbers.

## Related

- [ADR 163](163-actor-attestation-tool-boundary.md) — the emit-only observer this extends with a third kind.
- [ADR 150](150-structural-inducement-pretooluse-gates.md) — the hook plumbing; explicitly _not_ widened by this ADR.
- [ADR 088](088-interrupt-line-tool-boundary-inbox-check.md) /
  [ADR 054](054-wake-on-message.md) / [ADR 131](131-harness-residency-wake-ledger-host.md) — the
  reachability ladder; this rail is the new middle rung.
- [ADR 160](160-seat-session-labels.md) — the desktop session surface, its per-surface framing,
  and the labels the rail addresses by.
- [ADR 128](128-recipient-scoped-message-reads.md) — why the nudge is composed and body-free.
- [ADR 090](090-per-recipient-delivery-status.md) — delivery as derivation; `ccd_nudges` follows
  `interrupt_raises`.
- [ADR 153](153-ask-reachability-gated-hold.md) — the additive daemon-computed hint shape, and the
  reachability test the hint predicate reuses.
- [ADR 051](051-trace-eval-experiment-flywheel.md) — shapes-only; why fingerprints and never bodies.
