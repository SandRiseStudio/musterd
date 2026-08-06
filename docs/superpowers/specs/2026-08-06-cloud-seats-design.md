# Cloud seats — a persistent VM seat on the existing daemon, designed so ephemeral falls out later

**Date:** 2026-08-06
**Status:** Design approved in conversation (nick + kimi); implementation not started
**Scope:** Increment 1 — one persistent cloud VM seat (Fly + Tailscale), golden image +
runbook, with product code limited to what the dogfood proves broken (P4 remote-join
gaps, linux wake actuator). Ephemeral burst, the `musterd host` verbs, and seat
mobility automation are pre-registered future increments, not built here.

## Problem

The seat-footprint work (ADR 242, `docs/perf/seat-footprint.md`) measured this
machine's honest ceiling: **5 working seats, 4 comfortable, on 8 GB**. Scale past one
machine's ceiling means seats that run elsewhere. musterd users on constrained
machines will hit the same wall; cloud seats are the scale story past it.

Additional owner requirement: **admins can move a member between local and cloud
hosts whenever they want** — a seat is not pinned to the machine that first ran it.

## Design spine — nothing new is invented

1. **One team, one daemon** (ADR 039). The daemon stays on the admin's machine,
   joined to a Tailscale tailnet; the VM is a *client*. The overlay supplies
   reachability + encryption + mutual auth — musterd writes zero transport code.
2. **A cloud seat is an ordinary Member.** Same agent key, lanes, acts, memory,
   attestation; its Presence just attaches from a VM. Presence already carries
   `workspace`/`surface`, which is enough for a roster "☁" facet later.
3. **Seat ≠ host.** A seat is a durable identity; a host is where it currently
   attaches (the same split that lets humans fan out, ADR 042). Mobility is
   re-provisioning a workspace, never moving identity.
4. Deliberate consequence, stated honestly: **cloud seats work only while the
   daemon's machine is up.** Hosting the daemon itself is a separate future
   decision, not smuggled in here.

## Increment 1

### The image + bootstrap (`deploy/cloud-seat/`)

- `Dockerfile`: node 22, git, gh, claude CLI, tailscale, musterd (npm or checkout).
- `fly.toml`: 1–2 GB machine (the measured lean-seat budget: terminal `claude` +
  musterd MCP only — the cloud seat is born on the Phase 0 diet, no desktop app, no
  plugin fleet), **auto-stop off** (Fly stops on no *inbound* traffic, and this
  machine's life is outbound polling — auto-stop would kill an idle-but-enrolled
  seat), small volume for the workspace.
- `bootstrap.sh` (first boot): join tailnet (single-use auth key from Fly secrets),
  clone repo, `pnpm install`, enroll (below).
- Model auth via Fly secrets, both documented: `ANTHROPIC_API_KEY` (metered) or a
  `claude setup-token` credential (Max subscription, headless).

### Enrollment & credentials (the real P4 work)

- Admin mints the seat locally as usual. The VM receives **only**
  `{MUSTERD_SERVER (tailnet addr), team, seat name, agent key}` via Fly secrets.
- First `team_*` call claims through the existing HTTP claim flow
  (`claim.pending` → admin approval, or ADR 146 standing-reseat for known agents).
  `binding.json` is written VM-side by `musterd claim`.
- Secrets discipline: per-seat agent key only (ADR 143's shared-binding lesson);
  single-use tailnet key; nothing else leaves the admin's machine.
- Whatever assumption breaks in practice — loopback-only checks, provisioning
  paths, claim ergonomics — becomes this increment's product fix list rather than
  guessed fixes now.

### Wake & lifecycle

- ADR 131 residency machinery reused whole. The VM runs `musterd service --wake`
  as a **systemd unit** — the one known must-build (today's actuator installs a
  macOS LaunchAgent). It polls wake leases over the tailnet and spawns terminal
  `claude` in the seat workspace; ADR 236 sleeping-host-defers semantics already
  cover an unreachable actuator.
- **Lifecycle economics** (the one new lifecycle question): v1 keeps the machine
  running while enrolled (Fly auto-stop keys on *inbound* traffic, which an
  outbound poller never generates, so auto-stop is simply off); **parking is
  explicit** (`fly machine stop`, cents/month while stopped). Push-wake (daemon
  calls the provider start API, machine sleeps between wakes) is the
  pre-registered seam where both cheap-idle and ephemeral burst fall out — not
  built now.
- The VM is linux, where the ADR 242 footprint sampler self-disables; the linux
  `ps` port becomes worthwhile with the first cloud seat (pre-registered; cheap —
  parsing sits behind the platform module).

### Mobility (v1: a documented procedure, symmetric both directions)

1. **Strand/park** WIP per ADR 153 — WIP pushed on the lane branch; nothing
   movable lives outside git + the daemon.
2. **Release the old host**: end the session; unbind/prune the old folder's
   binding. Single-active per seat means no split-brain window.
3. **Claim on the new host**: local `musterd agent <seat> --path …`, or the VM
   bootstrap remotely. ADR 087 resume grants / re-mint cover credentials; ADR 146
   standing-reseat makes a known agent's move approval-free unless wanted.
4. Memory blob, lanes, inbox, attestation history **never move** — they live in
   the daemon. Only the workspace is rebuilt, from git.

`musterd host move <seat> --to <host>` is this procedure automated — a later
increment shaped by how often the manual version annoys.

## Testing & evaluation

- Product code (systemd unit, P4 fixes) gets normal TDD + through-DB tests; linux
  CI is the platform-assumption check (the reap `unverifiable` lesson).
- **Dogfood eval**: enroll one real cloud seat — the 6th seat the laptop cannot
  hold — and run it on real lanes for several days. Log to `docs/perf/cloud-seat.md`:
  wake latency (tailnet vs local baseline), VM cost/day, session success rate,
  every runbook step needing a human.
- **Exit criteria for increment 1**: a lane claimed, worked, submitted, and
  accepted entirely from the VM, including at least one cold wake — plus the
  friction list that becomes increment 2.

## Pre-registered future increments (in order)

2. **`musterd host enroll`** — provider-agnostic bootstrap generator (the
   Approach-3 middle): musterd emits a cloud-init/bootstrap script with one-time
   credentials; VM creation stays the user's.
3. **Linux footprint sampler** — ADR 242 parity on cloud hosts.
4. **Push-wake via provider start API → ephemeral burst** — machine created per
   wake, destroyed after submit; the persistent design's enrollment/credential
   flow is reused unchanged, which is what "designed so ephemeral falls out" means.
5. **`musterd host move`** — the mobility procedure as a verb.

Out of scope entirely: hosted daemon, federation (ADR 039 explicitly), managed
agent platforms (Claude Code cloud sessions / Cursor background agents — thinner
citizens, revisit after increment 1's evidence).
