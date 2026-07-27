# Stream the office from a rented box (hosted broadcast)

> **Audience:** the operator moving `musterd broadcast` off their laptop onto a rented Linux machine
> whose lifetime is the stream's lifetime. **Design:** the hosting spec
> (`../superpowers/specs/2026-07-26-broadcast-hosting-design.md`) — measure-first; the configuration
> below is the one that passed (720p25 · libx264 · Fly `performance-4x`, 2026-07-27). **Topology:**
> ADR 039 B — a Tailscale overlay supplies reachability and encryption; musterd writes none of it.

## Shape

- **The daemon stays where it is**, loopback-bound. `tailscale serve` forwards it onto the tailnet,
  so nothing about the daemon or its LaunchAgent changes.
- **The rented machine is a Fly Machine whose main process is the stream.** Starting a stream boots
  it; ending the stream (stop, Ctrl-C semantics, the ADR 159 stall watchdog, `--duration`) exits the
  process and `--rm` destroys the machine — billing tracks streamed hours (~$10–12/mo at ~90h).
- **No Docker on the operator's machine** — images build on Fly's remote builders.
- **Secrets are Fly secrets** (`TS_AUTHKEY`, `MUSTERD_STREAM_KEY`), set by the operator directly so
  they never pass through an agent, a script argument, or the repo.

## One-time setup (operator)

1. **Tailscale on the daemon's machine** — install the app, sign in, then forward the daemon onto
   the tailnet (daemon stays loopback-bound):

   ```sh
   tailscale serve --bg --tcp 4849 tcp://127.0.0.1:4849
   ```

   Note the machine's MagicDNS name (`tailscale status` — e.g. `nicks-air.tailnet-name.ts.net`).

2. **A tailnet auth key for the box** — admin console → Settings → Keys → generate an **ephemeral,
   reusable** key (ephemeral: dead nodes vanish from the tailnet; reusable: every stream is a fresh
   node). Consider a tag with an ACL that only allows reaching the daemon's port.

3. **The Fly app + secrets:**

   ```sh
   fly apps create musterd-broadcast --org personal
   fly secrets set -a musterd-broadcast TS_AUTHKEY=<key> MUSTERD_STREAM_KEY=<twitch key> --stage
   ```

4. **Build the image** (repeat only after broadcast-relevant code changes):

   ```sh
   scripts/broadcast/live.sh build
   ```

## Streaming

```sh
export MUSTERD_AIR_ADDR=<magicdns-name>   # or put it in your shell profile
scripts/broadcast/live.sh start           # go live
scripts/broadcast/live.sh status          # ● live / ○ not live
scripts/broadcast/live.sh stop            # end stream; machine self-destroys
```

`fly logs -a musterd-broadcast` tails the run (tailscale up → daemon health check → chromium warm →
the ffmpeg stats line every 10s).

## Failure modes, recorded

- **The laptop sleeps mid-stream** → Chrome loses the page, the ADR 159 watchdog ends the stream,
  the machine destroys itself. Accepted in the spec; the trigger to revisit topology A (move the
  daemon).
- **`start` says the daemon is unreachable** → the entrypoint refuses to open a stream on a black
  stage. Check the Air is awake, `tailscale status` on both ends, and the `tailscale serve` forward.
- **Stream key rotation** → `fly secrets set -a musterd-broadcast MUSTERD_STREAM_KEY=<new>`;
  next `start` picks it up. The Keychain copy on the laptop is independent and still serves local
  `musterd broadcast` runs.
