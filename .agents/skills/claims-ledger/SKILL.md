---
name: claims-ledger
description: When a claim someone put on the record turns out to be wrong, the correction mints one entry — who claimed it, who caught it, through which channel, how long it stood, what it cost. Minted by the corrector riding an act they are already performing, never by a sweep; no bare rates, ever; and self-correction scores best. Use when a team keeps being confidently wrong, when you want to know whether review catches anything, or before building any "quality" metric over people.
---

# claims-ledger

*One of three thin instruments from [dated-and-falsifiable](../dated-and-falsifiable/SKILL.md).
Each is a file convention plus a script of about two hundred lines; each works
alone, on one machine, with no server. They share one rule: **a record must be
able to fail.** If the check passes just as happily when the claim is wrong, it
is a ritual, not an instrument.*

Teams measure once and treat the snapshot as timeless. Sometimes review catches
it. Sometimes the wrong claim stands for a week and is found only when someone
collides with it.

A team with a loud, healthy correction culture still produces **prose, not
data.** Nothing records who claimed what, who caught it, through which channel,
how long it lived, or what it cost — so nothing can answer the questions that
actually matter: *does our review catch what it should? Which kinds of claim are
dangerous here? Is the same generator minting the same falsehood over and over?*

This is the cheapest possible instrument for that, and most of its design is
about **not compounding the disease it treats.**

## Three ways this goes wrong, designed against explicitly

**It becomes paperwork.** A registration tax at claim time is a tax people route
around. So the claimant pays *nothing*. The entry is written by the corrector,
at the moment of correction, in the same commit as the correction prose — about
fifteen lines of frontmatter beside writing they were doing anyway.

**It becomes a leaderboard.** Per-person "false claim rates" are detection-bias
artifacts, and they get quoted without their denominators. So: no bare rates,
ever, and nothing computed here feeds anything automatic.

**It gets gamed.** If being wrong is scored, people hedge into
unfalsifiability, under-claim, and — worst — stop self-correcting. So
self-correction is published as the **best** way to have been wrong.

> The design north star: **the cheapest way to game the metric must be identical
> to the behaviour the metric wants.**

## The four rules

### 1. The corrector mints, riding an act that already exists

Never a sweep, never a patrol, never a background job. There are four surfaces
where a correction already happens, and the entry rides whichever one fired:

- a **review** that overturns or materially amends what was submitted — the
  reviewer mints;
- a **challenge** that ends in concession — whoever lands the correcting commit;
- a **self-correction** posted publicly — the retracting person mints their own;
- a **strike-through or amendment** in a document — the striking commit carries
  the entry in the same branch.

If you are correcting someone and cannot spare the entry, **say so in the
correction.** An unminted entry somebody can backfill beats a silent one.

### 2. Entries are themselves claims

Every entry carries a `falsifier` that can fail. The person who was corrected
may challenge an entry once, with evidence; a losing entry is marked
`overturned` and **stays visible**.

Corrections err too. A ledger exempt from its own discipline is the thing it was
built to catch.

### 3. No bare rates, ever

Any cut over entries carries its **detection-channel breakdown** and its
**denominator basis**. This is not optional context — it *is* the finding.

The ledger measures **caught** wrongness, and catching is proportional to
scrutiny. A channel with a high count may simply be the one doing its job. A
rate without its detection story is a falsifier that cannot fail, wearing a new
costume.

The script makes this structural rather than cultural: `--cut` prints counts and
**never a percentage**, with the caveat attached every time.

### 4. Observational only, and self-correction scores best

Ledger data feeds nothing automatic — not who gets assigned what, not
permissions, not review thresholds. The published badness ordering of detection
channels is:

```
self  <  peer  <  review  <  challenge  <  human  <  collision
```

`self` is the *least* bad way to have been wrong. `collision` — discovered days
later because reality disagreed — is the worst.

> **If this ledger ever makes someone regret posting a retraction, it has failed
> at its one job.**

If you add stated confidence to claims, score it with a proper scoring rule
(Brier-style), under which honest confidence is the optimal strategy. And
**never infer a confidence that was not stated** — an absent confidence is
absent, not 1.0. Scoring someone at certainty they never claimed is how you
teach people to stop claiming anything.

## An entry

```yaml
---
claim: "that intermittent suite failure is runner noise -- safe to ignore"
claimant: a seat
claimant_model: unknown
claim_ref: docs/wiki/running-the-gates.md (the struck paragraph)
claim_class: absence
claim_confidence: unstated
claimed_at: 2026-08-12
falsified_at: 2026-08-19
detection_channel: collision
detection_latency: 7 days
corrector: a different seat
corrector_model: unknown
correction_ref: PR #918
cost: "high -- cost one person a whole task and another most of a day, and the reassurance stopped anyone else looking for seven days"
status: falsified
falsifier: "run the named suite 20 times in full and 20 times isolated; if the failure rate is the same in both, the claim was right and this entry is overturned"
---
```

Then a short body: what was claimed, and what showed it wrong, with references.
Append-only — a wrong entry is overturned in place with a dated note, never
deleted.

### `claim_class`

| class | what it looks like |
| --- | --- |
| `measurement` | a number, rate or frequency — *"the blob is ~880 B"* |
| `causal` | X because Y — *"the alerts correlate with the deploy"* |
| `defect` | something is broken — *"main is red"* |
| `absence` | **the dangerous one** — nothing is wrong, it's noise, the guard is in force |
| `record` | a bookkeeping fact — *"that task was never reviewed"* |

**`absence` is the class to watch.** Those claims stop people looking, so they
have the longest half-life of anything on the ledger — the worked example above
stood seven days *with* a date *and* a falsifier, because the falsifier could not
discriminate between a real defect and the harmless noise it claimed.

## What counts as a claim

A falsifiable assertion somebody **asserted as fact on the record**: a task
title, a status note, the factual premise of a review verdict or a decision
record, a documented claim.

Plans, opinions, and hypotheses *labelled as hypotheses* are not entries — an
entry needs a statement that was asserted and then shown wrong by evidence.

Instruments count. A monitor's alert asserts a fact and can be false; its
entries record `claimant_model: none (deterministic probe)`.

## The script

```sh
./claims.py [entries_dir]          # validate every entry
./claims.py [entries_dir] --cut    # validate, then print the aggregate
```

Exit 0 when every entry is well formed, 1 when one is not, 2 when the directory
cannot be read. Python 3.8+, standard library only.

| Rule | What it refuses |
| --- | --- |
| every field present | A missing field. All sixteen are the record. |
| the enums | A `claim_class`, `detection_channel` or `status` outside its set. |
| real dates, in order | Unreal dates, and a `falsified_at` before its `claimed_at`. |
| confidence is stated or `unstated` | Anything outside `(0, 1]` — and it will not let you write `0`, which is not a probability anyone holds. |
| the entry's own falsifier | A stub. An entry is a claim and is not exempt. |
| a body | Frontmatter alone. The frontmatter is the index; the body is the finding. |

`--cut` prints something deliberately blunt:

```
by detection channel (self is the BEST way to have been wrong):
  self         # 1
  ...
  collision    # 1

DENOMINATOR: these are CAUGHT claims. The denominator -- claims made --
is unknown and unknowable from this ledger. Catching is proportional to
scrutiny, so a channel with a high count may be the one doing its job.
Do not divide these by anything. Do not rank people by them.
```

That paragraph prints on every cut, and it is the most important output the
script has. Counts, never percentages — the moment someone can quote a
percentage without the caveat, rule 3 is gone.

## If you hold the cuts back, date the holdback

Raw entries are public in git from day one — they must be, the corrector commits
them. If you decide that *computed per-person cuts* stay off every surface until
the practice settles, that is reasonable. **Give the holdback an expiry date, in
writing, in the decision that creates it**, along with who decides at that date
and what the options are.

An undated holdback is just another guard everyone believes is in force. This
one expires by construction. (Accept the known leak out loud: anyone can compute
their own cut from public entries. Do not surface it, do not prohibit it, and
notice that the effect is itself observable.)

## The falsifier

**Break each rule and watch it fire.** Copy `entries.example/`, mutate one
field, run the script on the copy. Fifteen refusals and five must-*not*-fire
cases were exercised this way on 2026-09-21 against the shipped script:

| Mutation | Expected |
| --- | --- |
| delete any required field | exit 1, "missing required field" |
| `claim_class: vibes` | exit 1, "must be one of measurement \| causal \| …" |
| `detection_channel: osmosis` | exit 1, same for its set |
| `status: deleted` | exit 1, same — entries are append-only |
| `falsified_at: 2026-02-31` | exit 1, "must be a real ISO date" |
| `claimed_at: 13/08/2026` | exit 1, same |
| `falsified_at` before `claimed_at` | exit 1, "cannot be caught before it is made" |
| `claim_confidence: 1.4` / `0` / `pretty sure` | exit 1, "a probability in (0, 1] or the word `unstated`" |
| `falsifier: "it is wrong"` | exit 1, "an entry is itself a claim" |
| frontmatter with no body | exit 1, "the body is what showed it wrong" |
| prose with no frontmatter | exit 1, "structured data plus prose" |
| `claim_confidence` of `0.7`, `1.0`, `unstated` | exit 0 |
| `status: overturned` | exit 0 — a losing entry stays visible |
| no mutation | exit 0 |
| a directory that is not there | exit 2 |

Unlike the two sibling instruments, every row here fired on the first run. That
is not a claim to have got better at this — it is that this schema has only one
cross-field ordering rule (`falsified_at` after `claimed_at`), and the two
fixtures that broke in
[pre-registered-watch](../pre-registered-watch/SKILL.md) broke because a
*different* rule shadowed the one under test. Fewer interacting rules, fewer
places for a fixture to lie. Worth knowing when you design the next schema.

---

*From the musterd team — the coordination layer where agents and humans are
peers. This skill is the practice; musterd is where it has a name, a roster, and
a record. Everything above works on one machine with no server; what a file
cannot do is attest `claimant_model` — who or what actually made a claim is
self-declared here, not observed, and every per-model cut inherits that. musterd.io.*
