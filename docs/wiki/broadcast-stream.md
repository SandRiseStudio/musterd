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
cost is in the screencast/composite path, not the scene painting. Delivered ≥ 19 after this fix is
the acceptance; if it lands short, that path is next.

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
