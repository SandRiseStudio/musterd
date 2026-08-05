# 241 — A handoff carries its own why

- Status: accepted
- Date: 2026-08-05
- Deciders: izzo (lane opened by miley)
- Relates to: ADR 083 (lanes), ADR 173 (abstain by showing), ADR 203 (the acquisition ledger),
  ADR 231 (a handoff names its lane), ADR 240 (a lane's title is correctable)

## Context

miley hit this live on 2026-08-05 handing lane `01KZ9W0R29` to ryder. The transfer was correct; the
message explaining it arrived carrying `handoff_lane {lane: 01KZ9ANWB…, branch:
feat/release-consumer-smoke, source: 'derived'}` — a lane in acceptance that had nothing to do with
the handoff and that she had no intention of giving away. ryder read, in metadata, that he was being
handed a branch nobody meant to hand him. It took a correction message to undo.

**Nothing guessed badly. The candidate set was structurally missing the answer.** ADR 231 derives a
lane-less `handoff` act's lane from the non-terminal lanes the _sender owns_ — and `lane_handoff`
transfers ownership **before** the explanatory act is sent, so the lane the sender means has already
left that set and can never be derived. What remains is everything else they hold.

The ambiguity guard is what makes this dangerous rather than what saves it. Having just given one
lane away, a sender frequently holds exactly **one** other, so the derivation lands in the confident
single-candidate branch and attaches an unrelated lane with no warning at all. The guard fires only
when the sender holds several — the case where a wrong answer would have been obvious.

**The sequence is forced, so this recurs for everyone.** `lane_handoff` accepted `{id, to, branch}`
and nothing else: there was no way to say _why_. Explaining a handoff therefore REQUIRED a second
act, and `team_send {act:'handoff'}` takes no lane argument, so the second act was guaranteed to
derive. The ergonomics of the first tool produced the call the second tool could not get right.
Neither tool is wrong alone; the pair is.

It is not cosmetic, because `route.ts` **persists** the derived lane onto `env.meta`. The consumer
ADR 231 built this for — the orientation `why`, which reads a handoff as a live instruction — then
has a confident wrong instruction to check against rather than nothing. ADR 231's own argument was
that a handoff naming no lane leaves `why` unable to tell which work this is; a handoff naming the
WRONG lane tells it something false, which is worse than the gap 231 closed.

ADR 231 itself stays. 24 of the first 30 handoffs on this team named no lane; the derivation earns
its keep. What it did not anticipate is the one sequence its own sibling tool makes inevitable.

## Decision

**1. `lane_handoff` carries a note, so the second act is never needed.** `UpdateLaneSchema` gains
`handoff_note`, surfaced as `note` on the MCP tool and `--note` on the CLI. It rides into the body
of the `handoff` act the transfer _already_ emits — the act that has named the correct lane all
along. The why and the what-it-is-about travel together in one act.

The note is a **message, never lane state**: it is not persisted on the lane, and it is ignored
(not rejected) on a patch that moves no ownership, so a client that always sends it is not punished
for it. `detail` remains where durable context about a lane belongs.

**2. A lane just handed to THIS recipient outranks a lane the sender still holds.** When a
lane-less `handoff` act is directed at a seat, the derivation first asks: _what did this sender hand
to that seat, that that seat still holds and has not closed?_ Exactly one → attach. Two or more →
ambiguous, warn, attach nothing. None → fall back to ADR 231's held-lane rule, unchanged.

Preferred, **not merged into one pool**. A held lane must never dilute a handed one into a false
ambiguity, and a handed lane must never be outvoted by lanes that have nothing to do with this
recipient. The two sets are different strengths of evidence and are read in that order.

The qualifying test is **current state, not recency**: the recipient still owns the lane and it is
still live. A transfer the recipient has since resolved, released or passed on drops out because the
fact stopped being true — not because a timer expired it. This is ADR 231's own refusal to age out
an old handoff, applied to the other side of the same question, and it is why no time window
appears anywhere in the rule.

The evidence comes from the acquisition ledger (ADR 203), the only record that distinguishes a
handoff from a self-claim: after the fact the lane row shows who owns it, never who gave it to them.
A recipient who _claimed_ a lane for themselves is therefore not a candidate — they were not handed
anything.

**3. Two things explicitly not done.**

- **The ambiguity check is not tightened.** There was no ambiguity in the live instance: one
  candidate, confidently wrong. A stricter ambiguity rule would not have caught it and would weaken
  the case it does handle.
- **Derivation is not refused on `handoff`.** That re-opens the problem ADR 231 solved, and it is
  the wrong lesson: the derivation was reading the wrong evidence, not reaching too far. `source:
'derived'` stays in the payload — it is the only reason this was ever caught, and the defect was
  that consumers treat a derived lane like a stated one, not that the daemon hid its guess.

## Consequences

The failure mode that produced this ADR now has two independent closes: the sequence that caused it
is no longer necessary (1), and the sequence still mis-derives nothing if someone follows it
anyway (2). Either alone would have left the other half open — a note does not help a seat that
still sends two acts, and a better derivation still leaves explaining a handoff a two-call job.

The derivation now reads the audit log on the lane-less-handoff path. It is a bounded, indexed scan
of one action type by one actor (200 rows), on an act that is rare by construction, and `detail` is
parsed in JS rather than filtered with `json_extract` — ADR 173's evidence is that one malformed
`detail` makes SQLite raise from the _query_ and takes down every read that scans it.

A wrong attach is still possible in one shape: the sender handed the recipient a lane some time ago,
the recipient still holds it, and a later unrelated lane-less handoff to the same seat attaches it.
That is a strictly better guess than today's (it at least concerns this pair), it is warned about
whenever more than one such lane exists, and the note in (1) means a seat with anything to say has
no reason to send the lane-less act at all.

`handoff_note` is additive on the wire; an older daemon ignores it, and an older client simply never
sends it.

## Observability & Evaluation

**Traces.** No new action; one new field on the two ADR 231 rows. `handoff.lane_derived` and
`handoff.lane_ambiguous` now carry `detail.basis` — `handed_to_recipient` or `held` — so the two
rules can be told apart after the fact. It is written on **every** derivation, so absence means
"recorded before ADR 241" and never "the held set"; that unambiguous write edge is what makes the
read three-valued rather than quietly wrong (ADR 173 correction #1, same discipline). The note in
(1) adds no trace of its own: it is message body, and the `handoff` act already carries it.

**Eval.** Two claims, each with a baseline on this team's own ledger.

_Claim A — the derivation stops naming a lane the sender did not mean._ Baseline, read from the
dogfood ledger on 2026-08-05: **`handoff.lane_derived` has exactly one row in the team's entire
history, and it is the wrong attach** — message `01KZ9W28KR` (miley, 21:07:57Z), which attached
`01KZ9ANWB`, a lane in acceptance, to a handoff of `01KZ9W0R29`. One for one. That is a tiny
population and it is stated as one: the honest reading is not "100% wrong" but "the first time this
path ever fired in anger, it was wrong, and nothing in the ledger would have told us if the next
ten were too". The `basis` field is what makes the next window countable at all. Success over the
next 30 lane-less handoff acts: zero attaches whose lane the sender corrects in a follow-up, and a
`basis` population in which `handed_to_recipient` answers the transfer-then-explain pair. Failure to
watch: `handed_to_recipient` attaching lanes handed days earlier — visible as a gap between the
`lane.claimed` row's `ts` and the handoff act's, which is exactly the shape the Consequences admit
is still possible.

_Claim B — the note removes the reason to send the second act._ Baseline: **24 of the first 30
handoffs on this team named no lane** (ADR 231's own measurement), and `lane_handoff` could not
carry a word of explanation. Success is a fall in lane-less `handoff` acts sent within minutes of a
transfer by the same seat — the exact pair that produced the defect. If that pair persists at volume
while `handoff_note` stays unused, the note is not discoverable and the tool description is what
needs work, not the derivation.

_Counter-metric for both._ `handoff.lane_ambiguous` rising sharply would mean the handed-set
preference finds multiple referents where the old rule found one confident answer. That is the
intended trade — a warning beats a wrong field — but a large rise would say seats routinely hand
several lanes to one person at once, which is a coordination fact worth knowing on its own.

**Experiment.** None, and deliberately: withholding (2) from an arm would mean routing knowingly
wrong lanes to half the team to measure how often anyone notices, and the one instance we have
already cost a teammate a correction. The `basis` field makes the two rules separable in the
observed population instead, which answers the same question without a wrong-by-design arm.
