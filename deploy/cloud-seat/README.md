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

The volume is encrypted at rest (Fly's default; `fly volumes list` shows `ENCRYPTED true`).

Secrets arrive as Fly secrets and are never in the image, `fly.toml` or the repo. The machine
receives only what the job needs — the trust boundary is written down in
[ADR 390](../../docs/decisions/390-the-cloud-seat-holds-what-its-job-needs.md):

| secret                    | who needs it                          | lifetime on the machine                                       |
| ------------------------- | ------------------------------------- | ------------------------------------------------------------- |
| `TAILSCALE_AUTHKEY`       | `tailscaled`, first boot              | spent on first boot; scrubbed from the env before root drops  |
| `MUSTERD_INVITE`          | `musterd node join`, first boot       | spent on first boot; scrubbed before the wake actuator starts |
| `MUSTERD_SEAT`            | every step                            | the whole run                                                 |
| `ROSTER_REPO`, `GH_TOKEN` | `gh` (clone, push), the seat's work   | the whole run — the seat's work is git                         |
| model credential          | the woken `claude -p`                 | the whole run                                                 |

It does **not** receive the hub's team agent key: that key is daemon-private (the wake endpoints
check the bearer against the local team row), so the joiner mints its own at first boot and binds
the seat with it. **The entrypoint refuses to boot if `MUSTERD_AGENT_KEY` is set** — a stale
`fly secrets set` is the way it would come back.

### Who runs as what

`entrypoint.sh` is the root phase: it brings the tailnet up (kernel networking needs `/dev/net/tun`
and the `tailscaled` socket), resolves the hub, chowns the seat's part of the volume once, and
`setpriv`s into `seat.sh` as the unprivileged `seat` user (uid 1000, no inheritable capabilities).
The daemon, `git`, `gh`, the wake actuator and every `claude -p` it spawns run as `seat`.
`tailscaled` is the one root process left. Check it on a live machine:

```sh
fly ssh console --app musterd-seat-$SEAT -C "ps -eo user,comm --no-headers" | sort | uniq -c
#   1 root tailscaled        ← the only root line
#   … seat musterd / node / claude / bash
```

## Create **$**

```sh
SEAT=<name>                                   # an agent already on the roster (hub: musterd agent <name>)
fly apps create musterd-seat-$SEAT --org personal
fly volumes create seat_data --app musterd-seat-$SEAT --region sjc --size 3 --yes
```

Mint the three one-time credentials, each on its own machine:

```sh
# tailnet — Tailscale admin console → Settings → Keys → generate: reusable OFF, ephemeral OFF,
# pre-authorized ON, tags: tag:musterd-seat (§Tailnet policy below — the tag is what scopes the
# node's reach; an untagged node can reach the whole tailnet). Copy once.
# hub: the invite (single use, 15 minutes — mint it right before `fly deploy`)
musterd node invite --label "fly seat $SEAT"          # → msinv_…
# GitHub — a FINE-GRAINED token (github.com → Settings → Developer settings → Fine-grained tokens),
# resource owner SandRiseStudio, "only select repositories": the work repo AND the roster repo.
# Permissions — musterd: Contents read/write, Pull requests read/write, Metadata read (implied);
#               musterd-revive: Contents read (the joiner clones the roster; it never pushes it).
# NOT a `gh auth login` token (gho_…): that is your whole account, every org, every repo.
# model credential: ANTHROPIC_API_KEY (metered) or `claude setup-token` on a Max account
```

```sh
fly secrets set --app musterd-seat-$SEAT --stage \
  TAILSCALE_AUTHKEY=tskey-auth-… \
  MUSTERD_SEAT=$SEAT \
  MUSTERD_INVITE=msinv_… \
  ROSTER_REPO=SandRiseStudio/musterd-revive \
  GH_TOKEN=github_pat_… \
  CLAUDE_CODE_OAUTH_TOKEN=…        # or ANTHROPIC_API_KEY=…
```

Never `MUSTERD_AGENT_KEY` (the boot refuses it). After the first boot the two one-shots are spent —
the tailnet identity and the enrollment both live on the volume — so take them off the machine;
`unset` restarts it, so do this once, with the next redeploy:

```sh
fly secrets unset --app musterd-seat-$SEAT --stage TAILSCALE_AUTHKEY MUSTERD_INVITE
```

## Tailnet policy

A seat machine is a **seat**, not an operator's laptop: it needs exactly one thing on the tailnet,
the hub's daemon port, and nothing needs to reach it. Tailscale ACLs are the operator's (admin
console → Access controls); the runbook records the policy the seat is built to. Tag the auth key
`tag:musterd-seat` and the node inherits this on first boot:

```jsonc
{
  "tagOwners": { "tag:musterd-seat": ["autogroup:admin"] },
  "acls": [
    // a seat reaches the hub's daemon port on the laptop, and nothing else on the tailnet
    { "action": "accept", "src": ["tag:musterd-seat"], "dst": ["nicks-laptop:4849"] },
    // operators keep full reach (your existing rule); nothing needs to reach a seat
    { "action": "accept", "src": ["autogroup:member"], "dst": ["autogroup:member:*"] },
  ],
}
```

Check it from the VM — the hub answers, a neighbour does not:

```sh
fly ssh console --app musterd-seat-$SEAT -C "curl -s -m 2 -o /dev/null -w '%{http_code}\n' http://<hub ip>:4849/health"   # 200
fly ssh console --app musterd-seat-$SEAT -C "curl -s -m 2 -o /dev/null -w '%{http_code}\n' http://<hub ip>:22/"          # 000 (refused/timed out)
```

Not ephemeral: an ephemeral node is removed from the tailnet when it goes offline, and a parked
seat (`fly machine stop`) would lose its identity and need a fresh key every unpark. The state on
the volume is what makes the key single-use.

An existing node with no tag (delta, enrolled 2026-09-04) is re-tagged from the admin console
(Machines → the node → Edit ACL tags); it does not need a new key.

## First boot **$**

From the repo root (the build context is the checkout — the seat runs the build you deploy):

```sh
fly deploy --config deploy/cloud-seat/fly.toml --dockerfile deploy/cloud-seat/Dockerfile \
  --app musterd-seat-$SEAT --ha=false
fly logs --app musterd-seat-$SEAT
```

The entrypoint logs one line per step: `tailnet up · nicks-laptop → 100.…`, `daemon up`,
`enrolled at http://100.…:4849`, `wake actuator starting for seat <name>`. Then, on the **hub**,
one step the VM cannot do for itself — `team create` on the joiner minted events as nick, and nick
is bound to the hub's node (ADR 360), so until nick trusts the new node every push from it is
refused `403 bound_elsewhere` and queues:

```sh
musterd node list                    # the VM's row reads `enrolled`; the laptop's `local`
musterd node trust <the VM's node id>   # as nick, from the laptop (ADR 358) — clears the wedge
sqlite3 ~/.musterd/musterd.db "select count(*) from sync_log where origin_node='<node id>'"  # >0 within a tick
```

ADR 376's landed-outcome check: on the VM, `sync_log` stays at 0 (a joiner stages nothing):

```sh
fly ssh console --app musterd-seat-$SEAT -C \
  "sqlite3 /data/home/.musterd/musterd.db 'select count(*) from sync_log'"
```

## Verify — the exit criteria (spec §Testing)

1. **The seat is on the roster from the VM.** Hub: `musterd status` shows `<seat>` `offline ·
   wakeable`, bound to the VM's node (`musterd node list` names the residence).
2. **A cold wake.** Hub: `musterd send --act steer --to <seat> '…'`. It must be an act that
   wakes: `steer`, `resolve`, `accept`, `decline`, a `handoff`, or one carrying `meta.urgent`. A
   plain `message` is deliberately not a doorbell and will sit unread (2026-09-04, cost an hour). Within
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

## What the first boot taught (2026-09-04, node `01M1NB5B7J`, delta)

The full record is `docs/perf/cloud-seat.md`. The four that changed the script or the runbook:

- **The roster needs a remote.** The team home is now `SandRiseStudio/musterd-revive` (private);
  the joiner clones it before `team create`, and `delta` was on the roster at first boot. The
  design (ADR 058) held; the repo had simply never been pushed.
- **The hub must trust the new node** (`musterd node trust`), or the joiner's pushes wedge on
  ADR 360 — see §First boot. A one-line hub-side step, not a defect.
- **The team agent key is daemon-private.** Delta's binding carried the hub's key, so the wake
  actuator polled its own daemon into `401` on every tick. The joiner now mints its own key.
- **`musterd agent --path` makes a bare folder, not a worktree.** Run inside the checkout with no
  path flag and the seat gets a real worktree (`/data/musterd-<seat>`, branch `agent/<seat>`).

## What the least-privilege pass changed (2026-09-05, ADR 390)

The lane found the machine holding four things its job does not need: root for every process, the
hub's team agent key as a live Fly secret, an untagged tailnet node, and a `gh auth login` token in
place of the fine-grained one this runbook always described. The first two are fixed in the image
and the entrypoint (§Who runs as what; the boot refusal); the other two are operator steps this
runbook now spells out (§Create, §Tailnet policy). For a machine deployed before this pass:

```sh
fly secrets unset --app musterd-seat-$SEAT --stage MUSTERD_AGENT_KEY TAILSCALE_AUTHKEY MUSTERD_INVITE
fly secrets set   --app musterd-seat-$SEAT --stage GH_TOKEN=github_pat_…     # the fine-grained one
fly deploy --config deploy/cloud-seat/fly.toml --dockerfile deploy/cloud-seat/Dockerfile \
  --app musterd-seat-$SEAT --ha=false                                        # applies the staged set
fly logs --app musterd-seat-$SEAT | grep -E 'chown|dropping root|not root'   # the one-time migration
```

The volume from the root-era image is migrated on that boot (`chown … (one-time)` in the log), and
then re-tag the node in the Tailscale admin console. What the machine still holds by design — the
full team replica — is recorded in ADR 390 with the increment that would narrow it.

Still open: residency enrollment does not replicate, so the hub roster shows the seat plain
`offline` while the joiner shows `offline · wakeable`; the hub's `residency status` lists the
laptop's five seats and not delta. The wake decision is the joiner's (its daemon derives the due
acts from folded messages), so this is a roster-truth gap, not a wake gap.
