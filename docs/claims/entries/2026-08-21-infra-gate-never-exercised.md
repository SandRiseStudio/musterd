---
claim: "adr-227-infra-touch-gate — `neverExercised`: 'No deliberate exercise is recorded since it shipped 2026-08-04. […] no seat has fired the gate on purpose to confirm it still warns.' and `everTripped: false`"
claimant: ryder
claimant_model: claude-opus-5
claim_ref: docs/controls/registry.ts, PR #944 / 213b40b5
claim_class: absence
claimed_at: 2026-08-21
falsified_at: 2026-08-21
detection_channel: peer
detection_latency: 52m
corrector: izzo
corrector_model: claude-opus-5
correction_ref: msg 01M0GXJ1W91JQ4YT1YK3A030EV; lane 01M0GX9VD728WHMFJWJ8D630AC
cost: "Nil in operations — the gate works, and both halves of the claim understated it rather than overstating it. What it would have cost is a build failure: #948 starts a 60-day expiry at 2026-08-04 and fails CI on 2026-10-03 for a control that was in fact exercised on 2026-08-05. It also cost this entry's corrector an acceptance: I accepted #944 fifty-two minutes before falsifying it, and the query that settled both halves is one SELECT against a table I could have read then."
status: falsified
falsifier: "Read the audit table: `SELECT ts, actor, detail FROM audit WHERE action='infra.touch.warned'`. If it returns zero rows, the gate has never fired and both halves of the claim were true — this entry is wrong. Then read stanley's acceptance of #689 (2026-08-05 19:32:36Z, act=accept, lane 01KZ9JSX10): if it does not describe firing GET /infra-gate against the live daemon and observing the warning, the audit row, and the unauthenticated silence branch, then no deliberate exercise was recorded and the `neverExercised` half was true."
---

Two halves of one registry entry, both false, both understating a control that works better than
its own record said.

`everTripped: false` — the gate has caught three real touches, all on 2026-08-05:
stanley at 19:31:02 (`verb=agent`), ryder at 22:48:31 and 22:49:00 (`verb=refresh`). ryder's are a
genuine trip: twenty-five seconds after the second warning they posted "Bouncing the daemon in ~30s
— nick asked me to force it rather than wait for autorefresh." The warning fired on a real infra
touch and was correctly overridden by human authority, which is the warn-only design working, not
failing.

`neverExercised` is the more interesting half. A deliberate exercise **is** recorded, and a
thorough one: stanley's acceptance of #689 the day after the gate shipped describes firing
`GET /infra-gate?verb=agent` against the live daemon, checking plural verb agreement with two
holders, confirming the unauthenticated caller gets `{warn:null}`, and reading back the audit row —
while explicitly declining to run `musterd agent` for real, "that is the destructive act the gate
exists to warn about." That is a better exercise than most entries in the registry carry.

It was invisible because the registry consulted only itself. The evidence lived in the acceptance
stream — where ADR 192 puts outcome judgements — and `neverExercised` in practice meant "nobody
wrote it here." An absence-class claim about an absence-class instrument, arrived at by reading the
wrong record: the registry's own stated limit ("it does not discover controls") has a twin nobody
had stated, which is that it does not discover exercises either.

Recorded against the corrector as much as the claimant: I accepted #944 fifty-two minutes before
falsifying it, wrote two notes on that entry, and did not run the one-line query that settles both
halves. Exercising ryder's gate five ways was not the same as exercising the control the entry
describes, and I did not notice the difference until I went to fire it. See
[2026-08-20-prefix-cannot-skip-under-tie.md](2026-08-20-prefix-cannot-skip-under-tie.md) for the
same shape one day earlier: a claim that stood because the thing checking it was pointed somewhere
else.
