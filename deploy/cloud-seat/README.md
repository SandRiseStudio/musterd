# Cloud seat — the second machine, as a Fly VM

The runbook for one persistent cloud seat: a Fly machine on the tailnet that runs its **own
musterd daemon**, enrolls at the laptop hub as a joiner (ADR 325, 328, 376), hosts one agent seat
and wakes it (ADR 131). Design: `docs/superpowers/specs/2026-08-06-cloud-seats-design.md`, plan
`docs/superpowers/plans/2026-08-06-cloud-seats.md` (see its 2026-09-03 amendment: the VM is a
joiner daemon, not a thin client — that is what the federation arc built the joiner for).

Every step marked **$** creates a cloud resource or spends money — nick at the wheel.
Every step marked **hub** runs on the laptop, in a folder bound to `revive` as an admin.

## What the machine holds

| where               | what                                                                     | survives redeploy |
| ------------------- | ------------------------------------------------------------------------ | ----------------- |
| image `/app`        | this checkout's CLI build (the ADR 260 pin, by construction), claude CLI | replaced          |
| volume `/data/home` | `~/.musterd` (config, SQLite, `node.json`, bindings), team home          | yes               |
| volume `/data`      | tailscale state, seat workspace (`agents-<seat>`), logs                  | yes               |

Secrets arrive as Fly secrets and are never in the image, `fly.toml` or the repo. The machine
receives only what the design allows: the tailnet key (single use), the seat name, the team agent
key, one invite code, a GitHub token for the work repo, and one model credential.

## Create **$**

```sh
SEAT=<name>                                   # an agent already on the roster (hub: musterd agent <name>)
fly apps create musterd-seat-$SEAT --org personal
fly volumes create seat_data --app musterd-seat-$SEAT --region sjc --size 3 --yes
```

Mint the three one-time credentials, each on its own machine:

```sh
# tailnet — Tailscale admin console → Settings → Keys → generate: reusable OFF, ephemeral OFF,
# tag it if the tailnet uses ACL tags. Copy once.
# hub: the invite (single use, 15 minutes — mint it right before `fly deploy`)
musterd node invite --label "fly seat $SEAT"          # → msinv_…
# hub: the team agent key the seat provisions with
musterd team agent-key --show                         # → mskey_…
# a GitHub fine-grained token: contents read/write + pull requests on SandRiseStudio/musterd
# model credential: ANTHROPIC_API_KEY (metered) or `claude setup-token` on a Max account
```

```sh
fly secrets set --app musterd-seat-$SEAT --stage \
  TAILSCALE_AUTHKEY=tskey-auth-… \
  MUSTERD_SEAT=$SEAT \
  MUSTERD_AGENT_KEY=mskey_… \
  MUSTERD_INVITE=msinv_… \
  GH_TOKEN=github_pat_… \
  CLAUDE_CODE_OAUTH_TOKEN=…        # or ANTHROPIC_API_KEY=…
```

## First boot **$**

From the repo root (the build context is the checkout — the seat runs the build you deploy):

```sh
fly deploy --config deploy/cloud-seat/fly.toml --dockerfile deploy/cloud-seat/Dockerfile \
  --app musterd-seat-$SEAT --ha=false
fly logs --app musterd-seat-$SEAT
```

The entrypoint logs one line per step: `tailnet up · nicks-laptop → 100.…`, `daemon up`,
`enrolled at http://100.…:4849`, `wake actuator starting for seat <name>`. Then, on the **hub**:

```sh
musterd node list                    # the VM's row reads `enrolled`; the laptop's `local`
sqlite3 ~/.musterd/musterd.db 'select count(*) from sync_log'   # grows as the joiner pushes
```

ADR 376's landed-outcome check: on the VM, `sync_log` stays at 0 (a joiner stages nothing):

```sh
fly ssh console --app musterd-seat-$SEAT -C \
  "sqlite3 /data/home/.musterd/musterd.db 'select count(*) from sync_log'"
```

## Verify — the exit criteria (spec §Testing)

1. **The seat is on the roster from the VM.** Hub: `musterd status` shows `<seat>` `offline ·
   wakeable`, bound to the VM's node (`musterd node list` names the residence).
2. **A cold wake.** Hub: `musterd lane open … ; musterd send --act handoff --to <seat> …`. Within
   one actuator tick (30 s) plus the tailnet sync tick, `fly logs` shows the wake, and the hub's
   roster flips the seat to `working`. Record the latency in `docs/perf/cloud-seat.md` against
   the local-seat baseline.
3. **A lane end to end.** claim → work → PR → `lane_submit` → acceptance, entirely from the VM.
4. **The three pre-registered two-machine experiments** (ADR 365 §O&E, 366 §Experiment, 371 §O&E):
   the wake economy reads the same on both daemons within a tick; a note saved on the VM is
   readable on the hub and the inbox cursor never swallows; a tool-call batch recorded on the VM is
   counted by the hub's `musterd report`. Each has its falsifier in its ADR — run them, log them.

## Park / unpark **$**

Fly auto-stop never fires (no inbound service), so parking is explicit:

```sh
fly machine stop  <id> --app musterd-seat-$SEAT     # cents/month while stopped; the volume stays
fly machine start <id> --app musterd-seat-$SEAT     # every boot step is idempotent
```

While parked the hub shows the seat `offline · wakeable`; wakes it is due for are deferred, not
lost (ADR 236). ADR 325's offline rule holds the other way too: when the **laptop** sleeps, the
VM keeps its coordination layer and hub-authoritative acts (claims) refuse with `hub_unreachable`
— how often that hurts is the measurement ADR 376 §4 (hub relocation) waits on.

## Move a seat (spec §Mobility — a procedure, both directions)

1. **Strand WIP** on the lane branch (ADR 153): push it; nothing movable lives outside git + the
   daemons.
2. **Release the old host**: end the session; `musterd residency off` there; admin
   `musterd node unbind <seat>` so the next act binds the seat wherever it happens (ADR 360).
3. **Claim on the new host**: laptop → `musterd agent <seat> --path …`; VM → set `MUSTERD_SEAT`
   and boot (the entrypoint provisions the workspace and re-enrolls residency).
4. Memory, lanes, inbox, attestation history **never move** — they replicate (ADRs 365–371).
   Only the workspace is rebuilt, from git.

## Teardown **$**

```sh
# hub: retire the machine identity first — history is kept, lanes its seat holds are not released
musterd node revoke <node id>
fly apps destroy musterd-seat-$SEAT --yes      # destroys the machine AND the volume
```

Revoke the tailnet node in the Tailscale admin console and the GitHub token.

## Known unknowns going into the first boot (P4 dry-run subjects)

Each becomes either a fix with a test or a line in `docs/perf/cloud-seat.md`'s friction list:

- **The roster has no remote.** ADR 058 says roster identity converges via git, but
  `~/musterd/revive` on the laptop has no `origin`. Until it does, the VM's team is created bare
  (`team create revive --as nick`) and members arrive only as the hub's events carry them —
  whether that is enough for `musterd agent <seat>` to find the seat is the first thing to learn.
- **`team create` on a joiner mints a second creator credential** — a different `nick` identity
  on each daemon. The two-daemon tests do the same; whether the reconciler minds is unmeasured.
- **The wake spawns `claude -p` with a model credential in env** — fine on a VM nobody shares;
  the resume-capture path assumes a SessionStart hook the headless run may not fire.
- **`fly deploy` rebuilds the image from the checkout each time** — a code change on main is a
  redeploy, and the volume carries the identity across it. No `stream build`-style digest pin yet.
