# The cloud seat from inside

What delta's Fly VM looks like to the seat that lives on it — uid, paths, tools, remotes, daemon — measured from inside a woken session so the next person debugging it does not need `fly ssh`.

Everything below was measured on 2026-09-06 between 01:57Z and 03:35Z, across the wakes the actuator started, by the seat user itself. Where a reading is absent, the reason for its absence is the finding — see "What a woken session is not allowed to measure" below.

The counterpart page for the shared Mac is [nick's laptop](nicks-laptop.md).

## Identity: the seat is not root (2026-09-06 01:57:44Z; falsify: `id -u` from a woken session)

    $ id -u
    1001
    $ id -un
    seat

ADR 390's falsifier 5 asks for exactly this and it holds: the woken session runs as uid 1001 / `seat`, never 0. `HOME` is `/data/home`, not `/root` and not `/home/seat` — every musterd path below hangs off it, which is why `HOME=/data/home` has to be set explicitly when anything runs the CLI on this box as another user (that is how stanley's 01:26Z credential repair was run).

## Where the work happens (2026-09-06 01:57:44Z; falsify: `git rev-parse --show-toplevel` + `git remote -v`)

    $ pwd
    /data/musterd-delta
    $ git rev-parse --show-toplevel
    /data/musterd-delta
    $ git branch --show-current
    delta/cloud-seat-from-inside
    $ git remote -v
    origin  https://github.com/SandRiseStudio/musterd.git (fetch)
    origin  https://github.com/SandRiseStudio/musterd.git (push)

One remote, HTTPS not SSH, fetch and push both pointing at `SandRiseStudio/musterd`. The seat worktree is a sibling of nothing — `/data/musterd-delta` is a full checkout at the top of the data volume, not a `git worktree` hanging off a main clone the way the laptop's seats are.

Host and kernel: `hostname` → `850e40a4499168`, `uname -sr` → `Linux 6.12.105-fly`.

Disk (`df -h /data`, 03:32Z): 2.9 G total, 554 M used, 2.2 G available, 21 % — the checkout plus `~/.musterd` fits with room, but this is a small volume and a `pnpm install` that pulls a fresh store is a meaningful fraction of it.

## What the seat is bound to (2026-09-06 01:57Z; falsify: `musterd status` first three lines)

    ● revive  19 members · 10 present · 1 working
    you are delta  agent · claude-opus-5 · musterd-delta@delta/cloud-seat-from-inside
     ⚑ 3 requests waiting for you  since Yesterday 03:32 — musterd inbox to read
    localhost:4849 · ~/.musterd/musterd.db · schema 66

The line that matters for anyone debugging from off-box: **the binding points at `localhost:4849`**. The VM does not talk to the laptop's daemon — it runs its own, against its own `~/.musterd/musterd.db` (i.e. `/data/home/.musterd/musterd.db`) at schema 66. So "the team row" is a *different row* on this machine than on the Mac, which is exactly the gap stanley's 2026-09-06 credential finding turned on: `sha256(binding.agent_key) != teams.agent_key_hash` had to be evaluated **on the VM** to see the break at all. See [wake leases](wake-leases.md) and [shared daemon](shared-daemon.md).

The hooks are wired (`SessionStart`, `PostToolUse`, `PreToolUse` gate, `SessionEnd`, statusline, all marker-owned) but this workspace's `PostToolUse` still runs `musterd inbox --interrupt-check` bare, which is the form izzo measured as never reaching a Claude Code model — so the doorbell on this VM is deaf until `musterd init --refresh-hooks` runs here. See [huddles](huddles.md), "Bell check, 2026-09-05".

The seat's own view of that daemon is *only* what the CLI prints. The session cannot open `~/.musterd/musterd.db`, `host.log`, `daemon.log` or `binding.json` — see the path-scoping half of the refusal section below. `musterd status` answers because the CLI speaks to `localhost:4849`, not because the session can read the volume the daemon writes to.

## Tools on PATH (2026-09-06 01:57Z; falsify: `which musterd gh claude node pnpm`)

    /data/home/.musterd/bin/musterd
    /usr/bin/gh
    /usr/local/bin/claude
    /usr/local/bin/node
    /usr/local/bin/pnpm

`node --version` → `v22.23.2`. Note the split: `musterd` lives under `HOME` (`/data/home/.musterd/bin`), everything else is image-level in `/usr/bin` or `/usr/local/bin`. A `musterd` upgrade on this box is a per-user artifact; a `node` upgrade is a new image.

## Push and PR from the VM work (2026-09-06 01:59Z; falsify: `git push --dry-run` and `gh pr list --limit 1`)

The lane that produced this page expected the two-repo token to refuse a push from the cloud seat. It does not:

    $ git push --dry-run -u origin delta/cloud-seat-from-inside
    To https://github.com/SandRiseStudio/musterd.git
     * [new branch]        delta/cloud-seat-from-inside -> delta/cloud-seat-from-inside

`gh` is authenticated and answers about this repo (`gh pr list --limit 1` returned PR #1346). So steps "branch → commit → push → `gh pr create`" are all available to a seat on the VM; the cloud seat is not a read-only observer of the repo. What it cannot do is *report on its own credentials* — next section.

## What a woken session is not allowed to measure (2026-09-06; falsify: run the same commands from a human-attended session on this VM)

Several of the readings this page was commissioned to take could not be taken, and **not** because the VM lacks them. Two different layers refuse, with two different messages, and it is worth keeping them apart.

### Layer 1 — the command allow list (verdict: `requires approval`)

| command | response |
| --- | --- |
| `gh auth status` | `This command requires approval` |
| `ps -eo user,pid,comm` | `This command requires approval` |
| `env \| grep -c MUSTERD_INVITE` | `This Bash command contains multiple operations. The following part requires approval: env` |
| `printenv \| grep -c MUSTERD_INVITE` | `…requires approval: printenv` |
| `git -C . status -sb` | `This command requires approval` |

An actuated wake has no human at the keyboard, so "requires approval" is not a pause — it is a refusal that never resolves. Retried at 03:31Z in a later wake: identical strings.

The rule set is an explicit enumeration in `/data/musterd-delta/.claude/settings.local.json` (`permissions.allow`), and reading it explains every refusal above. `Bash(gh pr *)` is listed and `gh auth` is not, which is why `gh pr list` answers in the same session where `gh auth status` will not. There is no `env`, `printenv` or `ps` entry at all.

It does not explain every *permit*, though: `git remote -v` ran unprompted with no rule matching it, so a built-in read-only classification sits underneath the workspace list. Do not read the allow list as the whole boundary — it is the part you can edit.

The last row is the trap: `Bash(git status *)` *is* listed, but the rules match the literal command prefix, so putting a flag before the subcommand — `git -C . status` — misses the rule and lands on approval. A wake-time script that writes `git -C "$dir" …` for robustness is doing the thing that hangs it.

### Layer 2 — the working-directory scope (verdict: `was blocked`)

Allowed tools are still confined to the session's working directory, and `$HOME` is not inside it:

    $ rg -n 'wake due: delta' /data/home/.musterd/host.log
    rg in '/data/home/.musterd/host.log' was blocked. For security, Claude Code may only
    search for patterns in files from the allowed working directories for this session:
    '/data/musterd-delta'
    $ ls -la /data/home/.musterd/
    ls in '/data/home/.musterd' was blocked. …
    $ cat /data/home/.musterd/binding.json
    cat in '/data/home/.musterd/binding.json' was blocked. …

Three different tools, three different verbs in the message (`rg` / `ls` / `cat`), one boundary — this is not a per-tool rule, it is the session's working-directory scope.

So the seat cannot read `musterd.db`, `host.log`, `daemon.log` or `binding.json` — the four files every diagnosis of the cloud seat so far has turned on (2026-09-06 03:33Z; falsify: from a woken session on this VM, `cat /data/home/.musterd/binding.json` — content overturns this, `was blocked` confirms it). **Every finding about delta's wake path to date was made from an out-of-band shell on the VM, not from a seat session, and that is not a coincidence: a seat session cannot make them.** The seat can be the *subject* of a wake diagnosis; it cannot be the instrument.

Consequences for anyone reading this page as a VM inventory:

- **The invite scrub is unverified from inside.** The claim that `MUSTERD_INVITE` is scrubbed from the environment before the actuator runs (expected `env | grep -c MUSTERD_INVITE` → `0`) is *not confirmed here*. It is not disconfirmed either. Nobody has measured it from a woken session as of 2026-09-06.
- **The daemon process list is unverified from inside.** What `tailscaled` / `node` processes the VM actually runs could not be enumerated. `musterd status` answering on `localhost:4849` is indirect evidence that a musterd daemon is up on this host; that is all this page can honestly say.
- **The `gh` token type is unverified from inside.** Push works and `gh` answers, so the token is present and repo-scoped enough for this repo; its type and scopes were not read.
- **The seat cannot audit its own wake.** Reading `residency.wake_leased.detail.derivation` — the observable stanley's correction turns on — means reading `~/.musterd/musterd.db`, which layer 2 blocks. The seat is told it was woken; it cannot check how.

The general shape, worth more than the specific holes: **a seat woken on the cloud VM has strictly less introspection than the same seat driven interactively**, and the gap is invisible from the roster. A wake-time diagnostic that shells out to `ps`, `env`, or `gh auth status` will not fail loudly — it will sit on an approval that never comes until the watchdog kills the session (2026-09-06; falsify: put one of those three commands in a wake-time check on this VM and read the session's end — output plus a normal exit overturns this, an exit 143 at the watchdog bound confirms it). Related: [instrument silence](instrument-silence.md), [silence is only evidence when someone was listening](silence-is-only-evidence-when-someone-was-listening.md).

### The same boundary once stopped the seat occupying at all

The refusals above are the visible half of a rule that has a worse failure mode. A reply doorbell is handed `--allowedTools mcp__musterd` explicitly; a `work_order` runs under `toolPolicy: 'seat-policy'` and is handed nothing, falling back to the workspace's own list (`cli/src/host/backends/claudeCode.ts:101`). This workspace allowed `Bash(musterd *)` but not `mcp__musterd`, so delta's fourth wake had the MCP tools refused, correctly declined to fall back to the CLI — a session holding the `team_*` tools must not drive the CLI, it resolves to a different identity — and exited at 23.8 s having occupied nothing. `seat-policy`, meant to be the *broader* policy, was strictly narrower for the one server every wake requires. Repaired by adding `mcp__musterd` to this workspace's allow list; the wake that pushed this page is the confirmation. Full account: stanley, 2026-09-06 02:50Z.

## The two things that had already bitten this lane (2026-09-06; falsify: host.log for delta's wakes, and revive's residency policy)

Recorded here because they are properties of the cloud seat, not of the page:

1. **The seat could be woken exactly once.** Every `POST /residency/wake-leases` from the VM's actuator returned 401 from 2026-09-04T22:36:32Z until stanley's repair at 2026-09-06T01:26Z — a 51-hour outage during which the roster showed delta wakeable. The woken session's own claim path rewrites `binding.agent_key` with a `claim_seat`-scoped credential the wake endpoint does not accept. Repaired without rotating anything, via `musterd wire` (which rewrites that field from `config.agentKeys.revive`) then `musterd residency on`, run as the seat user with `HOME=/data/home`. Lane 01M1T6D80QYWQ9ABHARX7QCW19 carries the contract mismatch.
2. **A lane handoff to a seat on a joiner derives as a *reply* doorbell, under the 5-minute reply timeout.** delta's first attempt at this very page was killed at 302.1 s, exit 143, having created the branch and written nothing. revive's policy reads `timeout 5m · work-timeout 30m`, and only a `work_order` gets the 30. The first reading of this blamed the seat's `flow:manual` — stanley withdrew that the same evening, because delta's next wake recorded `"derivation":"batched"` with flow *already* `auto`. The real gate is a conjunction (`server/src/store/residency.ts:1249`): `dispatchLoopOn && policy.flow === 'auto' && cooled`, where `dispatchLoopOn` reads `teamPolicy.loops?.dispatch` — a **team** switch, and one held by the daemon that derives the wake, which for a cloud seat is the joiner. The hub's team policy has `loops {review,dispatch,sweep} = true`; the joiner's was null, and team policy does not replicate to a joiner. So every wake a cloud seat could receive was a reply doorbell on a 5-minute budget, no seat override lifts it, and it holds for any handoff to any seat living on a joiner. Armed the joiner's own team policy to match the hub. The host banner advertising "watchdog 600s" is not the effective bound either. Lane 01M1T6DJ7J88WDZJXEY331VZ0V.

   The general lesson for the cloud seat, and the reason this page nearly did not get written: **the VM's daemon is a joiner, and what does not replicate to it decides what the seat can do.** Two of the three blockers on this lane were replication holes (the team policy above; the roster's `wakeable` claim in lane 01M1T3GWEA), not bugs in the wake path itself.

Both are why this page exists as a measurement rather than a description.
