# The cross-machine huddle bell

A huddle's data crosses a machine boundary correctly and its bell does not ring on the far daemon — measured on a real second machine, with three independent causes and none of them the predicate everyone suspected.

## What was measured

Run of 2026-09-04, hub (nick's laptop) → `delta` (Fly VM, sjc, machine `850e40a4499168`), both daemons on build `16b6e3d8`, fly deployment `01M1Q8VQXXSQECKA3KXHRWDTBJ`. Huddle `01M1Q96J3H9T54MV2TFV35HVQW`, opened on the hub and directed at `delta`.

| act | origin `ts` | delta `created_at` | lag |
| --- | --- | --- | --- |
| root | 1788561541234 | 1788561589672 | 48.4s |
| turn 1 | 1788561716718 | 1788561769690 | 53.0s |
| turn 2 | 1788562286487 | 1788562369704 | 83.2s |
| turn 3 | sent 1788563598000 | 1788563689821 | 91.8s |

**The pull is a 60-second poll** (2026-09-04; falsify: read three consecutive folded `created_at` values on a joiner and check they are not 60000ms apart). Delta's folded rows arrive in batches exactly 60,000 ms apart, so the worst-case staleness of a joiner's replica is about one minute — it is a continuously folding replica, not a snapshot. <!-- claim: other -->

## The fold is correct

`fold.ts` rule 4 inserts `thread_id: env.thread ?? null` and `meta: env.meta ? JSON.stringify(env.meta) : null` verbatim, so `meta.huddle` (the root) and `thread` (every turn) both survive federation untouched, and `to_member` resolves to the peer's own local member id. Verified on delta's own database: the interrupt SQL predicate in `interruptCandidates.ts` **admits** the folded root.

A huddle is envelopes, and envelopes cross. That half of ADR 378 holds.

## The bell does not ring (2026-09-04)

With the root present, a qualifying turn above the cursor, the huddle open and `delta` named on the root, `musterd inbox --interrupt-check` on the VM was silent across 20 probes in two runs — 12 before the harness was wired and 8 after. Not late. Silent.

Falsify: on a joiner whose seat is a named huddle participant, fold a turn above the seat's cursor and run `musterd inbox --interrupt-check`; a printed line disproves this.

Three causes, all confirmed, in the order that matters:

### 1. A stale session lease makes the interrupt line permanently and silently deaf

The route answers delta's own on-disk credentials with:

    {"error":{"code":"unauthorized","message":"invalid, expired, or revoked agent session lease"}}

while `musterd inbox --peek` from the same folder works. The difference is deliberate: `inbox.ts` notes that the interrupt probe "takes the default (no reclaim)" — every ordinary command self-heals by re-claiming, and the probe must not, because it rides every tool call. It therefore keeps presenting a dead lease. And `interruptCheck` wraps the whole call in `try { } catch { }` and returns 0, so the 401 prints nothing.

**This is not a cloud-seat defect. It is every seat, on any machine.** A seat that loses its lease — see [the autorefresh bounce](#the-bounce-that-causes-it) — looks healthy in every other respect: `whoami` resolves, the roster shows it present, the daemon is green, the rows are all there, every other command works. Only the bell is gone, and nothing says so.

`musterd claim` does **not** repair it: after `✓ delta — occupied on revive`, the same request with the binding's credentials still returned the same 401 (2026-09-04; falsify: re-claim a seat and replay the `/inbox/interrupt-check` request with its `binding.json` `seat_credential` + `session_lease`; a 200 disproves this). <!-- claim: defect -->

The fix that makes this diagnosable at all: **stop swallowing the HTTP status in `interruptCheck`** (2026-09-04; falsify: read the `catch {}` in `interruptCheck` in `packages/cli/src/commands/inbox.ts` — any branch that surfaces a non-200 disproves this). A probe that cannot distinguish "nothing waiting" from "I am not authenticated" cannot be debugged by the seat it is failing. <!-- claim: defect -->

### 2. The cloud seat was running unwired, and the reason is not recoverable after the fact

`musterd harness status` on delta, before repair:

    claude-code   selected · available
      mcp.musterd   repo-shared  → needs wire
      hooks.global  machine      → needs wire

So the seat had **no `team_*` MCP tools** (CLI only) and **no PostToolUse hook** — nothing ran the ADR 088 interrupt probe at tool boundaries at all. Repaired by hand on 2026-09-04 with `musterd harness configure --select claude-code --yes`, after which both read `✓ in place`.

**Why it was unwired is unknown, and that is itself the finding** (2026-09-04; falsify: find a persisted boot log for this machine that records the configure's outcome). `deploy/cloud-seat/entrypoint.sh` *does* run `musterd harness configure --select claude-code --yes` unconditionally on every boot, outside the first-boot guard, with `|| log "harness configure failed …"`. So either that call failed on the 2026-09-04 redeploy, or it succeeded and the state was invalidated by the new build. It cannot be told apart now: `log` writes to stdout only, the entrypoint persists nothing to `/data/log` (which holds `daemon.log`, `host.log`, `tailscaled.log`, `workspace-install.log` and no boot log), and Fly's retained log for the machine had already rolled past the boot by the time it was checked — only SSH session lines remained. <!-- claim: defect -->

Two things follow, and both are cheap: **tee the entrypoint's own log to `/data/log/entrypoint.log`** so a boot is diagnosable after retention, and **verify the wiring after configuring it** rather than trusting the exit code, since a seat that comes up unwired is deaf and says nothing (~~prescribed but unbuilt (2026-09-04)~~ **BUILT 2026-09-16 by #1456**; falsify: redeploy to an empty volume, then read `/data/log/entrypoint.log` on the machine — it should narrate every step including the configure and its verification, and a clean `✓ in place` on the first boot narrows the unknown above to state loss). <!-- claim: other -->

What the verification actually asserts, and why the exit code alone was not enough: `musterd harness status` exits **zero** for a harness that is merely *unavailable* — "the selection survives; there is nothing to repair here" (`packages/cli/src/commands/harness.ts:190`). That is right on a laptop without Claude Code installed and exactly wrong on this machine, where an unavailable claude-code IS the deaf seat. So `seat.sh` reads `harness status --json` and asserts three things separately: claude-code is selected, it is available, and every fragment is settled (`journal: none`, unheld lock, `planned` in `unchanged`/`satisfied-unmanaged`). A failure names the offending fragments and the repair command in the boot log and does **not** stop the boot — a seat that boots and says it is deaf beats a seat that refuses to boot (2026-09-16; falsify: point the check at a workspace with a drifted hook and see it pass). <!-- claim: other -->

Only `claude` is installed on the image — `cursor`, `codex`, `opencode` and `grok` all report "install not found". The workspace's `.mcp.json` carries only `whiteboard`, which sits at "Pending approval" and is therefore useless to a headless `claude -p` wake.

### 3. Cursor burial: a turn that folded before an unrelated inbox read can never ring

`cursors.ts` is explicit that `last_read_ts` is the cursor row's **`created_at`** — the local daemon's receipt clock, not the envelope's `ts` — and that it only moves forward. `fold.ts` stamps a folded row `created_at: now`, i.e. when it landed *here*. `listInterruptCandidates` filters `created_at > cursorTs`.

So on a joiner:

1. T1 — a turn folds, `created_at = T1`.
2. T2 — the seat reads its inbox for any unrelated reason; the cursor moves to T2 > T1.
3. The turn is now permanently invisible to the interrupt check. Under any fix to causes 1 and 2, it will never ring.

Observed, not argued: reading delta's inbox moved its cursor to 1788562249698, past turn 1 at 1788561769690, and turn 1 stayed unrung through every subsequent probe (2026-09-04; falsify: fold a turn to a joiner, read that seat's inbox, repair its lease, and see the turn raise). <!-- claim: defect -->

The by-id root fetch in `listInterruptCandidates` rescues the **root** from the cursor window — ADR 378's own comment explains why it must. Nothing rescues a **turn**. This contradicts the ADR's expectation that a missed huddle bell "self-heals on the next push": self-healing holds only while no inbox read intervenes, and with a 60-second fold lag on a second machine, one usually does.

**Repaired 2026-09-15** (izzo, lane 01M1T43B84): the claim above is invalidated from that date. `listInterruptCandidates` now treats a huddle root landing inside the window as the arrival of its whole thread and fetches that thread's turns from below the cursor, so the buried turn rings on the first probe after the root folds (2026-09-15; falsify: fold a turn to a joiner, read that seat's inbox, then fold the root — a silent `inbox --interrupt-check` disproves this). The turn is discharged like any other row once a read carries the cursor past the root. The unit test reproduces the receipt-order scenario exactly. <!-- claim: defect -->

**Re-measured on delta, 2026-09-15 20:03–20:12Z** (izzo; hub laptop → `delta`, machine `850e40a4499168`, image `deployment-01M2KA7PKBTVP95TN7A8CK78HB` built from main at `8a3c0c37`, epoch 20). The receipt order was forced with two machines, no third node needed: `musterd huddle say <fresh-ulid>` sends a turn against a root the daemon has never seen (the gap named below), and a script then sends the root with that same id.

| step | hub `ts` | delta `created_at` | delta cursor after |
| --- | --- | --- | --- |
| turn `01M2KANJFB` sent 20:03:26Z | 1789502605804 | 1789502692295 (+86s) | — |
| `musterd inbox --limit 0 --unread` on delta | — | — | 1789502692295 (= the turn: buried) |
| root `01M2KANHNQ` sent 20:09:13Z | 1789502952877 | 1789503053609 (+101s) | unchanged |
| probe: candidate read + fold, as `delta` | — | — | **raised `01M2KANJFB`** (the turn, from izzo) |
| `musterd inbox --limit 0 --unread` on delta | — | — | 1789503053609 (past the root) |
| probe again | — | — | candidates `[]`, raised `[]` — discharged |

Two honest limits. **The probe was the daemon's own code path run in-process against delta's live database** (`listInterruptCandidates` → `rowsToEnvelopes` → `pendingInterrupts`, with delta's real cursor), not `musterd inbox --interrupt-check` over HTTP: no session held delta's lease during the run, so the route refused every probe with the #1317 deaf line — cause 1 above, still real and still the first thing to check on a silent bell (2026-09-15; falsify: hold a live delta Presence during the run and see the HTTP probe raise the same act). And the turn's `created_at` landed exactly equal to the cursor, which the old window (`created_at > cursorTs`) excludes just as a lower one would — the sharpest form of the burial, and the row the old read could never return. <!-- claim: other -->

## What this did *not* find

`pendingInterrupts` is not implicated. The fold is correct, the SQL admits the rows, and the predicate never gets to run because the request is rejected at the door. The ordering hazard predicted before the run — a root from node A racing a turn from node B on independent sequences — **needs three nodes to bite**, and the team has two: with a hub and one joiner there is no arrangement where a peer holds a turn while waiting for its root, because a seat cannot name a root it has not seen. It remains real and unwitnessed.

It is reachable from the near side with two machines, though, because **nothing refuses a turn against a root the local daemon has never seen**: `huddle say` builds the envelope with `thread` straight from argv, `envelope.ts` types it as a bare `z.string().min(1).nullish()` (shape only), and the route's persist path never resolves it. An out-of-band huddle id is enough (2026-09-04; falsify: `musterd huddle say <id-the-daemon-has-never-folded> "x"` and check for a refusal). <!-- claim: defect -->


**Guarded at the CLI 2026-09-15** (izzo, lane `01M2KSDKVZ`): `musterd huddle say` and `huddle close` now resolve the id against the recent timeline first — exact match, else a prefix — and refuse an id no huddle backs, naming both causes it can be (a typo, or a joiner where the root has not folded yet). The turn threads against the resolved WHOLE id, which also fixes a quieter bug: `show` accepted a prefix while `say` resolved nothing, so `huddle say <prefix>` threaded against a fragment and mirrored the turn to a board named after it. **The protocol claim above still stands and is deliberately not closed:** the daemon still accepts a turn against an unknown thread, because on a joiner a turn legitimately arrives before its root (see the repair above) and `thread` is not huddle-specific — every threaded act carries one — so a server-side refusal would reach past huddles and wedge legitimate replies. This closes the hole at the surface a person or an agent types; it is not a boundary, and any HTTP client can still do it (2026-09-15; falsify: `musterd huddle say <id-the-daemon-has-never-folded> "x"` — a send rather than a refusal disproves the CLI half). <!-- claim: defect -->
## The bounce that causes it

Twenty-one autorefresh bounces appear in one day's inbox window (2026-09-04), and the daemon reached epoch 19. Four seats independently reported losing a session lease that day — miley, sloane, izzo and stanley — each noticing because a *send* failed, none because a bell was missing. Cause 1 says the bell was missing too, for all of them, silently.

Related: [wake leases](wake-leases.md), [the shared daemon](shared-daemon.md).
