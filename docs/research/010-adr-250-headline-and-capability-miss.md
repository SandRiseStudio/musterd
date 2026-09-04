# 010 — ADR 250's headline and third reads, instrumented: 0.10 asks per merged PR, 10% of landings inert

**Status:** measured 2026-09-04 · **Lane** `01M1MMMDCRYFA0G9RVZQ7H7WX9` · **Reads** ADR 250 §Eval
instruments 1 + 3 · **Apparatus** `scripts/research/adr-250-asks-per-pr.ts` (`pnpm
adr250:asks-per-pr`), `scripts/research/adr-250-capability-miss.ts` (`pnpm adr250:capability-miss`)

ADR 250 named three weekly reads. Finding 009 took the second (repeat wakes); the other two —
**asks-to-founder per merged PR** (the one the ADR calls the headline) and **capability-miss
count** — had prose instructions, no instrument, and no schedule. This is the instrumentation and
the first readings.

## Headline (live dogfood ledger, 2026-09-04, all time)

**Asks-to-founder per merged PR: 0.10** (58 asks to humans / 569 merged PRs). Every directed ask to
a human went to nick. The per-week series is the read the ADR actually asks for, and it falls:

| Week | Asks | PRs | asks/PR |
| ---- | ---- | --- | ------- |
| 2026-W31 | 15 | 53 | 0.28 |
| 2026-W32 | 8 | 53 | 0.15 |
| 2026-W33 | 10 | 74 | 0.14 |
| 2026-W34 | 8 | 127 | 0.06 |
| 2026-W35 | 8 | 75 | 0.11 |
| 2026-W36 | 6 | 124 | 0.05 |

The ADR's baseline evening (2026-08-05, inside W32) had 26 open founder-directed asks; the ratio
has roughly halved twice since. The ADR's prediction — falls as the merge loop (item 2) and
acceptance absorption (item 4) land — is so far consistent with the ledger, and this instrument is
now the thing that would catch it not falling.

**Capability-miss: 40 of 420 lane-scoped landings inert (10%), 33 of them repeats.** A landing is a
`reported` wake lease naming a lane; inert means no `lane.*` audit row for that lane within 24h.
The worst clusters:

```
13×  gptbot · 01M040DH9X · dispatch_continuation   [69m from 2026-08-17]
13×  gptbot · 01M0B1DP6Z · dispatch_continuation   [167m from 2026-08-18]
 8×  gptbot · 01KZ4QH585 · (no edge)               [1832m from 2026-08-04]
 3×  ryder  · 01M159BHJK · dispatch_continuation   [10m from 2026-08-29]
```

The two 13× clusters are the *same lanes* finding 009's deferral half caught re-deriving
`local-session-live` 22–23× — the rail spun on those lanes on both sides of the spawn boundary in
the same weeks: the router deferred dozens of times, and when a lease did get taken, the landing
was inert 13 times running. That is the strongest form of the ADR's item-1/item-3 argument: the
churn and the inertness are one pathology seen from two sides.

## Interpretation, and what these do not say

**Inert understates capability-miss, on purpose.** The wire carries no capability field (recording
one is backlog item 3's own ADR), so this reads the observable shape of the ADR's named instance —
the wake landed, the lane never moved. A lane moved by *any* seat clears the landing, and a session
that landed and legitimately did something else first still counts. The count is therefore a floor,
not a verdict: 10% of landings provably produced nothing, and after item 3 lands any nonzero week
is a routing bug by the ADR's own definition.

**The asks ratio does not price judgment.** 0.10 asks/PR says nothing about how heavy each ask was;
the ADR's own corpus note is that what remains concentrates into *pure* judgment. A falling ratio
with a rising per-ask weight would not be the win the headline suggests — the per-recipient
breakdown and the ask-tier mix are the place to check that, and both are in the JSON output.

**Neither number is a target to minimize by construction.** Per the Goodhart caution in
`human-agent-dynamics.md` §4: these are diagnostics. A week of zero asks because nobody dared raise
one is worse, not better.

## Method, and the criteria that can come out false

Asks-per-PR: `messages` rows with `act='ask'`, `to_kind='member'`, recipient `kind='human'`
(humans identified by the members table, never a hardcoded name), divided by `audit` rows
`git.pr_merged`, bucketed by ISO week. A zero-PR week prints "no merged PRs", never NaN and never a
flattering 0.

Capability-miss: `wake_leases` (`status='reported'`, `lane_id` present) against all-time `lane.*`
audit targets, grace 24h; repeats counted attempts-beyond-the-first per (member, lane, edge), the
same quantity 009 counts. Timestamps come from `created_at`, never the lazy-swept `lease_expired`
rows (ADR 250's amendment measured those 4–11s late); `edge` comes from the lease row, never
`derivation` (the amendment's published conflation).

Both test suites open with the both-directions pair 009 established as the pattern: a clean ledger
reads 0, the ADR's own instance shape reads its count (6 inert landings → 5 repeats; 6 asks over 3
PRs → 2.0). Mutations checked: zero-PR window (null, not NaN), lane event before the wake (does not
clear), lane event at exactly grace expiry (does not clear), expired lease (not a landing), lane-less
lease (not a landing), per-edge separation on one lane.

**Scheduling: none built, deliberately.** The radar plan §8 defers a runner until the digest has run
for weeks, and these reads share that decision — they are hand-run alongside `pnpm radar:sweep
--triage --emit`, one weekly ritual, no second scheduler. Revisit together when M5 is picked up.

Reproduce: `pnpm adr250:asks-per-pr` and `pnpm adr250:capability-miss` (both take `--days N`,
`--json`). Falsify either headline by re-running against `~/.musterd/musterd.db` and disagreeing
with the numbers rather than with this page.
