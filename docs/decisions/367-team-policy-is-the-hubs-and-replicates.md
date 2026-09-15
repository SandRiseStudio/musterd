# 367 — Team policy is the hub's, and it replicates

- Status: accepted
- Date: 2026-09-03
- Relates to: ADR 325 (residence 1 — admission and policy are hub-authoritative; §Offline
  semantics), ADR 361 (every ownership edge is the hub's — the `/sync/lane` forward this copies),
  ADR 356 (presence as the third replicated kind), ADR 335 §8 (one allocator per node, dense across
  kinds), ADR 185 (the policy row is sparse — only what somebody chose), ADR 358 (a human's seat on
  a second machine), ADR 227 (a seat holds roles, plural)
- Lane: `01M1JNXSV74TNWWKWBTDDZY9HM` (residence-2 census gap 1)

## Context

ADR 325 named admission and policy hub-authoritative and shipped neither. The residence-2 census
(#1224, 2026-09-03) measured what policy actually does today, at 6a6304a7:

- `setPolicy` runs one `UPDATE teams SET policy = ?` and appends an **unstamped** `policy.change`
  audit row (`appendAudit`, not `appendReplicatedEvent`). Nothing ships it — the push selects rows
  by `origin_seq > ?`, and an unstamped row's is `0`.
- **21 readers** consult the local blob, `claimWakeLeases` among them. So after an admin runs
  `policy set` on the hub, a joiner's host actuator keeps waking seats under ITS `hourly_cap`,
  `cooldown_ms`, `attempt_cap`, `flow` and `loops` — the one policy input to the wake ledger,
  silently forked per machine. The census pinned this as its first gap, with a falsifier:
  `sync/census.test.ts`, "a team policy change on the hub never reaches the joiner".

Nothing in the fork announces itself. Two daemons disagree about a number both of them print with a
straight face, and the ledger they feed reads as one team's spend.

## Decision

**Policy is decided on the hub and learned everywhere through the fold — the `/sync/lane` shape
(ADR 361), applied to a fact about the team rather than about a lane.**

1. **A fourth replicated kind, `policy`.** The hub's `policy.change` audit row is stamped by
   `appendReplicatedEvent` — the same allocator as messages, lanes and presence, so the node's
   sequence stays dense and the hub's gap check is unchanged. `applyPolicyChange` writes the row and
   the stamp in one transaction: the value this daemon holds and the fact its peers will fold are
   the same fact, or neither happened. `setPolicy` stays as it was — the projector's own primitive,
   and deliberately silent.
2. **The event carries the STORED sparse doc, never the effective policy.** ADR 185 all over again,
   this time across a machine boundary: shipping the effective policy would bake the sending build's
   defaults into every peer's row and kill the schema default there for every knob nobody chose —
   the #530 failure, replicated instead of merely local. The fold applies it with **replace**
   semantics, so a knob an admin clears on the hub is cleared everywhere rather than surviving on
   each machine that once held it.
3. **An enrolled joiner forwards `POST /policy` to the hub** (`POST /teams/:slug/sync/policy`,
   node-credential authenticated) and writes nothing locally; it pulls immediately so the admin's
   next read agrees with the answer they were handed. The hub **re-authorizes the actor against its
   own roster** — a node credential proves the machine, never that the person behind the request is
   an admin there — resolving `is_admin` through capabilities, not a string compare on `role`
   (ADR 227).
4. **An unreachable hub refuses**, `hub_unreachable`, changing nothing (ADR 325 §Offline semantics).
   Policy is not an act that may fork: a provisional local value would be exactly the divergence
   this ADR closes, with the admin believing it had been set.
5. **The policy kind is exempt from residence binding at ingest, and hub-origin-only in exchange.**
   Residence answers "may this node speak AS this seat" (ADR 328 §4); a `policy.change` is a fact
   about the TEAM that only the hub ever mints, on a joiner admin's behalf. Binding the admin to the
   hub would strand the seat — its next message from the laptop it actually lives on would be refused
   for having set a policy it was told to forward.

   Residence is what normally stops one node writing under another's authority, so a kind that opts
   out of it has to earn the exemption some other way: **a `policy` event is admissible only on the
   hub's own loopback push**, and any other origin is refused at ingest. Without that, the exemption
   was the hole — `SyncPushRequestSchema` admits the kind (it must; the loopback push carries them),
   so any enrolled node could push a hand-built `policy.change` and the fold's replace semantics
   would install it as the team's policy everywhere, bypassing the forward and its re-authorization
   entirely.
6. **A forwarded policy change requires the actor to be ALREADY resident on the requesting node.**
   The strict form of residence, not the first-writer-wins `assertSeatResident` the lane routes use.
   Binding on first use is right for ordinary work — a seat's first act has to bind somewhere — but
   for an act that changes the team it is the opening: an unbound admin seat could be claimed by
   whichever enrolled machine named it first, in the same call that used it. "Not yet bound" reads
   here as "not entitled", never as a free claim.

   The cost is a constraint on the legitimate path, stated rather than discovered: an admin whose
   very first act on a fresh joiner is `policy set` is refused until the seat has done anything else
   there. It is self-healing (nearly any act binds the seat, and the refusal says so) and no real
   admin is in that state — the seat lives on the machine its human works from.

   Both of 5 and 6 come from gptbot's review of #1228, which declined the first cut for exactly these
   two gaps. `sync/policy.test.ts` holds all of it, negative and positive: a second enrolled node
   refused on the forward for a seat that lives elsewhere, refused again for an unbound seat (with
   the binding checked absent afterwards, so the refusal did not create what it refused for want of),
   refused on the direct push — and the hub's own loopback still carrying policy through to the
   joiner, so the checks cannot pass by having switched the kind off.

### Rejected

- **Last-writer-wins on a replicated blob, edited anywhere.** Two admins on two machines, and the
  loser's row is silently overwritten with no refusal anybody sees. Residence 1 exists to avoid it.
- **Merging the folded doc into the local one.** A knob cleared on the hub would live forever on
  every machine that once held it — a fork that heals in one direction only.
- **Leaving policy local and having the host ask the hub per wake.** A network round trip on the
  hottest path in the actuator, and an offline joiner then has no policy at all rather than a stale
  one it can name.

## Consequences

- A joiner's wake caps, cooldowns and loop switches are the hub's after one sync tick. The wake
  ledger's policy input stops forking per machine, which is what made cross-machine wake-cost
  numbers uncomparable.
- `policy set` on a joiner now needs the hub reachable. That is a new failure mode for an act that
  used to always "succeed" — succeed, and diverge. The refusal names the hub.
- The fold has a fourth kind to keep in step. A `policy.*` verb a build cannot project stops the
  cursor at that event (`unknown_policy_event`) and retries each tick, the same discipline as the
  lane and presence kinds; there is no `unborn` shape, because the team row always exists locally
  and the event carries the whole doc rather than a delta.
- **`policy set` from a joiner now has a precondition an admin can hit: the seat must be resident on
  that machine.** The refusal names it and any ordinary act clears it, but it is a real new way for
  the command to fail on a freshly enrolled laptop whose admin does nothing else first.
- **Every future replicated kind that claims a residence exemption inherits decision 5's obligation.**
  The exemption is not free: whatever kind takes it must say who is allowed to mint it and enforce
  that at ingest instead. `REPLICATED_LEDGER_VERBS` in `store/audit.ts` is where the next one lands.
- Census gap 1 closes; gaps 2 (`seat_memory` / `inbox_cursors`, lane `01M1JNY14F`) and 3 (the
  insight substrate, lane `01M1JNY95C`) stay open.

## Observability & Evaluation

**Traces** — the hub's `policy.change` rows now carry an origin stamp, and every other machine holds
the same row with the same stamp. Falsify on two live daemons:
`sqlite3 ~/.musterd/musterd.db "select origin_node, origin_seq, detail from audit where action='policy.change' order by ts desc limit 5"`
— a `policy.change` with `origin_seq = 0` written after this lands falsifies decision 1 (some caller
reached `setPolicy` directly); the same query on a joiner returning nothing after an admin edit on
the hub falsifies decisions 1–3.

**Eval** — `getPolicy` agreement across machines: the stored doc on hub and joiner, compared after a
sync tick, should be byte-identical. A divergence means either a direct `setPolicy` caller or a fold
that stopped — `sync_pull` logs the stop kind, and `unknown_policy_event` there means the joiner is
older than the hub and needs upgrading, not that the fold is broken. Owner: whoever next edits team
policy on a federated install.

**Experiment** — none. The two-daemon falsifiers in `sync/policy.test.ts` are the whole claim, and
they run in CI rather than needing a live pair.
