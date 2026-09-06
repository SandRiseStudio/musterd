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
removed. Unmeasured on the VM until the image is rebuilt from that commit — the falsifier is a
work-order wake on a workspace whose list has no `mcp__musterd` entry reaching `residency.woke`.

**Candidate product fixes:**

1. **`seat-policy` must be a superset of `reply-only`.** The musterd tools are the wake's own
   control plane, not part of the task's permissions — pass `--allowedTools mcp__musterd` on *both*
   paths and let the seat's settings add to it.
2. **`musterd agent`'s permissions floor (ADR 261) should include `mcp__musterd`.** It writes
   `Bash(musterd *)` today, which is the surface the seat is told not to use when it has tools.
3. **A wake that cannot call the wake's own tools should fail loudly, not quietly.** "exited without
   occupying" and "no roster occupancy within the verify window" are the same defect wearing two
   costumes; neither names the permission refusal that a transcript shows in one line.

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

- **The three wake-path defects have lanes, none fixed**: `01M1T6D80Q` (high — the actuator's
  credential is a field three code paths own), `01M1T6DJ7J` (high — team policy does not replicate
  to a joiner), and finding 18's `seat-policy` narrowing, which belongs with them.
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
  transcript. That is lane `01M1VDY8PY`'s third fix. Unmeasured until the credit is topped up. The
  three defects stay open (`01M1T6D80Q`, `01M1T6DJ7J`, finding 18); the boot script is the floor
  under them, not the fix — in particular a boot-time rebind cannot outlive the next wake if the
  claim path still rewrites `binding.agent_key` — **and it does not (2026-09-06 13:15Z)**: after
  the 01:24Z rebind delta was woken five times, each session claimed, and the actuator's polls
  stayed 200 throughout (`host.log`'s last 401 is before those leases; `daemon.log` shows
  `POST /residency/wake-leases 200` every ~31 s at 13:1xZ). Finding 14's "the wake rewrites the
  credential" is falsified; the 09-04 22:36Z writer ran once, on a first-boot workspace, and is
  still unnamed — recorded on lane `01M1T6D80Q`. A boot-time rebind is therefore a sufficient floor.
- ~~**The doorbell on the VM is deaf** — its `PostToolUse` hook still prints bare stdout, the form
  izzo's #1349 identified as never reaching a model. `musterd init --refresh-hooks` on the machine,
  once #1349's dist is deployed there.~~ Folded into the `seat.sh` line above (2026-09-06).
- **The two-machine experiments** (ADR 366 cursor, ADR 371 counts) — lane `01M1T3H3RB`, unblocked
  now that the seat can work.
- **Cost per day** — lane `01M1T3HA9T`. Today's arc: two clean runs at `$0.2476` and `$0.1073`, four
  killed runs at `$—`.
- **Residency enrollment still does not replicate** (finding 6), now with a sibling: team policy does
  not either (finding 16). Same family, one lane each.
