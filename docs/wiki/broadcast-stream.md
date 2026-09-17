# The Twitch broadcast — topology and cost

The stream rents one Fly machine per stream (its lifetime IS the stream's) reaching the loopback daemon over Tailscale; the whole cost is compute, not egress — and two plausible cost claims were measured dead.

## Topology (2026-07-29 review; ADR 157 is the contract)

`musterd stream start` rents one Fly machine (app `musterd-broadcast`, performance-4x, auto-destroy) that reaches the laptop's loopback-bound daemon via Tailscale (`MUSTERD_AIR_ADDR` is a tailnet name; the ADR 040 allow-list accepts that Host). Stop with `musterd stream stop`, never by killing the machine. Nothing stream-related runs locally unless you run `musterd broadcast` yourself — except the ADR 293 supervisor below.

## Crash vs deliberate stop (2026-08-19, ADR 293; falsify: induce a crash with a raw `fly machine stop` and watch `stream ensure` heal it) <!-- claim: other -->

The verbs record intent in `~/.musterd/stream/state.json`: `start` says live (before launching), `stop` says stopped with **who and why** (`--reason`, shown by `stream status`) — so a machine gone while the file says live is a crash by definition. `musterd service install --stream` installs a 60s LaunchAgent running `stream ensure`: crash → relaunch (≤3 per 30min, then it stands down and asks the team as the `streamwatch` service seat until a human `stream start` re-arms). Consequences to know: killing the machine any way other than `stream stop` now gets healed within ~60s, and `stream start --once` is the opt-out for deliberately unsupervised (e.g. `--duration`) runs. The 2026-08-18 Chrome death ("Chrome DevTools socket closed", dead until a human noticed) is the incident this closes; ADR 292 keeps the restarted page's bundle current from there.

## Two claims the evidence killed (measured 2026-07-29; falsify: read entrypoint.sh + re-measure bitrate)

1. ~~"The hosted stream runs 1080p30 and delivers 10 fps"~~ — wrong: `scripts/broadcast/entrypoint.sh` pins 720p25; the 1080p30 row in docs/perf/broadcast-baseline.md is the REJECTED arm. Read the entrypoint, not just the bench. ~~720p25 (2026-07-29)~~ SUPERSEDED 2026-09-15: the entrypoint now pins **1080p20**, measured at speed 0.998x on the same box (1080p15 sustains a clean 1.00x and is the fallback rung) — 1080p30 stays rejected, but 1080p was never the problem at a lower frame rate and nobody had checked.
2. ~~"Lower the bitrate to halve egress"~~ — wrong: a 10 h stream is ~3 GB of egress, cents. The cost is compute, and at ~2.7 cores of pipeline performance-4x cannot step down to 2x. ~~"the flat-color iso scene encodes at ~780 kbit/s against a 4500k cap that never binds" (2026-07-29)~~ INVALIDATED 2026-09-15 (falsify: read ffmpeg's `-stats` summary off any capture): measured **~2900 kbit/s at 720p25**, **~3334 at 1080p15** and **~3517 at 1080p20**, against the same 4500k cap. The room has gained props, lighting, a night veil and more members since July; the scene is no longer "flat colour" in the sense that figure assumed. The conclusion above still holds — egress is still cents, compute is still the cost — but the cap is much nearer binding than recorded, and a bitrate decision made on the 780 figure would be made on a number that is four times off. <!-- claim: other -->

## The local VideoToolbox arm (measured 2026-07-29, 45 s probe — promising, UNPROVEN)

Hardware encode is essentially free (ffmpeg on `h264_videotoolbox`: 4.3–8.6 % of one core); the bottleneck is Chrome's render. Mid-run speed dipped to 0.57x before recovering — marginal, not comfortable. nick's decision 2026-07-29: leave the stream infra exactly as is; do not migrate to the laptop on the strength of a 45 s probe. A 10–15 min soak (guarded per [nicks-laptop](nicks-laptop.md)) remains queued.

## The supervisor used to duplicate a healthy start (2026-09-03; falsify: `fly machine list --json` during a boot, then run `stream ensure`) <!-- claim: defect -->

`startedMachines()` filters `state === 'started'`, and every "is a machine already there" decision
asked it: the ADR 293 crash predicate, `start`'s own double-launch guard, and `stop`. But Fly reports
`created`, then `starting`, for the whole boot — **29.0s** on the run that caught this, 26.5s of it
pulling the 593 MB image. Inside that window the running question returns a false empty, so the
supervisor (60s tick) read `liveCount 0` under `desired: live` as *"crash detected: machine gone"*
and launched a **second performance-4x machine on top of a perfectly healthy start**.

Observed: `287d675bd05d08` created 18:08:52; `e8262d2f5e92e8` reached `streaming (rtmps)` at
18:10:28, hit `rtmps://live.twitch.tv/... Input/output error` — Twitch refuses a second ingest on one
key — and died at 18:10:47. Both machines billed, and which one survived was a race. The irony is
that `startedMachines`' own doc comment already warned that "a false empty would let `start` boot a
second machine beside a live stream — two encoders on one Twitch key, and double billing"; the
warning was right and the predicate was the door it came through.

Fixed by asking the right question: `occupiedMachines()` counts `created`/`starting`/`started`/
`replacing` — a machine holding the slot, up or not — and the three deciding call sites use it. The
same bug made `stream stop` during a boot print "nothing live" and walk away from a machine that
then came up and billed unattended; that path is fixed with it. `status` deliberately still reports
`started`, because there "live" means *streaming* and a booting machine is not yet.

## "The digest differs" stopped being evidence of a deploy the day a second checkout existed (2026-09-17; falsify: back-date `scripts/broadcast/.image-digest` in the main checkout, start a stream from a worktree, and watch `stream ensure` call the vanish a crash rather than a deploy) <!-- claim: defect -->

`.image-digest` is **gitignored and per-checkout**, and streamwatch's LaunchAgent has
`WorkingDirectory` `/Users/nick/agents/packages/cli/dist` — so `findRepoRoot` always resolves the
**main** checkout, while a stream is routinely started from a worktree. Measured the day the stream
was started from `agents-miley`:

| | |
| --- | --- |
| `/Users/nick/agents` | `c084cf6f` — **Sep 3**, 14 days old |
| `/Users/nick/agents-miley` (started the stream) | `ffdc018f` — Sep 16 |
| `~/.musterd/stream/state.json` `image` | `ffdc018f` |

So `decideEnsure` saw `state.image !== recordedDigest` and took the 2026-08-21 deploy branch. Three
consequences, and the third is the one worth keeping: it would have relaunched the capture on
**14-day-old code** (no frame watchdog, no `coalesceStep`, no ack fix — every defect closed on this
page since Sep 3, back); it would have done so **uncharged to the flap budget**, because a deploy
deliberately does not spend one; and the log would have **asserted a deploy that never happened**.
That last is the same error as `entrypoint.sh` claiming a rebuild for every exit 75, one layer up —
*a cause the supervisor cannot know is one it must not assert.*

The 2026-08-21 predicate was not wrong when it was written; it was written when one checkout was the
only checkout, and a worktree silently removed its premise. **A heuristic whose premise is a fact
about the environment fails silently when the environment gains a case.**

Two changes, and they are deliberately separate:

1. **A digest that predates the run is not a deploy.** `decideEnsure` now takes `recordedDigestAt`
   (the file's mtime) and demotes the deploy reading when the digest was written before `state.at`,
   since a file older than the run is older than the image the run launched. Absent (legacy state,
   unit tests) the old reading stands: only positive evidence of age demotes it.
2. **A crash relaunches what the STREAM recorded, not what the checkout holds.** `ensure` launches
   `d.state.image`, and `launchPreconditions`' digest is now only the fallback for legacy state with
   no `image`. The deploy branch remains the one path that adopts a new digest, and it has now
   proven the digest postdates the run.

~~Belt and braces on purpose: even a misclassified deploy now launches the right image.~~
CORRECTED 2026-09-17 by sloane's cross-family review of #1538, which caught the sentence claiming in
both directions what it had only earned in one: a digest that is merely *stale* could no longer
hijack a relaunch, but a genuine rebuild in the **main** checkout during a **worktree**-started
stream postdated `state.at`, passed the age gate, and relaunched main's image for a stream that
never ran it — uncharged. The age gate answered the question it could ask, not the one that
mattered.

### The fix was to give the digest one home, at which point the age proxy dissolves (2026-09-17; falsify: `stream build` in one checkout, `stream ensure` from another, and read which digest it launches) <!-- claim: other -->

Both of the above are properties of *where the digest lived*, so the repair is a location, not a
sharper heuristic. The record now sits at `~/.musterd/stream/image.json`, beside `state.json`:
written by `stream build` wherever it runs, read by `start`, `ensure` and `doctor` without reference
to a checkout. `scripts/broadcast/.image-digest` is no longer written and is read only when no
machine record exists, so an existing laptop keeps working until its next build.

**The age gate is gone for the authoritative record, and that is the result rather than a
simplification.** `start` launches whatever the record said and stamps it into `state.image`, so a
record that now *differs* can only mean somebody rebuilt since — whichever checkout they ran it in,
whichever way the timestamps fall. One comparison, the same rule in both directions. The mtime gate
survives only on the legacy per-checkout path, where the asymmetry it was built for is still real.

`stream doctor` now says **whose** image it is reporting (`recorded for this machine` vs `from this
checkout only`). A doctor that prints a digest without saying who holds it is the same false green
one layer down — it read green in a worktree while the supervisor would have launched something
else.

**Mitigated on the live stream before the code landed** by copying the running digest into the main
checkout's `.image-digest` (old value kept at `.image-digest.bak-20260917`), so the stream running
that afternoon could not be healed backwards.

## ffmpeg's `fps=20 speed=1.00x` was padding — the page delivered 15 (2026-09-16; falsify: `MUSTERD_BROADCAST_PERF` on the live box, compare `deliveredFps` to `encodedFps`) <!-- claim: defect -->

nick saw a "tiny bit choppy" on member walks and act bubbles at 1080p20 while every throughput
number said healthy. The perf recorder on the live performance-4x (407 s) said why: Chrome
delivered **14.9 distinct frames/s** (min 12, p95 16) while the pump emitted **20.0**, so ~26 % of
encoded frames were the previous frame re-sent, unevenly spaced. `speed=` and `fps=` are the
encoder's view and do not carry this; the pump re-emits the latest frame on a wall clock by design.
The instrument that could — `deliveredFps` vs `encodedFps` in the JSONL — existed since July and had
not been run on the hosted box.

Cause: the office's broadcast draw coalescer skipped any rAF tick that arrived under the 50 ms
budget (`acc < budget → skip`). That is exact when rAF runs far faster than the budget (a 60 Hz
viewer), but on the box at 1080p the rAF itself ran **~19-20 Hz** — a period equal to the budget —
so every tick a hair early was dropped and the next drew at ~100 ms. `draws/s ≈ delivered/s ≈ 15`,
`ticks/s ≈ 19`. Fixed by `coalesceStep`: draw on the tick nearest the budget (`phase + raf/2 ≥
budget`) and carry the remainder, clamped to ±half a budget so a stall cannot bank catch-up draws.
The viewer's 20 fps ambient cap is unchanged (60 Hz still draws every third tick).

What this does **not** fix: the rAF running at ~20 Hz means the box's per-frame cost (paint +
composite + 1080p JPEG screencast) is ~50 ms with no headroom. Chrome sat at 220 % of a core with
canvas draw rate making no difference to that figure (14/s and 16/s buckets both 219 %), so the
cost is in the screencast/composite path, not the scene painting.

**After the fix (2026-09-16 03:45Z, same box, same recorder, 426 s):** delivered **26.9/s** (min 17,
p5 19, median 26), encoded 20.0, repeats **0.6 %** (53 of 8524). Acceptance (≥ 19) met. Two things
the after-run shows that the before-run could not: draws/s (median 18) is now *below* delivered/s,
so roughly a third of composited frames come from something other than the canvas loop — DOM
bubbles, CSS transitions — and Chrome rose to 253 % of a core because it now JPEG-encodes ~7
screencast frames/s that the 20 fps pump discards. `screencastEveryNthFrame(20)` is 1 because
`compositorHz` assumes 30 on Linux; the box composites nearer 27 here. That waste is the next cut
if Chrome's CPU ever needs to come down; it does not affect what the viewer sees.

## Half speed is not a gap, so the freeze watchdog cannot see it — the floor is under `draws`, not under arrivals (2026-09-17; falsify: run a capture on a box that holds 18 draws/s and read `drawFps` p5 out of the perf JSONL — a p5 under 12 on a box we call healthy means this floor is set too high) <!-- claim: defect -->

nick said the stream looked slower than the evening before. It was: the live capture drew **8.06 frames/s inside a 20 fps stream**, measured over 484 samples / 483 s on the performance-4x box, against a median of **18** recorded the day before. `drawsPerEncodedFrame` was **0.403** — three in five encoded frames carried no new draw at all.

Every armed counter read healthy, for the same reason as the claim above and one step worse. `fps=` and `speed=` were clean because the pump re-emits `latest` on a wall clock. The ADR 159 queue watchdog was satisfied because queue growth was **negative**. `makeFrameWatchdog` was silent because frames kept *arriving* — just fewer of them, and it asks *when did one last arrive*, not *how many*. A freeze is a gap; this has no gap.

**The floor cannot go under arrivals.** Screencast delivers only on a new composite, so a genuinely still room legitimately delivers almost nothing, and a floor that cries on a calm office is a floor nobody leaves armed. The scene itself knows the difference: while its rAF loop runs it is *trying* to draw at the requested cadence, and when it parks it hands over to the drift heartbeat, which ticks `beats`. So `beats` advancing means the room chose to be calm, and that window is not evidence of anything. `makeDrawRateFloor` judges only unparked windows.

**It reports and never stops.** A half-rate stream is worth far more to a viewer than no stream, so this is the one counter that does not reach for `forceStop` — loud exactly once, because the run continues degraded for hours and a line per window buries the first one, which is the only one that says when it began.

**Sized from measurement:** 12/s sits ~33 % under the healthy median (18) and 50 % over the observed failure (8.06), judged over a 60 s window because the fault is sustained and the office's own bursts move the instantaneous rate far more than the fault does. The probe is a CDP read of `window.__office.stats()` every 10 s and is **always on** — the whole finding of the day was that the instrument which could have seen this (`deliveredFps`, behind `MUSTERD_BROADCAST_PERF`) was opt-in, so on an ordinary run nothing was watching.

**Not yet answered by this:** *why* the per-frame draw got dearer. The CPU profile on the live page is 50.4 % `(program)` — native Skia raster under canvas 2D gradients, fills and text, on a box with no GPU (`--use-angle=swiftshader-webgl`) — with the scene's own JS at ~6 % of samples. Whether that is more content than the baseline run had, or a draw path that got dearer per unit of content, is open.

## Every health signal the capture had measured the encoder, and the encoder is downstream of the freeze (2026-09-16; falsify: `Page.stopScreencast` mid-run and watch ffmpeg keep reporting a healthy rate) <!-- claim: defect -->

A frozen source keeps ffmpeg perfectly fed, because the pump re-emits `latest` by design. So every
counter the capture owned read healthy while the picture was stuck: `fps=` and `speed=` clean, and
the ADR 159 queue watchdog satisfied **because the queue was being drained exactly as it should
be**. The only counter that knew was `deliveredFps`, which is opt-in behind
`MUSTERD_BROADCAST_PERF` and therefore off on an ordinary run. One frozen frame went out for six
and a half minutes (2026-09-16, machine `84e694b2424e38`) and nothing said so.

`makeFrameWatchdog` asks the one question none of those did: **when did a frame last ARRIVE.** Armed
when the pump starts (Chrome launching and the page loading take a minute and none of it is a
freeze), swept on the pump's own timer — the tick IS the moment a frozen source is being papered
over — and disarmed on every deliberate stop.

**The threshold is measured, not chosen.** Two captures on the performance-4x box that day (778 s
total, a quiet Saturday floor) delivered a worst SECOND of 7 frames and **zero** seconds with no
frame at all: the office's ambient motion means a healthy capture never goes one second dark. 5 s is
~5x the coarsest healthy bucket and ~75x the healthy inter-frame gap. Lowering it toward the healthy
range is how this turns a still room into a restart loop, so a test pins it inside a range.

A freeze borrows `socketLossExitCode`'s judgement rather than the encoder stall's, and the
distinction is the point: an encoder that stops draining is *this run's* problem and relaunching
re-runs it, while a screencast that stops arriving is the class a relaunch genuinely fixes.

**Verified locally against `--out`, both arms and the control** (no Fly machine, no Twitch): silent
wedge at 10 s → watchdog fired at 5.0 s, ffmpeg still printing `fps=19 speed=0.955x`, exit **1**
("Ending the stream") because the run was under `RESTARTABLE_AFTER_MS`; wedge at 70 s under
`MUSTERD_BROADCAST_SUPERVISED=1` → exit **75** ("Asking the supervisor for a relaunch"); and a clean
90 s run exited 0 with the watchdog silent.

**And verified ON THE BOX** (machine `873ed1b0549138`, 2026-09-16 19:38–19:41Z, image
`d4abbeafc7a0` built with the wedge, destroyed after): two complete freeze-and-recover cycles.
ffmpeg reported `fps=20 speed=0.988x` up to the instant of each freeze — the healthy-looking number
that hid the original incident — the watchdog fired at 5.0 s both times, the process exited 75, and
`entrypoint.sh` relaunched it. **Wedge to live again was about nine seconds**, against the six and a
half minutes the same class of failure ran unreported in the morning. The local arms prove the
predicate; only this one proves the entrypoint actually reruns on 75.

### ~~Every capture leaves its tailnet node behind, and the auth key is the drift (2026-09-16)~~ FIXED the same day — verified on the box (2026-09-16; falsify: `musterd stream doctor` — it counts capture nodes and offline ones) <!-- claim: defect -->

22 capture nodes on the tailnet, 21 offline, and the entrypoint's own `▸ tailnet node:
musterd-broadcast-N` line climbing once per launch (17 → 19 → 20 across one afternoon) because
Tailscale will not hand out a hostname a live device record still holds.

**This is config drift from a documented design, not a design gap.** `entrypoint.sh`'s header
already says `TS_AUTHKEY … use an ephemeral, tagged key`, and its tailnet block already says "the
node is ephemeral by design and must not survive the machine (pair with an ephemeral+reusable auth
key)". The key in the Fly secret simply is not one. **Ephemeral is a property set when the key is
minted** — verified, it is not a flag on `tailscale up` — so nothing in this repo can make the
existing key behave that way. Minting is a human's: it happens in the Tailscale admin console, and
the value is a credential that should not pass through a transcript.

Mitigated meanwhile by `trap 'rc=$?; tailscale logout …; exit $rc' EXIT`, which hands the node back
on the way out. ~~Partial, and the limit is the common case: `fly machine destroy` and a hard stop
SIGKILL the box (2026-09-16)~~ **CORRECTED the same day, and the correction is in the mitigation's
favour.** `musterd stream stop` does not destroy the machine — it runs `fly machine stop --signal
SIGINT --timeout 30` (stream.ts), because SIGINT is the broadcast CLI's own graceful stop and `--rm`
destroys the box once the process ends. And bash **does** run an EXIT trap on an untrapped SIGINT —
measured directly rather than recalled, with a script carrying only an EXIT trap and a `kill -INT`.
So the ordinary deliberate stop IS covered. What is not: `fly machine destroy --force`, and the
SIGKILL that follows if the process outlives the 30s timeout. I under-claimed in the PR that shipped
this; the shape of the error was assuming a teardown path without reading which signal it sends. EXIT only, never INT/TERM — trapping signals
would put bash in front of the path the broadcast CLI uses for its own graceful stop, and reordering
that to tidy a device record trades a real behaviour for a cosmetic one. `rc` is captured and
re-raised because the entrypoint keys the machine's whole lifetime off 75-vs-anything-else, so a
trap whose own commands set the status would turn every restart into a teardown. Verified with a
stubbed `tailscale` that 0, 1 and 75 all survive the trap unchanged and the logout runs on each.

**CLOSED 2026-09-16 23:0xZ, and the close is measured rather than assumed.** nick minted an
ephemeral + reusable key and cleared the stale devices; the rotation is `fly secrets set TS_AUTHKEY=…
-a musterd-broadcast --stage`. **`--stage` is not optional here:** `secrets set` deploys by default,
and this app has no Fly Launch machines and no release — every capture is `fly machine run` against a
digest we build — so the default path fails with "could not find image to use for deployment; app has
no current release". The secret is stored before that error, so a run without `--stage` looks like a
failure and is not; check the digest in `fly secrets list` rather than trusting the exit.

The lifecycle, measured on one capture from birth to reap:

| | |
| --- | --- |
| 23:04:44Z | fresh node registers, online, and takes the BASE name `musterd-broadcast` — no `-N` suffix, because the names are free again after the cleanup |
| stop | node still present and still reading `online=True` **25s** after the machine was gone |
| 23:06:04Z | reaped — gone about **80s** after the stop |

Only the 2026-09-15 leftover remains, which predates the rotation.

**Two near-misreadings, both worth more than the result.** The first check used "the node count did
not grow across a stop" as the pass condition, and it passed — but the live machine's record had
already been deleted by hand during the cleanup, so a stop *could not* have added one. **A pass
condition that a confound also satisfies is not a pass**; the answer came from running a fresh node
through its own whole lifecycle instead. The second: at 25s the node was still there and still read
online, which looks exactly like a failure. Tailscale's online flag lags and ephemeral reaping is not
instant, so a verdict at 25 seconds would have been wrong in one direction or the other.

**Not separately proven, and not claimed:** whether the removal came from the `EXIT` trap's
`tailscale logout` or from the key's ephemeral property. Both were live on that machine, and an 80s
delay looks more like server-side reaping than a logout. They are belt and braces — the trap's value
is the `fly machine destroy` and SIGKILL paths, where the key still reaps but only on its own clock.

### The ack was the one CDP call nobody awaited, and both of its failures were fixed by the same line — in opposite directions (2026-09-16; falsify: stringify the ack's `sessionId`, run to `--out`, and the log must carry one refusal line and zero stack traces) <!-- claim: defect -->

`Page.screencastFrameAck` was sent with `void` and no `.catch()`, the only fire-and-forget CDP call
in the file. `ws.onclose` calls `failAll`, which rejects EVERY pending send with a `CliError`
carrying the code `socketLossExitCode` already chose — 75 when a supervisor is standing by. Every
awaited call turns that into a considered exit. The ack turned it into an **unhandled rejection**,
so Node exited 1 and `entrypoint.sh` ended a machine that was about to be restarted. Which outcome a
lost socket produced depended on whose rejection surfaced first.

**The first fix caused the second bug, and that is the part worth remembering.** A bare
`.catch(() => {})` (fd13a04a, on the closed #1466 branch) stopped the crash by swallowing
everything — including Chrome refusing the ack outright. The very next hosted run carried one frozen
frame for six and a half minutes with nothing in the log. The silence was that fix working exactly
as written and exactly as under-specified. **Two different events arrive at the same rejection
handler:** a socket closing under us during a deliberate teardown, which is expected and must be
silent, and Chrome rejecting the ack itself, which is a stream about to freeze and must be loud.
Treating them alike fails in one direction or the other, and we have now done both.

So: quiet while `stopping || restarting`, loud exactly once otherwise. Once because Chrome refuses
one per delivered frame, and at ~15/s the repeats bury the first line, which is the only one that
says when it began.

**Measured, three arms, locally against `--out`:**

| arm | exit | stack traces | cause reported | watchdog reached |
| --- | --- | --- | --- | --- |
| refusal, no catch (pre-fix) | 1, unhandled rejection | **10** | no | no — the process died first |
| refusal, with this fix | 1, a considered `forceStop` | **0** | yes, once | yes |
| clean start and stop | 0 | 0 | no false line | n/a |

The middle row exits 1 rather than 75 and that is correct, not a miss: a stringified `sessionId` is
refused from the first frame, so the run never reaches `RESTARTABLE_AFTER_MS` and
`socketLossExitCode` chooses 1 by design. What changed is where the 1 comes from — a considered stop
instead of a crash — and that the watchdog now gets to run at all.

### Every relaunch claimed a deploy it could not know about (2026-09-16; falsify: wedge the screencast on the box and read the entrypoint's line under the watchdog's) <!-- claim: defect -->

`entrypoint.sh` printed `▸ restarting the stream on the rebuilt daemon code` for **every**
`RESTART_EXIT_CODE`, and 75 has three causes: a daemon rebuild, a lost DevTools socket
(`socketLossExitCode`), and now a frozen picture. Two of the three were being reported as the
first. Read on the hosted falsifier above: a deliberately wedged screencast relaunched twice, and
both relaunches logged as the rebuilt daemon code — which tells an operator scanning the log that a
deploy landed and there is nothing to investigate.

It predates the watchdog (the socket case was already misreported); the watchdog adds a third cause
and is what surfaced it. The line now says `▸ relaunching the stream (ran Ns) — reason on the line
above`, because the stream prints its own reason on stderr immediately before exiting and the
supervisor genuinely does not know which one fired. **A restart reason the supervisor cannot know is
one it must not assert** — the same failure as a counter that reads healthy while the picture is
frozen, one layer up.

### The 6.5-minute freeze is not reachable on `main`, and that surprised me (2026-09-16; falsify: stringify the ack's `sessionId` on main and watch it die on an unhandled rejection instead of freezing) <!-- claim: other -->

The first falsifier I wrote reproduced the original bug — a stringified `sessionId` — and it did
**not** freeze the stream. It crashed the process. On `main` the ack is `void page.send(...)` with
no `.catch()`, so Chrome's "Invalid parameters" becomes an unhandled rejection and Node exits. The
six-and-a-half-minute silent freeze was a property of the closed #1466 branch, whose gate added a
`.catch()` that swallowed exactly that rejection.

Two things follow. The watchdog is still right, because a refused ack is only ONE way frames stop
arriving and the others (a wedged compositor, a renderer hang, a silently stopped screencast) raise
nothing at all — which is why the real falsifier had to be `Page.stopScreencast`, not a bad ack.
And, noted but **not fixed here**: that unhandled rejection exits 1, so a supervised stream will not
restart from a recoverable ack failure that `socketLossExitCode` would otherwise call restartable.

## Both ffmpeg inputs ran an 8-packet queue (2026-09-03; falsify: watch the log in the first seconds of a stream) <!-- claim: defect -->

Within a second of going live, ffmpeg reported against **both** inputs: `Thread message queue
blocking; consider raising the thread_queue_size option (current value: 8)`. Eight packets is a third
of a second at 25fps, so one missed frame deadline in Chrome blocks the reader instead of being
absorbed — a stutter the viewer sees. `image2pipe` and `pulse` now each get `-thread_queue_size 512`
(~20s of video, a few MB on an 8 GB box) placed **before** their own `-i`, since an ffmpeg input
option written after its input belongs to the next one. `anullsrc` is exempt: a synthetic source
cannot fall behind.

This raises the ceiling on a hiccup; it does not make the pipeline faster. Measured the same night:
load average **5.50 / 4.54 / 2.49 on 4 cores**, chromium ~2.2 cores across four processes, ffmpeg
0.83 — Chrome's render is still the bottleneck this page has recorded since 2026-07-29, and
`performance-4x` still cannot step down. If `speed=` sits below 1.0x, no queue size fixes that.

## `Page.navigate` ran on a deadline sized for local calls (2026-09-03; falsify: cold-boot a machine and time `streaming (rtmps)` → `◉ live`) <!-- claim: defect -->

`CDP_TIMEOUT_MS` is 15s and applied to **every** CDP call, but the startup calls are not alike.
`Page.enable`, `Runtime.enable` and `Emulation.setDeviceMetricsOverride` are local bookkeeping that
answer in microseconds. `Page.navigate` resolves only when the navigation **commits** — Chrome
reaching the laptop's daemon across Tailscale and beginning the document, on a cold machine, with a
Chrome seconds old, beside an encoder already burning most of a core.

Machine `8799e4b0267668` logged `streaming (rtmps)` at 18:44:40 and died at 18:45:07 on `✗ Chrome did
not answer Page.navigate in time` — fatal, `--restart no`, and the ADR 293 supervisor then spent a
flap slot relaunching it. The margin was never comfortable: the machine that *survived* the same
night took **16s** from `streaming` to `◉ live`, and that span contains navigate **plus**
`waitBroadcastReady`'s own poll, so navigate alone was close enough to the 15s bar that which side it
landed on was chance. This is the 2026-08-18 death class, and the supervisor was built to survive it
rather than prevent it.

`cdpTimeoutFor(method)` now gives `Page.navigate` 60s and leaves everything else at 15s.
Deliberately **not** a new global default: the 15s ceiling is what makes a wedged compositor
detectable, and raising it everywhere would trade a startup flake for a hang nothing reports.
Note `waitBroadcastReady` already had its own 30s budget for exactly this reason — navigate is the
same kind of wait and had simply never been given one.

## A digest the registry has not published yet is not a failed start (2026-09-03; falsify: `stream build` then `stream start` immediately) <!-- claim: defect -->

`stream start` failed **twice** with `MANIFEST_UNKNOWN ... manifest unknown [http 404]` against a
digest `stream build` had just pushed — while flyctl's own `image found: img_…` line said it had
resolved it — then succeeded about four minutes later with nothing changed. Registry propagation lag
against a digest-pinned launch. Pinning the digest is right and stays (a tag can resolve to a stale
image; a digest cannot); what was wrong is that a failure which heals itself in minutes was fatal.

Worse than the failed command: `start` records `desired: live` **before** launching, on purpose
(ADR 293), so giving up handed the supervisor a retry loop that would have burned all three flap
slots on a 404 that was about to stop happening, then stood down and asked a human about a
non-problem. On the night, the stream came back only because the state was stopped by hand first.

`start` now re-attempts up to 4 times, 45s apart, **only** on that signature. Every other launch
failure — no capacity, bad secrets, a broken entrypoint — stays fatal on the first try, because a
retry loop over real errors is how you bill for machines that were never going to run. Same reasoning
as the prerender crawl's `retryCount: 3`, which exists because one transient fetch failure used to
fail an entire build.

**The retry reaps before it relaunches (added 2026-09-15).** A `MANIFEST_UNKNOWN` exit is not proof
that no machine was created — and that is the other half of the sentence the 2026-09-03 note left
off. `fly machine run` creates the machine and *then* the VM fails to pull the not-yet-published
digest; the machine keeps trying and comes up on its own once the registry catches up. So the attempt
being retried may already have produced the very thing being retried for. Observed live 2026-09-15
starting the hosted broadcast: the "failed" first attempt's machine went `◉ live` 52s later unaided,
and 3s before that the retry had launched a **second** performance-4x against the same stream key —
both published, and only Twitch refusing the second publisher kept it to one machine. That is luck
standing in for a guard, and it is the exact 2026-09-03 duplicate-launch (`supervisor` §above),
reached through `start`'s own retry rather than the supervisor's crash predicate. `start` now asks
the same `occupiedMachines` question its top-of-function guard asks *before each relaunch*: if the
last attempt left an occupying machine, it waits for that machine instead of racing it. The 45s sleep
was always the right wait; only the second `fly machine run` was wrong.
