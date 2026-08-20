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
