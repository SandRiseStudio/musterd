# 270 — Incident convergence increment 2: detection that fires, then routing

- **Status:** accepted 2026-08-14
- **Relates to:** spec `docs/superpowers/specs/2026-08-14-incident-convergence-design.md` (the
  umbrella; §3 and §5 are what this increment closes), ADR 266 (increment 1 — this reorders its
  successor and amends nothing it decided), ADR 185 (sparse policy, defaults on read), ADR 227
  (roles), ADR 252 / 262 / 269 (wake pricing, the per-edge ledger, and the wake-report rejection
  this increment waits on), ADR 150 (lane ownership), ADR 051 (audit rows carry shapes).

## Context

ADR 266 shipped the detection and deduplication half: `meta.blocked_by` on a `status_update`, a
`kind:'incident'` lane at two distinct reporters, a duplicate auto-reply and a `team_next` banner.
Increment 2 was specified as routing, wakes, and the policy block — the convergence half.

**Before building it, the shipped half was measured, and it had never fired.** Zero `blocked_by`
reports in the entire message history, zero `incident_reports` rows, zero incident lanes, on a
daemon demonstrably running the v41 schema. Not a bug in clustering: nothing ever reached it.

Two mechanical causes were already known and had been handed back on increment 1's acceptance:

1. **A CLI seat could not express the report at all.** `--meta` coerces every value to a string,
   number, or boolean (`args.ts` `coerce`), so `--meta blocked_by.gate=…` lands as a flat key and
   never becomes the nested object clustering matches on.
2. **The norm was taught only in the on-demand skill body** — a document a seat that just hit a red
   has no reason to open. The always-loaded primer was considered during increment 1 and refused:
   the per-session context budgets had ~47 B of slack, and taxing every session for a rare event is
   the wrong trade. That left the bootstrap an unmeasured behaviour bet.

Building claim windows and wakes on top of that would have made the expensive half richer while the
cheap half produced nothing. So this increment leads with detection and gates the rest behind it.

## Decision

### 1. Detection first, and proven before anything routes

- **`musterd send --blocked-by <gate> [--ref <what>] [--sig <detail>]`.** It rides `status_update`
  (spec §1 — no new act), so the act is implied and a bare one-liner is a complete command; filing
  on any other act is refused rather than silently landing where clustering never looks. Empty
  `--ref`/`--sig` are dropped, because the protocol requires `min(1)` and a shell variable that
  expanded to nothing must not turn a good report into a rejected envelope.
- **The failing gate teaches the norm.** A shared CI gate that fails prints it, with the runnable
  command, at the moment of need (`scripts/lib/shared-blocker-notice.mjs`, wired into both failure
  paths of the a11y contrast gate). Zero context budget, and it reaches exactly the seats who hit
  the red. The notice carries the norm's own guard — "a red your diff **can't touch**" — without
  which it reads as permission to report your own bug and walk away.
- **The gate supplies the canonical gate string**, and this is load-bearing rather than convenient.
  Clustering is exact-match on `gate`, so two seats have to state a check name identically without
  coordinating. Printing the key removes that coordination problem instead of betting two agents
  phrase it the same way. Strings are `ci:<job>/<step>` as GitHub Actions names them, so a seat
  reading a red check in the PR UI and a seat reading this notice arrive at the same key.
- **The printed command is parsed back through the real CLI parser in test**, so the notice and the
  flag cannot drift apart.
- **An end-to-end probe** walks the path a seat actually walks — real `musterd send` against a real
  daemon, three reporters — and asserts convergence at the far end. Increment 1's integration tests
  posted hand-built envelopes straight to HTTP; they proved the daemon clusters a well-formed report
  and nothing about whether a seat could produce one.

### 2. The knobs become per-team policy, with a posture that differs from `loops` in both directions

`incident: { enabled, cluster_threshold, claim_window_ms, fallback_role, wake_on_route,
wake_on_resolve }`, beside `loops` in `PolicySchema`. Defaults apply on read, never on write
(ADR 185), so every existing team materializes the block with no migration.

- **Clustering defaults ON.** Increment 1 shipped it on for every team with no switch; a default-off
  block would silently remove shipped behaviour at upgrade. `enabled: false` is an opt-OUT that
  degrades to pre-increment-1 exactly, writing **no row at all** — a team that turned this off must
  not accumulate a pool that springs into an incident when someone turns it back on.
- **Both wake knobs default OFF, against the spec's `true`.** See §4.
- `cluster_threshold` is floored at 2: one seat is not a cluster.

### 3. The claim window closes onto a role, not onto a person

An incident unowned past `claim_window_ms` is assigned to the seat holding `fallback_role`, by a
sweeper in the reaper.

**Context beats role, and the window is what enforces it.** The seats who hit the red know most
about it, and the a11y episode this spec came from was fixed across two surfaces (`scripts/a11y/**`,
`packages/web/**`) that no single role seat should own. Any seat may take it first; this only ever
catches what nobody did, and never reassigns an owned lane. The message to the assignee says
outright that they may hand it back: **an assignment nobody chose is a routing default, not a
verdict about who should fix it.**

- `getMemberByRole` is new rather than a fourth copy of the inline `WHERE role = ? LIMIT 1` in
  `http.ts` and `ws.ts`, and differs from both where it matters for deciding who gets work: it reads
  the ADR 227 **roles array** (a seat whose platform role lives in the JSON is invisible to those
  copies, and a fallback owner who exists but cannot be found is indistinguishable from none), and
  it is **deterministic** (`LIMIT 1` with no `ORDER BY` routes by whim and is not reproducible from
  the audit log).
- **Nobody holds the role ⇒ the incident stays unowned.** An unrouted incident is a real state the
  banner keeps pointing at; a lane assigned to someone who never agreed to it looks owned while
  nobody is on it. Recorded once per lane, never once per sweeper tick.
- The sweeper is deliberately **not** behind `loops.sweep`. That switch arms a loop that CLOSES
  other people's lanes; this one only puts a name on a lane already open and visible. `incident.
  enabled` is its own switch.

### 4. Wakes are specified, defaulted off, and deferred behind ADR 269

The spec asked for `wake_on_route` and `wake_on_resolve` defaulting `true`. They ship `false`, and
the edge itself is not built in this increment.

The spec's `true` assumed wake pricing was sound. It is not, and the reason is worse than
"unpriced": wake reports were being **rejected**. `transcript_age_ms` is
`Date.now() - fs.stat().mtimeMs`, `mtimeMs` is fractional on APFS, the schema said `.int()`, and Zod
rejected the whole object — killing the lease settlement and the `cost_usd` together. 48 rejections,
$22.54 of measured spend discarded, and **zero audit rows**, because the ledger has no way to say "I
refused this" (ADR 269). An unsettled act stays due and gets re-leased, which is most of the observed
5× lease rise.

Two consequences, both recorded because the reasoning matters more than the conclusion:

- Arming a new wake edge for every team at upgrade, on top of accounting that is actively dropping
  prices, is not a defensible default. Every other spending switch in this repo is opt-in; `loops`
  is the precedent. An admin writes one knob.
- **Nothing in incident detection may key on wake-outcome rows.** `wake_failed {reason:
  lease_expired}` currently describes wakes that succeeded, reported, and cost money. Clustering
  built on that input would manufacture incidents out of successful wakes — and would fire hardest
  on the seats doing the most work. A detector whose input lies is worse than no detector.

Two seats independently read this code correctly and concluded "the report path was not taken", when
the truth was "the report was refused". That is a general trap worth naming: **absence of a record
is not evidence of absence of the event, when the failure path writes nothing.**

### 5. Resolve fans out to exactly the reporters

On close of a `kind:'incident'` lane, every distinct reporter is told — this is what increment 1's
"keep appending rows past the threshold" was for. A seat that parked a PR behind a shared red has no
other way to learn it can move again short of a human noticing and relaying it, which is the exact
job this spec set out to delete. Wired at **both** close paths (the board's PATCH and the ADR 202
acceptor `accept`), because `recordLaneClose` deliberately cannot route envelopes — it is imported
from the transport and protocol layers both, and routing from it would make that a cycle.

### 6. What this increment deliberately does not do

- **No banner enrichment.** The claim-window countdown and ownership belong in the `team_next`
  banner, which lives in `orientation.ts` — under a freeze until 2026-08-21 so the ADR 260 Eval
  re-run has a readable window (izzo's lane). Accepted with no carve-out: a freeze with a hole in
  the one file this increment would touch is most of the way to no freeze. Revisit after 08-21.
- **No wake edge** (§4), no CI watcher (increment 3), no cross-team incidents, no auto-remediation.
- "Does anything merge past the red" stays a human ask (spec §6).

## Observability & Evaluation

**Traces.** Increment 1's three verbs, plus two: `incident.routed` (the claim window closed and the
fallback role got it — actor null, a machine decision like `wake_leased`; target = lane, detail
`{ role, owner, waited_ms }`) and `incident.route_unfilled` (window closed, nobody holds the role;
once per lane, never once per tick, or it buries the ledger it exists to inform). Shapes only, never
sig or body text (ADR 051).

**Eval.** ADR 266's eval — "< 15 minutes from second report to single ownership, 0 human routing
messages on the next shared blocker" — could not be run, and that is the finding this increment is
built on: it waits on an unpredictable event, and after days of waiting the honest reading was not
"no shared blocker occurred" but "the mechanism never fired". An eval that cannot distinguish those
two is not an instrument.

So this increment carries an eval that runs on demand:

- **Dataset:** the 2026-08-13/14 a11y episode, as before (~4 hours to single ownership, ~5 human
  routing messages).
- **Runnable now, and green:** `packages/cli/src/commands/send.incident.test.ts` walks CLI → daemon
  → cluster → lane → park-behind reply with three reporters, plus the negatives (one seat reporting
  twice is not a cluster; an ordinary `status_update` opens nothing; a raised threshold holds the
  lane back; `--incident off` degrades exactly). This is the claim "a seat can converge a shared
  blocker", stated as a test rather than a hope.
- **Still measured in the wild:** time from second report to single ownership, and human routing
  messages, from the audit rows above joined to the message log.
- **Disproof:** a shared blocker where seats hit a red, did NOT file `blocked_by`, and debugged it
  separately — that falsifies the bootstrap (the gate notice failed to teach), which is now the
  weakest link rather than the clustering. Also: two seats each burning > 15 minutes on one gate
  after its incident opened, or an incident that never converges to one owner.

**Experiment.** None — this closes a measured coordination failure; no A/B (the spec's own call).
The one thing worth watching without an experiment is whether `incident.route_unfilled` shows up at
all: it would mean teams are pointing `fallback_role` at a role nobody holds, which is a
configuration failure that looks like silence.
