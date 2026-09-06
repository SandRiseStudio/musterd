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
6. **Residency enrollment does not replicate.** The hub's `residency status` lists the laptop's
   five seats, not delta; the hub roster shows delta plain `offline` while the VM shows `offline ·
   wakeable`. The wake decision is the joiner's (its daemon derives due acts from folded messages),
   so wakes are unaffected. **Disposition:** roster-truth gap, own lane; belongs beside ADR 371 §3's
   seed-lifecycle residue.
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
`host.log`; neither reaches the hub, and residency enrollment does not replicate (finding 6), so the
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
