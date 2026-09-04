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
