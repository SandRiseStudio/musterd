# 390 — The cloud seat holds what its job needs

- Status: accepted
- Date: 2026-09-05
- Lane: `01M1QAF7Z0FG65VEADX788A0A0` — opened by stanley 2026-09-04 out of the cloud-seat dogfood
  (`01KZAAS15M`), the security read big-body was asked for in the control huddle
  (`docs/wiki/cross-machine-huddle-bell.md`) and this lane records
- Relates to: ADR 325 (a joiner is a replica), ADR 328 (the machine credential and the invite
  ceremony), ADR 358 (a human seat trusts a set of machines), ADR 360 (residence at ingest),
  ADR 366 (seat continuity replicates — every seat's), ADR 371 (the record kind — the rest of the
  ledger crosses), ADR 376 (the hub is the creator's machine; a joiner cannot mint an invite),
  ADR 163 (actor attestation at the tool boundary — why a woken model's privileges are the
  question), ADR 385 (the optional Tailscale/Aperture doctor — the tooling this ADR's policy would be
  checked by, when it lands)
- Decided by: nick, 2026-09-05 (the lane claim: "claim it"); recorded by stanley

## Context

The first real second machine is a Fly VM in `sjc` running its own musterd daemon, enrolled at the
laptop hub over a tailnet, hosting the seat `delta` and waking it as `claude -p` (deploy/cloud-seat,
`docs/perf/cloud-seat.md`). It works: a cold wake in 23.6 s, the wake economy folded to the hub, a
cross-machine huddle carried its turns. Then the question the control huddle put to security, and
nobody had answered: what does this machine hold, and does its job need all of it?

Measured 2026-09-05 on `main` at `cd138abd` and on the live machine `850e40a4499168`:

1. **Every process runs as root.** The Dockerfile has no `USER`; the entrypoint runs `tailscaled`,
   the daemon, `gh`, `pnpm install`, the wake actuator and — through it — every woken `claude -p`
   as uid 0. A woken model is an actor whose tool calls ADR 163 attests precisely because they are
   not trusted; on this machine its shell was root's.
2. **The hub's team agent key is a live secret on the joiner.** `fly secrets list` shows
   `MUSTERD_AGENT_KEY` deployed. The first boot (perf finding 3) proved the key is daemon-private
   and useless there — the joiner mints its own — and the runbook dropped it, but the deploy
   script on the laptop still minted and shipped it on every deploy. A key that authorizes wake
   endpoints on the hub sat on a machine that has no use for it.
3. **The GitHub token is `gho_…`** — a `gh auth login` OAuth token: nick's whole account, every org
   and repo it can see, not the fine-grained two-repo token the runbook always described.
4. **The tailnet node is untagged** (`tailscale status --json`: `Tags: null`). With no tag and no
   ACL naming it, the node has whatever reach `autogroup:member` has: the whole tailnet, every port
   — the laptop's SSH included. The seat needs one destination, the hub's port 4849.
5. **The two one-shots stay in the environment forever.** `TAILSCALE_AUTHKEY` and `MUSTERD_INVITE`
   are spent on first boot (the identity and the enrollment live on the volume) and then ride in
   the env of every process, including the woken model's.
6. **The machine holds a full team replica.** By ADR 325 a joiner folds the hub's whole log: every
   lane, every act, the ledger (ADR 365/371), and — ADR 366's deliberate choice — every seat's
   continuity note, not just delta's. 22,000 events of one team's history on a 3 GB volume that
   an org-write token and a root shell shared the machine with.

Six things. Four are fixable in the image and the runbook without touching product code. One is
the operator's (the tailnet is nick's). One is the design, and the design is right for now.

## Decision

**A seat machine holds what a seat's job needs and nothing that the hub's or an operator's job
needs. The image enforces what it can; the runbook records the rest as the operator's policy with
a check; the replica stays, named, with the increment that would narrow it.**

1. **Root for the tailnet only.** `entrypoint.sh` is the root phase: `tailscaled` up (kernel
   networking wants `/dev/net/tun` and the daemon socket), the hub resolved, the seat's part of the
   volume chowned once, then `setpriv --reuid=seat --regid=seat --init-groups --inh-caps=-all`
   into `seat.sh`. The daemon, `git`, `gh`, the actuator and every `claude -p` run as `seat`
   (uid 1000). `tailscaled` is the one root process on the machine. A woken model gets an
   unprivileged shell, which is the least a machine can offer an actor it attests.
2. **The hub's key never boots.** If `MUSTERD_AGENT_KEY` is set, the entrypoint logs the fix and
   exits 1 before the tailnet comes up. Loud, not silent: a stale `fly secrets set` is the only way
   the key comes back, and a stopped machine with one log line is how it is found. The laptop's
   deploy script no longer mints or stages it, and unsets it from the app if present.
3. **Spent one-shots leave the environment.** `TAILSCALE_AUTHKEY` is unset before root drops;
   `MUSTERD_INVITE` is unset in `seat.sh` after enrollment and before the actuator — so neither is
   in the environment a woken session inherits. The runbook tells the operator to `fly secrets
   unset` both after first boot, with the next redeploy.
4. **The GitHub token is fine-grained to two repositories.** `SandRiseStudio/musterd` (contents
   read/write, pull requests read/write) and `SandRiseStudio/musterd-revive` (contents read — the
   joiner clones the roster and never pushes it). The runbook names the exact scopes and says in
   words that a `gho_` login token is the wrong shape. This is the operator's to mint; the image
   cannot check what a token can do without spending it.
5. **The tailnet node is tagged and the ACL admits one destination.** The auth key is generated
   with `tag:musterd-seat`, pre-authorized, reusable off, **ephemeral off** (a parked seat would
   lose an ephemeral identity every stop). The policy: `tag:musterd-seat` → `<hub>:4849`, and no
   rule admits anything *to* a seat. The runbook carries the ACL snippet and a two-line check from
   the VM (the hub answers; the laptop's SSH does not). The entrypoint accepts an optional
   `TAILSCALE_ADVERTISE_TAGS` for a tailnet that wants the node to ask.
6. **The replica stays, and is written down.** A joiner that holds less than the log cannot fold it
   (ADR 325's block-don't-skip; ADR 381's watermark is the only skip and it is about pre-history,
   not scope). Narrowing what a joiner holds — a seat-scoped or kind-scoped replica — is a
   federation increment with its own ADR, not a deploy change, and nothing today needs it: the
   volume is encrypted at rest (Fly default, verified), the machine has no inbound service, and
   after this ADR the actors on it are unprivileged and hold a two-repo token. Named here so the
   next reader knows the replica is a choice, not an oversight, and what would change the
   choice: a team whose seats are not all trusted with the team's history, or a second
   organisation's machine joining.

### Rejected

- **Userspace tailscale (`--tun=userspace-networking`) to avoid root entirely.** Every outbound
  connection would then need a SOCKS/HTTP proxy the daemon, `gh` and `curl` all honour; the kernel
  path is proven (the broadcast image, this one). One root process that is tailscale's own daemon
  is a smaller surface than a proxy in front of everything.
- **A secrets manager or per-process environment separation.** The seat's work needs the GitHub
  token and the model credential in the woken session; the daemon needs neither but shares the
  process tree. Separating them means a supervisor the entrypoint deliberately is not
  (`fly.toml`: no restart policy, the entrypoint is the supervisor). The one-shots, which no
  process needs after first boot, are scrubbed instead — that is the cut that costs nothing.
- **Refusing to boot on an untagged node or a `gho_` token.** The image cannot tell a tagged node
  from an untagged one without the admin API, and cannot tell a token's scope without using it.
  Both belong to the operator and are recorded as the operator's policy with a check, not faked as
  an enforcement.
- **Scoping the replica now.** See decision 6: it is product work, it has no driver yet, and a
  half-replica that cannot fold is worse than a full one that can.

## Consequences

- `deploy/cloud-seat/entrypoint.sh` is the root phase; `deploy/cloud-seat/seat.sh` is the seat's
  life. The Dockerfile adds the `seat` user, shares corepack's cache outside any HOME, and makes
  `/app` world-readable. No product code changes.
- A machine deployed from the root-era image migrates on its first boot of this one: the entrypoint
  chowns `/data/home`, the repo, the workspace and the logs to `seat` (one log line each). The
  runbook's §"What the least-privilege pass changed" is the exact sequence for delta.
- The laptop's deploy script (`~/.musterd/cloud-seat/deploy-delta.sh`, machine-local, not in the
  repo) mints the invite only on `FIRST_BOOT=1`, never the agent key, and unsets the spent set
  before staging. `delta.env` no longer carries the key.
- Three operator steps remain for delta and are not done by this merge: unset the three stale
  secrets, replace the token, re-tag the node in the admin console. Each is a `$` step in the
  runbook; the merge does not touch the live machine.

## Observability & Evaluation

- **Traces.** `fly logs` on boot: `dropping root → seat (tailscaled stays root; nothing else does)`
  and `wake actuator starting for seat <name> (uid 1000, not root)`. On a migrated volume, the
  `chown … (one-time)` lines, once.
- **Eval.** The claim is "one root process, and it is tailscaled". Dataset: the live machine's
  process table. Baseline 2026-09-05 (before): every process uid 0. Expected after the first boot
  of this image: `ps -eo user,comm` shows exactly one `root` line, `tailscaled`.
- **Experiment.** None — no flag, no rollout. One machine, one deploy, on nick's word.

## Falsifiers

1. `fly ssh console -C "ps -eo user,comm --no-headers" | grep root` prints more than `tailscaled`
   → decision 1 is not holding on that machine.
2. `fly secrets list` shows `MUSTERD_AGENT_KEY` and the machine is running → decision 2's refusal
   did not fire; the entrypoint on that image is not this one.
3. From the VM, `curl http://<hub>:22/` connects (any HTTP code, not `000`) → the ACL in the runbook
   is not applied; the node has more reach than its job.
4. `fly ssh console -C "cat /proc/$(pgrep -f 'musterd host')/environ" | tr '\0' '\n' | grep -E
   'TAILSCALE_AUTHKEY|MUSTERD_INVITE'` prints a line → decision 3's scrub is not reaching the
   actuator's environment.
5. A woken `claude -p` on the VM runs `id -u` and gets `0` → the drop did not survive the actuator's
   spawn path.
