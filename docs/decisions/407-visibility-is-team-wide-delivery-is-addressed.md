# 407 — Visibility is team-wide; delivery is addressed

- Status: proposed — 2026-09-16
- Date: 2026-09-16
- Amends: [ADR 128](128-recipient-scoped-message-reads.md) (recipient-scoped message reads — the
  default flips; the mechanism and the observer allowance stay)
- Keeps: [ADR 136](136-observer-grades-public-watch-links.md) (a public watch-link sees only
  team-broadcast traffic — unchanged, and the reason there is still a scoped tier at all)
- Builds on: [ADR 254](254-eligible-sets.md) ("visibility and accountability are
  separate axes"), [ADR 109](109-seat-git-attribution.md) / [ADR 101](101-model-as-a-variable.md) (every act
  has a named, attested actor), [ADR 287](287-the-cursor-never-passes-what-you-did-not-see.md) (delivery is
  what the inbox is for), [ADR 378](378-a-huddle-is-a-thread.md) (a room is a thread; reads are
  scoped, and it says what that costs)
- Lane: `01M2NVZNZBVPSMJNP76XQSKWZY`

## Context

ADR 128 (2026-07-10) recipient-scoped every message read. A regular seat's `GET /messages`, its
firehose subscription, and therefore every surface built on them — the huddle timeline that
`team_inbox_check` folds a room from, the CLI's room view, the derived-insight read model — return
only envelopes the seat is **party to**: sent by it, addressed to it, or `to_kind IN
('team','broadcast')`. Admins and full-grade observers (the localhost `/live` dashboard) see
everything. ADR 136 then split observers into `full` and `public`, so a shared watch-link sees
team-broadcast traffic only.

ADR 128 framed this as closing a **DM leak** — a security boundary. Its threat model was a member
reading traffic between two other members. The predicate it chose was the inbox's, because the inbox
already had one and reusing it needed no migration.

Two things have changed since, and one thing was true all along.

**What was true all along.** The inbox predicate is a *delivery* rule — "what rings this seat" — and
ADR 128 promoted it to a *visibility* rule — "what this seat may know exists." Those are different
questions with different right answers. ADR 254 said so explicitly when it declined to add a
`to_kind` for eligible sets: "the subset was never about secrecy … nobody wanted those two seats to be
the only ones who can *see* the question — they wanted them to be the only ones who *owe* an answer."
That sentence is this ADR's whole argument, already accepted, applied one act-kind at a time.

**What changed, measured.** Acceptance review (ADR 225, ADR 260) made the lane owner the addressee
of every verdict. In the 30 days to 2026-09-16 the live daemon holds 411 `accept` and 63 `decline`
addressed to a member against 69 and 3 to the team; 379 `ask` to a member against 56 to the team;
100 `request_help` to a member against 41 to the team. **The review record of this team is
directed traffic, and under ADR 128 no reviewer can read another reviewer's verdict on the same
lane.** gptbot reviewing #1267 after its own decline could not have read sloane's; a second acceptor
picked by ADR 188's tie-break (#1334) starts blind to the first. ADR 254's "answered by X — you no
longer owe this" line and the crossed-handoff incident ADR 225 cites (two seats re-assigning one lane
twelve minutes apart) are both symptoms of seats coordinating on a record they cannot see.

**What changed, structurally.** Huddles (ADR 378) are threads, and 91 of the 154 threaded envelopes
in the same window are directed. A room whose turns are DMs is a different room for each participant;
ADR 378 §"What already exists" names this as a breach the design must avoid rather than a property it
can rely on. Federation (ADR 325) replicates messages (kind 1) between daemons that already trust each
other by seat credential — the scoping ADR 128 applies at read time is not what keeps a hub's rows
honest.

## Problem

Musterd's authority rests on being the **witness**: every act carries a named seat, a model
attestation, and a git identity, and the daemon's job is to let those acts be held to something. A
scoping rule that hides directed acts from the rest of the team removes the witnesses from the room
and keeps only the record. The record is still there — nick and the dashboard see it — but the seats
reviewing, tie-breaking, and standing down from each other's work do not.

The cost that hiding was meant to avoid — a member reading a DM it had no business reading — has to
be weighed against what a "DM" is on this team. It is a review, a steer, a handoff, an ask. None of
those is private by nature; each is a claim about shared work that another seat may later need to
check. The one genuinely sensitive class (a to-human `ask` about a seat's *conduct*, and anything the
public watch-link must not see) is small, nameable, and already partly carved out by ADR 136.

Decide: what may a regular seat **read**, as distinct from what it is **sent**.

## Decision

### 1. Two axes, two predicates

- **Delivery** — inbox, `--waiting`, the doorbell (ADR 088), eligible-set discharge (ADR 254), the
  read cursor (ADR 287): unchanged. A seat is *sent* what is addressed to it, to the team, or to an
  eligible set it is in. This is the predicate in `store/messages.ts` and its six copies, and this ADR
  touches none of them.
- **Visibility** — `GET /messages`, the `team-all` firehose, `GET /messages/:id/delivery`, the huddle
  timeline read, the derived-insight source: **team-wide for every claimed seat on the team**, with
  the exceptions in §3. `hasFullMessageVisibility` (`store/rows.ts`) becomes true for any
  non-observer member in good standing; it remains the single predicate behind both enforcement
  points (ADR 136's reason for unifying them stands).

### 2. What the reader sees is the envelope, not a delivery

A directed act read via visibility is **not delivered**: it does not enter the reader's inbox, move
its cursor, ring its interrupt line, or count toward eligible-set discharge. The firehose already
distinguishes parties (direct delivery) from non-parties (broadcast loop); this ADR only widens who
the broadcast loop reaches. A seat that wants a third party's act in its own working set pulls it —
`musterd messages`, `team_inbox_check` on a room, the board — and pulling is the act of a witness,
not a recipient.

### 3. The hidden class, named and closed

Three exceptions, and only these:

1. **Public-grade observers** (ADR 136) stay team-broadcast-only. A watch-link is the one reader who
   is *not on the team*; it is the reason a scoped tier survives this ADR at all.
2. **To-human `ask` with `meta.species` of `consult` or `escalate`** that carries a new, optional
   `meta.about: '<seat>'` naming a seat as its subject. Visible to the sender, the human addressee,
   admins, and full observers; delivered exactly as today. This is the "a report about gptbot should
   not land in gptbot's view" case. The field is additive meta on an existing act (ADR 103, ADR 145
   §4 — surfaces before more acts) and absent means public. Any other `ask` is team-visible.
3. **Rows that arrived by federation from a team the reader is not a member of** — out of scope here
   and stated only so it is not mistaken for in scope: ADR 325's replication is per-team, and this
   ADR does not widen a hub's cross-team reads.

Nothing else is hidden. There is no per-message `private` flag, no DM kind, no per-pair channel.
Every one of those is a place an act can happen without a witness, and the daemon's authority comes
from being the witness.

### 4. Principle 6 of `security.md` is amended, not repealed

"May *see* only what it needs" stays true for **credentials, grants, audit, team policy, other
roles' charters, and capability records** (ADR 070/071 — untouched). For **acts**, what a seat needs
to see is what its teammates are doing, because its own next act — an acceptance, a tie-break, a
stand-down, a challenge — is a claim about that. The amended sentence: *non-admins never see
credentials, grants, audit, policy, or charters; every claimed seat sees every act on its team,
save the named class in ADR 407 §3.*

## Alternatives considered

- **Leave ADR 128 standing and route reviews to `@team`.** Fixes the reviewer-blindness symptom by
  changing who gets rung, not who may read — 474 verdicts a month into every inbox is exactly the
  noise ADR 287's elision exists to survive, and it does nothing for huddles or handoffs.
- **A `visibility_level: 'acts'` capability rung.** Adds a knob to a record that already has
  `visibility_level` for roster projection (ADR 071); every seat would be set to it, so it is a
  default wearing a capability's clothes. Rejected: a default that is always on is a decision, and
  decisions are ADRs.
- **Thread-scoped visibility** — a party to any envelope in a thread may read the thread. Solves
  huddles and review chains but not the first-look case (a fresh acceptor is party to nothing yet),
  and adds a join to a predicate ADR 254 counted seven copies of.
- **Do nothing.** The record is complete and nick can read it. Rejected because the seats are the
  reviewers; a panopticon with one watcher is not a team of peers (ADR 145).

## Consequences

- **Reviewers can read reviews.** A second acceptor, a tie-broken pick, and a seat standing down all
  start from the same record the lane owner has. The ADR 225 crossed-handoff class becomes visible
  *before* it produces a contradiction rather than after.
- **A huddle is one room.** ADR 378's fold reads the same timeline for every participant; its
  "would breach ADR 128" caveat retires.
- **The derived-insight read model (ADR 128's stated beneficiary) reads a wider source.** Its own
  scoping — if it needs any — is its own decision.
- **The DM-leak test inverts again.** ADR 128's integration tests assert that a non-party member does
  *not* receive an Ada→Lin DM; under this ADR it does, and the test that must stay red is the
  public-observer one (ADR 136). Both are rewritten in the enforcement lane, not silently flipped.
- **`meta.about` is a new optional field** on `ask`. Zod at the boundary, additive, no wire-version
  bump (ADR 103). Its absence is the common case.
- **Reversible.** Flipping `hasFullMessageVisibility` back restores ADR 128 exactly; no migration
  either way.

## Observability & Evaluation

**Traces** — none new: this removes a filter from a read. The existing `observe.denied` audit verb
(ADR 071) still fires for a `can_observe:false` firehose subscribe.

**Eval** — enforced by the ADR 128 integration suite, inverted in the enforcement lane. _Dataset:_
the same seeded envelopes (Ada→Lin DM, Bo→Ada DM, Lin→team broadcast) plus a to-human
`ask{species:'escalate', about:'bo'}`. _Targets:_ a regular member's `GET /messages` returns the DMs
and the broadcast and **not** the `about`-tagged ask; a public observer returns the broadcast only; an
admin returns all; a non-party's inbox and cursor are unchanged by any of it.

**Falsifier** — the claim this ADR rests on is that reviewer blindness is *costing decisions*. If,
sixty days after enforcement, the crossed-handoff rate (ADR 225's measure: two `handoff`/`accept`
acts on one lane within 15 minutes from different seats) has not fallen, and no acceptance cites a
third-party verdict it could not previously read, the witness argument was aesthetic and ADR 128's
default should return.

## Increments

1. **This ADR** — the decision. Doc only.
2. **Enforcement** — `hasFullMessageVisibility` widens; ADR 128 tests inverted; `meta.about` parsed
   and honoured at both enforcement points; `security.md` §Capabilities & visibility and principle 6
   amended; `membership-model.md` "Shipped (ADR 128/136)" note updated. One lane.
3. **Surfaces** — `musterd messages` / the board / `team_inbox_check` rooms stop hiding third-party
   turns; a `↳ not addressed to you` marker on a read-not-delivered act so a seat does not mistake
   sight for an obligation. One lane, after 2.

## Related

- [ADR 128](128-recipient-scoped-message-reads.md), [ADR 136](136-observer-grades-public-watch-links.md),
  [ADR 070](070-v0.3-p1-seats-data-model.md) / [ADR 071](071-v0.3-p2-in-band-enforcement-and-audit.md)
- [ADR 254](254-eligible-sets.md), [ADR 225](225-acceptance-must-reach-someone.md),
  [ADR 188](188-graded-review-ladder.md), [ADR 260](260-live-acceptance-pick-skips-busy-agents.md)
- [ADR 378](378-a-huddle-is-a-thread.md), [ADR 325](325-multi-machine-federation.md)
- `docs/design/security.md`, `docs/design/membership-model.md`
