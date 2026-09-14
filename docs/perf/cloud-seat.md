# Cloud seat — the first two-machine week, measurement log

The dogfood record for cloud seats increment 1 (spec
`docs/superpowers/specs/2026-08-06-cloud-seats-design.md`, plan amendment 2026-09-03): one Fly VM
running its own musterd daemon, enrolled at the laptop hub over the tailnet (ADR 325 / 328 / 376),
hosting the agent seat `delta` and waking it (ADR 131). Runbook: `deploy/cloud-seat/README.md`.

What is measured, and how:

- **Replication** — rows in the hub's `sync_log` stamped with the VM's `origin_node`, and the VM's
  `sync_pull_cursor` / `messages` count (`sqlite3` on the hub; `better-sqlite3` from
  `/app/packages/server` on the VM, which ships no `sqlite3` binary).
- **Wake latency** — from a directed act's `created_at` on the hub to the actuator's spawn line in
  `/data/log/host.log`, against the laptop baseline (`residency.wake_leased` rows there).
- **Cost** — the Fly dashboard figure per day for `musterd-seat-delta` (shared-cpu-2x, 2 GB, 3 GB
  volume, never auto-stopped).
- **Friction** — every step that needed a human or a fix, with its disposition.

Append; never rewrite old entries.

## 2026-09-04 first boot (build d9622253 → stanley/cloud-seat-boot-fixes)

Machine `850e40a4499168` in `sjc`, tailnet `musterd-seat-delta` (100.99.57.57), direct path to
the laptop (no relay). Node id `01M1NB5B7JATF1G9P4HQ02CWB9`, enrolled at `http://100.100.246.14:4849`
at 04:34:50Z — 52 s after the image started, of which 26 s was the tailnet coming up.

| step                       | result                                                              |
| -------------------------- | ------------------------------------------------------------------- |
| image build (`fly deploy`) | ~3 min, 593 MB-class image (node 22 + pnpm deps + claude CLI)       |
| tailnet up                 | 26 s (kernel networking, as the broadcast image)                    |
| daemon up                  | 9 s after tailnet                                                   |
| team home clone + create   | 2 s (private repo `SandRiseStudio/musterd-revive`, 19 seat files)   |
| `node join`                | 1 s; `nodes/join` 200; `node.json` 0600                             |
| first push accepted        | **not until the hub ran `node trust`** (finding 1 below)            |
| first fold on the VM       | **not until the roster root was declared** (finding 4 below)        |
| residency on               | after findings 2–3; `delta → /data/musterd-delta`, host registry OK |
| actuator poll              | `no wakes due` — authenticates once the binding carries the VM key  |

ADR 376's landed-outcome check holds: the VM's `sync_log` is empty (a joiner stages nothing) and
the hub's grew by the VM's rows. Push batches from the VM: presence attached/detached, then ledger
rows — the first `residency.*` events ever folded from a second machine (ADR 365 half 1, witnessed).

### Friction list — dispositions

1. **Pushes refused `403 bound_elsewhere` until `node trust`.** `team create` on the joiner mints
   events as nick; nick is bound to the hub's node (ADR 360). Every push from the VM was refused
   and queued (`sync_push_refused_residence`, every tick) until nick ran `musterd node trust
   <node>` on the laptop. **Disposition:** a hub-side step in the runbook. Not a defect — it is the
   ADR 358 ceremony for a human present on two machines — but the entrypoint now says so in its
   log line, because a silent wedge after a green enrollment is the worst shape.
2. **The team agent key is daemon-private.** The design had the VM receive the hub's team agent
   key. The wake endpoints check the bearer against the *local* team row's hash
   (`transport/http.ts`, `getAgentKeyHash`), so delta's binding carrying the hub's key polled the
   VM's own daemon into `401` every 30 s. **Disposition:** fixed in the entrypoint — the joiner
   rotates its own key (`team agent-key --rotate --yes` on a fresh daemon holding no seats) and
   binds the seat with it. The `MUSTERD_AGENT_KEY` secret is gone from the runbook. Open
   question for the ADR: should the team key replicate (residence 2) or stay per-daemon by design?
   Per-daemon is defensible — a seat's credential is minted where it lives — and it is what the
   code does.
3. **`musterd agent --path` provisions a bare folder.** With `--path`, `provisionWorkspace` makes
   a plain directory (no checkout, no `package.json`); the worktree form only fires when run
   inside a checkout with no path flag, landing at `<checkout>-<seat>`. **Disposition:** fixed in
   the entrypoint (repo cloned once at `/data/musterd`, worktree at `/data/musterd-<seat>` on
   `agent/<seat>`). The `--path` behaviour is documented in the command's own comment; no fix.
4. **A cloned team home is not a roster root.** `config.rosterHome` is what makes a daemon
   reconcile `.musterd/` files, and only `team export` records it — which refuses a folder that
   already holds `team.toml`, i.e. every clone. The VM's roster was two members (nick, delta), and
   the fold blocked at hub_seq 1 (`sync_fold_blocked … seat miley`) — block-don't-skip working as
   designed, on a roster that was never going to grow. **Disposition:** fixed in the entrypoint
   (declare the root in config, SIGHUP the daemon). Candidate product fix: `musterd team adopt
   <dir>` or `team export --adopt` for a home that already exists — the second machine of every
   file-backed team hits this.
5. **`musterd reload` is macOS-only** (drives launchd); a foreground `serve` takes SIGHUP.
   **Disposition:** friction line; the entrypoint uses the signal.
6. ~~**Residency enrollment does not replicate.**~~ **FIXED 2026-09-14 by [ADR 393](../decisions/393-residency-enrollment-projects.md)** (`sync/ledger.test.ts` case 5). The hub's `residency status` listed the laptop's
   five seats, not delta; the hub roster showed delta plain `offline` while the VM showed `offline ·
   wakeable`. The wake decision was the joiner's (its daemon derives due acts from folded messages),
   so wakes were unaffected. **Disposition:** closed; the fold now projects `residency.enrolled` /
   `residency.revoked` into the `residency` table. The grant and the actuator stay local.
7. **Pull timeouts during the first twenty minutes** (`sync_pull_failed … TimeoutError`, 10 s
   budget, five in a row) while the hub answered `GET /sync/pull` in 41–149 ms. Not reproduced
   after the roster reconcile; cause unmeasured (laptop busy? DERP fallback before the direct path
   settled?). **Disposition:** watch; if it recurs, instrument the client side of the pull.

8. **The first wake failed on a first-run consent gate, not on anything about waking.** The
   actuator did everything right — folded the handoff, leased it, spawned `claude -p` in the
   worktree — and then reported `no roster occupancy within the verify window`, killing the child
   at 91 s (the window is 90 s). Two independent causes, both first-run-on-a-new-machine:
   - **No Claude project trust.** `~/.claude.json` records `hasTrustDialogAccepted` per project
     path, written when a human first opens the folder. A machine that has never had an
     interactive session refuses the project's MCP servers, and a headless run cannot answer the
     prompt. **Disposition:** the entrypoint pre-accepts trust for the seat's workspace.
   - **The MCP registration had no launch-surface marker.** `musterd agent --harness claude-code`
     wrote a `musterd` server with an empty environment; the adapter refuses Presence attachment
     without `MUSTERD_LAUNCH_SURFACE` (ADR 286) and exits, which Claude reports as
     `CONNECTION_CLOSED`. No tools, so no occupancy, so a wake that cannot pass verification.
     `musterd wire` does not fix it (`no harness selection here`); `musterd harness configure
     --select claude-code --yes` does, and the server then connects. **Disposition:** the
     entrypoint runs the headless converter. **Candidate product fix:** `musterd agent --harness`
     should write what `harness configure` writes — one of them produces a registration the
     adapter refuses, and the failure surfaces three layers away as a wake that will not verify.

   Worth stating plainly: none of this is visible from the hub. The lane looked handed off, the
   seat looked enrolled, and the wake looked attempted. The evidence that named the cause was
   `claude mcp get musterd` **run from inside the workspace** — from any other directory it
   reports no such server, because the registration is local scope, keyed by cwd.

**Fix confirmed.** After the converter, `claude mcp get musterd` reads `✔ Connected` with
`MUSTERD_LAUNCH_SURFACE=claude-code`, and a headless run in the worktree called `team_inbox_check`
and answered `OK` (3 turns, $0.085). The seat's `presence.attached` / `presence.detached` rows for
that run reached the **hub** — occupancy from the second machine, replicated. The hub's `sync_log`
holds 52 rows stamped with the VM's origin, up from 2 before the roster reconcile.

9. **A fresh joiner folds the whole team history before it can see a new act.** Enrollment admits
   a machine; it does not draw a line under the log (node-enrollment.md says so for push, and pull
   starts at cursor 0 for the same reason). So delta's first wake could not fire on a message sent
   minutes earlier: the daemon was still pulling forward through ~22,500 hub events, and a wake is
   derived from *folded* messages. **Disposition:** expected, worth stating — the first wake on a
   new machine waits on the backlog, and on a team with history that is minutes, not seconds. If it
   ever becomes hours, the lever is a pull that starts near the head and backfills behind, which is
   a real design change and not something to reach for yet.

## 2026-09-04 the drain — three permanent wedges, in one replay of one team's history

Finding 9 said a fresh joiner replays the whole log before it can see a new act, and put the cost
at "minutes, not seconds". That was wrong in a way worth recording: it was not slow, it was
**stopped**, three separate times, and each stop was permanent rather than slow. Every one was a
`retrying each tick` line that would have retried until the machine was destroyed.

| # | stopped at | on | why it could never clear | fixed by |
| - | ---------- | -- | ------------------------ | -------- |
| 10 | `hub_seq 9394` | `lane.updated` for a lane born 2026-09-02 17:31 | its `lane.opened` predates lane replication and is in no log | ADR 381, the genesis watermark |
| 11 | `hub_seq 9657` | `presence.attached` for `web-u6mvaj` | a web sign-in seat, minted db-only, that git never carries | ADR 382 |
| 12 | `hub_seq 9659` | `presence.reattested` for `ryder` | the attach WAS applied (9652); this daemon's own reaper then swept the row | ADR 384 |

Finding 12 is the one that changes how to think about the other two. The seat was held, the attach
was in the log, and the joiner had applied it seven events earlier — then reaped the row, as it is
supposed to, and blocked forever waiting for it. A daemon replaying a backlog manufactures that
condition once per session, and there were hundreds of sessions left. It also means ADR 382, which
this seat wrote ninety minutes before, was right and too narrow: it unblocked one unprojectable
presence shape and left the other.

**The shape they share.** Block-don't-skip is the fold's best property and every one of these was
it, working exactly as designed, on a fact that could never arrive. The discriminator that resolves
all three is the same question asked three ways: *can this ever be satisfied?* A lane older than
the log's first birth cannot. A seat git will never carry cannot. A row this daemon deleted itself
cannot. Nothing else about the stops changed — a message from an unresolved seat still blocks, and
so does an event a newer build wrote, because an upgrade clears that one.

**Why a dogfood found them and 1,500 tests did not.** Each needs a daemon with *history* — a team
whose lanes predate a schema change, whose web sign-ins have come and gone, whose sessions attached
hours before they were replayed. Two daemons built fresh in one test process have no past. The
first real second machine had 22,496 events of it.

**The drain, measured.** After the three fixes the joiner moved at a full batch (500 events) per
60 s tick — 9,658 → 14,658 in ten minutes — against 22,496 at the head.

## 2026-09-04 19:41 UTC — the exit criterion: a seat woken on the second machine

`nick` sent a `steer` from the laptop. It replicated over the tailnet; the **Fly machine's own
daemon** derived the wake, leased it, and spawned the harness in delta's worktree; the seat occupied
the roster and answered as itself.

| measure | value |
| ------- | ----- |
| spawn → roster occupancy | **23.6 s** |
| run wall time | 55.1 s, `exit=0` |
| cost | **$0.2156**, recorded to the ledger against lease `01M1PZ2Y01` |
| session | `resumed` (the seat continued its own transcript), provenance `wake` |
| the seat's answer | `status_update`: "Woke on the Fly cloud seat (lane 01KZAAS15M); host 850e40a4499168." |

**The wake economy replicated.** On the hub, stamped with the VM's `origin_node`:
`residency.wake_leased` ×2, `residency.woke` ×1, `residency.session_captured` ×3,
`residency.enrolled` ×5, `mcp.surface_rendered` ×2. This is ADR 365 half 1 — "the economy is whole"
— witnessed between two machines for the first time. Until now it was proven only between two
daemons in one test process, the limit ryder named when accepting ADR 371.

### 13. A plain `message` never wakes a seat, and the runbook said "send it an act"

Three wake attempts produced nothing before this one, and the cause was the test, not the system.
`listInterruptCandidates` admits `steer`, `resolve`, `accept`, `decline`, or an act carrying
`meta.urgent` / `lane_review` / `eligible` — a bare `message` is deliberately not a doorbell, which
is right: an inbox that wakes a machine for every remark is an inbox nobody can use. The runbook's
Verify step said "send it an act", which is exactly the imprecision that cost the time.
**Disposition:** the runbook now names a `steer`, and this line stands as the reason.

Worth keeping beside it: the first wake attempt of the day *did* fire, on a `handoff`. Both are in
the admitted set; a message never was.

### What is still open

- **The three ADR 365/366/371 two-machine experiments** as written: the wake economy is now
  witnessed (365 §1), but 366's cursor experiment and 371's tool-call/seed/incident counts are not
  yet run as their own falsifiers.
- **A lane end to end from the VM** — claimed, worked, submitted, accepted. The wake proves the
  seat can be reached; it has not yet done work.
- **Cost per day.** One wake cost $0.2156. The machine itself is shared-cpu-2x/2 GB with a 3 GB
  volume, never auto-stopped — the Fly dashboard figure goes here after a full day.
- **Residency enrollment still does not replicate** (finding 6): the hub shows delta plain
  `offline` while the VM shows `offline · wakeable`. Wakes are unaffected — the decision is the
  joiner's — but the hub's roster is not telling the truth about which seats are reachable.

## 2026-09-06 01:26 UTC — the seat could be woken exactly once, and nothing said so for 51 hours

Exit criterion 3 (a lane end to end from the VM, lane `01M1T3GMDD`) opened with a handoff to delta
at 01:05:28Z. No wake came. The cause was not the handoff and not the ADR 390 image: **delta had
been unwakeable since its own first wake, and the roster showed it `offline · wakeable` throughout.**

### 14. The woken session disarms the actuator that spawned it

Every `POST /teams/revive/residency/wake-leases` from the VM's actuator returned **401** from
2026-09-04T22:36:32Z to the repair below — 50 h 50 m, across a reboot, roughly 6,100 polls. The
last success was 22:36:02Z, thirty seconds earlier, and the minute in between is the minute delta's
first (and only) wake ran: `⚡ woke delta: spawn→roster 17.4s`, `exit=0 cost=$0.2476`.

Measured on the VM, 2026-09-06:

| question | answer |
| -------- | ------ |
| `teams.agent_key_hash` for `revive` | non-null; `bootstrap_cutover_at` null |
| `key.rotate` rows in the VM's audit | **exactly one**, 2026-09-04T04:59:25Z (first boot) |
| `sha256(binding.agent_key) === teams.agent_key_hash` | **false** |
| `sha256(binding.seat_credential) === teams.agent_key_hash` | false |
| `sha256(config.agentKeys.revive) === teams.agent_key_hash` | **true** |

The server side never moved: one rotation ever, and the hash it wrote is still the one in the team
row — the machine's own `config.agentKeys` still matches it. What moved is the **workspace
binding**, and the binding is the only thing the actuator reads: `defaultReadAgentKey` is
`findBinding(workspace, {})?.agent_key` (`packages/cli/src/host/loop.ts:72`), handed straight to
`HttpClient({ key })` for every lease poll. On the server, `/residency/wake-leases` accepts exactly
two bearers (`packages/server/src/transport/http.ts` ~1330-1340): a bootstrap credential whose
`use_kind` is **`host`** and whose `target` equals the host label, or a token hashing to the team
agent key. Anything else is 401, and the message names the team key — which is why the log line
reads as a configuration mistake rather than a credential that was swapped underneath it.

**The contract mismatch.** `musterd agent` — the command that provisions a seat workspace —
deliberately writes a **`claim_seat`**-scoped credential into that same `binding.agent_key` field
(`packages/cli/src/commands/agent.ts:133-139`, ADR 344), with the comment "Never fall back to the
ambient legacy Team-wide key: that would silently preserve its blast radius." That is the right call
for ADR 344 and it is invisible to ADR 131: the field one ADR narrowed is the field the other
authenticates wakes with, and no third thing reconciles them. A `claim_seat` credential is neither
of the two bearers the endpoint takes.

**Why it fires on the first wake specifically** (2026-09-06; falsify: wake a repaired seat and read
`sha256(binding.agent_key)` before and after — if it still matches the team row, the claim path is
innocent and the writer is elsewhere): the binding's current field set
(`agent_key, claim, grant, model, model_observed, seat_credential, server, session, session_lease,
team, version`) is the shape written by the claim/occupy path at
`packages/cli/src/commands/claim.ts:264`, which preserves siblings rather than the flat five-field
shape at `:435`. A woken session claims its own seat as its first act, so the wake rewrites the
credential the next wake depends on.

**Why nothing said so.** The 401 is a warn line in the VM's own `daemon.log` and a `!` line in
`host.log`; neither reached the hub, and residency enrollment did not then replicate (finding 6, closed 2026-09-14), so the
hub's roster kept rendering `offline · wakeable` — a claim about reachability that had been false
for two days. The seat looked healthy from every surface a human uses.

### The repair — a rebind, not a rotation

The correct key was still on the machine (`config.agentKeys.revive`, matching), so nothing had to be
rotated and no credential was invalidated. `musterd wire` resolves `agent_key` in exactly that
precedence — `--key` → `MUSTERD_AGENT_KEY` → `config.agentKeys[team]`
(`packages/cli/src/commands/wire.ts:146`) — so the boot log's own claim, "worktree configured —
`musterd wire` repairs it any time", turned out to be literally true of this failure.

Run as the seat user with the daemon's `HOME` (the account's passwd home is `/home/seat`; the
daemon's state is `/data/home`, exported by the entrypoint — `su seat -c` without it reads the wrong
config and would write a **keyless** binding, which is worse than the break):

```sh
su seat -c 'export HOME=/data/home; cd /data/musterd-delta && musterd wire'
su seat -c 'export HOME=/data/home; cd /data/musterd-delta && musterd residency on \
  --seat delta --harness claude-code --as nick'
```

`wire` writes the spec's fields and the resolved key; it does **not** carry `grant`, `session_lease`
or `model_observed` across, so `residency on` follows to re-land the standing grant and the host
registry entry — the same two steps, in the same order, that `seat.sh` runs at boot. `residency on`
reported "delta has a live session — it occupies via the grant this enroll just rotated", which is
the expected note for a seat whose stale presence is still on the roster.

| moment | time (UTC) | note |
| ------ | ---------- | ---- |
| `musterd wire` | 01:24 | `agent_key` match flips false → **true** |
| `musterd residency on` | 01:27:26 | `residency.enrolled delta` |
| `residency.wake_leased` | 01:26:52 | **the first poll after the rebind** |
| `residency.session_captured` | 01:26:55 | |
| `residency.woke` | 01:26:59 | `spawn→roster 7.3s, session=fresh, provenance=wake` |
| `residency.context_read` | 01:27:13 | lane `01M1T3YXVD`, read by delta itself |

Spawn to roster occupancy was **7.3 s**, against 17.4 s on 2026-09-04; the actuator chose "portable
delivery for delta: fresh spawn (resume bypassed)" rather than resuming the stale transcript. The
wake fired on the poll immediately following the key repair, which is the falsifier for the whole
diagnosis: had the binding not been the broken side, the rebind would have changed nothing.

**ADR 390 falsifier 5, partially closed.** The boot log carries
`wake actuator starting for seat delta (uid 1001, not root)` on both boots of the new image. The
remaining half — `id -u` from inside the *woken* session — is delta's own to report.

**Candidate product fixes**, in the order they would have helped:

1. **The actuator's credential should be minted for the actuator.** `musterd residency on` knows the
   host label; it could mint the `host`-scoped bootstrap credential the endpoint already accepts and
   store it under a field no claim path touches, instead of sharing `binding.agent_key` with
   `musterd agent` and every claim.
   **Done 2026-09-14, ADR 395:** `binding.host_key`, minted at `residency on`, merge-guarded on
   save, preferred by the actuator. Candidates 2 and 3 are not this change.
2. **A 401 on the wake lease should reach the hub.** The one surface that showed the truth was on the
   machine nobody was looking at. A seat whose actuator cannot authenticate is not `wakeable`, and
   the roster is where that belongs — this is finding 6 with teeth.
3. **`musterd agent` and the wake endpoint should not disagree in silence.** Either the endpoint
   accepts a `claim_seat` credential for the seat it targets, or provisioning refuses to write a
   credential the wake path cannot use.

### 15. A lane handoff wakes a manual-flow seat under the *reply* budget, and the work dies at 5 minutes

With the credential repaired, the wake fired and delta did the right things: read the work order
(01:27:13Z), checked its inbox, ran `team_next`, moved lane `01M1T3YXVD` to active (01:28:13Z), and
created branch `delta/cloud-seat-from-inside`. Then it was killed.

```
run for delta (fresh) settled: exit=143 (watchdog) wall=302.1s
wake cost recorded for delta: $— (lease 01M1T56M9313EZMYPVSNCXPFGK)
```

**Nothing survived.** The VM's worktree was on the new branch with a clean tree and no page — the
run died before the first write. The cost is `$—` because a SIGTERM'd harness never emits its
summary line, so the most expensive shape a wake can take is also the one that records no spend.

**The bound was 5 minutes, and the policy grants 30.** `revive`'s residency policy reads
`timeout 5m · work-timeout 30m`. A work order uses `work_timeout_ms` un-clamped
(`packages/cli/src/host/loop.ts:353`, `packages/server/src/store/residency.ts:1411`) precisely so
that, in the loop's own words, "a coding session under a 5m host flag must not silently die at 5m".
Delta's run died at 5m anyway, because **it was never a work order**.

A lane handoff becomes a `work_order` only through `dueDispatchHandoffWorkOrders`
(`packages/server/src/store/residency.ts:913`, ADR 199's dispatch handoff edge), and that edge is
gated on the seat's `flow` — `manual` by default, and the protocol's own comment says `flow` is what
"gate[s] board-triggered WORK-ORDER wakes" (`packages/protocol/src/residency.ts:72-79`). Delta was
`flow: manual`. So the handoff derived as `batched` and took `policy.timeout_ms`, the **reply**
budget. The host log says so plainly, and this line is the whole finding:

```
wake due: delta [batched] — handoff from stanley (lease 01M1T56M9313EZMYPVSNCXPFGK)
```

**The shape.** A handoff is the act that says *do this lane's work*. On a manual-flow seat it still
wakes the seat — as a reply doorbell — and the session it starts is handed a lane, a branch, and an
acceptance contract it cannot possibly discharge in five minutes. The two halves disagree about what
the wake is for, and the seat pays for the disagreement by being killed mid-write. Nothing in the
handoff path warns the sender: `lane_handoff` reported "wake-eligible" and it was, under the wrong
budget.

**The banner is not the bound either.** `host.log`'s standing line reads
`1 seat(s) registered · every 30s · watchdog 600s` — that is the operator's `--timeout` ceiling
(`deps.bounds.timeout_ms`), not the effective per-run timeout, which comes from policy. An operator
reading the actuator's own banner would predict 600 s and observe 302 s.

**Disposition (2026-09-06):** delta set to `flow: auto`
(`musterd residency on --seat delta --harness claude-code --as nick --flow auto`), which is the
designed path — ADR 199's dispatch edge exists for exactly "a seat that does lane work". The
handoff still qualifies (unanswered, lane owned by delta, state `active`), so the next poll after
the 30 m cooldown derives it as a `work_order` with the 30 m budget and seat-policy tool access.
Falsify the diagnosis: if the next wake's host line reads `[work_order]` rather than `[batched]` and
the run outlives 302 s, `flow` was the gate; if it still reads `[batched]`, it was not.

**Candidate product fixes:**

1. **A handoff that cannot be worked in the budget should not be delivered as a reply.** Either the
   dispatch edge ignores `flow` for an explicit, directed `lane_handoff` (a human or a seat named
   this seat and this lane — that is not "board-triggered" in the sense `flow` exists to gate), or
   the handoff is refused/deferred with a reason the sender can read.
2. **`lane_handoff` should tell the sender which budget the recipient will get.** It already knows
   the seat is wake-eligible; the derivation and the timeout are knowable at send time.
3. **A watchdog kill should record its spend.** `$—` on the most expensive outcome makes the cost
   ledger silently under-count exactly the runs worth counting.
4. **The actuator banner should print the effective bound**, or say that policy overrides it.

### 15a. Correction (2026-09-06 02:00Z) — finding 15's gate was wrong, and its falsifier could not have failed

Two errors in finding 15, kept visible rather than overwritten (rule 4 of `docs/wiki/README.md`).

**The falsifier was a ritual.** It said: "if the next wake's host line reads `[work_order]` rather
than `[batched]`, `flow` was the gate." That line can never read `[work_order]`. `host.log` prints
`order.lane` — the *delivery* lane, interrupt vs batched (`packages/cli/src/host/loop.ts:253`) — and
`dueDispatchHandoffWorkOrders` itself sets `lane: 'batched'` alongside `derivation: 'work_order'`
(`packages/server/src/store/residency.ts:958-960`). A work order and a reply doorbell print the same
word. The check would have "confirmed" the diagnosis whichever way the truth fell, which is exactly
what rule 3 forbids. **The observable that does discriminate** is the ledger:
`residency.wake_leased`'s detail carries `derivation` outright.

**~~`flow` was the gate~~ (2026-09-06 01:46Z) — INCOMPLETE.** The gate is a conjunction:

```ts
if (dispatchLoopOn && policy.flow === 'auto' && cooled) {   // residency.ts:1249
const dispatchLoopOn = teamPolicy.loops?.dispatch === true; //           :1221
```

`flow` is a *seat* override; `loops.dispatch` is a **team** switch, dark until an admin arms it
(ADR 191/199). Setting delta to `flow: auto` was therefore inert, and the re-run proved it: the
second wake leased at 01:57:03Z recorded `"derivation":"batched"` with flow already auto.

### 16. Team policy does not replicate to a joiner, so a cloud seat can never receive a work order

The measurement that corrects 15 is the real finding, and it is finding 6's family:

| daemon | `teams.policy.loops` |
| ------ | -------------------- |
| hub (laptop) | `{"review":true,"dispatch":true,"sweep":true}` |
| joiner (delta's VM) | **`null`** |

The hub has armed the dispatch loop team-wide. The joiner has no `loops` at all — and **the joiner is
the daemon that derives the wake** (finding 6: the wake decision is the joiner's). So
`dispatchLoopOn` is false on the only machine whose opinion counts, `dueDispatchHandoffWorkOrders`
and `dueDispatchContinuationWorkOrders` never run there, and **every wake a cloud seat can ever
receive is a reply doorbell under the 5-minute reply timeout.** No seat override can lift it; the
seat is structurally incapable of being handed lane work.

That is why exit criterion 3 has never been met, and it is not a property of this lane's handoff:
any handoff, from any seat, to any seat living on a joiner, lands the same way.

Worth noting against fold: `fold.ts:252` does `UPDATE teams SET policy = ?`, so team policy *is* a
projected shape — the joiner's is null anyway (2026-09-06; falsify: read
`json_extract(policy,'$.loops')` on both daemons — hub non-null, joiner null, as tabulated above).
Whether the hub never emitted the policy event, or the joiner folded it before the loops were armed
and nothing re-emits, is the first question for the lane.

**Disposition (2026-09-06 02:00Z):** armed the joiner's own team policy to agree with the hub —
`musterd team policy --dispatch-loop on --as nick`, run on the VM. Blast radius is delta alone: that
daemon has exactly one enrolled seat. With `loops.dispatch` on *and* `flow: auto` *and* the 30 m
cooldown elapsed, the next poll should lease the handoff with `derivation: work_order` and the 30 m
`work_timeout_ms`.

**Falsifier, restated so it can fail:** read `detail.derivation` on the next `residency.wake_leased`
row in the VM's audit. `work_order` and a run outliving 302 s means the conjunction was the whole
gate. `batched` again means something else still refuses, and the two knobs were not it.

### 16a. Confirmed (2026-09-06 02:27Z) — the conjunction was the gate, and the actuator says so

With the joiner's `loops.dispatch` armed and delta on `flow: auto`, the third wake leased at
02:27:23Z recorded `"derivation":"work_order"`, and the actuator printed the bound it took:

```
wake bounds: delta work_order using policy timeout 1800000ms
             (host --timeout 600000ms is not a ceiling for work_orders)
```

Finding 16 stands as diagnosed. Note the same log line still says `wake due: delta [batched]` for
this run — the delivery lane, not the derivation, exactly as 15a describes. **An operator watching
`host.log` cannot tell a 30-minute work order from a 5-minute doorbell**, which is worth fixing on
its own.

| wake | leased | derivation | budget | outcome |
| ---- | ------ | ---------- | ------ | ------- |
| 1 | 01:26:52Z | batched | 5 m | killed 302.1 s, nothing written |
| 2 | 01:57:03Z | batched (flow already auto) | 5 m | killed 301.4 s, **page written**, uncommitted |
| 3 | 02:27:23Z | **work_order** | 30 m | killed **91.4 s** on verify, **page committed** `ca079afe` |

### 17. The 90-second roster-verify window kills a work order for doing the work

The third wake had thirty minutes and used ninety-one seconds of it:

```
! wake FAILED for delta (batched): no roster occupancy within the verify window
run for delta (fresh) settled: exit=143 wall=91.4s
```

`VERIFY_WINDOW_MS = 90_000` is a **hard-coded constant** (`packages/cli/src/host/loop.ts:35`) with
no CLI flag — `musterd host` exposes only `--once` and `--host`; `verifyWindowMs` is a test
injectable. It does not scale with the wake's budget, so a run granted 1,800,000 ms is verified
against 90,000 ms regardless.

**The shape.** Verification asks "did the seat occupy the roster?", which a session answers by
calling any `team_*` tool. The first two runs answered it in 7.3 s and 17.5 s because a doorbell
wake's natural first move is to read the inbox. A *work order* hands the session a lane and a
branch, and its natural first move is to open the files. Delta did exactly that — it finished the
page and committed `ca079afe` — and was killed at 91.4 s for not having said hello. **The
verification is anti-correlated with the behaviour the work order asks for**, and the better the
seat is at getting to work, the more reliably it dies.

Two second-order costs, both already visible: the lease records failure for a run that *succeeded*
at its actual task (the commit is on the branch), and the spend is `$—` again, so the ledger
under-counts the run for the third time today.

**Disposition (2026-09-06 02:47Z):** the lane's own brief now carries the workaround — "FIRST
ACTION, before any git or file work: call `team_inbox_check`" — so the instruction travels inside
the work order the seat fetches. That is a patch on the symptom and is recorded as such.

**Candidate product fixes:**

1. **Scale the verify window with the bound**, or verify a work order differently — a run that is
   still alive and has produced a commit is not a failed wake. `min(bounds.timeout_ms, …)` with a
   work-order floor would do; so would treating any harness output as liveness.
2. **Verification should not require an MCP round-trip the task does not need.** Occupancy is a
   proxy for "the session started"; the process being alive and writing is a better one.
3. **`host.log` should print the derivation**, not only the delivery lane (see 16a) — three runs
   today logged `[batched]` and one of them was a work order.

### 18. A work order is not given the musterd tools, so it can never occupy the roster — and this is finding 17's cause

Wake 4 (02:58Z, `work_order`, 30 m budget) exited **cleanly** — `exit=0 cost=$0.1073 wall=23.8s` —
and the actuator reported `run exited (code 0) without occupying the seat`. The session's own
transcript on the VM says why, and it is not ambiguous: it called
`mcp__musterd__team_wake_context` and `mcp__musterd__team_inbox_check`, **both were refused
("permission not granted")**, and it then deliberately declined to fall back to the `musterd` CLI —
correctly, because the seat guidance says a session holding the `team_*` tools must not also drive
the CLI (it resolves to a different identity and its sends fail). The seat was caught between two
correct rules with no third option, and stopped.

**The cause is one line** (`packages/cli/src/host/backends/claudeCode.ts:101`):

```ts
...(opts.toolPolicy === 'seat-policy' ? [] : ['--allowedTools', 'mcp__musterd']),
```

A `reply-only` doorbell is **handed** the musterd tools explicitly. A `work_order` runs under
`tool_policy: 'seat-policy'` (`packages/server/src/store/residency.ts:1408`) and is handed nothing,
falling back to the workspace's own permissions. Delta's `.claude/settings.local.json` allowed
`Bash(musterd *)` — the CLI — and **no `mcp__musterd` entry at all**.

So `seat-policy`, whose whole purpose is to be *broader* than reply-only, is **strictly narrower for
the one MCP server every wake requires**. A work order cannot occupy the roster, cannot
`lane_submit`, and cannot report; the more authority the wake grants, the less it can do.

**This supersedes finding 17's causal claim** (~~"the session's natural first move is to open the
files, so it never says hello"~~ — 2026-09-06 02:47Z). Wake 3 was not busy-and-late; it was
**unable** to occupy for this same reason, and the 90-second window merely decided how it died. The
window's own defect stands as written (a hard-coded 90 s that does not scale with a 30 m bound, and
a run that produced a commit is not a failed wake) — but it is the symptom, and finding 18 is the
cause. That the two failure modes look different in `host.log` (killed at 91.4 s vs exited at 23.8 s)
while sharing one cause is the reason to read the transcript rather than the log.

**Disposition (2026-09-06 03:10Z):** added `mcp__musterd` to delta's workspace allow list — exactly
what the reply-only path already grants, so this widens nothing the doorbell wakes did not already
have. **Fixed at the source 2026-09-06 (lane `01M1VDY8PY`):** the wake path hands
`--allowedTools mcp__musterd` under both policies (ADR 131 §6 amendment), the ADR 261 floor carries
`mcp__musterd`, a run that exits without occupying appends the harness's own error text to its
reason (`… — harness: Credit balance is too low`), and the `seat.sh` allow-list merge from #1357 is
removed. ~~Unmeasured on the VM until the image is rebuilt from that commit~~ — **measured 2026-09-14 on
the redeploy, see 18a below: fixes 1 and 2 confirmed from inside the woken session, fix 3 confirmed
from the laptop's `host.log`.**

**Candidate product fixes:**

1. **`seat-policy` must be a superset of `reply-only`.** The musterd tools are the wake's own
   control plane, not part of the task's permissions — pass `--allowedTools mcp__musterd` on *both*
   paths and let the seat's settings add to it.
2. **`musterd agent`'s permissions floor (ADR 261) should include `mcp__musterd`.** It writes
   `Bash(musterd *)` today, which is the surface the seat is told not to use when it has tools.
3. **A wake that cannot call the wake's own tools should fail loudly, not quietly.** "exited without
   occupying" and "no roster occupancy within the verify window" are the same defect wearing two
   costumes; neither names the permission refusal that a transcript shows in one line.

### 18a. Confirmed on the VM (2026-09-14 16:35Z) — the fix holds, and the retry cost more than the fix

Finding 18's repair landed as `c8e89dd8` (#1371) on 2026-09-06 at 14:33Z. **The image the VM was
running had been deployed at 13:23Z — an hour earlier — so for eight days the fix existed only on
the laptop.** Dolly's acceptance said so explicitly and accepted on the argv contract rather than on
a cloud-seat run. Redeployed 2026-09-14 16:17Z (`fly` v11 → v12, image
`deployment-01M2GB6HWK`), built from `c8e89dd8`: the first image that has ever carried this fix.

Verified on the host before waking anything: `/usr/local/bin/musterd` resolves to
`/app/packages/cli/dist/bin.js`, and `dist/host/backends/claudeCode.js` contains both `allowedTools`
and `mcp__musterd` (2026-09-14 16:20Z; falsify: `grep -o allowedTools` that file on the machine —
absent means the image predates #1371).

**Fixes 1 and 2 — confirmed from inside.** delta, woken on v12, called `team_join`,
`team_wake_context`, `team_inbox_check`, `lane_board`, `team_memory_read` and `lane_update`, all of
which returned, **with no permission prompt on any of them** — and the same session simultaneously
held the workspace toolset (`Bash`, `Edit`, `Write`, `Agent`, `Skill`), which a `reply-only` grant
would not include. Both at once is precisely fix 1: `argTail` passes `--allowedTools mcp__musterd`
under *both* policies, and the workspace list adds to it rather than replacing it. Pre-#1371 this
run is finding 18's exact death (2026-09-14 16:35Z; falsify: a work-order wake on v12 whose
`mcp__musterd__*` call is refused).

**Fix 3 — confirmed, but only from outside.** The failed-wake line now carries the harness's own
words. Read from `host.log` on the machine:

    ! wake FAILED for delta (batched): run exited (code 1) without occupying the seat — harness: Credit balance is too low

That is the same `$0.0000 / ~10 s` failure the 09-06 entry above could describe only as "the reason
is visible nowhere but the transcript". It is now in the log. The seat still cannot read that line
itself — `tail` on `~/.musterd/host.log` is refused by the working-directory scope, re-verified
unchanged on v12 — so fix 3 is attested from the laptop, and the seat remains the *subject* of a
wake diagnosis rather than its instrument.

**Two things this run measured that were not the point, and are worth more than the confirmation.**

1. **A granted tool is not yet a callable tool.** The musterd tools arrive *deferred*: only their
   names are in the woken session's prompt, and schemas must be fetched with `ToolSearch` before any
   call succeeds. A wake brief that says "orient via `team_wake_context`" is one `ToolSearch` away
   from working, and a session that does not know that reads its own prompt as evidence the tools
   are missing. The allow list is necessary and is **not** sufficient (2026-09-14 16:35Z; falsify: a
   woken session whose first `mcp__musterd__*` call succeeds with no preceding `ToolSearch`).

   **This is not a cloud-seat property, and the first version of this entry said it was.** ryder
   reproduced it in an ordinary Claude Code session on the laptop while accepting this lane —
   deferred at session start, and **every schema had to be re-fetched after an MCP server dropped
   and reconnected mid-session** (2026-09-14 18:43Z, ryder; falsify: a laptop session whose first
   `mcp__musterd__*` call succeeds with no preceding `ToolSearch`). So the claim's real scope is
   *any harness with a tool-deferral path*, woken or interactive, and the reconnect case is the
   worse half: a session that was already calling these tools can silently lose the ability to,
   with no permission change and nothing in the roster to show for it. The doorbell contract
   anchored the same day has a clause about a probe reaching the model; this is its unwritten
   sibling — **granting a tool and making it callable are two different things, and only the first
   one is visible to musterd.**
2. **A seat can name the *kind* of its doorbell and not its *budget*.** `team_wake_context` returned
   `wake.kind: "work_order"` and carries no bounds, timeout or deadline field; `wakeContext.ts` on
   `origin/main` emits none, and the bound lives daemon-side in `spec.bounds.timeout_ms`
   (`claudeCode.ts:607,700`). **Finding 15 was a work order dying at the reply budget — and a seat
   cannot detect that condition about itself** (2026-09-14 16:35Z; falsify: a `wake.kind` packet
   carrying a timeout field).

**The retry arc, because the costs are the finding.** Four wakes were needed to get one report:

| wake | act | derivation | outcome |
|---|---|---|---|
| 16:18Z | handoff | `work_order`, bounds `1800000ms` | `exit=1` at 10.0 s, `$0.0000` — credit exhausted |
| 16:26Z | steer | *no bounds line*, killed at 301.7 s | occupied (`spawn→roster 29.8s`), watchdog-killed mid-report |
| 16:3xZ | handoff | `work_order` | `exit=0`, `$3.0403` — the report above, written into the lane |
| 16:4xZ | — | `work_order` | `exit=0`, `$0.7519 / 175.1s`, **fresh spawn**: `resume skipped — newest transcript is 1.1 MiB (hygiene bound 256 KiB)` |

Three separate lessons sit in that table. **A `steer` to a seat on a joiner is a reply doorbell**:
no `wake bounds` line is printed and the run dies at 301.7 s, which is finding 16's conjunction
holding for `steer` exactly as it holds for `handoff` — so the act you choose to nudge a cloud seat
decides whether it gets 5 minutes or 30. **A wake that fails for an environmental reason does not
retry**: the 16:18Z credit failure consumed its lease and the act was not re-leased, so topping up
the credit did nothing until a human sent a fresh act. And **the transcript-hygiene bound turns a
multi-wake lane into repeated cold starts**: once past 256 KiB every subsequent wake spawns fresh,
re-reads the lane, and spends its budget re-orienting — ~$3.80 across four wakes for one docs commit
that was never made from the VM.

### 18b. `team_join` alone is sufficient when the join is not a no-op (2026-09-14 19:24Z) — an open falsifier, run

**The deaf-on-arrival state itself is not new.** [The cloud seat from inside](../wiki/cloud-seat-from-inside.md)
recorded on 2026-09-06 that a woken cloud seat begins with a dead session lease and its opening
probes are 401s. What that page could not settle was **the repair**, and it left a falsifier open:
"from a deaf seat call `team_join` *alone* and re-run the probe — silence means join is sufficient
and this paragraph is wrong." This wake ran that experiment, unintentionally and cleanly.

Session `c9f545d5`, started 19:24:36Z (`binding.json:started_at` 1789413876962), uid `1001`, work
order on this lane. The `SessionStart` hook attached the deaf line to each of the first two tool
results (a `ToolSearch` and a `Skill`, neither a musterd call). The third call was `team_join`
**on its own, in its own turn** — not batched with `team_inbox_check` or `team_next`, which is
exactly what made the 09-06 reading unattributable. The line has not fired on any tool call since,
across the whole session (2026-09-14 19:26Z onward; falsify: a deaf seat whose solo `team_join`
leaves the next probe still ringing).

**So join alone is sufficient — and the discriminator is whether the join actually does anything.**
ryder's counter-case on 09-06 was `team_join` returning "Already joined" as a **no-op** with the
probe still deaf. This seat's join was not a no-op; it returned "Joined revive as delta
(claude-code). You are now the live occupant of this seat… The server authenticated this occupancy."
That reconciles the two results without either being wrong: **a join that mints a fresh Presence
clears the deafness; a join that finds one already recorded returns early and repairs nothing.**
The prescription in the hook line is correct but underspecified — it should say what to do when the
join no-ops, which is the case the page's other counter-example (dolly's, cleared only by an
`/mcp reload`) sits in.

**Replicated on a second wake 31 minutes later (2026-09-14 19:55Z).** Trial 2, same machine, same
lane: session `0131bef2`, `binding.json:started_at` 1789415705070 (19:55:05Z), work order. Same
course as trial 1 — the deaf line rode the first three tool results (two `ToolSearch` calls and a
`Read`, none of them a musterd call), the fourth call was `team_join` **alone in its own turn**, it
answered "You are now the live occupant of this seat" rather than "Already joined", and no tool
result since has carried the line. Two for two, both non-no-op joins. And the binding again held a
lease written before turn 1 (`msls_DhjMB5NF…`) *and* an `attested_at` stamped 227 ms after
`started_at` — so the seat could read a lease, an attestation and a refusal at the same instant,
which is worth more than the lease finding alone: **not even the seat's own attestation record
distinguishes a live Presence from a dead one.**

**What trial 2 adds beyond the count is scope: this is not a cloud-seat property.** Within the same
hour three seats on the **laptop** — the hub itself — reported the same arrival state and the same
repair: stanley at 19:34Z ("session lease was dead on arrival, the ring stopped after `team_join`,
exactly delta's *a work-order wake arrives deaf*"), izzo at 19:38Z ("lease dead on arrival, same
as delta/stanley"), and dolly at 20:02Z ("re-joined (lease dead on arrival — same deaf-wake
arrival delta/stanley/izzo all hit)"). Those are their own status updates, not measurements of
mine — I cannot read their machines from here, and they should be read as corroboration rather
than as data I took. But
with the two trials above they place the defect in the **residency handover, not in the Fly
transport and not in the work-order path**: neither a wake nor this VM is required to produce it.
The wiki's framing — a *cloud* seat begins deaf — is too narrow in exactly the way clause 8's
"granted is not callable" was, and was corrected for, on the same page (2026-09-14 19:56Z; falsify:
a seat on any machine that arrives with both `session_lease` and `attested_at` in its binding and
whose first interrupt check is honoured with no join).

**Trial 3 (2026-09-14 20:27Z) is three for three — and it is the first one with a positive
control.** Session `6599f170`, `started_at` 1789417624719 (20:27:04.719Z), `attested_at` 170 ms
later, work order on the same lane. Same course again: the deaf line rode the first tool result (a
`ToolSearch`, not a musterd call), the second call was `team_join` **alone**, it answered "You are
now the live occupant of this seat — the server authenticated this occupancy" rather than "Already
joined", and no tool result since has carried it. Three trials, three non-no-op joins, three
repairs.

What the first two trials could not do was tell *silence* apart from *deafness*: a line that has
stopped ringing and a line that is still refused look identical when nothing is trying to ring.
This trial has the control. Within a minute of the join, stanley's `steer` `01M2GSCEHM` began
riding every tool result as a delivery nudge and has not stopped. **The same interrupt line that
was refused before the join is observably carrying a real act after it** — so the post-join silence
in trials 1 and 2 was the absence of traffic, not the absence of a line (falsify: a repaired seat
whose interrupt line stays silent through a directed act sent to it).

**The lease was not missing — it was on disk and refused.** `.musterd/binding.json` already carried
`"session_lease": "msls_hmmp…"`, written at 19:24, before the first turn. So the woken session held
a lease string the server would not honour: *a lease on disk is not a live Presence*, and a seat
checking its own binding for one would conclude, wrongly, that it was fine.

**And on trial 3 the lease turned out not to be stable either.** Beyond being unhonoured, the
string moves: this session's binding read `session_lease: "msls_qeiYKz0D…"` at 20:28:0xZ and
`"msls_4tzGD9…"` at 20:30:18.879Z (file mtime), with no `team_join` from this seat in between, so
some other writer rotates it mid-session. A seat cannot reason about its own Presence from the
binding in either direction: a dead lease looks live, and the value it would compare against is a
moving target. What does the rotating was not measured here and should not be guessed (falsify: a
session whose `session_lease` is byte-identical from turn 1 to wrap-up).

This still matters for the brief, eight days on. The wake brief says "orient via
`team_wake_context` (then `team_next`) and begin" — a seat that follows it exactly never calls
`team_join`, because it was *just woken* and has every reason to believe it is already on the team.
Only a hook firing on an unrelated tool call surfaced it. **A woken seat that is deaf cannot
discover it from the tools the brief names**, and open lane `01M2GP25R3` (clause 8 — the
`ToolSearch` requirement and reconnect deferral) is the same seam. 18a's finding 1 and this are one
defect wearing two hats: *the wake hands over a session whose capabilities are not yet real*,
whether the missing piece is a tool schema or a Presence.

**The budget is written where the seat cannot reach it, and now the mechanism is named.** 18a
recorded that `team_wake_context` carries no timeout field and that the bound lives daemon-side.
There is also a seat-side drop point: `.musterd/pending/`. On this wake it was **empty, with an
mtime of 19:24 — one minute before the session marker** — so the brief passes through the seat's own
directory and is cleared before turn 1. The seat cannot read its own budget not because nothing was
ever written down locally, but because the local copy is deleted in the handover (falsify: a wake
whose `.musterd/pending/` still holds the brief on the first turn).

**Two smaller readings from inside, for the record.**

1. `tool_allowlist` in `.musterd/binding.json` is `[]` on the v12 image, and the `mcp__musterd`
   tools arrived anyway. 18a confirmed fix 1 *behaviourally* — calls returned, no permission
   prompt; this is the same fact structurally, in the binding the seat was handed: nothing is
   narrowing the set (falsify: a v12 binding whose `tool_allowlist` is non-empty).
2. **18a's own falsifier cannot be run by the seat it describes.** It reads `grep -o allowedTools`
   on `/app/packages/cli/dist/host/backends/claudeCode.js`; from inside, `/app` is outside the
   harness working-directory scope and the read is refused. Same boundary that keeps `host.log`
   unreadable — and `host.log` is not merely out of scope but **absent from this machine entirely**
   (`find` over the worktree returns nothing; `/data/home/.musterd/host.log` resolves to "File does
   not exist"). Fix 3 stays attested from the laptop. When this log prints a falsifier, it is worth
   saying which machine can run it.

## 2026-09-14 — what the cloud seat costs per day

Lane `01M1T3HA9T` asked for the figure the 09-04 open-items list left as "the Fly dashboard figure
goes here after a full day". The machine has now existed for **10.6 days** (created 2026-09-04
04:33:31Z, read 2026-09-14 19:00Z), never auto-stopped, so there is a real window to read.

**Read this table as two different kinds of number.** The model spend is *measured* — every row is a
`wake cost recorded` line the actuator wrote on the machine. The infrastructure spend is *list
price arithmetic*, not an invoice: Fly's published rates applied to this machine's actual shape.
They are not the same evidence and the table says which is which.

### Model spend — measured, every wake since the machine existed

`grep "wake cost recorded" /data/log/host.log` gives 15 leases, 9 of which carry a number:

| wake | cost | what it bought |
| --- | --- | --- |
| `01M1PZ2Y01` | `$0.2156` | the first successful wake (09-05) |
| `01M1PZ6D43` | `$0.3257` | |
| `01M1Q2JAA4` | `$0.2476` | |
| `01M1TC90GS` | **`$3.4128`** | **exit=1 at 521.5 s — paid in full, delivered nothing** |
| `01M1VH16X3` | `$3.7200` | PR #1353, the lane taken end to end from the VM |
| `01M2GF3158` | `$3.0403` | the #1371 falsifier report (2026-09-14) |
| `01M2GFPY6M` | `$0.7519` | |
| `01M2GJJC7H` | `$0.8374` | the lane close |
| (earlier) | `$0.1073` | wake 4, the 23.8 s no-occupy that became finding 18 |

**Total `$12.6586` across 9 billed wakes — `$1.41` mean, `$1.19`/day averaged over the machine's
life.** The remaining 6 leases recorded `$—`: watchdog kills and the four credit-exhausted runs,
which cost nothing because no tokens were spent.

Two things this table says that a mean hides:

1. **The distribution is not flat — three wakes are 80% of the spend.** `$3.41 + $3.72 + $3.04 =
   $10.17` of `$12.66`. A wake that does real work costs ~20× one that reads its inbox and stops.
2. **A failed wake can be the most expensive one.** `01M1TC90GS` exited 1 after 521.5 s having
   charged `$3.4128` — more than the wake that opened PR #1353. Failure is not free, and
   `$—` in this log means "no tokens", never "no cost".

### Infrastructure — list price, not the invoice

`shared-cpu-2x`, 2048 MB RAM, one 3 GB volume, `sjc`, no `[[services]]` block so Fly's auto-stop
never applies (spec §image; the machine stays up while enrolled).

| line | rate | /month |
| --- | --- | --- |
| `shared-cpu-2x` preset (512 MB) | $4.04 | $4.04 |
| + 1.5 GB RAM to reach 2 GB | ~$5/GB/mo | $7.50 |
| 3 GB volume | $0.15/GB/mo | $0.45 |
| egress | $0.02/GB (NA) | ~$0 — the seat pulls, it does not serve |
| **always-on total** | | **$11.99/mo ≈ $0.40/day** |

**Infrastructure to date: ~$4.24.** So over this machine's life, **model spend is ~3× the machine
that runs it** — $12.66 against $4.24, 75% of an all-in $16.90 (2026-09-14; falsify: read the Fly
invoice for the period and compare — a difference over 20% means these list rates are wrong for
this account, and the model half is unaffected because it is measured, not derived).

### Parked vs always-up — the README's "cents per month", measured

README §Park says parking a seat costs cents per month. It does:

| state | /month | |
| --- | --- | --- |
| always-up | $11.99 | the seat can be woken at any time |
| parked (`fly machine stop`) | **$0.53** | rootfs $0.08 (506 MB image at $0.15/GB/30d) + volume $0.45 |

**A parked seat is 4% of a running one**, and the volume is 85% of what is left — the data outlives
the machine and is billed whether or not anything is attached. So the choice is not "pay or don't
pay", it is `$11.46/month for wakeability`. For a seat woken a handful of times a week, parking and
accepting a cold boot is the cheaper shape; for one enrolled as an always-reachable joiner, it is
not, and that is a decision about reachability rather than about money.

### What a real working day costs

2026-09-14 is the only day with a full arc of wakes on a current image: four wakes, `$4.6296` in
model spend, `$0.3997` of machine. **`$5.03` all-in for one day of one cloud seat doing real work** —
and `$3.80` of that went to the four wakes it took to get one report out, because a credit failure
did not retry and the transcript-hygiene bound cold-started every wake after (see 18a).

**The cheapest thing on this page is the machine.** Every optimisation that matters is in the wake
economy — not re-spawning fresh, not paying for failed wakes, not waking a seat to do bookkeeping a
tool call could do.

## 2026-09-06 03:36 UTC — exit criterion 3 met: a lane taken end to end from the VM

`delta` claimed lane `01M1T3YXVD`, wrote `docs/wiki/cloud-seat-from-inside.md`, committed, pushed,
and opened **PR #1353** — every step in a woken session on the Fly machine as uid 1001. Merged
`c272e2be` (nick), ancestor-verified on `origin/main`, `pnpm wiki:check` green. Both commits are
authored **and** committed by `delta (musterd seat) <delta@revive.musterd>` at 02:28:23Z and
03:38:14Z, so ADR 109/197 attribution holds on the second machine. ADR 390's falsifier 5 is closed
from inside: `id -u` → `1001`, user `seat`.

**The lane's own falsifier resolved negative, and that is worth stating.** It predicted that push or
`lane_submit` would be refused from the VM — by the two-repo token, by the joiner's lease, or by
ancestor verification on the joiner's clone. None of that happened: push and `gh pr create` both
work. Every real obstacle was somewhere the lane had not thought to look, and each was a different
defect in the wake path rather than in the git path.

### The five wakes it took, and what each one proved

| # | leased | derivation | budget | outcome | blocker it exposed |
| - | ------ | ---------- | ------ | ------- | ------------------ |
| — | — | — | — | never fired | **14** credential: 401 for 50 h 50 m |
| 1 | 01:26:52Z | batched | 5 m | killed 302.1 s | **16** joiner has no team policy |
| 2 | 01:57:03Z | batched | 5 m | killed 301.4 s, page written | (same) |
| 3 | 02:27:23Z | work_order | 30 m | killed 91.4 s, page committed | **17/18** cannot occupy |
| 4 | 02:58Z | work_order | 30 m | exited 23.8 s, `$0.1073` | **18** musterd tools not permitted |
| 5 | 03:30Z | work_order | 30 m | **push + PR #1353** | — |

Four wakes recorded `$—` for spend; only the two that ended cleanly recorded anything. The ledger
under-counts this arc by four runs.

### What delta found that this seat could not

The page's own findings are better evidence than anything measured from the laptop, because they are
about the boundary a woken session sits inside:

1. **The command allow list matches a literal prefix.** `Bash(git status *)` is allowed; `git -C .
   status -sb` is refused. The *robust* form — the one a wake-time script writes to be
   directory-safe — is the one that hangs a headless session, and with no human at the keyboard
   `requires approval` is not a pause but a refusal that never resolves. (Conversely `git remote -v`
   ran with no rule matching it, so the workspace list is the editable part of the boundary, not the
   boundary.)
2. **A woken seat cannot read its own daemon's files.** The session is scoped to its workspace, so
   `rg`, `ls` and `cat` are all refused on `~/.musterd` — `musterd.db`, `host.log`, `daemon.log`,
   `binding.json`. Those four files are what every finding in this log turned on. **A seat session
   can be the subject of a wake diagnosis; it cannot be the instrument.** That is why findings 14-18
   all came from an out-of-band shell, and why delta correctly reported that it could not read its
   own `residency.wake_leased.detail.derivation` rather than guessing it.

Delta also recorded three commissioned readings as *unverified from inside*, with the reason — the
`MUSTERD_INVITE` scrub, the process list, the `gh` token type — rather than working around the
refusal or inventing a value. That is the right shape for a measurement page.

### What is still open (supersedes the 2026-09-04 list)

- **Two wake-path defects have lanes**: ~~`01M1T6D80Q` (high — the actuator's credential is a
  field three code paths own)~~ **FIXED 2026-09-14, ADR 395** (`binding.host_key`) and
  `01M1T6DJ7J` (high — team policy does not replicate to a joiner). ~~and finding 18's `seat-policy` narrowing~~ — **finding 18 is closed
  (#1371, confirmed on the VM 2026-09-14; see 18a)**. Two new ones opened in its place, both from
  the confirming run: a granted tool is not yet a callable tool (the musterd tools arrive deferred,
  and ryder reproduced it on the laptop and across an MCP reconnect — not a cloud-seat property);
  and a seat can read its doorbell's *kind* but not its *budget*, which is the one observable
  finding 15 needed.
- ~~**Every disposition here is hand-applied on the VM and will not survive a rebuild**: the
  credential rebind, `loops.dispatch` on the joiner, `flow: auto`, and `mcp__musterd` in the
  workspace allow list. `seat.sh` should do all four, or the defects should be fixed so it need not.~~
  **2026-09-06 13:20Z: `seat.sh` now does all four at every boot** (`musterd wire` before
  `residency on`; `team policy --dispatch-loop on` on the joiner; `--flow auto`; `mcp__musterd`
  merged into the workspace allow list), plus `musterd init --refresh-hooks` for the doorbell seam.
  Verified by `bash -n` and `shellcheck` only — the falsifier is a redeploy of the image from that
  commit followed by a handoff that leases `derivation: work_order` and an interrupt line that lands
  in the woken session's context with no hand step after boot. **Measured 2026-09-06 13:18Z** on
  the first redeploy from #1357 (image `deployment-01M1VDSN5A`, one boot, read from `fly logs` and
  the VM): `team policy --dispatch-loop on` took (the joiner's policy reads `dispatch loop: on`);
  `residency on` recorded `seat overrides: {"flow":"auto"}`; `mcp__musterd` was already in the allow
  list (the merge is silent when nothing changes); the hook now reads `--interrupt-check --hook
  claude-code`; the actuator started as uid 1001 and its first polls were 200. **Two steps failed
  on that boot and the order was the cause**: `harness configure` printed `claude-code ✗ conflict`
  and `musterd wire` refused, because both ran *before* `init --refresh-hooks` and the workspace
  still held the pre-#1349 hook, which they read as a foreign edit. Refresh-hooks then rewrote it,
  and by hand afterwards both commands pass `✓ unchanged`. So on an image upgrade that changes a
  hook, the first boot's rebind does not happen — fixed by running `--refresh-hooks` first (#1360).
  The handoff half of the falsifier could not run: since 04:00Z every wake on delta has exited 1 in
  ~10 s at `$0.0000` because the model credential returns `billing_error: Credit balance is too
  low` (four identical 21,818-byte transcripts, 04:00/04:32/05:04/05:35Z), and `host.log` reports
  only `run exited (code 1) without occupying the seat` — the reason is visible nowhere but the
  transcript. That is lane `01M1VDY8PY`'s third fix. ~~Unmeasured until the credit is topped up.~~
  **Measured 2026-09-14 16:35Z: the credit was topped up and the line now reads `… — harness: Credit
  balance is too low` (18a).** Finding 18 is closed. `01M1T6DJ7J` (team policy does not replicate)
  stays open. `01M1T6D80Q` is ADR 395: the actuator now polls with `binding.host_key`, a field no
  claim path writes. The boot script remains the floor for enrollments that have not yet run
  `residency on` on a build that mints it. Finding 14's "the wake rewrites the credential" was
  already falsified (2026-09-06 13:15Z): after the 01:24Z rebind delta was woken five times, each
  session claimed, and the actuator's polls stayed 200 throughout (`host.log`'s last 401 is before
  those leases; `daemon.log` shows `POST /residency/wake-leases 200` every ~31 s at 13:1xZ). The
  09-04 22:36Z writer ran once, on a first-boot workspace, and is still unnamed — splitting the
  field means it no longer matters.
- ~~**The doorbell on the VM is deaf** — its `PostToolUse` hook still prints bare stdout, the form
  izzo's #1349 identified as never reaching a model. `musterd init --refresh-hooks` on the machine,
  once #1349's dist is deployed there.~~ Folded into the `seat.sh` line above (2026-09-06).
- **The two-machine experiments** (ADR 366 cursor, ADR 371 counts) — lane `01M1T3H3RB`, unblocked
  now that the seat can work.
- ~~**Cost per day** — lane `01M1T3HA9T`.~~ **Read 2026-09-14** (see "what the cloud seat costs
  per day" above): `$12.66` model over 10.6 days against `$4.24` of machine, `$5.03` for one real
  working day, and a parked seat at `$0.53/month` against `$11.99` running. The machine is the
  cheap half.
- **Residency enrollment still does not replicate** (finding 6), now with a sibling: team policy does
  not either (finding 16). Same family, one lane each.
