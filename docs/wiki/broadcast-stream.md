# The Twitch broadcast — topology and cost

The stream rents one Fly machine per stream (its lifetime IS the stream's) reaching the loopback daemon over Tailscale; the whole cost is compute, not egress — and two plausible cost claims were measured dead.

## Topology (2026-07-29 review; ADR 157 is the contract)

`musterd stream start` rents one Fly machine (app `musterd-broadcast`, performance-4x, auto-destroy) that reaches the laptop's loopback-bound daemon via Tailscale (`MUSTERD_AIR_ADDR` is a tailnet name; the ADR 040 allow-list accepts that Host). Stop with `musterd stream stop`, never by killing the machine. Nothing stream-related runs locally unless you run `musterd broadcast` yourself — except the ADR 293 supervisor below.

## Crash vs deliberate stop (2026-08-19, ADR 293; falsify: induce a crash with a raw `fly machine stop` and watch `stream ensure` heal it)

The verbs record intent in `~/.musterd/stream/state.json`: `start` says live (before launching), `stop` says stopped with **who and why** (`--reason`, shown by `stream status`) — so a machine gone while the file says live is a crash by definition. `musterd service install --stream` installs a 60s LaunchAgent running `stream ensure`: crash → relaunch (≤3 per 30min, then it stands down and asks the team as the `streamwatch` service seat until a human `stream start` re-arms). Consequences to know: killing the machine any way other than `stream stop` now gets healed within ~60s, and `stream start --once` is the opt-out for deliberately unsupervised (e.g. `--duration`) runs. The 2026-08-18 Chrome death ("Chrome DevTools socket closed", dead until a human noticed) is the incident this closes; ADR 292 keeps the restarted page's bundle current from there.

## Two claims the evidence killed (measured 2026-07-29; falsify: read entrypoint.sh + re-measure bitrate)

1. ~~"The hosted stream runs 1080p30 and delivers 10 fps"~~ — wrong: `scripts/broadcast/entrypoint.sh` pins 720p25; the 1080p30 row in docs/perf/broadcast-baseline.md is the REJECTED arm. Read the entrypoint, not just the bench.
2. ~~"Lower the bitrate to halve egress"~~ — wrong: the flat-color iso scene encodes at ~780 kbit/s against a 4500k cap that never binds; a 10 h stream is ~3 GB of egress, cents. The cost is compute, and at ~2.7 cores of pipeline performance-4x cannot step down to 2x.

## The local VideoToolbox arm (measured 2026-07-29, 45 s probe — promising, UNPROVEN)

Hardware encode is essentially free (ffmpeg on `h264_videotoolbox`: 4.3–8.6 % of one core); the bottleneck is Chrome's render. Mid-run speed dipped to 0.57x before recovering — marginal, not comfortable. nick's decision 2026-07-29: leave the stream infra exactly as is; do not migrate to the laptop on the strength of a 45 s probe. A 10–15 min soak (guarded per [nicks-laptop](nicks-laptop.md)) remains queued.

## The supervisor used to duplicate a healthy start (2026-09-03; falsify: `fly machine list --json` during a boot, then run `stream ensure`)

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

## Both ffmpeg inputs ran an 8-packet queue (2026-09-03; falsify: watch the log in the first seconds of a stream)

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
