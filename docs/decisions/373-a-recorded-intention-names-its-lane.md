# 373 — A recorded intention names its lane, or names why it has none

- Status: proposed — 2026-09-03. Authored by ryder on lane `01M1MMVY2A6YY7JV0DS95B95ME`, on nick's
  word after the 2026-09-03 planning sweep.
- Date: 2026-09-03
- Builds on: [ADR 220](220-adr-numbers-allocated-against-open-prs.md) / [ADR 223](223-adr-numbers-are-published-not-just-read.md)
  (the machinery that already reads open PRs to reconcile a document against work in flight),
  [ADR 041](041-roadmap-single-source.md) (the roadmap is one source),
  [ADR 236](236-sleeping-host-defers.md) (absence is not an assertion),
  [ADR 259](259-memory-git-truth-derived-indexes.md) (a fact the team learned is a wiki page),
  [ADR 297](297-longitudinal-watches-pre-registered-not-scheduled.md) (a measurement over days is a
  pre-registered question with a `revisit_by`, not a cron job)
- Lane: `01M1MMVY2A6YY7JV0DS95B95ME`

## Context

On 2026-09-03 a sweep read all 62 wiki pages, all 364 ADRs, all 86 roadmap items and all 843 lanes in
every state, against the code, looking for work that had been written down and reflected in no goal,
no lane and no implementation. It found nine such items. Four are verifiable in one line each:

- **ADR 354 §Consequences** reads, verbatim: "That evidence exists and is not consulted before the
  kill. **Left for a sibling lane**; this ADR fixes the attestation, not the judgement." No sibling
  lane was ever opened. Zero of 843 lanes match it. The actuator still kills a session it spawned
  ninety seconds earlier (`backends/claudeCode.ts:371`).
- **`content/roadmap.data.ts`** carries five `building:` strings naming exactly what remains on an
  accepted-ADR arc. Two of them — `ledger-seats` increments 3–5, `research-intake` M4–M5 — have no
  lane of any kind.
- **`packages/cli/src/service/census.ts:23`** reads "Platform services increment 3 will
  auto-provision." Increment 3 has no lane and no owner.
- **ADR 095** (2026-07-06) has a committed implementation plan at
  `docs/superpowers/plans/2026-07-06-non-blocking-team-join.md` and scores **0 references in code, 0
  in the wiki, 0 across all 843 lanes**. `team_join`'s wait is still the `JOIN_WAIT_MS` constant the
  ADR proposed to replace.

The sweep took roughly four hours of a seat's time and could not have been run by any existing
command.

**This is not people forgetting.** In three of the four cases above the author wrote the intention
down deliberately, in the right document, in words a human reads correctly. ADR 354's author knew
precisely what was left and said so. The sentence had no teeth because nothing downstream could see
it.

Two adjacent measurements from the same sweep bound the problem:

- **46 ADRs sit at `proposed`; 28 of those carry ten or more in-code citations of their own number** —
  they shipped and nobody flipped the status. This is not cosmetic. `roadmap-truth:check` rule 3 keys
  on the `Status:` line, so a stale status silently disables the only cross-check the repo has
  between a plan and its delivery.
- **Three roadmap items are `plan:` while their goals are `shipped`** (`office-delight`,
  `role-routing-profiles`, `research-intake`). Two carry no `frozenBy` ADR at all, so rule 3
  structurally cannot see the disagreement.

## Problem

musterd represents **work in flight** (a lane) and **a mission** (a goal). It has exactly one
representation for an **intention that has been recorded and not started**, and that one rail
covers a single intake channel.

**The rail that exists, and what it proves.** [ADR 248](248-a-seed-is-captured-in-the-open-and-lands-as-a-lane.md)
built `seeds`: an idea arrives by SMS or Slack, the relay buffers it verbatim, and the daemon
promotes it into an open unowned lane on ingest. The table carries `state`, `promotion_kind` and —
the field that matters here — **`linked_lane_id`**, the edge from the thing that asked to the lane
that answers. Twelve rows exist. The shape is right and it is already in the schema; what it is
wired to is a phone number and a Slack channel.

**Where the nine findings came from instead.** Not one of them arrived by SMS. They were recorded in
the repo's own documents by the people best placed to know — an ADR's Consequences, a `building:`
string, a comment above a constant. That channel has no relay, no promotion and no `linked_lane_id`,
so an intention entering musterd through the front door of its own git history gets less tracking
than one texted in from a phone.

Every such intention lives as prose in git — a sentence in an ADR's Consequences, a
`building:` string, a comment above a constant, a wiki line dated and falsifiable and true. Prose in
git has no identity the board can hold. So the question "what has been decided and never started?"
is not merely unanswered; it is **unaskable**, and the only way to answer it is the four-hour
archaeology above.

The repo already believes the general form of the fix everywhere else. A control needs an exercise
date or it is decoration ([controls-in-force](../wiki/controls-in-force.md)). A defect claim needs a
date and a falsifier. A measurement over days needs a `revisit_by` a gate can read (ADR 297). An
absent value is not an assertion (ADR 236). The one artifact class exempt from all of it is the one
that says *what we are going to do next*.

## Decision

Two increments. Each is independently useful and independently reversible; neither decides what
anyone should work on.

### Increment 1 — a forward reference names its disposition, and a gate can see when it doesn't

A single machine-checkable line, placed directly after any sentence that promises future work:

```
Follows-up: <lane-id>
Follows-up: deferred — <trigger that would reopen it> (<date>)
Follows-up: none — <why this needs no work> (<date>)
```

A new gate, `pnpm intents:check`, joins `format:check` beside its siblings. It scans a hand-kept
`INTENT_RE` — the closed set of phrasings this corpus actually uses for a forward reference ("left
for a sibling lane", "increment N will", "what remains is", "not yet built", "a separate lane") —
over three surfaces, and fails when a match carries no `Follows-up:` within a small window:

1. `docs/decisions/**` — Consequences above all, where ADR 354's sentence lived;
2. `content/roadmap.data.ts` — every `building:` string, which by construction names a remainder;
3. `docs/wiki/**` — where the "designed and not built" lists live.

The three accepted dispositions are the point. A lane id is tracking. **A deferral with a named
trigger is also a complete answer** — the model to copy is ADR 272 §5, whose reopen trigger is
measured and has vacuously never fired, which is exactly why nobody keeps rediscovering it as a gap.
Silence is the only shape the gate refuses.

**Code comments are deliberately out of scope for increment 1**, despite `census.ts` being one of the
clearest instances. A phrase list that must survive ordinary engineering prose is a different and
much noisier problem than one that must survive four document genres, and this ADR is not willing to
guess at that noise floor. Increment 3 may extend there once increment 1's own coverage is measured.

**The gate is a floor, not an inventory**, and must say so in its own output. `INTENT_RE` is
hand-kept and will go stale exactly as `DEFECT_RE` did — measured 2026-08-24, the entire "reaches
nobody" family passed the wiki gate undated. That precedent also supplies the mitigation, and this
ADR adopts it wholesale: **print measured coverage on every run**, the way
[defect-gate-coverage](../wiki/defect-gate-coverage.md) does, so how far short the list falls is a
number rather than a hope. A green `intents:check` means "no forward reference in a *named* shape is
undisposed", never "every intention is tracked."

### Increment 2 — a document-recorded intention is a Seed, and the edge already exists

**No new field, and no new word.** This increment was drafted as `sourced_from` on the lane record;
dolly rejected that on lane `01M1MKSMBP` (the surface survey), and the rejection is right and is
adopted here in full.

The thing that asked for the work already has a noun on both surfaces — a **Seed**
([ADR 291](291-shared-seeds-before-lanes.md), [ADR 319](319-shared-seed-surfaces.md): a Team idea
captured before it becomes a Lane, an immutable source plus an exploration thread) — and the edge
already has a name: **`seeds.linked_lane_id`** ([ADR 248](248-a-seed-is-captured-in-the-open-and-lands-as-a-lane.md)).
`sourced_from` would have been a third word for an edge that already has one.

So the increment is:

> **A document-recorded intention is a Seed whose source is a repo path and anchor instead of an
> SMS or Slack capture.** `intents:check` ingests a `Follows-up:` marker the same way the relay
> ingests a Slack message — capture, never interpret — and promotion to a lane sets `linked_lane_id`
> exactly as it does today.

What that buys, measured against the draft it replaces: zero new lane fields, zero new MCP tool
parameters, no ADR 296 vocabulary entry to defend, and no `context:check` bytes charged to every
seat on every turn. The promotion path, the tray (`team_seed_list`), and the `seed → lane` edge are
all already built and already exercised.

**Edge direction: `seed → lane`, unchanged.** A Seed promotes to exactly one lane — that is what
promotion means — while one lane may answer several documents, so the many-side belongs on the Seed.
A lane's provenance is therefore *"the seeds whose `linked_lane_id` is me"*: a query, not a column.
If a lane-side back-pointer is ever genuinely needed, the existing noun is `seed_id`.

**The one real cost, stated plainly.** `SeedSourceSchema` is `z.literal('slack')`
(`packages/protocol/src/seeds.ts:14`) — a single literal, not an enum, even though the relay already
carries `sms` in its buffer. Admitting a repo-path source widens it, which is a protocol change under
AGENTS.md hard rule 1, with this ADR as its authority. That is the whole schema delta, and it is
smaller than the one this increment was originally going to make.

This is what turns the sweep from archaeology into a query: increment 1 asks "does this sentence
name a disposition?", and the Seed tray answers the reciprocal — **what has been captured and never
promoted** — which is how ADR 095 went unnoticed for two months while being perfectly legible to any
human who opened the file.

### Increment 4 — the up-next brief lists open Seeds above open lanes

Placed by dolly, whose surface it is, and recorded here so the arc is legible rather than because
this ADR decides it. `next` already answers "what should I do next" and already has an up-next
section of open unowned lanes (`packages/server/src/store/orientation.ts:119`, currently `Lane[]`).
Seeds awaiting exploration are the same question one step earlier, so the brief's up-next lists open
Seeds — source-tagged, e.g. *"from ADR 373 §4"* — above open lanes. Nothing else changes.

**Not `inbox`, and not `--waiting`.** Those carry things addressed to a seat. An intention is
addressed to nobody, which is precisely the problem this ADR exists to solve, and filing it where a
reader expects their own name would hide it a second time.

### Explicitly not decided here

- **ADR status is not derived from code citations.** The ≥10-citation signal that found the 28 stale
  ADRs is a good *flag* and a bad *authority*. An ADR's status is a decision by a human, and deriving
  it from what shipped would manufacture consent the same way the ask-timeout clock does today — 0 of
  12 blocking asks ever answered, every one resolved by the clock running out
  (`docs/design/2026-09-01-human-surface.md`). Flag it; never flip it. Whether to add that flag as a
  gate is increment 3.
- **No new "what is waiting for me" surface, and no new noun.** Lane `01M1MB7WCW` measured on
  2026-09-03 that `inbox`, `nudge`, `next` and `status` are two questions wearing four commands.
  Increment 4 above is dolly's placement, not this ADR's; increment 2's shape is likewise hers. Both
  were drafted worse here and corrected there, which is the argument for asking the seat that holds
  the surface before minting anything on it.

## Consequences

- **A forward reference becomes a small, explicit cost at authoring time.** One line, three legal
  answers, one of which ("deferred — trigger") is free and is the honest answer most of the time.
  That cost is the mechanism: it moves the decision to the moment the author still has the context,
  which is the only moment anyone has it.
- **The nine lanes opened on 2026-09-03 are the labelled ground truth for this ADR's own eval.** They
  were found by hand, before the gate existed, which makes them an unusually clean corpus: nobody
  selected them to make a gate look good.
- **Increment 1 would not have caught all nine.** By inspection: it catches ADR 354's sentence, both
  unlaned `building:` strings, and the wiki's "designed and not built" entries — four to five of the
  nine. The frontier-cadence manifest lives in `docs/research/`, outside all three scanned surfaces,
  and `census.ts` is a code comment, deliberately excluded. Increment 2 is what reaches ADR 095 and
  the three undisposed multi-admin ADRs. **Neither increment reaches all nine, and this ADR does not
  claim otherwise** — the pair is a large improvement on zero, not a solution.
- **The only schema delta is widening `SeedSourceSchema` past `z.literal('slack')`**, which is a
  protocol change under AGENTS.md hard rule 1 with this ADR as its authority. No new lane field, no
  new MCP tool parameter, no ADR 296 vocabulary entry, and no `context:check` bytes charged to every
  seat on every turn — all of which the rejected `sourced_from` draft would have cost.
- **This ADR was wrong twice and got corrected twice before landing, both times by looking rather
  than asking after the fact.** Checking the board before messaging dolly turned up `seeds` and
  falsified the Problem section's first sentence; dolly's answer then replaced increment 2's whole
  mechanism and placed increment 4. Recorded because the ADR's own subject is intentions that go
  unreconciled: the reconciliation that worked here was a seat reading another seat's lanes before
  writing, which is cheaper than any gate this ADR proposes. It needs a migration; per
  [migration-high-water-mark](../wiki/migration-high-water-mark.md), the number must not be reserved
  ahead of a branch that will not merge before the next number is taken.
- **A new gate is a new thing that can rot.** `intents:check` joins fourteen registered controls, and
  by [controls-in-force](../wiki/controls-in-force.md)'s rule it needs a registry entry, an exercise
  instruction runnable from a stated roster position, and a seat that fires it and records what it
  saw. An unexercised control is indistinguishable from a broken one.
- **The three roadmap/goal disagreements are not fixed by either increment.** They are a separate,
  smaller defect in `roadmap-truth:check` — rule 3 cannot fire on an item with no `frozenBy` ADR.
  Named here so it is not mistaken for something this ADR closes.

## Observability & Evaluation

**Traces.** `intents:check` prints, on every run, the same two-part shape the wiki gate prints: the
pass/fail verdict, and its **measured coverage** — matched intentions over hand-labelled intentions
in the corpus, with shape misses and out-of-scope-surface misses counted separately. Increment 2 adds
no trace of its own beyond the rows it creates: an ingested `Follows-up:` marker is a Seed like any
other, visible in `team_seed_list` and carrying `linked_lane_id` once promoted, so the existing seed
surfaces are the observability.

**Eval.** Dataset: the nine lanes opened 2026-09-03 (`01M1MMHJP3`, `01M1MMJ1AC`, `01M1MMJKBY`,
`01M1MMK333`, `01M1MMKHX8`, `01M1MMKYMN`, `01M1MMMDCR`, `01M1MMND6E`, `01M1MMNRW7`), each carrying
the document and line that recorded it, plus the corpus state at the merge commit. Two questions:

1. **Recall against ground truth.** Run `intents:check` over the corpus as it stood *before* the nine
   lanes existed. It must flag the ADR 354 sentence and both unlaned `building:` strings — the three
   this ADR claims by name. Fewer than three means `INTENT_RE` does not match the phrasings this
   corpus actually uses, and the list is wrong rather than the idea.
2. **Coverage, stated not assumed.** The printed coverage number at merge is the baseline. It is
   expected to be well under 100% and the ADR is not falsified by a low number — it is falsified by a
   number that is never printed, or by a green run being read as an inventory.

**Experiment (pre-registered).** The claim this ADR actually rests on is that a marked forward
reference gets acted on and an unmarked one does not. Ninety days from merge, take every
`Follows-up: <lane-id>` written in the window and ask what fraction of those lanes reached any state
past `open`, against the base rate for lanes opened in the same window from any other source.

**Falsify:** a `Follows-up:`-sourced lane advances no more often than a lane from any other source.
Then the marker is bookkeeping that changed nobody's behaviour, and the honest response is to delete
the gate rather than widen it — the same disposition ADR 180's eval reached for the advisory
reviewer, whose own rule ("near zero ⇒ drop it") decided its outcome. This ADR pre-commits to that
rule now, before the number exists.

**Snapshot-debt:** none. Every count above (9 lanes, 46 proposed ADRs, 28 with ≥10 citations, 843
lanes, 62 pages, 364 ADRs, 86 roadmap items) is exact and dated 2026-09-03, not a rate.
