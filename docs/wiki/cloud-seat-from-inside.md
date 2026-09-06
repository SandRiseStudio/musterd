# The cloud seat from inside

What delta's Fly VM looks like to the seat that lives on it — uid, paths, tools, remotes, daemon — measured from inside a woken session so the next person debugging it does not need `fly ssh`.

Everything below was measured on 2026-09-06 by the seat user itself, across the wakes the actuator started: the inventory between 01:57Z and 03:35Z, and the doorbell section between 13:33Z and 13:58Z from a woken session on the rebuilt machine. Where a reading is absent, the reason for its absence is the finding — see "What a woken session is not allowed to measure" below.

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

The hooks are wired (`SessionStart`, `PostToolUse`, `PreToolUse` gate, `SessionEnd`, statusline, all marker-owned). ~~This workspace's `PostToolUse` still runs `musterd inbox --interrupt-check` bare, which is the form izzo measured as never reaching a Claude Code model — so the doorbell on this VM is deaf until `musterd init --refresh-hooks` runs here.~~ **Superseded 2026-09-06 13:33Z** — the 13:24Z redeploy from `4636b396` runs `init --refresh-hooks` at boot, the hook now carries `--hook claude-code`, and the line reaches the model. Measured from inside: "Does the doorbell reach a woken cloud seat" below. See also [huddles](huddles.md), "Bell check, 2026-09-05".

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

`gh` is authenticated and answers about this repo (`gh pr list --limit 1` returned PR #1346). So steps "branch → commit → push → `gh pr create`" are all available to a seat on the VM; the cloud seat is not a read-only observer of the repo. What it cannot do is *report on its own credentials* — next section but one.

## The doorbell reaches a woken cloud seat, and its first ring was about itself (2026-09-06 13:33Z; falsify: from a woken session on this VM, read the transcript for a musterd line arriving as `hook additional context` — a musterd line present only as `hook_success.stdout` means this is wrong)

The VM was redeployed 13:24Z from `4636b396`, where `seat.sh` runs `musterd init --refresh-hooks` *before* `harness configure` and `wire`. This is izzo's ADR 088 amendment check, taken for the first time from a **woken** session rather than a hand-started one — the case the 2026-09-05 bell check could not cover, because every seat in it was started by hand on one laptop.

**The hook carries the seam.**

    $ grep -o 'interrupt-check[^"]*' .claude/settings.local.json
    interrupt-check --hook claude-code 2>/dev/null || true # musterd-interrupt-hook

`musterd init --check` prints no `STALE` line, and `permissions.allow` holds both `Bash(musterd *)` and `mcp__musterd`. Two dispositions this page had recorded as one-off hand repairs — the `--hook claude-code` refresh and the `mcp__musterd` grant that fixed the finding-18 occupancy failure below — both survived a rebuild of the machine. That is what `seat.sh` (#1357/#1360) was for, and this wake is its confirmation.

**The line reached the model.** Two `PostToolUse` hooks landed in this session's context as `hook additional context` — the `hookSpecificOutput.additionalContext` path, not the bare stdout that goes to the debug log. Verbatim, identical both times:

    musterd: the interrupt line is deaf — this seat's session lease is dead, so
    every interrupt check is being refused. it needs a live Presence: re-join
    from your harness adapter (team_join). `musterd claim delta` mints a lease
    that dies with the command, and `--detach` writes none.

So the answer is **yes**, with a detail worth more than the yes: **the first thing the repaired doorbell said was that the doorbell was deaf.** A woken cloud seat begins with a dead session lease, so its opening probes are 401s — and #1349's seam is precisely what let the seat learn that about itself, in context, on tool call one, instead of failing silently for the length of the session. dolly's row in [huddles](huddles.md) "Bell check, 2026-09-05" is the same sequence discovered by hand on the laptop; here it announced itself.

**The deaf line cleared — but not demonstrably because of `team_join`.** The line prescribes `team_join` from the harness adapter and rules out `musterd claim`. That MCP call answered:

    Already joined revive as delta.

A no-op by its own words — and yet no tool call after it carried the deaf line again, and the probe the hook runs is silent when run by hand:

    $ musterd inbox --interrupt-check --hook claude-code       # 13:35:03Z
    (no output)

**Do not read that as `team_join` being the repair.** This session issued `team_join`, `team_inbox_check` and `team_next` in one batch, so the healing cannot be attributed to any one of the three — and on the same afternoon two seats measured the discriminating cases on the laptop. ryder: `team_join` returned the identical "Already joined" no-op and the probe stayed deaf; the *next* `team_send` cleared it. dolly: deaf across many `team_*` calls all session, cleared only by nick's `/mcp reload`. So at least two states wear this one message — a session lease that a send re-writes, and a dormant adapter that needs the harness to reconnect — and the line prescribes one repair for both (2026-09-06 13:32Z, with ryder's and dolly's counter-cases at 13:48Z and 13:49Z; falsify: from a deaf seat call `team_join` *alone* and re-run the probe — silence means join is sufficient and this paragraph is wrong).

The wording is a trap either way: `Already joined` reports on roster membership, which was never in doubt, when the thing that was dead was the session lease.

**A cloud wake is not on the 5-minute bound any more.** This session passed 302 s still working on ordinary tool calls, with no watchdog kill — the failure mode that ate delta's first attempt at this page. `team_wake_context` reported `wake.kind: work_order`, which is stanley's falsifier for the `seat.sh` lane, answered from the packet rather than from the ledger row the seat still cannot read (below).

### The mid-session ring arrives — and a directed `message` is not one (2026-09-06 13:45Z; falsify: send a live, healthy seat a bare directed `message` and watch its next probe — a ring means this is wrong)

The brief for this lane was "keep making tool calls while I send you a directed message." stanley sent one at 13:33:26Z, id `01M1VERTJ3QAP7C5GVTSCTWWV4`. **It never rang.** Twelve minutes and some twenty tool boundaries later the session's first real interrupt landed, again as `hook additional context`:

    ⚡ musterd: acceptance from big-body (ask) — run 'musterd inbox' to read it.

13:45:35Z, on the first tool boundary after big-body's acceptance ask (`01M1VFFSNR7FGGTDYBRBDV8ZPW`) arrived, and on every tool boundary after that until it was discharged. So the live rail works end to end on the VM: daemon → probe → `additionalContext` → model.

**The silence on stanley's message is neither the hook nor replication.** The act is on this machine — `musterd inbox --peek --unread` lists `▌ 13:33 stanley [message] → delta`. It did not ring because a plain directed `message` **is not an interrupt candidate, by design**: `packages/server/src/store/interruptCandidates.ts` admits an act only if it carries `meta.urgent`, is a `steer`, is an obligation (an `ask` carrying the daemon-set `meta.lane_review`), or is a turn in an open huddle this seat is in (ADR 378). Naming one seat in the `to` field is not on that list. dolly's directed `message` at 13:49Z is the second instance in the same session, and it did not ring either.

That makes it a **methodology trap, and it bit the experiment built to look for it**: "send the seat a directed message and see whether it hears" cannot succeed, on any harness, for any seat, however healthy its lease. The 2026-09-05 bell check escaped this only because it probed with *huddle turns*, which are candidates. Anyone re-running a bell check against the VM must send an `ask`, a `steer`, or something carrying `meta.urgent` — and a wake brief that says "I will send you a message" is specifying a test that is guaranteed to look like a failure.

### The cloud seat's daemon is a different build, and autorefresh does not reach it (2026-09-06 13:57Z; falsify: `git merge-base --is-ancestor 4636b396 1972d8fe`)

The ring above headlined an acceptance while two `steer` acts from dolly (13:47Z, 13:49Z) sat unread in the same window — and `steer` outranks acceptance under izzo's #1362 class ordering, with a tail naming the rest. Neither happened, and that is **not** a regression in #1362: this machine's daemon is not the machine autorefresh bounces. The VM was imaged 13:24Z from `4636b396`; #1362 landed at `1972d8fe`, which `4636b396` predates. Every "bounced the daemon on `<sha>`" line in the stream today concerns the laptop's daemon; the VM's own daemon on `localhost:4849` moves only when the machine is redeployed.

So a cloud seat can sit hours behind the team on every daemon-side fix while its CLI-side hooks are perfectly current, and **nothing on the roster distinguishes the two**. Read any daemon-behaviour observation made from delta against the image sha, not against `main` — including the observations on this page.

The seat cannot read that sha from inside, either: `musterd service status`, the command that prints the running build, answers `musterd service is macOS-only for now (this is linux)` (ADR 045). The one number needed to date a finding from this box is the one the box will not tell you.

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
- **The daemon's build is unreadable from inside, and this one is a refusal by the CLI rather than by the sandbox.** `musterd service status` is macOS-only (ADR 045) and declines on Linux, so the seat cannot date its own daemon — which, per "a different build" above, is the number every daemon-behaviour finding from this box has to be read against (2026-09-06 13:57Z; falsify: run `musterd service status` on the VM and read a build line).
- **The seat cannot audit its own wake — but it can now ask what kind it was.** Reading `residency.wake_leased.detail.derivation` — the observable stanley's correction turns on — means reading `~/.musterd/musterd.db`, which layer 2 blocks, and that is still true. What closes half the gap is `team_wake_context`: it answered `wake.kind: work_order` for the 13:31Z wake (2026-09-06 13:32Z; falsify: call it on a lane you were woken for and compare its `wake.kind` against the `host.log` bounds line from an out-of-band shell — a disagreement means the packet is not a substitute). Keep the two apart: the packet is the daemon *telling* the seat, over the same channel that woke it; the ledger row is independent evidence, and only the second one can catch a daemon that lies or a wake that was derived differently from how it was announced.

The general shape, worth more than the specific holes: **a seat woken on the cloud VM has strictly less introspection than the same seat driven interactively**, and the gap is invisible from the roster. A wake-time diagnostic that shells out to `ps`, `env`, or `gh auth status` will not fail loudly — it will sit on an approval that never comes until the watchdog kills the session (2026-09-06; falsify: put one of those three commands in a wake-time check on this VM and read the session's end — output plus a normal exit overturns this, an exit 143 at the watchdog bound confirms it). Related: [instrument silence](instrument-silence.md), [silence is only evidence when someone was listening](silence-is-only-evidence-when-someone-was-listening.md).

### The same boundary once stopped the seat occupying at all

The refusals above are the visible half of a rule that has a worse failure mode. A reply doorbell is handed `--allowedTools mcp__musterd` explicitly; a `work_order` runs under `toolPolicy: 'seat-policy'` and is handed nothing, falling back to the workspace's own list (`cli/src/host/backends/claudeCode.ts:101`). This workspace allowed `Bash(musterd *)` but not `mcp__musterd`, so delta's fourth wake had the MCP tools refused, correctly declined to fall back to the CLI — a session holding the `team_*` tools must not drive the CLI, it resolves to a different identity — and exited at 23.8 s having occupied nothing. `seat-policy`, meant to be the *broader* policy, was strictly narrower for the one server every wake requires. Repaired by adding `mcp__musterd` to this workspace's allow list; the wake that pushed this page is the confirmation. Full account: stanley, 2026-09-06 02:50Z. Since #1357/#1360 `seat.sh` re-applies that grant at every boot, and it was still in `permissions.allow` after the 13:24Z rebuild (2026-09-06 13:34Z; falsify: redeploy the machine and grep `permissions.allow` for `mcp__musterd`). The underlying `seat-policy` asymmetry is not fixed, only papered over per workspace — lane 01M1VDY8PY.

## The two things that had already bitten this lane (2026-09-06; falsify: host.log for delta's wakes, and revive's residency policy)

Recorded here because they are properties of the cloud seat, not of the page:

1. **The seat could be woken exactly once.** Every `POST /residency/wake-leases` from the VM's actuator returned 401 from 2026-09-04T22:36:32Z until stanley's repair at 2026-09-06T01:26Z — a 51-hour outage during which the roster showed delta wakeable. The woken session's own claim path rewrites `binding.agent_key` with a `claim_seat`-scoped credential the wake endpoint does not accept. Repaired without rotating anything, via `musterd wire` (which rewrites that field from `config.agentKeys.revive`) then `musterd residency on`, run as the seat user with `HOME=/data/home`. Lane 01M1T6D80QYWQ9ABHARX7QCW19 carries the contract mismatch.
2. **A lane handoff to a seat on a joiner derives as a *reply* doorbell, under the 5-minute reply timeout.** delta's first attempt at this very page was killed at 302.1 s, exit 143, having created the branch and written nothing. revive's policy reads `timeout 5m · work-timeout 30m`, and only a `work_order` gets the 30. The first reading of this blamed the seat's `flow:manual` — stanley withdrew that the same evening, because delta's next wake recorded `"derivation":"batched"` with flow *already* `auto`. The real gate is a conjunction (`server/src/store/residency.ts:1249`): `dispatchLoopOn && policy.flow === 'auto' && cooled`, where `dispatchLoopOn` reads `teamPolicy.loops?.dispatch` — a **team** switch, and one held by the daemon that derives the wake, which for a cloud seat is the joiner. The hub's team policy has `loops {review,dispatch,sweep} = true`; the joiner's was null, and team policy does not replicate to a joiner. So every wake a cloud seat could receive was a reply doorbell on a 5-minute budget, no seat override lifts it, and it holds for any handoff to any seat living on a joiner. Armed the joiner's own team policy to match the hub. The host banner advertising "watchdog 600s" is not the effective bound either. Lane 01M1T6DJ7J88WDZJXEY331VZ0V.

   The general lesson for the cloud seat, and the reason this page nearly did not get written: **the VM's daemon is a joiner, and what does not replicate to it decides what the seat can do.** Two of the three blockers on this lane were replication holes (the team policy above; the roster's `wakeable` claim in lane 01M1T3GWEA), not bugs in the wake path itself.

Both are why this page exists as a measurement rather than a description.
