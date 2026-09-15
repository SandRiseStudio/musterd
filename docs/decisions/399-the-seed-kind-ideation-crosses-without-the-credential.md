# 399 — The `seed` kind: ideation crosses to a joiner without the relay credential

- Status: accepted
- Date: 2026-09-15
- Relates to: ADR 371 (the `record` kind — this ADR amends its §3 and falsifier 2), ADR 248 / 311
  (the seeds relay and its ingest loop), ADR 325 (one team, one authority; a joiner is a replica),
  ADR 367 / 398 (the `policy` kind — the hub-exclusive origin rule this ADR copies), ADR 390 (the
  cloud seat holds what its job needs — the constraint that decides this), ADR 344 (per-seat scoped
  credentials)
- Lane: `01M2GX7SG5NHWMJE144XRJM3F9` — opened by stanley 2026-09-14 out of ADR 371's unrun falsifier 2
- Decided by: nick, 2026-09-15 ("replicate seeds, hub-origin"); recorded by stanley

## Context

ADR 371 §3 decided how a seed reaches a second machine, and it did not choose replication:

> A seed this daemon has not ingested from the relay yet stops as `seed_unborn`, retried each tick —
> `startSeedsIngest` runs on every daemon unconditionally (`index.ts:181`), so the seed is at most
> one relay poll away.

That is a coherent design and it is built: `seed_unborn` is real code (`sync/fold.ts:85`, `:326`,
`:874`), logged at `sync/pull.ts:164`, and tested at `sync/record.test.ts:283`. Thread entries
already cross as `record.seed_thread`, resolved by `relay_id` rather than by the daemon-local
`seeds.id`.

**Measured 2026-09-14/15, and the premise does not hold.** Three readings, hub and joiner:

1. **The joiner holds no seeds and never will by this path.** delta: `seeds` = 0, against the hub's
   53. No seed payload of any kind has ever appeared in `sync_log`, in either direction.
2. **The ingest loop is gated on credentials, not on hub-ness.** Nothing in `seeds/ingest.ts`
   mentions the hub. The loop runs on any daemon where `policy.seeds_relay_url` *and*
   `seeds_relay_token` are both set (`ingest.ts:66-69`). "Unconditionally" describes the call site,
   not the poll.
3. **Neither machine has those set.** Both policies read exactly `{"loops":{"dispatch":true}}` —
   identical, which incidentally confirms ADR 398's restatement works. So the relay poll is dormant
   on *both* daemons, and the hub's 53 seeds are historical (41 `repo`, 12 `slack`).

So "at most one relay poll away" is false for a joiner in the way that matters: the poll it is
waiting on can only happen if that machine is given the relay's bearer token.

**The incoherence this leaves.** `record.seed_thread` replicates — 55 rows in `sync_log` today. The
team already ships the *comments on* seeds across machines while the seeds they hang on stay put.
`seed_unborn` exists to cover a window that, for a credential-less joiner, never closes.

**What is not wrong.** No live wedge was found: zero `sync_fold_seed_unborn` on delta (other stops
do appear — `lane_unborn` ×3, `presence_unborn` ×1), so the dangling-thread-entry hazard is latent
rather than active. Recorded because it was checked, not assumed.

## Problem

Give a joiner the team's ideation without giving it the relay's credential, and make ADR 371
falsifier 2 runnable — without re-opening the federation question ADR 390 §6 defers.

## Decision

**`seed` becomes a replicated kind with a hub-exclusive origin, and the relay stays the hub's.**

1. **The hub is the only node that mints `seed` events.** This copies the rule `policy` and
   `record.incident_report` already carry (`sync/log.ts:185`, `:197`): a joiner-minted `seed` event
   is refused at ingest. The relay is polled in exactly one place, so a seed has one birth and one
   `relay_id` per team, and two daemons cannot race the same relay cursor.
2. **`relay_id` is the cross-machine identity, as it already is for thread entries.** The fold
   resolves to the local `seeds.id`; `UNIQUE(team_id, relay_id)` makes the projection idempotent.
   This is why no migration is needed — the kind rides `audit` + `sync_log`, and the projection
   target already exists.
3. **Lifecycle state does not cross with the row, and that restriction is unchanged.** ADR 371 §3
   left `seeds.state` local because an explorer claim is "exactly one holder" — a residence-1
   change. This ADR replicates the *capture* (the seed's identity and body), not its claim. A
   joiner can therefore read a seed and append to its thread; claiming or promoting one from a
   joiner remains out of scope, and is the same posture ADR 365 took.
4. **`seed_unborn` stops become closable.** The stop stays exactly as written; what changes is that
   the seed it waits for now arrives by fold rather than only by relay poll, so the window closes on
   a joiner that holds no relay token.

**ADR 371 §3 is amended, not overturned.** Its mechanism was right for a team whose every daemon can
reach the relay; it did not weigh the credential. Where §3 says the seed is one relay poll away,
read: one relay poll *or one fold* away, whichever the node can do.

### Rejected

- **Give the joiner the relay credentials.** Near-zero code — set `seeds_relay_url` and
  `seeds_relay_token` in team policy and they replicate to every joiner, which is §3 working as
  designed. Rejected because it puts the Slack relay's bearer token on a cloud VM, which is the
  exact direction ADR 390 ("what does this machine hold, and does its job need all of it?") and
  ADR 344 (per-seat scoped credentials) were written to push against. Ideation is data the seat
  needs; the relay token is not.
- **Declare seeds deliberately hub-only** and strike falsifier 2. Honest and docs-only, but it
  leaves a joiner unable to see or append to any Seed, and leaves the standing incoherence that
  thread entries replicate while their seeds do not.
- **Replicate lifecycle state too.** That is a residence-1 change — "exactly one holder" for an
  explorer claim — and belongs with the federation increment ADR 390 §6 defers, not here.

## Consequences

- **One more audit-shaped kind**, following the `record` kind's shape: a schema extension and union
  member (`protocol/src/sync.ts`), one push tag arm (`sync/push.ts`), an ingest authority rule
  (`sync/log.ts`), a verb set + projector + fold block (`sync/fold.ts`), a pull stop case
  (`sync/pull.ts`), writers moved to `appendReplicatedEvent`, a `sync/seed.test.ts`, and a census
  row. No DB migration.
- **A joiner's ideation is read-and-append, not claim.** `team_seed_list` and `team_seed_get`
  answer on a joiner; `claim`/`promote` stay hub-side. This is a deliberate half-step and is named
  so nobody reads the gap as a defect.
- **The relay remains a single-writer boundary.** Only the hub polls it, so the relay buffer's
  cursor has one consumer per team — unchanged from today, now by rule rather than by accident of
  configuration.
- **ADR 371 falsifier 2 becomes runnable** for the first time since it was written.

## Observability & Evaluation

**Traces** — after one sync tick, both daemons hold a `seed.captured` audit row for the same
`relay_id` with `origin_seq > 0`, and the joiner holds a `seeds` row for it. Falsify:
`sqlite3 ~/.musterd/musterd.db "select origin_seq, target from audit where action='seed.captured' order by ts desc limit 3"`
on hub and joiner, plus
`select count(*) from seeds` on both. A joiner that stays at zero while the hub's count climbs
falsifies this ADR — that is exactly the 2026-09-14 reading this ADR exists to fix.

**Eval** — seed agreement across daemons after one round trip, by `relay_id` rather than by
`seeds.id`. `sync/seed.test.ts` carries the claim (the capture crosses; re-delivery does not
duplicate; a joiner-minted `seed` is refused) and the negatives that keep it honest: lifecycle
does NOT cross (the claim stays where it was made), and `census.test.ts`'s existing row still
holds that a bare `UPDATE seeds SET state` ships nothing. ADR 371 falsifier 2 in
`sync/record.test.ts` is the end-to-end eval — a thread entry appended on the joiner lands on the
hub under the same entry id with `by` naming the seat, which could not run before this ADR.

**Experiment** — none as a flag or rollout: the kind is inert until a second machine exists, the
same posture ADR 371 took. The live pair (the revive hub and delta's joiner) is the first
production read, and it is owed rather than assumed: after this lands and both daemons run it,
`musterd seed list` on delta should answer with the hub's seeds, and a brief appended there should
appear in the hub's thread. Until that runs, the two-daemon in-process test is the evidence and the
cross-machine claim is unproven — recorded that way rather than implied.

**Falsifiers.**

1. A seed ingested at the hub appears on the joiner under the same `relay_id`, with the same body,
   within one sync tick. Fails without §1/§2.
2. **ADR 371 falsifier 2, finally runnable as written:** a brief appended on the joiner appears in
   the hub's `toSeed(...).thread` with the same entry id and `by` naming the seat. Appended before
   the joiner has folded the seed, the fold stops `seed_unborn` and applies it on the tick after the
   seed lands.
3. A `seed` event pushed by any node but the hub is refused at ingest, stages nothing and inserts
   nothing — hand-built from the joiner's own writer, as ADR 371 falsifier 4 does for records.
4. A joiner's `UPDATE seeds SET state = …` ships nothing (`census.test.ts`) — lifecycle stays local
   per §3.
5. Re-delivering the same pull batch does not duplicate a seed: `UNIQUE(team_id, relay_id)` holds
   and the projection is idempotent.
