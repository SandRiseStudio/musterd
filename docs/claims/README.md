# Claims ledger

When a claim a seat put on the team record turns out to be wrong, the correction mints one entry
here: who claimed it, who caught it, through which channel, how long it lived, and what it cost.
ADR 294 governs. Entries are research data for the ADR 056 program (model / harness / memory
comparisons) — they are **not** a scoreboard, and decision 4 of the ADR forbids reading them as one.

## What counts as a claim

A falsifiable assertion a seat asserted as fact on the team record: a lane title or detail, a
status_update assertion, the factual premise of an acceptance verdict or an ADR, a wiki claim.
Plans, opinions, and hypotheses *labeled as hypotheses* are not entries — an entry needs a
statement that was asserted and then shown wrong by evidence. Instruments count: a service seat's
raise (e.g. guardian's `daemon_down`) asserts a fact and can be false; its entries record
`claimant_model: none (deterministic probe)`.

## Who mints an entry, and when

**The corrector, at the moment of correction, riding the act they are already performing.** Never
a sweep, never a patrol, never a background job (ADR 294 decision 2). The four surfaces:

1. **Acceptance** that overturns or materially amends a submitted claim — the acceptor mints.
2. **Challenge** that ends in concession — the challenger mints (or the conceder; whoever lands
   the correcting commit).
3. **Self-correction** posted to the stream — the retracting seat mints its own entry.
4. **Wiki strike-through / ADR amendment** — the commit that strikes the claim carries the entry
   in the same branch.

The claimant pays nothing at claim time. If you are correcting someone and cannot spare the entry,
say so in the correction — an unminted entry someone else can backfill beats a silent one.

## Entry format

One file per entry: `entries/<falsified-date>-<slug>.md`. YAML frontmatter, then a short prose
body: what was claimed, what showed it wrong, with references. Append-only — a wrong entry is
overturned in place with a dated note (wiki rule 4 shape), never deleted.

| field | meaning |
| --- | --- |
| `claim` | the assertion, quoted or tightly paraphrased |
| `claimant` | seat that asserted it |
| `claimant_model` | model attestation of the claiming message/PR; `unknown` if unresolvable; `none (deterministic probe)` for instruments |
| `claim_ref` | message id / file+PR / lane id where the claim was made; `unresolved (quoted in correction)` when the original is off-stream |
| `claim_class` | `measurement` \| `causal` \| `defect` \| `absence` \| `record` (see below) |
| `claim_confidence` | the probability the claimant stated, in (0, 1], or `unstated` (ADR 294 amendment 2026-09-02). Never infer one; an absent confidence is absent, not 1.0 |
| `claimed_at` / `falsified_at` | dates (UTC) |
| `detection_channel` | `self` \| `peer` \| `acceptance` \| `challenge` \| `human` \| `collision` (see below) |
| `detection_latency` | how long the claim stood |
| `corrector` / `corrector_model` | who falsified it, and their attestation |
| `correction_ref` | message id / PR / commit carrying the correction |
| `cost` | what the false claim consumed while it stood (qualitative is fine; name it) |
| `status` | `falsified` \| `amended` \| `overturned` (this entry was successfully challenged) |
| `falsifier` | **of this entry itself** — what observation would show the entry is wrong |

### `claim_class`

- `measurement` — a number, rate, or frequency ("blob is ~880 B", "5 slugs are dead")
- `causal` — X because Y ("the raises correlate with autorefresh bounces")
- `defect` — something is broken ("main is RED", "goals.test.ts is broken")
- `absence` — the reassurance class: nothing is wrong, it's noise, the control is in force.
  Rule 3 of the [wiki README](../wiki/README.md) explains why these are the dangerous ones:
  they stop people looking.
- `record` — a bookkeeping fact about team state ("lane X is unaccepted")

### `detection_channel`

By process stage, in roughly increasing order of badness:

- `self` — the claimant caught it (the *best* way to have been wrong)
- `peer` — a teammate remeasured outside any gate
- `acceptance` — caught while exercising a submitted outcome
- `challenge` — a standing claim was formally challenged
- `human` — a human's question triggered the recheck
- `collision` — the claim was discovered wrong days later by colliding with reality
  (a lane failed against it, an incident exposed it)

## Rules entries inherit

1. **An entry is itself a claim.** Its `falsifier` must be able to fail (wiki rule 3). An entry
   whose falsifier would pass either way is not ready to merge.
2. **One challenge.** The claimant may challenge an entry with evidence; an entry that loses is
   marked `overturned` with a dated note and stays visible. No re-litigating past that.
3. **No bare rates.** Any computed cut over these entries must carry its detection-channel
   breakdown and its denominator basis, per ADR 294 decision 4. A rate without its detection
   story misleads exactly the way this ledger exists to prevent.
4. **Visibility holdback.** Until the ADR 294 checkpoint (2026-10-01), computed per-seat and
   per-model cuts stay out of agent-facing surfaces (orientation briefs, acceptance context,
   wiki). Raw entries are public — this file and `entries/` are readable by anyone — but nothing
   computes a leaderboard into an agent's context. See the ADR for why.

## Template

    ---
    claim: "<the assertion>"
    claimant: <seat>
    claimant_model: <model | unknown | none (deterministic probe)>
    claim_ref: <msg id | file + PR | unresolved (quoted in correction)>
    claim_class: <measurement | causal | defect | absence | record>
    claim_confidence: <0.xx | unstated>
    claimed_at: <YYYY-MM-DD>
    falsified_at: <YYYY-MM-DD>
    detection_channel: <self | peer | acceptance | challenge | human | collision>
    detection_latency: <duration>
    corrector: <seat>
    corrector_model: <model>
    correction_ref: <msg id | PR | commit>
    cost: <what it consumed>
    status: falsified
    falsifier: "<what would show THIS ENTRY is wrong>"
    ---

    <2-6 sentences: what was claimed, what showed it wrong, references.>
