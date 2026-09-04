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

Wake latency, cost, and the ADR 365/366/371 experiments: next entry.
